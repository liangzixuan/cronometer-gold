import { describe, expect, it } from "vitest";

import {
  createSignedHealthImportEnvelope,
  type DeviceSigner,
  type SignedHealthImportEnvelope,
} from "./device-signing";
import { establishHealthCursorEpoch } from "./health-connection";
import type { HealthCursorState, HealthSyncState, PendingHealthImport } from "./health-cursor";
import {
  type HealthSyncStore,
  RetryableHealthImportTransportError,
  syncNativeWeight,
} from "./health-sync";
import {
  buildNativeHealthChanges,
  type NativeHealthAdapter,
  type NativeWeightRecord,
} from "./native-health.types";

const deviceId = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";

function upsert(index: number): Extract<NativeWeightRecord, { readonly operation: "upsert" }> {
  return {
    operation: "upsert",
    externalId: `sample-${index}`,
    externalRevision: "2",
    definitionCode: "body_weight",
    measuredAt: "2026-08-16T08:00:00.000Z",
    recordedTimeZone: "America/Chicago",
    value: "72.125",
    unit: "kg",
  };
}

function signer(): DeviceSigner {
  return {
    ensureHardwareKey: async () => {
      throw new Error("unused");
    },
    resetHardwareKey: async () => undefined,
    sha256Hex: async (value) =>
      `${value.length.toString(16).padStart(8, "0")}${"a".repeat(56)}`.slice(0, 64),
    signUtf8: async () =>
      "MEQCIE6kweXWD-Ftm-gUhuoawRTXa45ihYaZhr2_euC8AFsUAiBf7LqVIbPw5oQcopItyEpYgekjKiE6aWU7hf707TMgLA",
  };
}

function journalStore(initial: HealthCursorState): {
  readonly store: HealthSyncStore;
  state(): HealthSyncState;
  accepted(): readonly HealthCursorState[];
} {
  let state: HealthSyncState = { version: 2, cursor: initial, pending: null };
  const accepted: HealthCursorState[] = [];
  return {
    store: {
      load: async () => state,
      stage: async (expected, pending) => {
        expect(state.pending).toBeNull();
        expect(expected).toBe(state.cursor.serverDigest);
        state = { ...state, pending };
      },
      accept: async (batchId) => {
        expect(state.pending?.envelope.body.batchId).toBe(batchId);
        const next = state.pending?.nextCursor;
        if (!next) throw new Error("missing test journal");
        state = { version: 2, cursor: next, pending: null };
        accepted.push(next);
      },
    },
    state: () => state,
    accepted: () => accepted,
  };
}

describe("multi-page signed native health synchronization", () => {
  it("chunks 1,001 records and infers missing deletions only after the complete full snapshot", () => {
    const records = Array.from({ length: 1_001 }, (_, index) => upsert(index));
    const plan = buildNativeHealthChanges(
      "provider-anchor-final",
      records,
      [],
      { removed: "1" },
      true,
      "full:final",
      true,
      3,
    );
    expect(plan.pages).toHaveLength(11);
    expect(plan.pages[0]?.records).toHaveLength(100);
    expect(plan.pages[0]?.records.some((record) => record.externalId === "removed")).toBe(false);
    expect(plan.pages.at(-1)?.records.at(-1)).toEqual({
      operation: "delete",
      externalId: "removed",
      externalRevision: "full:final",
    });
  });

  it("recreates the exact two-page signed cursor chain after a cursor-epoch reset", async () => {
    const plan = buildNativeHealthChanges(
      "provider-anchor-repeat",
      Array.from({ length: 101 }, (_, index) => upsert(index)),
      [],
      {},
      true,
      "full:repeat",
      false,
      2,
    );
    expect(plan.pages.map((page) => page.records.length)).toEqual([100, 1]);
    const adapter: NativeHealthAdapter = {
      platform: "apple_healthkit",
      availability: async () => ({ status: "available" }),
      requestWeightReadPermission: async () => ({
        readAuthorizationOpaque: true,
        status: "ready",
      }),
      readWeightChanges: async () => plan,
      openPermissionSettings: async () => undefined,
    };
    const runFromResetCursor = async () => {
      const envelopes: SignedHealthImportEnvelope[] = [];
      let identifier = 1;
      await syncNativeWeight({
        adapter,
        cursorStore: journalStore({
          knownRevisions: {},
          providerCursor: null,
          serverDigest: null,
          version: 1,
        }).store,
        deviceId,
        cursorEpoch: "1",
        ids: {
          nextUuid: () => `${String(identifier++).padStart(8, "0")}-0000-4000-8000-000000000001`,
          now: () => new Date("2026-08-16T08:00:00.000Z"),
        },
        recordedTimeZone: "America/Chicago",
        signer: signer(),
        transport: {
          send: async (envelope) => {
            envelopes.push(envelope);
            return {
              data: {
                accepted: envelope.body.records.length,
                conflicts: [],
                deleted: 0,
                duplicates: 0,
                replayed: false,
              },
            };
          },
        },
      });
      return envelopes;
    };

    const firstEpoch = await runFromResetCursor();
    const secondEpoch = await runFromResetCursor();
    expect(secondEpoch).toEqual(firstEpoch);
    expect(firstEpoch).toHaveLength(2);
    expect(firstEpoch[0]?.body.sourceCursor).toBeNull();
    expect(firstEpoch[1]?.body.sourceCursor).toBe(firstEpoch[0]?.body.nextSourceCursor);
  });

  it("reuses the identical signed envelope after a lost response and commits each accepted page", async () => {
    const plan = buildNativeHealthChanges(
      "provider-anchor-final",
      [upsert(1), upsert(2)],
      [],
      {},
      false,
      "unused",
      false,
      2,
    );
    const adapter: NativeHealthAdapter = {
      platform: "android_health_connect",
      availability: async () => ({ status: "available" }),
      requestWeightReadPermission: async () => ({
        status: "ready",
        readAuthorizationOpaque: false,
      }),
      readWeightChanges: async () => plan,
      openPermissionSettings: async () => undefined,
    };
    const initial: HealthCursorState = {
      version: 1,
      providerCursor: "old-provider-token",
      serverDigest: "b".repeat(64),
      knownRevisions: {},
    };
    const journal = journalStore(initial);
    const envelopes: SignedHealthImportEnvelope[] = [];
    let first = true;
    const result = await syncNativeWeight({
      adapter,
      cursorStore: journal.store,
      signer: signer(),
      transport: {
        send: async (envelope) => {
          envelopes.push(envelope);
          if (first) {
            first = false;
            throw new RetryableHealthImportTransportError("response-lost-after-acceptance");
          }
          return {
            data: {
              replayed: envelopes.length > 1,
              accepted: envelope.body.records.filter((record) => record.operation === "upsert")
                .length,
              deleted: envelope.body.records.filter((record) => record.operation === "delete")
                .length,
              duplicates: 0,
              conflicts: [],
            },
          };
        },
      },
      ids: {
        nextUuid: (() => {
          let value = 1;
          return () => `${String(value++).padStart(8, "0")}-0000-4000-8000-000000000001`;
        })(),
        now: () => new Date("2026-08-16T08:00:00.000Z"),
      },
      deviceId,
      cursorEpoch: "1",
      recordedTimeZone: "America/Chicago",
    });
    expect(result).toEqual({
      batches: 1,
      records: 2,
      accepted: 2,
      deleted: 0,
      duplicates: 0,
      fullReconciliation: false,
      deletionSemantics: "explicit_only",
      recoveredPendingBatch: false,
    });
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toEqual(envelopes[0]);
    expect(journal.accepted()).toHaveLength(1);
    expect(journal.state().cursor.providerCursor).toBe("provider-anchor-final");
  });

  it("does not advance any cursor when both attempts for the first page fail", async () => {
    const original: HealthCursorState = {
      version: 1,
      providerCursor: null,
      serverDigest: null,
      knownRevisions: {},
    };
    const journal = journalStore(original);
    await expect(
      syncNativeWeight({
        adapter: {
          platform: "apple_healthkit",
          availability: async () => ({ status: "available" }),
          requestWeightReadPermission: async () => ({
            status: "ready",
            readAuthorizationOpaque: true,
          }),
          readWeightChanges: async () =>
            buildNativeHealthChanges("anchor", [upsert(1)], [], {}, true, "full:anchor", false, 1),
          openPermissionSettings: async () => undefined,
        },
        cursorStore: journal.store,
        signer: signer(),
        transport: {
          send: async () => {
            throw new RetryableHealthImportTransportError("offline");
          },
        },
        ids: {
          nextUuid: () => "018f6f58-4e2c-7b62-8f0b-3d75491713b5",
          now: () => new Date("2026-08-16T08:00:00.000Z"),
        },
        deviceId,
        cursorEpoch: "1",
        recordedTimeZone: "America/Chicago",
      }),
    ).rejects.toThrow(/offline/u);
    expect(journal.state().cursor).toEqual(original);
    expect(journal.state().pending).not.toBeNull();
  });

  it("does not retry a server rejection or an invalid acknowledgement", async () => {
    const adapter: NativeHealthAdapter = {
      platform: "apple_healthkit",
      availability: async () => ({ status: "available" }),
      requestWeightReadPermission: async () => ({ status: "ready", readAuthorizationOpaque: true }),
      readWeightChanges: async () =>
        buildNativeHealthChanges("anchor", [upsert(1)], [], {}, true, "full:anchor", false, 1),
      openPermissionSettings: async () => undefined,
    };
    let sends = 0;
    const journal = journalStore({
      version: 1,
      providerCursor: null,
      serverDigest: null,
      knownRevisions: {},
    });
    await expect(
      syncNativeWeight({
        adapter,
        cursorStore: journal.store,
        signer: signer(),
        transport: {
          send: async () => {
            sends += 1;
            return {
              data: { replayed: false, accepted: 0, deleted: 0, duplicates: 0, conflicts: [] },
            };
          },
        },
        ids: { nextUuid: () => deviceId, now: () => new Date("2026-08-16T08:00:00.000Z") },
        deviceId,
        cursorEpoch: "1",
        recordedTimeZone: "America/Chicago",
      }),
    ).rejects.toThrow(/acknowledgement/u);
    expect(sends).toBe(1);
    expect(journal.state().pending).not.toBeNull();
  });

  it("accepts exact provider duplicates as accounted no-ops", async () => {
    const journal = journalStore({
      version: 1,
      providerCursor: null,
      serverDigest: null,
      knownRevisions: {},
    });
    const result = await syncNativeWeight({
      adapter: {
        platform: "apple_healthkit",
        availability: async () => ({ status: "available" }),
        requestWeightReadPermission: async () => ({
          status: "ready",
          readAuthorizationOpaque: true,
        }),
        readWeightChanges: async () =>
          buildNativeHealthChanges("anchor", [upsert(1)], [], {}, true, "full:anchor", false, 1),
        openPermissionSettings: async () => undefined,
      },
      cursorStore: journal.store,
      signer: signer(),
      transport: {
        send: async () => ({
          data: { replayed: false, accepted: 0, deleted: 0, duplicates: 1, conflicts: [] },
        }),
      },
      ids: { nextUuid: () => deviceId, now: () => new Date("2026-08-16T08:00:00.000Z") },
      deviceId,
      cursorEpoch: "1",
      recordedTimeZone: "America/Chicago",
    });
    expect(result).toMatchObject({ records: 1, accepted: 0, deleted: 0, duplicates: 1 });
  });

  it("replays a durable exact envelope after process restart and an accepted-response save failure", async () => {
    const initial: HealthCursorState = {
      version: 1,
      providerCursor: "old-token",
      serverDigest: "c".repeat(64),
      knownRevisions: {},
    };
    let state: HealthSyncState = { version: 2, cursor: initial, pending: null };
    let failFirstAccept = true;
    const store: HealthSyncStore = {
      load: async () => state,
      stage: async (expected, pending) => {
        expect(expected).toBe(state.cursor.serverDigest);
        state = { ...state, pending };
      },
      accept: async (batchId) => {
        expect(state.pending?.envelope.body.batchId).toBe(batchId);
        if (failFirstAccept) {
          failFirstAccept = false;
          throw new Error("secure-store-write-failed-after-server-acceptance");
        }
        const next = state.pending?.nextCursor;
        if (!next) throw new Error("missing pending test batch");
        state = { version: 2, cursor: next, pending: null };
      },
    };
    const adapter: NativeHealthAdapter = {
      platform: "android_health_connect",
      availability: async () => ({ status: "available" }),
      requestWeightReadPermission: async () => ({
        status: "ready",
        readAuthorizationOpaque: false,
      }),
      readWeightChanges: async () =>
        buildNativeHealthChanges("new-token", [upsert(4)], [], {}, false, "unused", false, 1),
      openPermissionSettings: async () => undefined,
    };
    const sent: SignedHealthImportEnvelope[] = [];
    const transport = {
      send: async (envelope: SignedHealthImportEnvelope) => {
        sent.push(envelope);
        return {
          data: {
            replayed: sent.length > 1,
            accepted: envelope.body.records.length,
            deleted: 0,
            duplicates: 0,
            conflicts: [],
          },
        };
      },
    };
    const common = {
      adapter,
      cursorStore: store,
      signer: signer(),
      transport,
      ids: { nextUuid: () => deviceId, now: () => new Date("2026-08-16T08:00:00.000Z") },
      deviceId,
      cursorEpoch: "1",
      recordedTimeZone: "America/Chicago",
    } as const;
    await expect(syncNativeWeight(common)).rejects.toThrow(/secure-store-write-failed/u);
    const durablePending = state.pending as PendingHealthImport | null;
    expect(durablePending).not.toBeNull();
    const recovered = await syncNativeWeight({
      ...common,
      ids: {
        nextUuid: () => {
          throw new Error("must not regenerate identity");
        },
        now: () => new Date(0),
      },
    });
    expect(sent[1]).toEqual(sent[0]);
    expect(recovered.recoveredPendingBatch).toBe(true);
    expect(state.pending).toBeNull();
    expect(state.cursor).toEqual(durablePending?.nextCursor);
  });

  it("admits a fresh-launch pending replay when the server cursor is either prior or committed", async () => {
    const prior = "c".repeat(64);
    const next = "d".repeat(64);
    const envelope = await createSignedHealthImportEnvelope(
      signer(),
      {
        batchId: "118f6f58-4e2c-7b62-8f0b-3d75491713b5",
        cursorEpoch: "5",
        deviceId,
        nextSourceCursor: next,
        platform: "android_health_connect",
        records: [upsert(9)],
        sourceCursor: prior,
      },
      "2026-08-16T08:00:00.000Z",
      "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
    );
    const pending: PendingHealthImport = {
      deletionSemantics: "explicit_only",
      envelope,
      fullReconciliation: false,
      nextCursor: {
        knownRevisions: { "sample-9": "2" },
        providerCursor: "new-token",
        serverDigest: next,
        version: 1,
      },
    };

    for (const serverCursor of [prior, next]) {
      let state: HealthSyncState = {
        cursor: {
          knownRevisions: {},
          providerCursor: "old-token",
          serverDigest: prior,
          version: 1,
        },
        pending,
        version: 2,
      };
      const store: HealthSyncStore = {
        accept: async (batchId) => {
          expect(batchId).toBe(envelope.body.batchId);
          state = { cursor: pending.nextCursor, pending: null, version: 2 };
        },
        load: async () => state,
        stage: async () => {
          throw new Error("A recovered pending envelope must not be restaged.");
        },
      };
      const integration = {
        consentGrantedAt: "2026-08-16T07:00:00.000Z",
        consentHistory: [],
        currentSourceCursor: serverCursor,
        cursorEpoch: "5",
        dataTypeCodes: ["body_weight"] as const,
        deviceId,
        disconnectedAt: null,
        lastImportAt: null,
        platform: "android_health_connect" as const,
        revision: "5",
        status: "connected" as const,
      };
      const epoch = await establishHealthCursorEpoch({
        consent: async () => {
          throw new Error("Consent must not be changed for a stable pending replay.");
        },
        deviceId,
        existing: integration,
        localServerDigest: prior,
        pendingBatch: envelope.body,
        rebind: async () => {
          throw new Error("The cursor epoch must not change for a stable pending replay.");
        },
        resetLocalCursor: async () => {
          throw new Error("The pending journal must not be cleared before replay.");
        },
      });
      expect(epoch).toEqual({ integration, reset: false });
      const sent: SignedHealthImportEnvelope[] = [];
      const recovered = await syncNativeWeight({
        adapter: {
          availability: async () => ({ status: "available" }),
          openPermissionSettings: async () => undefined,
          platform: "android_health_connect",
          readWeightChanges: async () => {
            throw new Error("A pending replay must not reread native health data.");
          },
          requestWeightReadPermission: async () => ({
            readAuthorizationOpaque: false,
            status: "ready",
          }),
        },
        cursorEpoch: epoch.integration.cursorEpoch,
        cursorStore: store,
        deviceId,
        ids: {
          nextUuid: () => {
            throw new Error("A pending replay must not generate a new identity.");
          },
          now: () => new Date(0),
        },
        recordedTimeZone: "America/Chicago",
        signer: signer(),
        transport: {
          send: async (candidate) => {
            sent.push(candidate);
            return {
              data: {
                accepted: 1,
                conflicts: [],
                deleted: 0,
                duplicates: 0,
                replayed: serverCursor === next,
              },
            };
          },
        },
      });
      expect(sent).toEqual([envelope]);
      expect(recovered.recoveredPendingBatch).toBe(true);
      expect(state).toEqual({ cursor: pending.nextCursor, pending: null, version: 2 });
    }
  });
});
