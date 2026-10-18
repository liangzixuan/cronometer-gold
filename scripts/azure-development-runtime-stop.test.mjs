import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { recoverPreparedDevelopmentRuntime } from "./azure-development-runtime.mjs";
import { runtimeClientDeadline } from "./azure-development-runtime-client.mjs";
import {
  references,
  runtimeDockerFixture,
  runtimeDriverFixture,
} from "./azure-development-runtime-fixture.mjs";
import { readRuntimeJournal } from "./azure-development-runtime-journal.mjs";

const owner = "11111111-1111-4111-8111-111111111111",
  bootId = "22222222-2222-4222-8222-222222222222";
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
async function fixture(t, options = {}) {
  const now = Date.now();
  const monotonicStartNs = (process.hrtime.bigint() - 1_000_000_000n).toString();
  const clientStart = Math.ceil(now / 1000) * 1000 + 60_000;
  const clientAccess = options.publicClient
    ? {
        adminIpv4Cidr: "8.8.8.8/32",
        notBeforeUtc: new Date(clientStart).toISOString(),
        notAfterUtc: new Date(clientStart + 60_000).toISOString(),
      }
    : null;
  const apiDeadlineNs = runtimeClientDeadline(clientAccess, {
    startedAtUtc: new Date(now - 1000).toISOString(),
    monotonicStartNs,
    notAfterUtc: new Date(now + 3_600_000).toISOString(),
  });
  const base = await runtimeDockerFixture(t, {
    project: `nourishing-development-${owner}`,
    clientAccess,
    apiDeadlineNs,
  });
  const input = {
    schemaVersion: 1,
    kind: "nutrition-development-runtime-input-v1",
    sourceRevision: "a".repeat(40),
    owner,
    project: base.model.name,
    root: base.root,
    notAfterUtc: new Date(now + (options.expired ? -60_000 : 3_600_000)).toISOString(),
    tools: {
      node: { path: process.execPath, sha256: "b".repeat(64) },
      git: { path: "/usr/bin/git", sha256: "c".repeat(64) },
      docker: { path: "/usr/bin/docker", sha256: "d".repeat(64) },
    },
    images: references,
    clientAccess,
    host: { bootId },
  };
  const path = join(base.root, "runtime.json"),
    raw = Buffer.from(`${canonicalJson(input)}\n`),
    inputSha256 = hash(raw);
  await writeFile(path, raw, { mode: 0o600, flag: "wx" });
  const f = await runtimeDriverFixture(t, {
    base,
    inputSha256,
    unknownCreate: options.unknownCreate,
    clientAccess,
    apiDeadlineNs,
    stopFailure: options.stopFailure,
    admission: {
      startedAtUtc: new Date(now - (options.expired ? 7_200_000 : 1000)).toISOString(),
      monotonicStartNs: options.expired
        ? (process.hrtime.bigint() - 7_200_000_000_000n).toString()
        : monotonicStartNs,
      controllerPid: 2_000_000_000,
      controllerStartToken: "12345",
      notAfterUtc: input.notAfterUtc,
      bootId,
    },
  });
  if (options.unknownCreate) await assert.rejects(f.driver.create(), /lost create/u);
  else {
    await f.driver.create();
    await f.driver.start("api");
    await f.driver.start("worker");
    if (clientAccess) await f.driver.start("client-edge");
  }
  const stopDirectory = join(base.root, "recovery-stop-journal");
  await mkdir(stopDirectory, { mode: 0o700 });
  f.useStopEvidence(stopDirectory, inputSha256);
  const prerequisiteCalls = [];
  const execute = async (tool, args, configuration) => {
    if (tool.path === input.tools.docker.path) return f.execute(tool, args, configuration);
    configuration.signal.throwIfAborted();
    prerequisiteCalls.push([tool.path, args]);
    let text;
    if (tool.path === process.execPath) {
      assert.deepEqual(args, ["--version"]);
      text = "v22.23.2\n";
    } else {
      assert.equal(tool.path, input.tools.git.path);
      text = args.includes("rev-parse")
        ? `${options.wrongSource ? "b".repeat(40) : input.sourceRevision}\n`
        : "";
    }
    return {
      text,
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
      stderrBytes: 0,
      stderrSha256: hash(""),
    };
  };
  const readSystem = async (path) => {
    if (path === "/proc/sys/kernel/random/boot_id")
      return `${options.wrongBoot ? owner : bootId}\n`;
    assert.equal(path, "/proc/2000000000/stat");
    if (options.parentAlive || options.reusedPid) {
      const fields = Array(20).fill("0");
      fields[0] = "S";
      fields[19] = options.reusedPid ? "98765" : "12345";
      return `2000000000 (node) ${fields.join(" ")}`;
    }
    throw Object.assign(new Error("Synthetic controller has ended"), { code: "ENOENT" });
  };
  const run = () =>
    recoverPreparedDevelopmentRuntime(["stop", "--input", path, "--input-sha256", inputSha256], {
      execute,
      readSystem,
    });
  return { ...f, path, input, inputSha256, stopDirectory, prerequisiteCalls, run };
}

test("actual protected stop command conserves original lease/journal and stops only retained IDs after parent loss", async (t) => {
  const f = await fixture(t),
    before = f.calls.length;
  const result = await f.run();
  assert.equal(result.knownOwnedContainersSettled, 9);
  assert.equal(result.originalJournalComplete, true);
  assert.equal(result.operationalAcceptance, false);
  assert.deepEqual(f.stops, ["api", "worker"]);
  assert.equal(f.prerequisiteCalls.length, 3);
  assert(!f.calls.slice(before).some((args) => args.includes("compose") || args.includes("start")));
  const journal = await readRuntimeJournal(f.stopDirectory, f.inputSha256);
  assert(journal.complete && journal.records.at(-1).event.phase === "recovery-stopped");
});
test("reused PID never signals or adopts the unrelated process", async (t) => {
  const f = await fixture(t, { reusedPid: true });
  await f.run();
  assert.deepEqual(f.stops, ["api", "worker"]);
});
test("live original controller, expired original lease or different boot refuses all native recovery commands", async (t) => {
  for (const options of [{ parentAlive: true }, { expired: true }, { wrongBoot: true }]) {
    const f = await fixture(t, options),
      before = f.calls.length;
    await assert.rejects(f.run());
    assert.equal(f.calls.length, before);
    assert.deepEqual(f.prerequisiteCalls, []);
    assert.deepEqual(f.stops, []);
  }
});
test("wrong source or substituted protected input cannot start native stop", async (t) => {
  for (const options of [{ wrongSource: true }, { substituted: true }]) {
    const f = await fixture(t, options),
      before = f.calls.length;
    if (options.substituted) await writeFile(f.path, `${await readFile(f.path, "utf8")} `);
    await assert.rejects(f.run());
    assert.equal(f.calls.length, before);
    assert.deepEqual(f.stops, []);
  }
});
test("unknown creation with no durable full-ID claim remains read-only reconciliation", async (t) => {
  const f = await fixture(t, { unknownCreate: true }),
    before = f.calls.length;
  await assert.rejects(f.run(), /No complete durable creation record/u);
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.stops, []);
  assert.deepEqual(await readdir(f.stopDirectory), []);
});
test("a torn original suffix still settles known IDs and cannot become complete success", async (t) => {
  const f = await fixture(t),
    state = await readRuntimeJournal(f.directory, f.inputSha256);
  const path = join(
    f.directory,
    `${String(state.records.length).padStart(3, "0")}-unconfirmed.json`,
  );
  await writeFile(path, '{"partial":', { mode: 0o600, flag: "wx" });
  await assert.rejects(f.run(), /original evidence remains incomplete/u);
  assert.deepEqual(f.stops, ["api", "worker"]);
  assert.equal(await readFile(path, "utf8"), '{"partial":');
  const proof = await readRuntimeJournal(f.stopDirectory, f.inputSha256);
  assert.equal(proof.records[0].event.originalJournalComplete, false);
});

test("actual parent-loss stop command preserves the public variant and independently settles every ID after an edge refusal", async (t) => {
  for (const refusal of [false, true]) {
    const f = await fixture(t, {
      publicClient: true,
      stopFailure: refusal ? "client-edge" : undefined,
    });
    const before = f.calls.length;
    if (refusal) await assert.rejects(f.run(), AggregateError);
    else {
      const result = await f.run();
      assert.equal(result.knownOwnedContainersSettled, 10);
    }
    assert.deepEqual(f.stops, ["client-edge", "api", "worker"]);
    assert.equal(f.containers["client-edge"].State.Running, refusal);
    assert.equal(f.containers.api.State.Running, false);
    assert.equal(f.containers.worker.State.Running, false);
    assert(
      !f.calls.slice(before).some((args) => args.includes("compose") || args.includes("start")),
    );
  }
});
