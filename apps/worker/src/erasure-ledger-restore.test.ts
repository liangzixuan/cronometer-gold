import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AzureBlobRawArtifactStore,
  type ErasureReplayLedgerEntry,
} from "@nutrition-tracker/artifact-store";
import type { DatabaseRestoreAttestationRecord } from "@nutrition-tracker/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const operations = vi.hoisted(() => ({
  createDatabase: vi.fn(),
  migration: vi.fn(),
  attest: vi.fn(),
  ready: vi.fn(),
  apply: vi.fn(),
  reconcile: vi.fn(),
  prepare: vi.fn(),
  readback: vi.fn(),
}));
vi.mock("@nutrition-tracker/db", async (original) => ({
  ...(await original<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: operations.createDatabase,
  assertDatabaseMigrationLedgerReady: operations.migration,
  completeDatabaseRestoreReplayAttestation: operations.attest,
  assertDatabaseReady: operations.ready,
  replayExternalErasureLedgerEntry: operations.apply,
  reconcileErasedAccountRows: operations.reconcile,
  prepareDatabaseRestoreReplaySession: operations.prepare,
}));

import {
  replayAndAttestErasureLedgerRestore,
  replayErasureLedgerSubjects,
  restoreVersionResolver,
  runErasureLedgerRestoreFromEnvironment,
} from "./erasure-ledger-restore.js";

const first = "10000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";

async function* subjects() {
  yield first;
  yield second;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function observe<T>(work: Promise<T>) {
  let settled = false;
  const outcome = work.then(
    (value) => {
      settled = true;
      return { status: "fulfilled" as const, value };
    },
    (reason: unknown) => {
      settled = true;
      return { status: "rejected" as const, reason };
    },
  );
  return { outcome, isSettled: () => settled };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function attestationReader() {
  const query = {
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    execute: vi.fn(async () => {
      if (operations.readback.getMockImplementation()) return operations.readback();
      const committed = await operations.attest.mock.results.at(-1)?.value;
      return [{ ...committed, completedAt: new Date(committed.completedAt) }];
    }),
  };
  return vi.fn((schema: string) => {
    expect(schema).toBe("public");
    return query;
  });
}
const reconciled = { reconciled: true, remainingRows: { app_user: "0" } };
const replayEntry: ErasureReplayLedgerEntry = {
  formatVersion: "nutrition-erasure-replay-ledger-v1",
  jobId: "30000000-0000-4000-8000-000000000003",
  ledgerEntryId: "30000000-0000-4000-8000-000000000003",
  recordedAt: "2026-08-16T12:00:00.000Z",
  restoreLocator: `v1:key-v1:${"a".repeat(64)}`,
  subjectUserId: second,
};

describe("offline erasure replay", () => {
  it("permits an explicit strict S3-compatible inventory in production without OCI configuration", async () => {
    await expect(
      restoreVersionResolver(
        {
          ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "s3_compatible",
          NODE_ENV: "production",
        },
        {
          bucket: "nutrition-erasure-ledger",
          endpoint: "https://objects.example.test",
          region: "us-east-1",
          requestTimeoutMs: 30_000,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when production version inventory is absent or unknown", async () => {
    const input = {
      bucket: "nutrition-erasure-ledger",
      endpoint: "https://objects.example.test",
      region: "us-east-1",
      requestTimeoutMs: 30_000,
    };
    await expect(restoreVersionResolver({ NODE_ENV: "production" }, input)).rejects.toThrow(
      "Missing restore configuration: ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER",
    );
    await expect(
      restoreVersionResolver(
        {
          ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "latest",
          NODE_ENV: "production",
        },
        input,
      ),
    ).rejects.toThrow("Invalid restore object version inventory provider");
  });

  it("probes every restored subject with bounded concurrency and applies only authenticated tombstones", async () => {
    let active = 0;
    let maximumActive = 0;
    const entry: ErasureReplayLedgerEntry = {
      formatVersion: "nutrition-erasure-replay-ledger-v1",
      jobId: "30000000-0000-4000-8000-000000000003",
      ledgerEntryId: "30000000-0000-4000-8000-000000000003",
      recordedAt: "2026-08-16T12:00:00.000Z",
      restoreLocator: `v1:key-v1:${"a".repeat(64)}`,
      subjectUserId: second,
    };
    const apply = vi.fn(async (_entry: ErasureReplayLedgerEntry) => ({
      reconciled: true,
      remainingRows: { app_user: "0" },
    }));
    const ledger = {
      replaySubject: vi.fn(async (input: { subjectUserId: string; apply: typeof apply }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return input.subjectUserId === second ? input.apply(entry) : null;
      }),
    };
    await expect(
      replayErasureLedgerSubjects({
        apply,
        ledger,
        maximumConcurrency: 2,
        subjects: subjects(),
      }),
    ).resolves.toEqual({
      reconciled: true,
      reconciliationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      replayedTombstones: 1,
      scannedSubjects: 2,
    });
    expect(ledger.replaySubject).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith(entry);
    expect(maximumActive).toBe(2);
  });

  it("fails the readiness command when a replay does not reconcile to zero", async () => {
    const entry: ErasureReplayLedgerEntry = {
      formatVersion: "nutrition-erasure-replay-ledger-v1",
      jobId: "30000000-0000-4000-8000-000000000003",
      ledgerEntryId: "30000000-0000-4000-8000-000000000003",
      recordedAt: "2026-08-16T12:00:00.000Z",
      restoreLocator: `v1:key-v1:${"a".repeat(64)}`,
      subjectUserId: first,
    };
    await expect(
      replayErasureLedgerSubjects({
        apply: async () => ({ reconciled: false, remainingRows: { app_user: "1" } }),
        ledger: {
          replaySubject: async (input) => {
            const result = await input.apply(entry);
            if (!result.reconciled) throw new Error("not-reconciled");
            return result;
          },
        },
        maximumConcurrency: 1,
        subjects: (async function* () {
          yield first;
        })(),
      }),
    ).rejects.toThrow("not-reconciled");
  });
});

describe("replay batch ownership", () => {
  it.each([undefined, null, 0, false, new Error("first replay failure")])(
    "settles delayed reads and prevents late apply after failure %s",
    async (reason) => {
      const firstRead = deferred<null>();
      const secondRead = deferred();
      const started = deferred();
      const apply = vi.fn(async () => reconciled);
      let siblingSignal: AbortSignal | undefined;
      let inventoryClosed = false;
      let laterSubjectRead = false;
      const ledger = {
        replaySubject: vi.fn(
          async (
            input: Parameters<
              Parameters<typeof replayErasureLedgerSubjects>[0]["ledger"]["replaySubject"]
            >[0],
          ) => {
            if (input.subjectUserId === first) return firstRead.promise;
            siblingSignal = input.signal;
            started.resolve();
            await secondRead.promise;
            return input.apply(replayEntry);
          },
        ),
      };
      const work = observe(
        replayErasureLedgerSubjects({
          apply,
          ledger,
          maximumConcurrency: 2,
          subjects: (async function* () {
            try {
              yield first;
              yield second;
              laterSubjectRead = true;
              yield "30000000-0000-4000-8000-000000000003";
            } finally {
              inventoryClosed = true;
            }
          })(),
        }),
      );
      await started.promise;
      firstRead.reject(reason);
      await nextTurn();
      expect(siblingSignal?.aborted).toBe(true);
      expect(work.isSettled()).toBe(false);
      expect(inventoryClosed).toBe(false);
      secondRead.resolve();
      expect(await work.outcome).toEqual({ status: "rejected", reason });
      expect(apply).not.toHaveBeenCalled();
      expect(inventoryClosed).toBe(true);
      expect(laterSubjectRead).toBe(false);
      expect(ledger.replaySubject).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "waits for already-running apply to %s",
    async (outcome) => {
      const firstRead = deferred<null>();
      const applyGate = deferred<typeof reconciled>();
      const applying = deferred();
      const failure = new Error("first failure");
      const apply = vi.fn(async () => {
        applying.resolve();
        return applyGate.promise;
      });
      const work = observe(
        replayErasureLedgerSubjects({
          apply,
          maximumConcurrency: 2,
          subjects: subjects(),
          ledger: {
            replaySubject: async (input) =>
              input.subjectUserId === first ? firstRead.promise : input.apply(replayEntry),
          },
        }),
      );
      await applying.promise;
      firstRead.reject(failure);
      await nextTurn();
      expect(work.isSettled()).toBe(false);
      if (outcome === "resolve") applyGate.resolve(reconciled);
      else applyGate.reject(new Error("later apply failure"));
      expect(await work.outcome).toEqual({ status: "rejected", reason: failure });
      expect(apply).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["abort", "failure"] as const)(
    "keeps the first observed %s while awaiting siblings",
    async (firstEvent) => {
      const controller = new AbortController();
      const firstRead = deferred<null>();
      const secondRead = deferred<null>();
      const started = deferred();
      const failure = new Error("task failure");
      const cancellation = new Error("external cancellation");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      let siblingSignal: AbortSignal | undefined;
      const work = observe(
        replayErasureLedgerSubjects({
          signal: controller.signal,
          apply: async () => reconciled,
          maximumConcurrency: 2,
          subjects: subjects(),
          ledger: {
            replaySubject: async (input) => {
              if (input.subjectUserId === first) return firstRead.promise;
              siblingSignal = input.signal;
              started.resolve();
              return secondRead.promise;
            },
          },
        }),
      );
      await started.promise;
      if (firstEvent === "abort") controller.abort(cancellation);
      firstRead.reject(failure);
      await nextTurn();
      if (firstEvent === "failure") controller.abort(cancellation);
      expect(siblingSignal?.aborted).toBe(true);
      expect(work.isSettled()).toBe(false);
      secondRead.resolve(null);
      expect(await work.outcome).toEqual({
        status: "rejected",
        reason: firstEvent === "abort" ? cancellation : failure,
      });
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      remove.mockRestore();
    },
  );

  it("retains the admitted signal when the caller replaces its property", async () => {
    const original = new AbortController();
    const replacement = new AbortController();
    const reason = new Error("original cancellation");
    const started = deferred();
    const read = deferred<null>();
    const remove = vi.spyOn(original.signal, "removeEventListener");
    const replacementRemove = vi.spyOn(replacement.signal, "removeEventListener");
    const input = {
      signal: original.signal,
      apply: async () => reconciled,
      maximumConcurrency: 1,
      subjects: subjects(),
      ledger: {
        replaySubject: async () => {
          started.resolve();
          return read.promise;
        },
      },
    };
    const work = observe(replayErasureLedgerSubjects(input));
    await started.promise;
    input.signal = replacement.signal;
    original.abort(reason);
    await nextTurn();
    expect(work.isSettled()).toBe(false);
    read.resolve(null);
    expect(await work.outcome).toEqual({ status: "rejected", reason });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(replacementRemove).not.toHaveBeenCalled();
    remove.mockRestore();
    replacementRemove.mockRestore();
  });

  it("rejects an already aborted empty stream without advancing its iterator", async () => {
    const controller = new AbortController();
    const reason = new Error("before iterator");
    controller.abort(reason);
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const ledger = { replaySubject: vi.fn(async () => null) };
    await expect(
      replayErasureLedgerSubjects({
        signal: controller.signal,
        apply: async () => reconciled,
        ledger,
        maximumConcurrency: 1,
        subjects: { [Symbol.asyncIterator]: () => ({ next }) },
      }),
    ).rejects.toBe(reason);
    expect(next).not.toHaveBeenCalled();
    expect(ledger.replaySubject).not.toHaveBeenCalled();
  });

  it.each(["empty", "final-next", "final-replay"] as const)(
    "rejects cancellation at %s",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error("last cancellation");
      const work = replayErasureLedgerSubjects({
        signal: controller.signal,
        apply: async () => reconciled,
        maximumConcurrency: 1,
        subjects: (async function* () {
          if (stage !== "empty") yield first;
          if (stage !== "final-replay") controller.abort(reason);
        })(),
        ledger: {
          replaySubject: async () => {
            if (stage === "final-replay") controller.abort(reason);
            return null;
          },
        },
      });
      await expect(work).rejects.toBe(reason);
    },
  );

  it("retains an iterator error without admitting its incomplete batch", async () => {
    const reason = new Error("inventory failed");
    let closed = false;
    const ledger = { replaySubject: vi.fn(async () => null) };
    await expect(
      replayErasureLedgerSubjects({
        apply: async () => reconciled,
        ledger,
        maximumConcurrency: 2,
        subjects: (async function* () {
          try {
            yield first;
            throw reason;
          } finally {
            closed = true;
          }
        })(),
      }),
    ).rejects.toBe(reason);
    expect(closed).toBe(true);
    expect(ledger.replaySubject).not.toHaveBeenCalled();
  });

  it.each([1, 16])(
    "preserves ordered digest and concurrency %s across successful batches",
    async (maximumConcurrency) => {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const ids = Array.from(
        { length: maximumConcurrency + 1 },
        (_, i) => `${String(i + 1).padStart(8, "0")}-0000-4000-8000-000000000001`,
      );
      const gates = ids.map(() => deferred<null>());
      const batchStarted = deferred();
      const order: string[] = [];
      const signals: AbortSignal[] = [];
      let active = 0;
      let maximumActive = 0;
      const work = replayErasureLedgerSubjects({
        signal: controller.signal,
        apply: async () => reconciled,
        maximumConcurrency,
        subjects: (async function* () {
          yield* ids;
        })(),
        ledger: {
          replaySubject: async (input) => {
            const index = order.length;
            order.push(input.subjectUserId);
            if (input.signal) signals.push(input.signal);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (active === maximumConcurrency) batchStarted.resolve();
            const gate = gates[index];
            if (!gate) throw new Error("Missing test gate");
            try {
              return await gate.promise;
            } finally {
              active -= 1;
            }
          },
        },
      });
      await batchStarted.promise;
      expect(order).toEqual(ids.slice(0, maximumConcurrency));
      for (const gate of [...gates].reverse()) gate.resolve(null);
      const result = await work;
      const expectedDigest = createHash("sha256").update(
        "nutrition-tracker-erasure-restore-reconciliation-v1\n",
      );
      for (const id of ids) expectedDigest.update(`${id}\t0\n`);
      expect(result).toEqual({
        reconciled: true,
        reconciliationDigest: expectedDigest.digest("hex"),
        replayedTombstones: 0,
        scannedSubjects: ids.length,
      });
      expect(order).toEqual(ids);
      expect(maximumActive).toBe(maximumConcurrency);
      expect(active).toBe(0);
      expect(add).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledTimes(2);
      for (const call of add.mock.calls) expect(remove).toHaveBeenCalledWith("abort", call[1]);
      controller.abort(new Error("after completed invocation"));
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      add.mockRestore();
      remove.mockRestore();
    },
  );
});

describe("persisted erasure replay attestation", () => {
  const epoch = "synthetic-private-restore-epoch-".repeat(3);
  const completedAt = "2026-10-12T20:00:00.000Z";
  const epochHash = createHash("sha256").update(epoch).digest("hex");
  const events: string[] = [];
  let persisted: DatabaseRestoreAttestationRecord;

  function fixture(signal?: AbortSignal) {
    const query = {
      select: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      execute: vi.fn(async () => [{ id: first }]),
    };
    const database = {
      selectFrom: vi.fn(() => query),
      withSchema: attestationReader(),
    } as unknown as Parameters<typeof replayAndAttestErasureLedgerRestore>[0]["database"];
    const ledger = {
      replaySubject: vi.fn(async () => {
        events.push("replay");
        return null;
      }),
    };
    return {
      database,
      ledger,
      maximumConcurrency: 1,
      restoreEpoch: epoch,
      clock: () => new Date(completedAt),
      ...(signal ? { signal } : {}),
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    events.length = 0;
    operations.migration.mockImplementation(async () => {
      events.push("migration");
    });
    operations.attest.mockImplementation(async (_database, input) => {
      events.push("attest");
      persisted = {
        completedAt,
        databaseName: "nutrition_isolated_restore",
        databaseOid: "4567",
        reconciliationDigest: input.reconciliationDigest,
        replayedSubjectCount: String(input.replayedSubjectCount),
        restoreEpochHash: epochHash,
      };
      return persisted;
    });
    operations.ready.mockImplementation(async () => {
      events.push("ready");
    });
  });

  it("returns the committed identity only after readiness, without raw epoch or subjects", async () => {
    let release!: () => void;
    let reached!: () => void;
    const readyReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const readyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    operations.ready.mockImplementation(async () => {
      events.push("ready");
      reached();
      await readyGate;
    });
    let returned = false;
    const work = replayAndAttestErasureLedgerRestore(fixture()).then((result) => {
      returned = true;
      return result;
    });
    await readyReached;
    expect(returned).toBe(false);
    release();
    const result = await work;
    expect(result).toEqual({
      attestation: persisted,
      reconciled: true,
      reconciliationDigest: persisted.reconciliationDigest,
      replayedTombstones: 0,
      scannedSubjects: 1,
    });
    expect(result.attestation).not.toBe(persisted);
    expect(Object.isFrozen(result.attestation)).toBe(true);
    expect(events).toEqual(["migration", "replay", "attest", "ready"]);
    expect(operations.ready).toHaveBeenCalledWith(expect.anything(), {
      requireRestoreAttestation: true,
      restoreEpoch: epoch,
    });
    const output = JSON.stringify({
      event: "erasure_restore.reconciled",
      level: "info",
      ...result,
    });
    expect(output).not.toContain(epoch);
    expect(output).not.toContain(first);
    expect(output).not.toContain("subjectUserId");
    expect(output).not.toContain("encryptionKey");
    expect(result.attestation.restoreEpochHash).toBe(epochHash);
  });

  it.each([
    ["restoreEpochHash", "0".repeat(64)],
    ["reconciliationDigest", "0".repeat(64)],
    ["replayedSubjectCount", "01"],
    ["replayedSubjectCount", "1.0"],
    ["replayedSubjectCount", "1"],
  ])("rejects persisted %s=%s before readiness", async (field, value) => {
    const original = operations.attest.getMockImplementation();
    operations.attest.mockImplementation(async (...args) => ({
      ...(await original?.(...args)),
      [field]: value,
    }));
    await expect(replayAndAttestErasureLedgerRestore(fixture())).rejects.toThrow(
      /Restore attestation|Invalid restore observation/u,
    );
    expect(operations.ready).not.toHaveBeenCalled();
  });

  it.each(["migration", "attest", "ready"] as const)(
    "does not report success after %s failure",
    async (stage) => {
      const failure = new Error(`synthetic ${stage} failure`);
      operations[stage].mockRejectedValue(failure);
      await expect(replayAndAttestErasureLedgerRestore(fixture())).rejects.toBe(failure);
      if (stage !== "ready") expect(operations.ready).not.toHaveBeenCalled();
    },
  );

  it("captures the qualified target before role preparation and limits readback", async () => {
    const input = fixture();
    const expectedTarget = {
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      expectedOwner: "nutrition_owner",
    };
    operations.prepare.mockImplementation(async (_db, target) => {
      expect(target).not.toBe(expectedTarget);
      expect(Object.isFrozen(target)).toBe(true);
      expectedTarget.databaseOid = "9999";
    });
    const result = await replayAndAttestErasureLedgerRestore({ ...input, expectedTarget });
    expect(result.attestation.databaseOid).toBe("4567");
    expect(operations.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      operations.migration.mock.invocationCallOrder[0] ?? 0,
    );
    const reader = vi.mocked(input.database.withSchema).mock.results[0]?.value;
    expect(reader.limit).toHaveBeenCalledWith(2);
    expect(reader.where).toHaveBeenCalledWith("singleton", "=", true);
  });

  it.each(["Nutrition", "nutrition$restore"])(
    "preserves unqualified observed database name %s",
    async (databaseName) => {
      const original = operations.attest.getMockImplementation();
      operations.attest.mockImplementation(async (...args) => ({
        ...(await original?.(...args)),
        databaseName,
      }));
      const result = await replayAndAttestErasureLedgerRestore(fixture());
      expect(result.attestation.databaseName).toBe(databaseName);
      expect(operations.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      expectedOwner: "nutrition_owner",
      extra: true,
    },
    {
      databaseName: "nutrition_isolated_restore",
      databaseOid: "04567",
      expectedOwner: "nutrition_owner",
    },
    { databaseName: "nutrition_isolated_restore", databaseOid: "4567", expectedOwner: "bad owner" },
    Object.defineProperty(
      { databaseName: "nutrition_isolated_restore", databaseOid: "4567" },
      "expectedOwner",
      {
        get() {
          throw new Error("getter must not run");
        },
      },
    ),
  ])("refuses malformed qualified target before database work", async (expectedTarget) => {
    await expect(
      replayAndAttestErasureLedgerRestore({
        ...fixture(),
        expectedTarget: expectedTarget as never,
      }),
    ).rejects.toThrow();
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(operations.migration).not.toHaveBeenCalled();
  });

  it("refuses qualified concurrency and role failures before traversal", async () => {
    const expectedTarget = {
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      expectedOwner: "nutrition_owner",
    };
    const input = fixture();
    await expect(
      replayAndAttestErasureLedgerRestore({ ...input, expectedTarget, maximumConcurrency: 2 }),
    ).rejects.toThrow();
    expect(operations.prepare).not.toHaveBeenCalled();
    const failure = new Error("role refused");
    operations.prepare.mockRejectedValue(failure);
    await expect(replayAndAttestErasureLedgerRestore({ ...input, expectedTarget })).rejects.toBe(
      failure,
    );
    expect(input.ledger.replaySubject).not.toHaveBeenCalled();
  });

  it.each([
    ["databaseName", "another_database"],
    ["databaseOid", "9999"],
    ["restoreEpochHash", "0".repeat(64)],
    ["reconciliationDigest", "0".repeat(64)],
    ["replayedSubjectCount", "1"],
    ["completedAt", new Date("2026-10-12T20:00:01.000Z")],
    ["extra", "private value"],
    ["replayedSubjectCount", "01"],
    ["completedAt", completedAt],
  ])("refuses full persisted drift or malformed %s after readiness", async (field, value) => {
    operations.readback.mockImplementation(async () => [
      { ...persisted, completedAt: new Date(persisted.completedAt), [field]: value },
    ]);
    await expect(replayAndAttestErasureLedgerRestore(fixture())).rejects.toThrow();
    expect(operations.ready).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2])("refuses %i persisted singleton rows", async (count) => {
    operations.readback.mockImplementation(async () =>
      Array.from({ length: count }, () => ({
        ...persisted,
        completedAt: new Date(persisted.completedAt),
      })),
    );
    await expect(replayAndAttestErasureLedgerRestore(fixture())).rejects.toThrow();
  });

  it("does not let readiness mutation change the copied committed attestation", async () => {
    operations.ready.mockImplementation(async () => {
      Object.assign(persisted, { reconciliationDigest: "0".repeat(64) });
    });
    await expect(replayAndAttestErasureLedgerRestore(fixture())).rejects.toThrow();
  });

  it("awaits readback settlement and checks cancellation before returning", async () => {
    const gate = deferred<unknown[]>(),
      entered = deferred();
    const controller = new AbortController();
    operations.readback.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    const work = observe(replayAndAttestErasureLedgerRestore(fixture(controller.signal)));
    await entered.promise;
    controller.abort(new Error("readback cancellation"));
    expect(work.isSettled()).toBe(false);
    gate.resolve([{ ...persisted, completedAt: new Date(persisted.completedAt) }]);
    expect(await work.outcome).toMatchObject({
      status: "rejected",
      reason: controller.signal.reason,
    });
  });

  it("settles replay siblings before caller cleanup and never attests a failed batch", async () => {
    const firstRead = deferred<null>();
    const secondRead = deferred<null>();
    const started = deferred();
    const reason = new Error("batch failure");
    const input = fixture();
    const query = {
      select: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      execute: vi.fn(async () => [{ id: first }, { id: second }]),
    };
    input.database.selectFrom = vi.fn(() => query) as unknown as typeof input.database.selectFrom;
    const ledger = {
      replaySubject: vi.fn(async (item: { subjectUserId: string }) => {
        if (item.subjectUserId === first) return firstRead.promise;
        started.resolve();
        return secondRead.promise;
      }),
    };
    const cleanup = vi.fn();
    const work = observe(
      replayAndAttestErasureLedgerRestore({ ...input, ledger, maximumConcurrency: 2 }).finally(
        cleanup,
      ),
    );
    await started.promise;
    firstRead.reject(reason);
    await nextTurn();
    expect(work.isSettled()).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(operations.attest).not.toHaveBeenCalled();
    secondRead.resolve(null);
    expect(await work.outcome).toEqual({ status: "rejected", reason });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(operations.attest).not.toHaveBeenCalled();
    expect(operations.ready).not.toHaveBeenCalled();
  });

  it("rejects an already aborted operation before database work", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation");
    controller.abort(reason);
    await expect(replayAndAttestErasureLedgerRestore(fixture(controller.signal))).rejects.toBe(
      reason,
    );
    expect(operations.migration).not.toHaveBeenCalled();
    expect(operations.attest).not.toHaveBeenCalled();
  });

  it.each(["attest", "ready"] as const)(
    "does not report success after cancellation during %s",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error("synthetic cancellation");
      const original = operations[stage].getMockImplementation();
      operations[stage].mockImplementation(async (...args) => {
        const value = await original?.(...args);
        controller.abort(reason);
        return value;
      });
      await expect(replayAndAttestErasureLedgerRestore(fixture(controller.signal))).rejects.toBe(
        reason,
      );
      expect(operations.attest).toHaveBeenCalledTimes(1);
      if (stage === "attest") expect(operations.ready).not.toHaveBeenCalled();
    },
  );
});

describe("bounded restore subject inventory", () => {
  type ReplayInput = Parameters<
    Parameters<typeof replayErasureLedgerSubjects>[0]["ledger"]["replaySubject"]
  >[0];
  const epoch = "private-subject-budget-test-epoch-".repeat(2);
  const id = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  async function* inventory(count: number) {
    for (let index = 1; index <= count; index++) yield id(index);
  }
  function fixture(count: number, signal?: AbortSignal) {
    let cursor = 0;
    let limit = 0;
    const requests: { cursor: number; limit: number }[] = [];
    const query = {
      select: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn((value: number) => {
        limit = value;
        return query;
      }),
      where: vi.fn((_column: string, _operator: string, value: string) => {
        cursor = Number(value.slice(-12));
        return query;
      }),
      execute: vi.fn(async () => {
        requests.push({ cursor, limit });
        return Array.from(
          { length: Math.min(limit, Math.max(0, count - cursor)) },
          (_, offset) => ({
            id: id(cursor + offset + 1),
          }),
        );
      }),
    };
    const database = {
      selectFrom: vi.fn(() => query),
      withSchema: attestationReader(),
    } as unknown as Parameters<typeof replayAndAttestErasureLedgerRestore>[0]["database"];
    const ledger = {
      replaySubject: vi.fn(
        async (_input: ReplayInput): Promise<Awaited<ReturnType<ReplayInput["apply"]>> | null> =>
          null,
      ),
    };
    const input = {
      database,
      ledger,
      maximumConcurrency: 16,
      restoreEpoch: epoch,
      ...(signal ? { signal } : {}),
    };
    return { input, query, requests, ledger };
  }
  beforeEach(() => {
    vi.resetAllMocks();
    operations.migration.mockResolvedValue(undefined);
    operations.ready.mockResolvedValue(undefined);
    operations.apply.mockResolvedValue(reconciled);
    operations.reconcile.mockResolvedValue(reconciled);
    operations.attest.mockImplementation(async (_database, input) => ({
      completedAt: input.completedAt,
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      reconciliationDigest: input.reconciliationDigest,
      replayedSubjectCount: String(input.replayedSubjectCount),
      restoreEpochHash: createHash("sha256").update(input.restoreEpoch).digest("hex"),
    }));
  });

  it.each([0, 499, 500, 501, 9999, 10_000])(
    "fully enumerates %i subjects with bounded proof queries",
    async (count) => {
      const { input, query, requests, ledger } = fixture(count);
      const result = await replayAndAttestErasureLedgerRestore(input);
      expect(result.scannedSubjects).toBe(count);
      expect(result.replayedTombstones).toBe(0);
      expect(query.execute).toHaveBeenCalledTimes(Math.floor(count / 500) + 1);
      expect(requests).toEqual(
        Array.from({ length: Math.floor(count / 500) + 1 }, (_, page) => ({
          cursor: page * 500,
          limit: page === 20 ? 1 : 500,
        })),
      );
      expect(ledger.replaySubject.mock.calls.map(([item]) => item.subjectUserId)).toEqual(
        Array.from({ length: count }, (_, index) => id(index + 1)),
      );
      expect(query.where.mock.calls).toEqual(
        requests.slice(1).map(({ cursor }) => ["id", ">", id(cursor)]),
      );
      expect(operations.attest).toHaveBeenCalledTimes(1);
      expect(operations.ready).toHaveBeenCalledTimes(1);
      const digest = createHash("sha256").update(
        "nutrition-tracker-erasure-restore-reconciliation-v1\n",
      );
      for (let index = 1; index <= count; index++) digest.update(`${id(index)}\t0\n`);
      expect(result.reconciliationDigest).toBe(digest.digest("hex"));
      const output = JSON.stringify({
        event: "erasure_restore.reconciled",
        level: "info",
        ...result,
      });
      expect(Buffer.byteLength(output)).toBeLessThan(1024);
      expect(output).not.toContain(epoch);
      expect(output).not.toContain(id(1));
      expect(Object.keys(result).sort()).toEqual(
        [
          "attestation",
          "reconciled",
          "reconciliationDigest",
          "replayedTombstones",
          "scannedSubjects",
        ].sort(),
      );
    },
  );

  it("refuses a nonempty final probe after prior replay, without query 22 or attestation", async () => {
    const { input, query, requests, ledger } = fixture(10_001);
    ledger.replaySubject.mockImplementation(async (item) =>
      item.apply({ ...replayEntry, subjectUserId: item.subjectUserId }),
    );
    const outcome = await observe(replayAndAttestErasureLedgerRestore(input)).outcome;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected budget refusal");
    expect(outcome.reason).toBeInstanceOf(RangeError);
    expect(String(outcome.reason)).not.toContain(id(10_001));
    expect(query.execute).toHaveBeenCalledTimes(21);
    expect(requests.at(-1)).toEqual({ cursor: 10_000, limit: 1 });
    expect(ledger.replaySubject).toHaveBeenCalledTimes(10_000);
    expect(operations.apply).toHaveBeenCalledTimes(10_000);
    expect(operations.reconcile).toHaveBeenCalledTimes(10_000);
    expect(operations.attest).not.toHaveBeenCalled();
    expect(operations.ready).not.toHaveBeenCalled();
  });

  it("refuses an oversized returned page before admitting any of it", async () => {
    const { input, query, ledger } = fixture(0);
    query.execute.mockResolvedValueOnce(
      Array.from({ length: 501 }, (_, index) => ({ id: id(index + 1) })),
    );
    await expect(replayAndAttestErasureLedgerRestore(input)).rejects.toThrow(
      "subject budget exceeded",
    );
    expect(query.execute).toHaveBeenCalledTimes(1);
    expect(query.limit).toHaveBeenCalledWith(500);
    expect(ledger.replaySubject).not.toHaveBeenCalled();
    expect(operations.attest).not.toHaveBeenCalled();
  });

  it.each(["invalid", id(1)])(
    "refuses an invalid or repeated ID before its admission: %s",
    async (invalid) => {
      const { input, query, ledger } = fixture(0);
      input.maximumConcurrency = 1;
      query.execute.mockResolvedValueOnce([{ id: id(1) }, { id: invalid }]);
      await expect(replayAndAttestErasureLedgerRestore(input)).rejects.toBeInstanceOf(TypeError);
      expect(ledger.replaySubject).toHaveBeenCalledTimes(1);
      expect(operations.attest).not.toHaveBeenCalled();
    },
  );

  it("captures the original signal before migration awaits and avoids the first subject query", async () => {
    const controller = new AbortController();
    const replacement = new AbortController();
    const gate = deferred();
    const started = deferred();
    const reason = new Error("synthetic original cancellation");
    operations.migration.mockImplementation(async () => {
      started.resolve();
      await gate.promise;
    });
    const { input, query, ledger } = fixture(1, controller.signal);
    const work = observe(replayAndAttestErasureLedgerRestore(input));
    await started.promise;
    input.signal = replacement.signal;
    controller.abort(reason);
    gate.resolve();
    expect(await work.outcome).toEqual({ status: "rejected", reason });
    expect(query.execute).not.toHaveBeenCalled();
    expect(ledger.replaySubject).not.toHaveBeenCalled();
    expect(operations.attest).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "awaits a query that later %s after cancellation",
    async (settlement) => {
      const controller = new AbortController();
      const gate = deferred<{ id: string }[]>();
      const started = deferred();
      const cancellation = new Error("synthetic cancellation");
      const queryFailure = new Error("synthetic query failure");
      const { input, query, ledger } = fixture(1, controller.signal);
      query.execute.mockImplementationOnce(async () => {
        started.resolve();
        return gate.promise;
      });
      const cleanup = vi.fn();
      const work = observe(replayAndAttestErasureLedgerRestore(input).finally(cleanup));
      await started.promise;
      controller.abort(cancellation);
      await nextTurn();
      expect(work.isSettled()).toBe(false);
      expect(cleanup).not.toHaveBeenCalled();
      if (settlement === "resolve") gate.resolve([{ id: id(1) }]);
      else gate.reject(queryFailure);
      expect(await work.outcome).toEqual({
        status: "rejected",
        reason: settlement === "resolve" ? cancellation : queryFailure,
      });
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(query.execute).toHaveBeenCalledTimes(1);
      expect(ledger.replaySubject).not.toHaveBeenCalled();
      expect(operations.attest).not.toHaveBeenCalled();
    },
  );

  it("checks cancellation after an empty query settles", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic empty-query cancellation");
    const { input, query } = fixture(0, controller.signal);
    query.execute.mockImplementationOnce(async () => {
      controller.abort(reason);
      return [];
    });
    await expect(replayAndAttestErasureLedgerRestore(input)).rejects.toBe(reason);
    expect(operations.attest).not.toHaveBeenCalled();
  });

  it("does not read the next page row after cancellation between yields", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic yield cancellation");
    const { input, query } = fixture(0, controller.signal);
    let secondRead = false;
    query.execute.mockResolvedValueOnce([
      {
        get id() {
          controller.abort(reason);
          return id(1);
        },
      },
      {
        get id() {
          secondRead = true;
          return id(2);
        },
      },
    ]);
    await expect(replayAndAttestErasureLedgerRestore(input)).rejects.toBe(reason);
    expect(secondRead).toBe(false);
    expect(operations.attest).not.toHaveBeenCalled();
  });

  it.each(["before", "during"] as const)(
    "refuses cancellation %s the final probe",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error("synthetic probe cancellation");
      const { input, query, ledger } = fixture(10_000, controller.signal);
      if (stage === "before") {
        ledger.replaySubject.mockImplementation(async (item) => {
          if (item.subjectUserId === id(10_000)) controller.abort(reason);
          return null;
        });
      } else {
        const execute = query.execute.getMockImplementation();
        query.execute.mockImplementation(async () => {
          const rows = await execute?.();
          if (rows?.length === 0) controller.abort(reason);
          return rows ?? [];
        });
      }
      await expect(replayAndAttestErasureLedgerRestore(input)).rejects.toBe(reason);
      expect(query.execute).toHaveBeenCalledTimes(stage === "before" ? 20 : 21);
      expect(operations.attest).not.toHaveBeenCalled();
      expect(operations.ready).not.toHaveBeenCalled();
    },
  );

  it("keeps scalar admission stable across migration and subject reads", async () => {
    const { input, ledger } = fixture(2);
    input.maximumConcurrency = 1;
    operations.migration.mockImplementation(async () => {
      input.maximumConcurrency = 0;
      input.restoreEpoch = "different-private-epoch";
    });
    const result = await replayAndAttestErasureLedgerRestore(input);
    expect(result.scannedSubjects).toBe(2);
    expect(ledger.replaySubject).toHaveBeenCalledTimes(2);
    expect(operations.attest.mock.calls[0]?.[1].restoreEpoch).toBe(epoch);
  });

  it("enforces the generic iterable cap, leaves a partial batch unstarted and awaits closure", async () => {
    const closed = deferred();
    const closeGate = deferred();
    const ledger = fixture(0).ledger;
    const work = observe(
      replayErasureLedgerSubjects({
        subjects: (async function* () {
          try {
            yield* inventory(10_001);
          } finally {
            closed.resolve();
            await closeGate.promise;
          }
        })(),
        ledger,
        apply: async () => reconciled,
        maximumConcurrency: 7,
      }),
    );
    await closed.promise;
    expect(work.isSettled()).toBe(false);
    expect(ledger.replaySubject).toHaveBeenCalledTimes(9996);
    closeGate.resolve();
    const outcome = await work.outcome;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected refusal");
    expect(outcome.reason).toBeInstanceOf(RangeError);
    expect(ledger.replaySubject.mock.calls.at(-1)?.[0].subjectUserId).toBe(id(9996));
  });

  it("captures generic concurrency before iteration awaits", async () => {
    const ledger = fixture(0).ledger;
    const input = {
      subjects: changingSubjects(),
      maximumConcurrency: 1,
      ledger,
      apply: async () => reconciled,
    };
    async function* changingSubjects() {
      input.maximumConcurrency = 16;
      yield id(1);
      expect(ledger.replaySubject).toHaveBeenCalledTimes(1);
      yield id(2);
    }
    const result = await replayErasureLedgerSubjects(input);
    expect(result.scannedSubjects).toBe(2);
    expect(ledger.replaySubject).toHaveBeenCalledTimes(2);
  });

  it("refuses attestation if the captured clock cancels before dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic clock cancellation");
    const { input } = fixture(0, controller.signal);
    await expect(
      replayAndAttestErasureLedgerRestore({
        ...input,
        clock: () => {
          controller.abort(reason);
          return new Date();
        },
      }),
    ).rejects.toBe(reason);
    expect(operations.attest).not.toHaveBeenCalled();
    expect(operations.ready).not.toHaveBeenCalled();
  });

  it("uses fresh counters for independent exact-cap invocations", async () => {
    for (let invocation = 0; invocation < 2; invocation++) {
      const ledger = fixture(0).ledger;
      const result = await replayErasureLedgerSubjects({
        subjects: inventory(10_000),
        ledger,
        apply: async () => reconciled,
        maximumConcurrency: 16,
      });
      expect(result.scannedSubjects).toBe(10_000);
      expect(ledger.replaySubject).toHaveBeenCalledTimes(10_000);
    }
  });
});

describe("environment replay database cleanup", () => {
  const epoch = "synthetic-private-runner-epoch-".repeat(3);
  const failures = [undefined, null, false, 0, "", new Error("private-work-reason")];
  let root: string;
  let environment: NodeJS.ProcessEnv;
  const query = {
    select: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    execute: vi.fn(),
  };

  function database() {
    return {
      selectFrom: vi.fn(() => query),
      withSchema: attestationReader(),
      destroy: vi.fn(async (): Promise<void> => undefined),
    };
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 9, 12));
    vi.spyOn(AzureBlobRawArtifactStore.prototype, "open").mockImplementation(async () => {
      throw new Error("Empty runner fixture must not request a ledger object");
    });
    root = await mkdtemp(join(tmpdir(), "nutrition-replay-runner-"));
    environment = {
      NODE_ENV: "test",
      DATABASE_RESTORE_EPOCH: epoch,
      ERASURE_REPLAY_LEDGER_STORE: "azure",
      ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "azure_blob",
      ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL:
        "https://nourishingrecovery.blob.core.windows.net/ledger",
      ERASURE_REPLAY_LEDGER_AZURE_PREFIX: "ledger/",
      ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS: new URLSearchParams({
        sv: "2026-04-06",
        spr: "https",
        sr: "c",
        sp: "rl",
        sig: "synthetic-signature",
        st: "2026-10-09T11:00:00Z",
        se: "2026-10-09T15:00:00Z",
        skoid: "11111111-1111-4111-8111-111111111111",
        sktid: "22222222-2222-4222-8222-222222222222",
        skt: "2026-10-09T10:00:00Z",
        ske: "2026-10-09T16:00:00Z",
        sks: "b",
        skv: "2026-04-06",
      }).toString(),
      ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR: root,
      ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "aes",
      ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
        aes: Buffer.alloc(32, 7).toString("base64"),
      }),
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator",
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
        locator: Buffer.alloc(32, 8).toString("base64"),
      }),
    };
    query.select.mockReturnThis();
    query.orderBy.mockReturnThis();
    query.limit.mockReturnThis();
    query.execute.mockResolvedValue([]);
    operations.migration.mockResolvedValue(undefined);
    operations.ready.mockResolvedValue(undefined);
    operations.attest.mockImplementation(async (_database, input) => ({
      completedAt: input.completedAt,
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      reconciliationDigest: input.reconciliationDigest,
      replayedSubjectCount: String(input.replayedSubjectCount),
      restoreEpochHash: createHash("sha256").update(input.restoreEpoch).digest("hex"),
    }));
  });

  afterEach(async () => {
    try {
      expect(AzureBlobRawArtifactStore.prototype.open).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds environment replay to the admitted source database before migration", async () => {
    const db = database();
    const target = {
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      expectedOwner: "nutrition_owner",
    };
    operations.createDatabase.mockReturnValue(db);
    environment.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY = "1";
    const result = await runErasureLedgerRestoreFromEnvironment(environment, {
      expectedTarget: target,
    });
    expect(operations.prepare).toHaveBeenCalledExactlyOnceWith(db, target);
    expect(operations.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      operations.migration.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.attestation.databaseName).toBe(target.databaseName);
    expect(result.attestation.databaseOid).toBe(target.databaseOid);
    expect(db.destroy).toHaveBeenCalledOnce();
  });

  it("refuses a different source database observation before readiness", async () => {
    const db = database();
    operations.createDatabase.mockReturnValue(db);
    environment.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY = "1";
    await expect(
      runErasureLedgerRestoreFromEnvironment(environment, {
        expectedTarget: {
          databaseName: "different_source_database",
          databaseOid: "4567",
          expectedOwner: "nutrition_owner",
        },
      }),
    ).rejects.toThrow("Restore attestation does not match replay");
    expect(operations.ready).not.toHaveBeenCalled();
    expect(db.destroy).toHaveBeenCalledOnce();
  });

  it("rejects an already cancelled controller before configuration or database acquisition", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic controller cancellation");
    controller.abort(reason);
    await expect(
      runErasureLedgerRestoreFromEnvironment({}, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(operations.createDatabase).not.toHaveBeenCalled();
  });

  it("settles cancellation during migration and closes the acquired database", async () => {
    const db = database();
    const controller = new AbortController();
    const reason = new Error("synthetic migration cancellation");
    operations.createDatabase.mockReturnValue(db);
    operations.migration.mockImplementation(async () => controller.abort(reason));
    await expect(
      runErasureLedgerRestoreFromEnvironment(environment, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(query.execute).not.toHaveBeenCalled();
    expect(operations.attest).not.toHaveBeenCalled();
    expect(db.destroy).toHaveBeenCalledOnce();
  });

  it("preserves cancellation observed while database closure settles", async () => {
    const db = database();
    const controller = new AbortController();
    const reason = new Error("synthetic closure cancellation");
    operations.createDatabase.mockReturnValue(db);
    db.destroy.mockImplementation(async () => controller.abort(reason));
    await expect(
      runErasureLedgerRestoreFromEnvironment(environment, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(operations.ready).toHaveBeenCalledOnce();
    expect(db.destroy).toHaveBeenCalledOnce();
  });

  it("captures the admitted target before asynchronous private-spool preparation", async () => {
    const db = database();
    const target = {
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      expectedOwner: "nutrition_owner",
    };
    operations.createDatabase.mockReturnValue(db);
    environment.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY = "1";
    const work = runErasureLedgerRestoreFromEnvironment(environment, { expectedTarget: target });
    target.databaseName = "later_mutated_target";
    await expect(work).resolves.toMatchObject({
      attestation: { databaseName: "nutrition_isolated_restore", databaseOid: "4567" },
    });
    expect(operations.prepare).toHaveBeenCalledWith(db, {
      databaseName: "nutrition_isolated_restore",
      databaseOid: "4567",
      expectedOwner: "nutrition_owner",
    });
  });

  it.each(["fulfilled", "rejected"] as const)(
    "waits for %s replay and then actual destruction",
    async (outcome) => {
      const db = database();
      const ready = deferred();
      const readyStarted = deferred();
      const close = deferred();
      const closeStarted = deferred();
      const reason = new Error("private-readiness-failure");
      operations.createDatabase.mockReturnValue(db);
      operations.ready.mockImplementation(() => {
        readyStarted.resolve();
        return ready.promise;
      });
      db.destroy.mockImplementation(() => {
        closeStarted.resolve();
        return close.promise;
      });
      const work = observe(runErasureLedgerRestoreFromEnvironment(environment));
      await readyStarted.promise;
      expect(operations.attest).toHaveBeenCalledOnce();
      expect(db.destroy).not.toHaveBeenCalled();
      expect(work.isSettled()).toBe(false);
      if (outcome === "fulfilled") ready.resolve();
      else ready.reject(reason);
      await closeStarted.promise;
      expect(work.isSettled()).toBe(false);
      close.resolve();
      const result = await work.outcome;
      if (outcome === "rejected") {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toBe(reason);
      } else {
        expect(result.status).toBe("fulfilled");
        if (result.status === "fulfilled") {
          expect(result.value).toEqual({
            reconciled: true,
            scannedSubjects: 0,
            replayedTombstones: 0,
            reconciliationDigest: createHash("sha256")
              .update("nutrition-tracker-erasure-restore-reconciliation-v1\n", "utf8")
              .digest("hex"),
            attestation: await operations.attest.mock.results[0]?.value,
          });
          expect(JSON.stringify(result.value)).not.toContain(epoch);
          expect(JSON.stringify(result.value)).not.toContain(root);
          expect(JSON.stringify(result.value)).not.toContain("synthetic-signature");
        }
      }
      expect(db.destroy).toHaveBeenCalledOnce();
    },
  );

  describe.each(["resolve", "reject", "throw"] as const)(
    "cleanup %s after failed work",
    (cleanup) => {
      it.each(failures)("preserves exact work reason %s", async (reason) => {
        const db = database();
        operations.createDatabase.mockReturnValue(db);
        operations.migration.mockRejectedValue(reason);
        if (cleanup === "reject")
          db.destroy.mockRejectedValue(new Error("private-cleanup-failure"));
        if (cleanup === "throw")
          db.destroy.mockImplementation(() => {
            throw new Error("private-cleanup-failure");
          });
        const result = await observe(runErasureLedgerRestoreFromEnvironment(environment)).outcome;
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toBe(reason);
        expect(db.destroy).toHaveBeenCalledOnce();
        expect(query.execute).not.toHaveBeenCalled();
        expect(operations.attest).not.toHaveBeenCalled();
        expect(operations.ready).not.toHaveBeenCalled();
      });
    },
  );

  describe.each(["reject", "throw"] as const)("cleanup %s after successful replay", (cleanup) => {
    it.each(failures)("rejects exact cleanup reason %s", async (reason) => {
      const db = database();
      operations.createDatabase.mockReturnValue(db);
      if (cleanup === "reject") db.destroy.mockRejectedValue(reason);
      else
        db.destroy.mockImplementation(() => {
          throw reason;
        });
      const result = await observe(runErasureLedgerRestoreFromEnvironment(environment)).outcome;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe(reason);
      expect(operations.ready).toHaveBeenCalledOnce();
      expect(db.destroy).toHaveBeenCalledOnce();
    });
  });

  it("preserves a synchronous replay helper throw through cleanup failure", async () => {
    const db = database();
    const reason = new Error("private-synchronous-migration-failure");
    operations.createDatabase.mockReturnValue(db);
    operations.migration.mockImplementation(() => {
      throw reason;
    });
    db.destroy.mockRejectedValue(new Error("private-cleanup-failure"));
    const result = await observe(runErasureLedgerRestoreFromEnvironment(environment)).outcome;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(reason);
    expect(db.destroy).toHaveBeenCalledOnce();
  });

  it("preserves settings failure after acquisition and attempts cleanup once", async () => {
    const db = database();
    operations.createDatabase.mockReturnValue(db);
    db.destroy.mockRejectedValue(new Error("private-cleanup-failure"));
    environment.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY = "0";
    await expect(runErasureLedgerRestoreFromEnvironment(environment)).rejects.toThrow(
      "Invalid bounded restore configuration",
    );
    expect(db.destroy).toHaveBeenCalledOnce();
    expect(operations.migration).not.toHaveBeenCalled();
  });

  it("does not invent cleanup before preparation returns a database", async () => {
    const db = database();
    operations.createDatabase.mockReturnValue(db);
    delete environment.DATABASE_RESTORE_EPOCH;
    await expect(runErasureLedgerRestoreFromEnvironment(environment)).rejects.toThrow(
      "DATABASE_RESTORE_EPOCH",
    );
    expect(operations.createDatabase).not.toHaveBeenCalled();
    expect(db.destroy).not.toHaveBeenCalled();
  });

  it("preserves factory failure without cleanup of an unreturned database", async () => {
    const db = database();
    const reason = new Error("private-factory-failure");
    operations.createDatabase.mockImplementation(() => {
      throw reason;
    });
    await expect(runErasureLedgerRestoreFromEnvironment(environment)).rejects.toBe(reason);
    expect(db.destroy).not.toHaveBeenCalled();
    expect(operations.migration).not.toHaveBeenCalled();
  });

  it("keeps overlapping database outcomes independent", async () => {
    const failed = database();
    const successful = database();
    const failedReady = deferred();
    const failedStarted = deferred();
    const reason = new Error("private-first-invocation-failure");
    operations.createDatabase.mockReturnValueOnce(failed).mockReturnValueOnce(successful);
    operations.ready.mockImplementation((db) => {
      if (db === failed) {
        failedStarted.resolve();
        return failedReady.promise;
      }
      return Promise.resolve();
    });
    failed.destroy.mockRejectedValue(new Error("private-first-cleanup-failure"));
    const firstWork = observe(runErasureLedgerRestoreFromEnvironment(environment));
    await failedStarted.promise;
    const secondResult = await runErasureLedgerRestoreFromEnvironment({
      ...environment,
      ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR: join(root, "second"),
    });
    expect(secondResult.scannedSubjects).toBe(0);
    expect(successful.destroy).toHaveBeenCalledOnce();
    expect(failed.destroy).not.toHaveBeenCalled();
    failedReady.reject(reason);
    const result = await firstWork.outcome;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(reason);
    expect(failed.destroy).toHaveBeenCalledOnce();
  });
});
