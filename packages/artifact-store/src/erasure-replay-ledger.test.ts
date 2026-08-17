import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ArtifactAuthenticationError,
  EncryptedArtifactStore,
  type RawArtifactStore,
} from "./artifact-encryption.js";
import {
  deriveErasureLedgerLocator,
  ErasureLedgerLocatorConfigurationError,
  parseErasureLedgerLocatorKeyRing,
} from "./erasure-ledger-locator.js";
import {
  EncryptedErasureReplayLedger,
  ErasureReplayLedgerConflictError,
} from "./erasure-replay-ledger.js";

const userA = "a0000000-0000-4000-8000-000000000001";
const userB = "b0000000-0000-4000-8000-000000000002";
const jobId = "c0000000-0000-4000-8000-000000000003";
const recordedAt = "2026-08-16T12:00:00.000Z";

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

class ImmutableMemoryRawStore implements RawArtifactStore {
  readonly objects = new Map<string, Buffer>();

  async put(input: {
    readonly objectKey: string;
    readonly source: Readable;
    readonly contentLength: number;
  }): Promise<void> {
    if (this.objects.has(input.objectKey)) throw new Error("immutable-object-exists");
    const chunks: Buffer[] = [];
    for await (const chunk of input.source) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength !== input.contentLength) throw new Error("length-mismatch");
    this.objects.set(input.objectKey, bytes);
  }

  async open(input: { readonly objectKey: string }) {
    const bytes = this.objects.get(input.objectKey);
    return bytes
      ? { contentLength: bytes.byteLength, stream: Readable.from([Buffer.from(bytes)]) }
      : null;
  }
}

function locatorRing(currentKeyId = "locator-v2") {
  return parseErasureLedgerLocatorKeyRing({
    currentKeyId,
    serializedKeys: JSON.stringify({
      "locator-v1": Buffer.alloc(32, 1).toString("base64"),
      "locator-v2": Buffer.alloc(32, 2).toString("base64"),
    }),
  });
}

function encryptedStore(rawStore: RawArtifactStore, keyIds = ["ledger-aes-v1", "ledger-aes-v2"]) {
  return new EncryptedArtifactStore({
    keyRing: {
      currentKeyId: keyIds.at(-1) as string,
      keys: new Map(keyIds.map((keyId, index) => [keyId, Buffer.alloc(32, index + 4)])),
      purpose: "erasure_replay_ledger",
    },
    nonce: () => Buffer.alloc(12, 3),
    rawStore,
  });
}

function ledger(rawStore: RawArtifactStore, currentLocatorKey = "locator-v2") {
  const ring = locatorRing(currentLocatorKey);
  return {
    instance: new EncryptedErasureReplayLedger({
      artifactStore: encryptedStore(rawStore),
      clock: () => new Date("2026-08-16T12:00:01.000Z"),
      locatorKeyRing: ring,
    }),
    ring,
  };
}

describe("encrypted external erasure replay ledger", () => {
  it("writes no raw identity, verifies before acknowledgement, and retries an exact immutable put", async () => {
    const raw = new ImmutableMemoryRawStore();
    const { instance, ring } = ledger(raw);
    const restoreLocator = deriveErasureLedgerLocator(ring, userA).value;
    const first = await instance.append({
      jobId,
      recordedAt,
      restoreLocator,
      subjectUserId: userA,
    });
    expect(first).toMatchObject({
      ackDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      replayed: false,
      reference: expect.stringMatching(/^erasure-ledger\/v1\/locator-v2\//),
    });
    const rawBytes = raw.objects.get(first.reference);
    expect(rawBytes).toBeDefined();
    expect(first.reference).not.toContain(userA);
    expect(rawBytes?.includes(Buffer.from(userA))).toBe(false);

    const retried = await instance.append({
      jobId,
      recordedAt,
      restoreLocator,
      subjectUserId: userA,
    });
    expect(retried).toMatchObject({
      ackDigest: first.ackDigest,
      reference: first.reference,
      replayed: true,
    });
    await expect(
      instance.append({
        jobId,
        recordedAt: "2026-08-16T12:00:02.000Z",
        restoreLocator,
        subjectUserId: userA,
      }),
    ).rejects.toBeInstanceOf(ErasureReplayLedgerConflictError);
  });

  it("replays from a pre-request backup using only the restored user id and reconciles zero rows", async () => {
    const raw = new ImmutableMemoryRawStore();
    const { instance, ring } = ledger(raw);
    await instance.append({
      jobId,
      recordedAt,
      restoreLocator: deriveErasureLedgerLocator(ring, userA).value,
      subjectUserId: userA,
    });
    const apply = vi.fn(async () => ({
      reconciled: true,
      remainingRows: { app_user: "0", diary_entry: "0" },
      userId: userA,
    }));
    const result = await instance.replaySubject({ apply, subjectUserId: userA });
    expect(result?.reconciled).toBe(true);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: userA, restoreLocator: expect.any(String) }),
    );
    expect(await instance.replaySubject({ apply, subjectUserId: userB })).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-user ciphertext substitution, tampering, and a wrong AES key", async () => {
    const raw = new ImmutableMemoryRawStore();
    const { instance, ring } = ledger(raw);
    const receipt = await instance.append({
      jobId,
      recordedAt,
      restoreLocator: deriveErasureLedgerLocator(ring, userA).value,
      subjectUserId: userA,
    });
    const userBPath = deriveErasureLedgerLocator(ring, userB).objectKey;
    raw.objects.set(
      userBPath,
      Buffer.from(required(raw.objects.get(receipt.reference), "Missing ledger ciphertext")),
    );
    await expect(instance.findForSubject({ subjectUserId: userB })).rejects.toBeInstanceOf(
      ArtifactAuthenticationError,
    );
    raw.objects.delete(userBPath);
    const original = Buffer.from(
      required(raw.objects.get(receipt.reference), "Missing ledger ciphertext"),
    );
    const tampered = Buffer.from(original);
    const tamperIndex = tampered.byteLength - 17;
    tampered.writeUInt8(tampered.readUInt8(tamperIndex) ^ 1, tamperIndex);
    raw.objects.set(receipt.reference, tampered);
    await expect(instance.findForSubject({ subjectUserId: userA })).rejects.toBeInstanceOf(
      ArtifactAuthenticationError,
    );

    raw.objects.set(receipt.reference, original);
    const wrongKeyLedger = new EncryptedErasureReplayLedger({
      artifactStore: new EncryptedArtifactStore({
        keyRing: {
          currentKeyId: "wrong",
          keys: new Map([["wrong", Buffer.alloc(32, 9)]]),
          purpose: "erasure_replay_ledger",
        },
        rawStore: raw,
      }),
      locatorKeyRing: ring,
    });
    await expect(wrongKeyLedger.findForSubject({ subjectUserId: userA })).rejects.toBeInstanceOf(
      ArtifactAuthenticationError,
    );
  });

  it("requires every locator and matching ledger AES key through the longest backup tail", async () => {
    const raw = new ImmutableMemoryRawStore();
    const oldRing = locatorRing("locator-v1");
    const oldAes = encryptedStore(raw, ["ledger-aes-v1"]);
    const oldLedger = new EncryptedErasureReplayLedger({
      artifactStore: oldAes,
      locatorKeyRing: oldRing,
    });
    await oldLedger.append({
      jobId,
      recordedAt,
      restoreLocator: deriveErasureLedgerLocator(oldRing, userA).value,
      subjectUserId: userA,
    });

    const retained = new EncryptedErasureReplayLedger({
      artifactStore: encryptedStore(raw, ["ledger-aes-v1", "ledger-aes-v2"]),
      locatorKeyRing: locatorRing("locator-v2"),
    });
    expect(await retained.findForSubject({ subjectUserId: userA })).toMatchObject({
      subjectUserId: userA,
    });

    const locatorRetired = parseErasureLedgerLocatorKeyRing({
      currentKeyId: "locator-v2",
      serializedKeys: JSON.stringify({
        "locator-v2": Buffer.alloc(32, 2).toString("base64"),
      }),
    });
    const prematurelyRetired = new EncryptedErasureReplayLedger({
      artifactStore: encryptedStore(raw, ["ledger-aes-v2"]),
      locatorKeyRing: locatorRetired,
    });
    expect(await prematurelyRetired.findForSubject({ subjectUserId: userA })).toBeNull();
  });

  it("executes a queued old-locator job after rotation and fails if that key was retired", async () => {
    const raw = new ImmutableMemoryRawStore();
    const oldLocator = deriveErasureLedgerLocator(locatorRing("locator-v1"), userA).value;
    const rotated = ledger(raw, "locator-v2");
    const receipt = await rotated.instance.append({
      jobId,
      recordedAt,
      restoreLocator: oldLocator,
      subjectUserId: userA,
    });
    expect(receipt.reference).toMatch(/^erasure-ledger\/v1\/locator-v1\//);
    expect(await rotated.instance.findForSubject({ subjectUserId: userA })).toMatchObject({
      recordedAt,
      restoreLocator: oldLocator,
    });

    const retiredRing = parseErasureLedgerLocatorKeyRing({
      currentKeyId: "locator-v2",
      serializedKeys: JSON.stringify({
        "locator-v2": Buffer.alloc(32, 2).toString("base64"),
      }),
    });
    const retired = new EncryptedErasureReplayLedger({
      artifactStore: encryptedStore(new ImmutableMemoryRawStore()),
      locatorKeyRing: retiredRing,
    });
    await expect(
      retired.append({ jobId, recordedAt, restoreLocator: oldLocator, subjectUserId: userA }),
    ).rejects.toBeInstanceOf(ErasureLedgerLocatorConfigurationError);
  });

  it("fails closed when two retained locator generations both contain valid tombstones", async () => {
    const raw = new ImmutableMemoryRawStore();
    for (const keyId of ["locator-v1", "locator-v2"]) {
      const ring = locatorRing(keyId);
      const writer = new EncryptedErasureReplayLedger({
        artifactStore: encryptedStore(raw),
        locatorKeyRing: ring,
      });
      await writer.append({
        jobId,
        recordedAt,
        restoreLocator: deriveErasureLedgerLocator(ring, userA).value,
        subjectUserId: userA,
      });
    }
    const reader = ledger(raw).instance;
    await expect(reader.findForSubject({ subjectUserId: userA })).rejects.toBeInstanceOf(
      ErasureReplayLedgerConflictError,
    );
  });
});
