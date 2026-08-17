import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { EncryptedArtifactStore, type RawArtifactStore } from "./artifact-encryption.js";
import {
  ArtifactReadBulkhead,
  ArtifactReadRateLimitedError,
  ArtifactReadUnavailableError,
} from "./artifact-read-bulkhead.js";

class MemoryRawArtifactStore implements RawArtifactStore {
  readonly objects = new Map<string, Buffer>();

  async put(input: { readonly objectKey: string; readonly source: Readable }): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.source) chunks.push(Buffer.from(chunk as Uint8Array));
    this.objects.set(input.objectKey, Buffer.concat(chunks));
  }

  async open(input: { readonly objectKey: string }) {
    const value = this.objects.get(input.objectKey);
    return value
      ? { contentLength: value.byteLength, stream: Readable.from([Buffer.from(value)]) }
      : null;
  }
}

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture(payload: Buffer, temporaryDirectory?: string) {
  const rawStore = new MemoryRawArtifactStore();
  const store = new EncryptedArtifactStore({
    keyRing: {
      currentKeyId: "key-v1",
      keys: new Map([["key-v1", Buffer.alloc(32, 4)]]),
      purpose: "export",
    },
    nonce: () => Buffer.alloc(12, 8),
    rawStore,
    ...(temporaryDirectory ? { temporaryDirectory } : {}),
  });
  const metadata = await store.put({
    mediaType: "application/json",
    objectKey: `exports/${randomBytes(8).toString("hex")}.json.enc`,
    plaintextBytes: payload.byteLength,
    source: Readable.from([payload]),
  });
  return { metadata, rawStore, store };
}

describe("artifact read bulkhead", () => {
  it("enforces per-owner single flight, global concurrency, and reserved plaintext bytes", async () => {
    const one = await fixture(Buffer.alloc(10, 1));
    const two = await fixture(Buffer.alloc(10, 2));
    const bulkhead = new ArtifactReadBulkhead({
      maximumArtifactBytes: 10,
      maximumConcurrentReads: 1,
      maximumReservedPlaintextBytes: 10,
    });
    const open = await bulkhead.openAuthenticated({
      metadata: one.metadata,
      ownerKey: "owner-a",
      store: one.store,
    });
    expect(bulkhead.utilization).toEqual({ activeReads: 1, reservedPlaintextBytes: 10 });
    await expect(
      bulkhead.openAuthenticated({ metadata: two.metadata, ownerKey: "owner-a", store: two.store }),
    ).rejects.toBeInstanceOf(ArtifactReadRateLimitedError);
    await expect(
      bulkhead.openAuthenticated({ metadata: two.metadata, ownerKey: "owner-b", store: two.store }),
    ).rejects.toBeInstanceOf(ArtifactReadUnavailableError);
    await open?.dispose();
    expect(bulkhead.utilization).toEqual({ activeReads: 0, reservedPlaintextBytes: 0 });
    const afterRelease = await bulkhead.openAuthenticated({
      metadata: two.metadata,
      ownerKey: "owner-b",
      store: two.store,
    });
    await afterRelease?.dispose();
  });

  it("rejects an artifact larger than the absolute plaintext spool cap", async () => {
    const artifact = await fixture(Buffer.alloc(11, 3));
    const bulkhead = new ArtifactReadBulkhead({
      maximumArtifactBytes: 10,
      maximumConcurrentReads: 2,
      maximumReservedPlaintextBytes: 20,
    });
    await expect(
      bulkhead.openAuthenticated({
        metadata: artifact.metadata,
        ownerKey: "owner-a",
        store: artifact.store,
      }),
    ).rejects.toBeInstanceOf(ArtifactReadUnavailableError);
    expect(bulkhead.utilization.activeReads).toBe(0);
  });

  it("releases reservations and removes plaintext spool files when the client aborts sending", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "nutrition-artifact-bulkhead-"));
    cleanup.push(temporaryDirectory);
    const artifact = await fixture(Buffer.alloc(32, 5), temporaryDirectory);
    const bulkhead = new ArtifactReadBulkhead({
      maximumArtifactBytes: 64,
      maximumConcurrentReads: 1,
      maximumReservedPlaintextBytes: 64,
    });
    const opened = await bulkhead.openAuthenticated({
      metadata: artifact.metadata,
      ownerKey: "owner-a",
      store: artifact.store,
    });
    expect(await readdir(temporaryDirectory)).toHaveLength(1);
    const closed = new Promise<void>((resolvePromise) =>
      opened?.stream.once("close", resolvePromise),
    );
    opened?.stream.once("error", () => undefined);
    opened?.stream.destroy(new Error("client-aborted"));
    await closed;
    await opened?.dispose();
    expect(bulkhead.utilization).toEqual({ activeReads: 0, reservedPlaintextBytes: 0 });
    expect(await readdir(temporaryDirectory)).toEqual([]);

    const retry = await bulkhead.openAuthenticated({
      metadata: artifact.metadata,
      ownerKey: "owner-a",
      store: artifact.store,
    });
    await retry?.dispose();
  });

  it("rate-limits sequential per-owner decrypt/egress abuse by opens and bytes", async () => {
    const artifact = await fixture(Buffer.alloc(10, 6));
    let now = Date.parse("2026-08-16T00:00:00.000Z");
    const bulkhead = new ArtifactReadBulkhead({
      clock: () => now,
      maximumArtifactBytes: 10,
      maximumBytesPerOwnerPerWindow: 20,
      maximumConcurrentReads: 1,
      maximumOpensPerOwnerPerWindow: 2,
      maximumReservedPlaintextBytes: 10,
      rateWindowMs: 60_000,
    });
    for (let index = 0; index < 2; index += 1) {
      const opened = await bulkhead.openAuthenticated({
        metadata: artifact.metadata,
        ownerKey: "owner-a",
        store: artifact.store,
      });
      await opened?.dispose();
    }
    await expect(
      bulkhead.openAuthenticated({
        metadata: artifact.metadata,
        ownerKey: "owner-a",
        store: artifact.store,
      }),
    ).rejects.toBeInstanceOf(ArtifactReadRateLimitedError);
    const otherOwner = await bulkhead.openAuthenticated({
      metadata: artifact.metadata,
      ownerKey: "owner-b",
      store: artifact.store,
    });
    await otherOwner?.dispose();
    now += 60_000;
    const afterWindow = await bulkhead.openAuthenticated({
      metadata: artifact.metadata,
      ownerKey: "owner-a",
      store: artifact.store,
    });
    await afterWindow?.dispose();
  });

  it("does not charge a successful-open slot for pre-admission aborts or transient store failure", async () => {
    const artifact = await fixture(Buffer.alloc(10, 7));
    const bulkhead = new ArtifactReadBulkhead({
      maximumArtifactBytes: 10,
      maximumBytesPerOwnerPerWindow: 20,
      maximumConcurrentReads: 1,
      maximumOpensPerOwnerPerWindow: 1,
      maximumReservedPlaintextBytes: 10,
      rateWindowMs: 60_000,
    });
    const aborted = new AbortController();
    aborted.abort("client-aborted-before-admission");
    await expect(
      bulkhead.openAuthenticated({
        metadata: artifact.metadata,
        ownerKey: "owner-a",
        signal: aborted.signal,
        store: artifact.store,
      }),
    ).rejects.toBe("client-aborted-before-admission");
    const transientStore = {
      openAuthenticated: async () => {
        throw new Error("transient-object-store-error");
      },
    } as unknown as EncryptedArtifactStore;
    await expect(
      bulkhead.openAuthenticated({
        metadata: artifact.metadata,
        ownerKey: "owner-a",
        store: transientStore,
      }),
    ).rejects.toThrow("transient-object-store-error");
    const retry = await bulkhead.openAuthenticated({
      metadata: artifact.metadata,
      ownerKey: "owner-a",
      store: artifact.store,
    });
    await retry?.dispose();
    await expect(
      bulkhead.openAuthenticated({
        metadata: artifact.metadata,
        ownerKey: "owner-a",
        store: artifact.store,
      }),
    ).rejects.toBeInstanceOf(ArtifactReadRateLimitedError);
  });
});
