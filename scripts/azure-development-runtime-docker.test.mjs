import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openRuntimeDocker } from "./azure-development-runtime-docker.mjs";
import { runtimeDriverFixture as fixture } from "./azure-development-runtime-fixture.mjs";
import { openRuntimeJournal, readRuntimeJournal } from "./azure-development-runtime-journal.mjs";

const inputSha256 = "a".repeat(64);

test("fixed create/start/observe/one-shot restart/owned-stop path records actual raw observations", async (t) => {
  const f = await fixture(t);
  const created = await f.driver.create();
  assert.equal(Object.keys(created).length, 9);
  for (const name of [
    "postgres",
    "meilisearch",
    "internal-tls",
    "capture",
    "migrate",
    "azure-canary",
    "search-bootstrap",
    "api",
    "worker",
  ])
    await f.driver.start(name);
  for (const name of ["migrate", "azure-canary", "search-bootstrap"]) {
    const result = await f.driver.waitForExit(name, 5000);
    assert.equal(result.container.exitCode, 0);
    assert.match(result.text, /synthetic-maintenance-output/u);
  }
  await f.driver.start("migrate");
  await f.driver.waitForExit("migrate", 5000);
  const observed = await f.driver.observe(["api", "worker"]);
  assert(observed.api.healthy && observed.worker.healthy);
  await f.driver.stop();
  assert.deepEqual(f.stops, [
    "api",
    "worker",
    "capture",
    "internal-tls",
    "meilisearch",
    "postgres",
  ]);
  const state = await readRuntimeJournal(f.directory, inputSha256);
  assert(state.complete);
  assert(
    state.records.some(
      (record) =>
        record.event.phase === "created" && Object.keys(record.event.containers).length === 9,
    ),
  );
  assert(
    !f.calls.some((args) =>
      args.some((value) => ["rm", "down", "pull", "build", "restart"].includes(value)),
    ),
  );
});

test("ambiguous creation is retained and never permits another create, start or guessed cleanup", async (t) => {
  const f = await fixture(t, { unknownCreate: true });
  await assert.rejects(f.driver.create(), /lost create/u);
  const before = f.calls.length;
  await assert.rejects(f.driver.create());
  await assert.rejects(f.driver.start("api"));
  await assert.rejects(f.driver.stop());
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
  const state = await readRuntimeJournal(f.directory, inputSha256);
  assert(state.records.some((record) => record.event.phase === "create-intent"));
  assert(!state.records.some((record) => record.event.phase === "created"));
});

test("substituted ID, mount, network or protected input prevents the next native start", async (t) => {
  for (const mutate of [
    (f) => {
      f.containers.api.Id = "e".repeat(64);
    },
    (f) => {
      f.containers.api.Mounts[0].Source = "/unowned/ca.crt";
    },
    (f) => {
      f.rawNetworks.backend.Id = "e".repeat(64);
    },
    (f) => f.substitute(),
  ]) {
    const f = await fixture(t);
    await f.driver.create();
    mutate(f);
    await assert.rejects(f.driver.start("api"));
    assert.deepEqual(f.starts, []);
  }
});

test("work cancellation blocks new starts but settles only reverified owned application IDs in the original reserve", async (t) => {
  const f = await fixture(t);
  await f.driver.create();
  await f.driver.start("api");
  await f.driver.start("worker");
  f.controller.abort();
  await assert.rejects(f.driver.start("capture"));
  await f.driver.stop();
  assert.deepEqual(f.stops, ["api", "worker"]);
});

test("stop evidence failure does not strand known owned applications and cannot report complete settlement", async (t) => {
  const f = await fixture(t, { failStopEvidence: true });
  await f.driver.create();
  await f.driver.start("api");
  await f.driver.start("worker");
  await assert.rejects(f.driver.stop(), /journal publication failed/u);
  assert.deepEqual(f.stops, ["api", "worker"]);
  assert.equal(f.containers.api.State.Running, false);
  assert.equal(f.containers.worker.State.Running, false);
});

test("a replacement application identity refuses stop before sending a signal to that ID", async (t) => {
  const f = await fixture(t);
  await f.driver.create();
  await f.driver.start("api");
  f.containers.api.Id = "f".repeat(64);
  await assert.rejects(f.driver.stop());
  assert.deepEqual(f.stops, []);
});

test("loss or substitution of retained ownership evidence refuses the next native start", async (t) => {
  for (const mutation of ["remove", "replace", "edit"]) {
    const f = await fixture(t);
    await f.driver.create();
    const name = (await readdir(f.directory)).find((name) => name.endsWith("-created.json"));
    assert(name);
    const path = join(f.directory, name),
      raw = await readFile(path);
    if (mutation === "remove") await rm(path);
    else if (mutation === "replace") {
      await rename(path, join(f.root, "retained-created.json"));
      await writeFile(path, raw, { mode: 0o600, flag: "wx" });
    } else
      await writeFile(
        path,
        Buffer.from(raw.toString().replace('"phase":"created"', '"phase":"altered"')),
      );
    const before = f.calls.length;
    await assert.rejects(f.driver.start("api"));
    assert.equal(
      f.calls.length,
      before,
      "Broken evidence must refuse even the next native observation",
    );
    assert.deepEqual(f.starts, []);
  }
});

test("a broken retained journal still permits owned shutdown and reports incomplete settlement", async (t) => {
  const f = await fixture(t, { brokenJournalCleanup: true });
  await f.driver.create();
  await f.driver.start("api");
  await f.driver.start("worker");
  const name = (await readdir(f.directory)).find((name) => name.endsWith("-created.json"));
  await rename(join(f.directory, name), join(f.root, "retained-created.json"));
  await assert.rejects(f.driver.start("capture"));
  await assert.rejects(f.driver.stop(), /journal publication failed/u);
  assert.deepEqual(f.stops, ["api", "worker"]);
  assert.equal(f.containers.api.State.Running, false);
  assert.equal(f.containers.worker.State.Running, false);
});

async function recover(t, f, mutate = () => {}) {
  const state = await readRuntimeJournal(f.directory, inputSha256);
  const createdRecord = state.records.find((record) => record.event.phase === "created").event;
  const recovery = structuredClone({ model: f.model, createdRecord });
  mutate(recovery);
  const directory = join(f.root, "recovery-journal");
  await mkdir(directory, { mode: 0o700 });
  const journal = await openRuntimeJournal(directory);
  t.after(() => journal.close());
  await journal.publish({
    phase: "admitted",
    inputSha256,
    originalJournalSha256: state.lastSha256,
  });
  f.useStopEvidence(directory, inputSha256);
  return openRuntimeDocker({ ...f.driverInput, journal, recovery }, f.execute);
}

test("hard-loss reconstruction sends no creation/start command and stops only retained reverified IDs", async (t) => {
  const f = await fixture(t);
  await f.driver.create();
  await f.driver.start("api");
  await f.driver.start("worker");
  const before = f.calls.length;
  const recovered = await recover(t, f);
  assert.equal(
    f.calls.length,
    before,
    "Recovery must not reload potentially removed service configuration",
  );
  await assert.rejects(recovered.create());
  await assert.rejects(recovered.start("capture"));
  await assert.rejects(recovered.observe(["api"]));
  await assert.rejects(recovered.waitForExit("migrate", 1000));
  assert.equal(f.calls.length, before);
  await recovered.stop();
  assert.deepEqual(f.stops, ["api", "worker"]);
  assert(!f.calls.slice(before).some((args) => args.includes("compose") || args.includes("start")));
});

test("an inconsistent retained model, related ID or source contract refuses recovery before native access", async (t) => {
  for (const mutate of [
    (recovery) => {
      recovery.createdRecord.containers.api.id = "e".repeat(64);
    },
    (recovery) => {
      recovery.model.services.api.command = ["node", "dist/unowned.js"];
    },
    (recovery) => {
      recovery.createdRecord.contracts.api.revision = "e".repeat(40);
    },
  ]) {
    const f = await fixture(t);
    await f.driver.create();
    const before = f.calls.length;
    await assert.rejects(recover(t, f, mutate));
    assert.equal(f.calls.length, before);
    assert.deepEqual(f.stops, []);
  }
});

test("recovered cleanup still refuses a subsequently replaced native container identity", async (t) => {
  const f = await fixture(t);
  await f.driver.create();
  await f.driver.start("api");
  const recovered = await recover(t, f);
  f.containers.api.Id = "f".repeat(64);
  await assert.rejects(recovered.stop());
  assert.deepEqual(f.stops, []);
});

test("a cancelled HTTP ownership observation cannot issue another native command", async (t) => {
  const f = await fixture(t);
  await f.driver.create();
  const before = f.calls.length,
    cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(f.driver.observe(["api"], cancellation.signal));
  assert.equal(f.calls.length, before);
});
test("cancellation after network observation stops before container inspection", async (t) => {
  const f = await fixture(t),
    cancellation = new AbortController();
  let watching = false;
  const driver = await openRuntimeDocker(f.driverInput, async (tool, args, configuration) => {
    const raw = await f.execute(tool, args, configuration);
    if (watching && args.includes("network") && args.includes("inspect")) cancellation.abort();
    return raw;
  });
  await driver.create();
  const before = f.calls.length;
  watching = true;
  await assert.rejects(driver.observe(["api"], cancellation.signal));
  assert.equal(f.calls.length, before + 1);
});
