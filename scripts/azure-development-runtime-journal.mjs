import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { heldOperatorInput } from "./postgres-operator-input.mjs";
import { trustedPath } from "./postgres-operator-process.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const zero = "0".repeat(64),
  MAX_RECORD = 1_048_576,
  MAX_RECORDS = 1024,
  MAX_TOTAL = 67_108_864;
const directoryIdentity = (row) => [row.dev, row.ino, row.mode, row.uid, row.gid].join(":");
const fileIdentity = (row) =>
  [
    row.dev,
    row.ino,
    row.mode,
    row.uid,
    row.gid,
    row.nlink,
    row.size,
    row.mtimeNs,
    row.ctimeNs,
  ].join(":");
const bytesOf = (value) => Buffer.from(`${canonicalJson(value)}\n`);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function decode(raw) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  assert(bytesOf(value).equals(raw), "Runtime records must use exact canonical JSON");
  return value;
}

/** Same finite execution window for work and reserved owned shutdown; no renewal or timer scheduling. */
export function createRuntimeLease(notAfterUtc, signal, clocks = {}) {
  const wall = clocks.wall ?? Date.now,
    mono = clocks.monotonic ?? (() => performance.now());
  assert(signal instanceof AbortSignal);
  signal.throwIfAborted();
  const start = wall(),
    initialMono = mono(),
    stop = Date.parse(notAfterUtc),
    reserve = 1_800_000;
  assert(
    new Date(stop).toISOString() === notAfterUtc &&
      stop - start >= reserve + 60_000 &&
      stop - start <= 4 * 3_600_000,
  );
  const duration = stop - start;
  let latest = start;
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(duration - reserve)]);
  const cleanupSignal = AbortSignal.timeout(duration);
  function remaining(maximum, cleanup = false) {
    assert(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 1_800_000);
    const now = wall(),
      elapsed = mono() - initialMono;
    assert(elapsed >= 0 && elapsed < duration && now < stop);
    if (!cleanup) {
      workSignal.throwIfAborted();
      assert(now >= latest);
      latest = now;
    } else cleanupSignal.throwIfAborted();
    const budget = Math.floor(
      Math.min(
        maximum,
        stop - now - (cleanup ? 0 : reserve),
        duration - elapsed - (cleanup ? 0 : reserve),
      ),
    );
    assert(budget > 0);
    return budget;
  }
  return Object.freeze({
    notAfterUtc,
    reserveMs: reserve,
    workSignal,
    cleanupSignal,
    remaining,
    guard: () => remaining(1),
    guardCleanup: () => remaining(1, true),
  });
}

/** Create-only, retained journal in a prepared empty private directory. A failed publication poisons
 * further records, but never deletes prior evidence or grants authority to repeat a mutation. */
export async function openRuntimeJournal(directory) {
  await trustedPath(directory, { directory: true, privateLeaf: true });
  assert((await readdir(directory)).length === 0, "Runtime journal already contains an outcome");
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const expected = directoryIdentity(await handle.stat({ bigint: true }));
  let sequence = 0,
    previous = zero,
    total = 0,
    failed = false,
    closed = false;
  const published = [];
  const conserve = async (pending = []) => {
    assert(!failed && !closed);
    await trustedPath(directory, { directory: true, privateLeaf: true });
    assert(
      directoryIdentity(await lstat(directory, { bigint: true })) === expected &&
        directoryIdentity(await handle.stat({ bigint: true })) === expected,
    );
    const names = [...published.map((record) => record.name), ...pending].sort();
    assert.deepEqual((await readdir(directory)).sort(), names);
    const verifyRecord = async (record) => {
      const path = join(directory, record.name);
      assert.equal(fileIdentity(await lstat(path, { bigint: true })), record.identity);
      // The held, reverified parent pins each relative name. Recheck the original inode,
      // metadata and full content without walking that same parent chain for every record.
      const file = await open(
        `/proc/self/fd/${handle.fd}/${record.name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let current;
      try {
        const before = await file.stat({ bigint: true });
        assert.equal(fileIdentity(before), record.identity);
        current = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < current.length) {
          const { bytesRead } = await file.read(current, offset, current.length - offset, offset);
          assert(bytesRead > 0);
          offset += bytesRead;
        }
        assert.equal(sha(current), record.sha256);
        assert.equal(fileIdentity(await file.stat({ bigint: true })), record.identity);
        assert.equal(fileIdentity(await lstat(path, { bigint: true })), record.identity);
      } finally {
        current?.fill(0);
        await file.close();
      }
    };
    // Bound descriptors and buffers while preserving every record check. Settle
    // all opened peers before rejecting, so cleanup never races an active read.
    for (let offset = 0; offset < published.length; offset += 4) {
      const outcomes = await Promise.allSettled(
        published.slice(offset, offset + 4).map(verifyRecord),
      );
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure) throw failure.reason;
    }
    assert.deepEqual((await readdir(directory)).sort(), names);
    assert.equal(directoryIdentity(await lstat(directory, { bigint: true })), expected);
  };
  try {
    await conserve();
  } catch (error) {
    await handle.close();
    throw error;
  }
  return Object.freeze({
    directory,
    async conserve() {
      try {
        await conserve();
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async publish(event) {
      assert(!failed && !closed && sequence < MAX_RECORDS);
      assert(
        event &&
          typeof event === "object" &&
          !Array.isArray(event) &&
          /^[a-z][a-z0-9-]{0,47}$/u.test(event.phase),
      );
      if (sequence === 0) assert(event.phase === "admitted" && digest(event.inputSha256));
      const value = {
        kind: "nutrition-development-runtime-record-v1",
        sequence,
        previousSha256: previous,
        event,
      };
      const raw = bytesOf(value);
      assert(raw.length > 0 && raw.length <= MAX_RECORD && total + raw.length <= MAX_TOTAL);
      const name = `${String(sequence).padStart(String(MAX_RECORDS - 1).length, "0")}-${event.phase}.json`;
      let file;
      try {
        await conserve();
        file = await open(
          `/proc/self/fd/${handle.fd}/${name}`,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await file.writeFile(raw);
        await file.sync();
        await handle.sync();
        await conserve([name]);
        const before = await file.stat({ bigint: true });
        assert(
          before.isFile() &&
            before.uid === BigInt(process.getuid()) &&
            before.nlink === 1n &&
            (before.mode & 0o7777n) === 0o600n &&
            before.size === BigInt(raw.length),
        );
        const observed = Buffer.alloc(raw.length);
        try {
          let offset = 0;
          while (offset < observed.length) {
            const result = await file.read(observed, offset, observed.length - offset, offset);
            assert(result.bytesRead > 0);
            offset += result.bytesRead;
          }
          assert(observed.equals(raw));
          assert(
            fileIdentity(before) === fileIdentity(await file.stat({ bigint: true })) &&
              fileIdentity(before) ===
                fileIdentity(await lstat(join(directory, name), { bigint: true })),
          );
        } finally {
          observed.fill(0);
        }
        await file.close();
        file = undefined;
        published.push({ name, identity: fileIdentity(before), sha256: sha(raw) });
        await conserve();
        previous = sha(raw);
        total += raw.length;
        sequence += 1;
        return Object.freeze({
          path: join(directory, name),
          sha256: previous,
          sequence: sequence - 1,
        });
      } catch (error) {
        failed = true;
        if (file) {
          try {
            await file.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              "Runtime journal publication and closure failed",
            );
          }
        }
        throw error;
      } finally {
        raw.fill(0);
      }
    },
    async close() {
      if (!closed) {
        closed = true;
        await handle.close();
      }
    },
  });
}

/** Read only the intact ordered prefix. Incomplete publication remains visible and cannot become a
 * successful installation. A recovery-stop caller may use only IDs in the conserved prefix. */
export async function readRuntimeJournal(directory, inputSha256) {
  assert(digest(inputSha256));
  await trustedPath(directory, { directory: true, privateLeaf: true });
  const directoryBefore = directoryIdentity(await lstat(directory, { bigint: true }));
  const names = (await readdir(directory)).sort();
  assert(names.length > 0 && names.length <= MAX_RECORDS);
  const records = [];
  let previous = zero,
    total = 0;
  for (const [sequence, name] of names.entries()) {
    let held;
    try {
      assert(
        new RegExp(
          `^${String(sequence).padStart(String(MAX_RECORDS - 1).length, "0")}-[a-z][a-z0-9-]{0,47}\\.json$`,
          "u",
        ).test(name),
      );
      const path = join(directory, name);
      await trustedPath(path);
      const info = await lstat(path);
      assert(info.size > 0 && info.size <= MAX_RECORD && total + info.size <= MAX_TOTAL);
      const peek = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let expected;
      const raw = Buffer.alloc(MAX_RECORD + 1);
      try {
        const before = await peek.stat({ bigint: true });
        assert(
          before.isFile() &&
            before.nlink === 1n &&
            before.uid === BigInt(process.getuid()) &&
            (before.mode & 0o7777n) === 0o600n &&
            before.size > 0n &&
            before.size <= BigInt(MAX_RECORD),
        );
        let count = 0;
        while (count < raw.length) {
          const result = await peek.read(raw, count, raw.length - count, count);
          if (result.bytesRead === 0) break;
          count += result.bytesRead;
        }
        assert(
          count === Number(before.size) &&
            fileIdentity(before) === fileIdentity(await peek.stat({ bigint: true })) &&
            fileIdentity(before) === fileIdentity(await lstat(path, { bigint: true })),
        );
        expected = sha(raw.subarray(0, count));
      } finally {
        raw.fill(0);
        await peek.close();
      }
      held = await heldOperatorInput(path, expected, { privateFile: true, maximum: MAX_RECORD });
      const record = decode(held.raw);
      assert(
        record.kind === "nutrition-development-runtime-record-v1" &&
          record.sequence === sequence &&
          record.previousSha256 === previous &&
          name ===
            `${String(sequence).padStart(String(MAX_RECORDS - 1).length, "0")}-${record.event.phase}.json`,
      );
      if (sequence === 0)
        assert(record.event.phase === "admitted" && record.event.inputSha256 === inputSha256);
      const current = await held.conserve();
      current.fill(0);
      records.push(record);
      previous = expected;
      total += held.raw.length;
    } catch {
      return Object.freeze({
        records: Object.freeze(records),
        complete: false,
        uncertainAt: sequence,
        lastSha256: previous,
      });
    } finally {
      if (held) {
        held.raw.fill(0);
        await held.fd.close();
      }
    }
    await trustedPath(directory, { directory: true, privateLeaf: true });
    assert(directoryIdentity(await lstat(directory, { bigint: true })) === directoryBefore);
  }
  assert(
    JSON.stringify(await readdir(directory).then((value) => value.sort())) ===
      JSON.stringify(names),
  );
  return Object.freeze({
    records: Object.freeze(records),
    complete: true,
    uncertainAt: null,
    lastSha256: previous,
  });
}
