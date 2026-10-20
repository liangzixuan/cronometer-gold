import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import {
  createRuntimeLease,
  openRuntimeJournal,
  readRuntimeJournal,
} from "./azure-development-runtime-journal.mjs";

const inputSha256 = "a".repeat(64);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nutrition-runtime-journal-")),
    directory = join(root, "journal");
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory };
}

test("durably binds admission, creation intent and full IDs in an intact private canonical chain", async (t) => {
  const f = await fixture(t),
    journal = await openRuntimeJournal(f.directory);
  const first = await journal.publish({
    phase: "admitted",
    inputSha256,
    sourceRevision: "b".repeat(40),
  });
  const second = await journal.publish({
    phase: "create-intent",
    project: "nourishing-test",
    owner: "synthetic",
  });
  const third = await journal.publish({
    phase: "created",
    containers: [{ id: "c".repeat(64), identity: "d".repeat(64) }],
  });
  await journal.close();
  const read = await readRuntimeJournal(f.directory, inputSha256);
  assert.equal(read.complete, true);
  assert.equal(read.records.length, 3);
  assert.equal(read.lastSha256, third.sha256);
  assert.equal(read.records[1].previousSha256, first.sha256);
  assert.equal(read.records[2].previousSha256, second.sha256);
  for (const name of await readdir(f.directory))
    assert.equal((await lstat(join(f.directory, name))).mode & 0o7777, 0o600);
  await assert.rejects(openRuntimeJournal(f.directory));
});

test("the first record must bind its input before any file is published", async (t) => {
  const f = await fixture(t),
    journal = await openRuntimeJournal(f.directory);
  try {
    await assert.rejects(journal.publish({ phase: "created", containers: [] }));
    await assert.rejects(journal.publish({ phase: "admitted", inputSha256: "wrong" }));
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    await journal.close();
  }
});

test("unknown creation or torn record retains the intact prefix and all partial evidence", async (t) => {
  const f = await fixture(t),
    journal = await openRuntimeJournal(f.directory);
  await journal.publish({ phase: "admitted", inputSha256 });
  await journal.publish({ phase: "create-intent", project: "nourishing-test" });
  await journal.close();
  await writeFile(join(f.directory, "002-created.json"), '{"partial":', {
    mode: 0o600,
    flag: "wx",
  });
  const read = await readRuntimeJournal(f.directory, inputSha256);
  assert.equal(read.complete, false);
  assert.equal(read.uncertainAt, 2);
  assert.equal(read.records.length, 2);
  assert.equal(await readFile(join(f.directory, "002-created.json"), "utf8"), '{"partial":');
});

test("hash-chain substitution and duplicate JSON keys cannot become a valid recovery record", async (t) => {
  for (const raw of [
    '{"event":{"phase":"created"},"sequence":1}\n',
    '{"kind":"first","kind":"second"}\n',
  ]) {
    const f = await fixture(t),
      journal = await openRuntimeJournal(f.directory);
    await journal.publish({ phase: "admitted", inputSha256 });
    await journal.close();
    await writeFile(join(f.directory, "001-created.json"), raw, { mode: 0o600, flag: "wx" });
    const read = await readRuntimeJournal(f.directory, inputSha256);
    assert.equal(read.complete, false);
    assert.equal(read.records.length, 1);
  }
});

test("a colliding output is never overwritten and prevents later publication", async (t) => {
  const f = await fixture(t),
    journal = await openRuntimeJournal(f.directory);
  await journal.publish({ phase: "admitted", inputSha256 });
  const path = join(f.directory, "001-create-intent.json");
  await writeFile(path, "retained collision", { mode: 0o600, flag: "wx" });
  await assert.rejects(journal.publish({ phase: "create-intent" }));
  await assert.rejects(journal.publish({ phase: "created" }));
  await journal.close();
  assert.equal(await readFile(path, "utf8"), "retained collision");
});

test("replacing the named journal directory cannot redirect a held publication", async (t) => {
  const f = await fixture(t),
    journal = await openRuntimeJournal(f.directory);
  await journal.publish({ phase: "admitted", inputSha256 });
  await rename(f.directory, join(f.root, "retained-journal"));
  await mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(journal.publish({ phase: "create-intent" }));
  await journal.close();
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal((await readdir(join(f.root, "retained-journal"))).length, 1);
});

test("public directory modes and wrong input identity cannot admit recovery", async (t) => {
  const f = await fixture(t);
  await chmod(f.directory, 0o755);
  await assert.rejects(openRuntimeJournal(f.directory));
  await chmod(f.directory, 0o700);
  const journal = await openRuntimeJournal(f.directory);
  await journal.publish({ phase: "admitted", inputSha256 });
  await journal.close();
  const read = await readRuntimeJournal(f.directory, "b".repeat(64));
  assert.equal(read.complete, false);
  assert.equal(read.records.length, 0);
});

test("removed, replaced or edited published records refuse later work evidence", async (t) => {
  for (const mutation of ["remove", "replace", "edit"]) {
    const f = await fixture(t),
      journal = await openRuntimeJournal(f.directory);
    t.after(() => journal.close());
    const record = await journal.publish({ phase: "admitted", inputSha256 });
    const raw = await readFile(record.path);
    if (mutation === "remove") await rm(record.path);
    else if (mutation === "replace") {
      await rename(record.path, join(f.root, "retained-record"));
      await writeFile(record.path, raw, { mode: 0o600, flag: "wx" });
    } else
      await writeFile(
        record.path,
        Buffer.from(raw.toString().replace(inputSha256, "b".repeat(64))),
      );
    await assert.rejects(journal.publish({ phase: "create-intent" }));
    assert(!(await readdir(f.directory)).includes("001-create-intent.json"));
  }
});

test("a rejected journal read waits for opened peers to close before cleanup", {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t),
    moduleUrl = new URL("./azure-development-runtime-journal.mjs?peer-settlement", import.meta.url)
      .href,
    hook = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === "node:fs/promises" && context.parentURL === moduleUrl)
          return {
            url: `data:text/javascript,${encodeURIComponent('export * from "node:fs/promises";export const open=(...args)=>globalThis.runtimeJournalOpenForTest(...args);')}`,
            shortCircuit: true,
          };
        return next(specifier, context);
      },
    });
  let gated = false,
    firstName,
    secondName,
    release,
    peerStarted,
    failureClosed,
    pending;
  const blocked = new Promise((resolve) => {
      release = resolve;
    }),
    reading = new Promise((resolve) => {
      peerStarted = resolve;
    }),
    failedReadClosed = new Promise((resolve) => {
      failureClosed = resolve;
    }),
    opened = new Set();
  globalThis.runtimeJournalOpenForTest = async (...args) => {
    const file = await open(...args),
      name = String(args[0]).split("/").at(-1);
    if (!gated || ![firstName, secondName].includes(name)) return file;
    const descriptor = file.fd;
    opened.add(descriptor);
    return {
      stat: file.stat.bind(file),
      async read(...readArgs) {
        if (name === firstName) {
          peerStarted();
          await blocked;
          return file.read(...readArgs);
        }
        await reading;
        throw new Error("Controlled journal read failure");
      },
      async close() {
        await file.close();
        opened.delete(descriptor);
        if (name === secondName) failureClosed();
      },
    };
  };
  let journal;
  try {
    const isolated = await import(moduleUrl);
    journal = await isolated.openRuntimeJournal(f.directory);
    const first = await journal.publish({ phase: "admitted", inputSha256 }),
      second = await journal.publish({ phase: "create-intent" });
    firstName = first.path.split("/").at(-1);
    secondName = second.path.split("/").at(-1);
    gated = true;
    let settled = false;
    pending = journal.conserve();
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve, reject) => {
      const abort = () => reject(t.signal.reason);
      t.signal.addEventListener("abort", abort, { once: true });
      failedReadClosed.then(() => {
        t.signal.removeEventListener("abort", abort);
        resolve();
      });
      if (t.signal.aborted) abort();
    });
    await new Promise(setImmediate);
    assert.equal(settled, false, "A failed read must wait for its still-open peer");
    release();
    await assert.rejects(pending, /Controlled journal read failure/);
    assert.equal(opened.size, 0);
    await assert.rejects(journal.publish({ phase: "created" }));
    assert.equal((await readdir(f.directory)).length, 2);
  } finally {
    release();
    await pending?.catch(() => {});
    await journal?.close();
    hook.deregister();
    delete globalThis.runtimeJournalOpenForTest;
  }
});

function leaseFixture() {
  let wall = Date.now(),
    mono = 100;
  const start = wall,
    controller = new AbortController();
  const lease = createRuntimeLease(new Date(start + 3_600_000).toISOString(), controller.signal, {
    wall: () => wall,
    monotonic: () => mono,
  });
  return {
    lease,
    controller,
    advance: (w, m = w) => {
      wall += w;
      mono += m;
    },
  };
}
test("normal work consumes one window while preserving thirty minutes for owned cleanup", () => {
  const f = leaseFixture();
  assert.equal(f.lease.reserveMs, 1_800_000);
  f.advance(1_799_000);
  assert.equal(f.lease.remaining(60_000), 1000);
  assert.equal(f.lease.remaining(60_000, true), 60_000);
  f.advance(1000);
  assert.throws(() => f.lease.guard());
  assert.doesNotThrow(() => f.lease.guardCleanup());
  f.advance(1_800_000);
  assert.throws(() => f.lease.guardCleanup());
});
test("wall rollback cannot reopen work or extend the original monotonic cleanup horizon", () => {
  const f = leaseFixture();
  f.advance(1000);
  f.lease.guard();
  f.advance(-2000, 1000);
  assert.throws(() => f.lease.guard());
  assert.doesNotThrow(() => f.lease.guardCleanup());
  f.advance(0, 3_598_000);
  assert.throws(() => f.lease.guardCleanup());
});
test("cancellation refuses new work but leaves only the original reserved owned-stop window", () => {
  const f = leaseFixture();
  f.controller.abort();
  assert.throws(() => f.lease.guard());
  assert.doesNotThrow(() => f.lease.guardCleanup());
  assert.throws(() =>
    createRuntimeLease(new Date(Date.now() + 3_600_000).toISOString(), AbortSignal.abort()),
  );
});
test("expired, oversized and reserve-only leases cannot admit a run", () => {
  for (const offset of [-1, 1_800_000, 14_400_001])
    assert.throws(() =>
      createRuntimeLease(new Date(Date.now() + offset).toISOString(), new AbortController().signal),
    );
});

test("all 1024 bounded records retain numeric recovery order across sequence 1000", async (t) => {
  const f = await fixture(t),
    journal = await openRuntimeJournal(f.directory);
  const first = await journal.publish({ phase: "admitted", inputSha256 });
  await journal.close();
  const width = first.path.split("/").at(-1).split("-")[0].length;
  let previous = first.sha256;
  // The actual writer fixes the naming convention. Construct the remaining canonical raw
  // boundary records directly to avoid a quadratic thousand-publication conservation test.
  for (let sequence = 1; sequence < 1024; sequence++) {
    const event = { phase: "observed" },
      raw = Buffer.from(
        `${canonicalJson({ kind: "nutrition-development-runtime-record-v1", sequence, previousSha256: previous, event })}\n`,
      );
    await writeFile(
      join(f.directory, `${String(sequence).padStart(width, "0")}-observed.json`),
      raw,
      { flag: "wx", mode: 0o600 },
    );
    previous = createHash("sha256").update(raw).digest("hex");
  }
  const actual = await readRuntimeJournal(f.directory, inputSha256);
  assert.equal(actual.complete, true);
  assert.equal(actual.records.length, 1024);
  assert.equal(actual.records[1000].sequence, 1000);
  assert.equal(actual.lastSha256, previous);
});
