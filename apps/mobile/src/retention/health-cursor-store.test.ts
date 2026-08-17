import { describe, expect, it } from "vitest";

import type { SignedHealthImportEnvelope } from "./device-signing";
import type { PendingHealthImport } from "./health-cursor";
import {
  createChunkedHealthSyncStore,
  type HealthJournalRuntime,
  type ProtectedJournalKeyValue,
} from "./health-cursor-store";

const deviceId = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";

class MemoryProtectedStore implements ProtectedJournalKeyValue {
  readonly values = new Map<string, string>();
  maximumValueBytes = Number.POSITIVE_INFINITY;
  failSet: ((key: string, value: string) => boolean) | null = null;
  corruptSet: ((key: string, value: string) => string | null) | null = null;
  failDelete: ((key: string) => boolean) | null = null;

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    if (new TextEncoder().encode(value).byteLength > this.maximumValueBytes) {
      throw new Error("protected-store-item-too-large");
    }
    if (this.failSet?.(key, value)) throw new Error("injected-set-crash");
    this.values.set(key, this.corruptSet?.(key, value) ?? value);
  }

  async delete(key: string) {
    if (this.failDelete?.(key)) throw new Error("injected-delete-crash");
    this.values.delete(key);
  }
}

function runtime(): HealthJournalRuntime {
  let id = 1;
  return {
    randomUuid: async () => `${String(id++).padStart(8, "0")}-0000-4000-8000-000000000001`,
    sha256Hex: async (value) => {
      let digest = 2_166_136_261;
      for (const byte of new TextEncoder().encode(value)) {
        digest = Math.imul(digest ^ byte, 16_777_619) >>> 0;
      }
      return digest.toString(16).padStart(8, "0").repeat(8);
    },
  };
}

function envelope(recordCount: number, batchId = deviceId): SignedHealthImportEnvelope {
  return {
    body: {
      deviceId,
      batchId,
      cursorEpoch: "1",
      platform: "apple_healthkit",
      sourceCursor: null,
      nextSourceCursor: "a".repeat(64),
      records: Array.from({ length: recordCount }, (_, index) => ({
        operation: "upsert" as const,
        externalId: `sample-${index}`,
        externalRevision: `revision-${index}`,
        definitionCode: "body_weight",
        measuredAt: "2026-08-16T08:00:00.000Z",
        recordedTimeZone: "America/Chicago",
        value: "72.125",
        unit: "kg",
      })),
    },
    headers: {
      "x-device-timestamp": "2026-08-16T08:00:00.000Z",
      "x-device-nonce": "n".repeat(22),
      "x-device-signature": "s".repeat(86),
    },
  };
}

function pending(recordCount = 1, knownCount = recordCount): PendingHealthImport {
  return {
    envelope: envelope(recordCount),
    nextCursor: {
      version: 1,
      providerCursor: "provider-anchor",
      serverDigest: "a".repeat(64),
      knownRevisions: Object.fromEntries(
        Array.from({ length: knownCount }, (_, index) => [`sample-${index}`, `revision-${index}`]),
      ),
    },
    fullReconciliation: true,
    deletionSemantics: "explicit_only",
  };
}

describe("chunked protected health synchronization journal", () => {
  it("stays below a forced 2 KiB item limit with 1,001 known revisions and a 100-record batch", async () => {
    const storage = new MemoryProtectedStore();
    storage.maximumValueBytes = 2_048;
    const store = createChunkedHealthSyncStore("apple_healthkit", {
      storage,
      runtime: runtime(),
    });
    await store.stage(null, pending(100, 1_001));
    const restored = await store.load();
    expect(restored.pending?.envelope).toEqual(envelope(100));
    expect(Object.keys(restored.pending?.nextCursor.knownRevisions ?? {})).toHaveLength(1_001);
    expect(
      [...storage.values.values()].every(
        (value) => new TextEncoder().encode(value).byteLength <= 2_048,
      ),
    ).toBe(true);
    expect([...storage.values.values()].some((value) => value.includes("sample-1000"))).toBe(false);
  });

  it("keeps the prior state when a chunk or atomic pointer write fails", async () => {
    const storage = new MemoryProtectedStore();
    const store = createChunkedHealthSyncStore("apple_healthkit", {
      storage,
      runtime: runtime(),
    });
    let failed = false;
    storage.failSet = (key) => {
      if (!failed && key.includes(".chunk.")) {
        failed = true;
        return true;
      }
      return false;
    };
    await expect(store.stage(null, pending())).rejects.toThrow(/injected-set-crash/u);
    storage.failSet = null;
    expect((await store.load()).pending).toBeNull();

    let pointerFailed = false;
    storage.failSet = (key) => {
      if (!pointerFailed && key.endsWith(".pointer")) {
        pointerFailed = true;
        return true;
      }
      return false;
    };
    await expect(store.stage(null, pending())).rejects.toThrow(/injected-set-crash/u);
    storage.failSet = null;
    expect((await store.load()).pending).toBeNull();
  });

  it("refuses a silently truncated staged generation before swapping the good pointer", async () => {
    const storage = new MemoryProtectedStore();
    const store = createChunkedHealthSyncStore("apple_healthkit", {
      storage,
      runtime: runtime(),
    });
    await store.stage(null, pending());
    await store.accept(deviceId);
    const good = await store.load();
    expect(good.cursor.serverDigest).toBe("a".repeat(64));

    let corrupted = false;
    storage.corruptSet = (key, value) => {
      if (!corrupted && key.includes(".chunk.")) {
        corrupted = true;
        return value.slice(0, -4);
      }
      return null;
    };
    await expect(
      store.stage("a".repeat(64), {
        ...pending(),
        nextCursor: {
          ...pending().nextCursor,
          serverDigest: "b".repeat(64),
        },
        envelope: {
          ...envelope(1, "118f6f58-4e2c-7b62-8f0b-3d75491713b5"),
          body: {
            ...envelope(1, "118f6f58-4e2c-7b62-8f0b-3d75491713b5").body,
            sourceCursor: "a".repeat(64),
            nextSourceCursor: "b".repeat(64),
          },
        },
      }),
    ).rejects.toThrow(/truncated|read-back/u);
    storage.corruptSet = null;
    expect(await store.load()).toEqual(good);
  });

  it("recovers a committed generation when cleanup crashes after the atomic pointer swap", async () => {
    const storage = new MemoryProtectedStore();
    const store = createChunkedHealthSyncStore("apple_healthkit", {
      storage,
      runtime: runtime(),
    });
    let crashed = false;
    storage.failDelete = (key) => {
      if (!crashed && key.endsWith(".staging")) {
        crashed = true;
        return true;
      }
      return false;
    };
    await store.stage(null, pending());
    storage.failDelete = null;
    const restarted = createChunkedHealthSyncStore("apple_healthkit", {
      storage,
      runtime: runtime(),
    });
    expect((await restarted.load()).pending?.envelope).toEqual(envelope(1));
  });

  it("serializes concurrent A-to-B attempts so only one exact envelope wins", async () => {
    const storage = new MemoryProtectedStore();
    const store = createChunkedHealthSyncStore("apple_healthkit", {
      storage,
      runtime: runtime(),
    });
    const alternate = {
      ...pending(),
      envelope: envelope(1, "118f6f58-4e2c-7b62-8f0b-3d75491713b5"),
    };
    const results = await Promise.allSettled([
      store.stage(null, pending()),
      store.stage(null, alternate),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const acceptedBatch = (await store.load()).pending?.envelope.body.batchId;
    expect([deviceId, "118f6f58-4e2c-7b62-8f0b-3d75491713b5"]).toContain(acceptedBatch);
    if (!acceptedBatch) throw new Error("test journal did not retain a winner");
    await store.accept(acceptedBatch);
    const state = await store.load();
    expect(state.pending).toBeNull();
    expect(state.cursor.serverDigest).toBe("a".repeat(64));
  });
});
