import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactAuthenticationError,
  ArtifactEncryptionConfigurationError,
  EncryptedArtifactStore,
  FileRawArtifactStore,
  parseArtifactEncryptionKeyRing,
  type RawArtifactStore,
} from "./artifact-encryption.js";

class MemoryRawArtifactStore implements RawArtifactStore {
  readonly objects = new Map<string, Buffer>();

  async put(input: {
    readonly objectKey: string;
    readonly source: Readable;
    readonly contentLength: number;
  }): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of input.source) chunks.push(Buffer.from(chunk as Uint8Array));
    const value = Buffer.concat(chunks);
    expect(value.byteLength).toBe(input.contentLength);
    this.objects.set(input.objectKey, value);
  }

  async open(input: { readonly objectKey: string }) {
    const value = this.objects.get(input.objectKey);
    return value
      ? { contentLength: value.byteLength, stream: Readable.from([Buffer.from(value)]) }
      : null;
  }

  async delete(input: { readonly objectKey: string }): Promise<void> {
    this.objects.delete(input.objectKey);
  }
}

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

function keyRing() {
  return {
    currentKeyId: "export-key-2026-08",
    purpose: "export",
    keys: new Map([
      ["export-key-2026-07", Buffer.alloc(32, 7)],
      ["export-key-2026-08", Buffer.alloc(32, 8)],
    ]),
  } as const;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

describe("encrypted export artifact store", () => {
  it("streams AES-256-GCM ciphertext to raw storage and authenticates before returning plaintext", async () => {
    const raw = new MemoryRawArtifactStore();
    const plaintext = Buffer.from('{"exactDecimal":"72.125","private":"never-at-rest"}\n');
    const store = new EncryptedArtifactStore({
      keyRing: keyRing(),
      nonce: () => Buffer.alloc(12, 9),
      rawStore: raw,
    });
    const metadata = await store.put({
      mediaType: "application/json",
      objectKey: "exports/user/job/account.json.enc",
      plaintextBytes: plaintext.byteLength,
      source: Readable.from([plaintext.subarray(0, 7), plaintext.subarray(7)]),
    });

    const encrypted = raw.objects.get(metadata.objectKey);
    expect(encrypted).toBeDefined();
    expect(encrypted?.includes(Buffer.from("never-at-rest"))).toBe(false);
    expect(metadata).toMatchObject({
      encryptionKeyId: "export-key-2026-08",
      envelopeVersion: 1,
      plaintextBytes: plaintext.byteLength,
      plaintextSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const opened = required(
      await store.openAuthenticated(metadata),
      "Missing authenticated export",
    );
    expect(await collect(opened.stream)).toEqual(plaintext);
    await opened.dispose();
  });

  it("deletes the immutable ciphertext, verifies absence, and returns domain-bound evidence", async () => {
    const raw = new MemoryRawArtifactStore();
    const store = new EncryptedArtifactStore({ keyRing: keyRing(), rawStore: raw });
    const bytes = Buffer.from("private export");
    const metadata = await store.put({
      mediaType: "application/json",
      objectKey: "exports/delete-me.json.enc",
      plaintextBytes: bytes.byteLength,
      source: Readable.from([bytes]),
    });
    const result = await store.deleteVerified({ objectKey: metadata.objectKey });
    expect(result).toEqual({
      deletionEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      objectKey: metadata.objectKey,
    });
    expect(raw.objects.has(metadata.objectKey)).toBe(false);
  });

  it("rejects ciphertext, tag, context, length, digest, and missing-key tampering before exposing a stream", async () => {
    const raw = new MemoryRawArtifactStore();
    const plaintext = Buffer.from("private export payload");
    const store = new EncryptedArtifactStore({
      keyRing: keyRing(),
      nonce: () => Buffer.alloc(12, 4),
      rawStore: raw,
    });
    const metadata = await store.put({
      mediaType: "application/json",
      objectKey: "exports/a.json.enc",
      plaintextBytes: plaintext.byteLength,
      source: Readable.from([plaintext]),
    });
    const original = Buffer.from(
      required(raw.objects.get(metadata.objectKey), "Missing encrypted artifact"),
    );

    const attempts = [
      () => {
        const tampered = Buffer.from(original);
        const index = tampered.byteLength - 17;
        tampered.writeUInt8(tampered.readUInt8(index) ^ 1, index);
        raw.objects.set(metadata.objectKey, tampered);
        return store.openAuthenticated(metadata);
      },
      () => {
        raw.objects.set(metadata.objectKey, original);
        return store.openAuthenticated({ ...metadata, mediaType: "application/zip" });
      },
      () => store.openAuthenticated({ ...metadata, plaintextBytes: metadata.plaintextBytes + 1 }),
      () =>
        store.openAuthenticated({
          ...metadata,
          mediaType: "text/plain" as unknown as typeof metadata.mediaType,
        }),
      () => store.openAuthenticated({ ...metadata, ciphertextBytes: metadata.ciphertextBytes + 1 }),
      () => store.openAuthenticated({ ...metadata, plaintextSha256: "0".repeat(64) }),
      () =>
        new EncryptedArtifactStore({
          keyRing: {
            currentKeyId: "replacement",
            keys: new Map([["replacement", randomBytes(32)]]),
            purpose: "export",
          },
          rawStore: raw,
        }).openAuthenticated(metadata),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ArtifactAuthenticationError);
      raw.objects.set(metadata.objectKey, Buffer.from(original));
    }
  });

  it("keeps only encrypted, mode-0600 bytes in the local raw store", async () => {
    const root = join(tmpdir(), `nutrition-export-store-${randomBytes(12).toString("hex")}`);
    cleanupDirectories.push(root);
    const plaintext = Buffer.from("raw-health-detail-must-not-land-on-volume");
    const store = new EncryptedArtifactStore({
      keyRing: keyRing(),
      rawStore: new FileRawArtifactStore(root),
    });
    const metadata = await store.put({
      mediaType: "application/zip",
      objectKey: "exports/one/csv.zip.enc",
      plaintextBytes: plaintext.byteLength,
      source: Readable.from([plaintext]),
    });
    const path = join(root, metadata.objectKey);
    const bytes = await readFile(path);
    expect(bytes.includes(plaintext)).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects ciphertext across export and erasure-ledger cryptographic domains even with a reused key", async () => {
    const raw = new MemoryRawArtifactStore();
    const sharedKey = Buffer.alloc(32, 6);
    const exportStore = new EncryptedArtifactStore({
      keyRing: {
        currentKeyId: "shared-misconfiguration",
        keys: new Map([["shared-misconfiguration", sharedKey]]),
        purpose: "export",
      },
      nonce: () => Buffer.alloc(12, 7),
      rawStore: raw,
    });
    const ledgerStore = new EncryptedArtifactStore({
      keyRing: {
        currentKeyId: "shared-misconfiguration",
        keys: new Map([["shared-misconfiguration", sharedKey]]),
        purpose: "erasure_replay_ledger",
      },
      rawStore: raw,
    });
    const payload = Buffer.from('{"userId":"private-subject"}');
    const metadata = await exportStore.put({
      mediaType: "application/json",
      objectKey: "cross-purpose/same-key.enc",
      plaintextBytes: payload.byteLength,
      source: Readable.from([payload]),
    });
    await expect(ledgerStore.openAuthenticated(metadata)).rejects.toBeInstanceOf(
      ArtifactAuthenticationError,
    );
  });

  it("discovers and authenticates ledger envelope metadata without an in-database receipt", async () => {
    const raw = new MemoryRawArtifactStore();
    const store = new EncryptedArtifactStore({
      keyRing: {
        currentKeyId: "ledger-v1",
        keys: new Map([["ledger-v1", Buffer.alloc(32, 5)]]),
        purpose: "erasure_replay_ledger",
      },
      nonce: () => Buffer.alloc(12, 2),
      rawStore: raw,
    });
    const payload = Buffer.from('{"subjectUserId":"a0000000-0000-4000-8000-000000000001"}');
    const written = await store.put({
      mediaType: "application/json",
      objectKey: "erasure-ledger/v1/locator-v1/opaque.json.enc",
      plaintextBytes: payload.byteLength,
      source: Readable.from([payload]),
    });
    const discovered = required(
      await store.openAuthenticatedByObject({
        mediaType: "application/json",
        objectKey: written.objectKey,
      }),
      "Missing authenticated ledger entry",
    );
    expect(discovered.metadata).toEqual(written);
    expect(await collect(discovered.stream)).toEqual(payload);
    await discovered.dispose();
  });

  it("verifies an exact retry without creating a second plaintext spool", async () => {
    const raw = new MemoryRawArtifactStore();
    const directory = join(tmpdir(), `nutrition-retry-verify-${randomBytes(12).toString("hex")}`);
    cleanupDirectories.push(directory);
    await mkdir(directory, { mode: 0o700 });
    const store = new EncryptedArtifactStore({
      keyRing: keyRing(),
      nonce: () => Buffer.alloc(12, 3),
      rawStore: raw,
      temporaryDirectory: directory,
    });
    const payload = Buffer.from("near-cap artifact is streamed and discarded during exact retry");
    const metadata = await store.put({
      mediaType: "application/json",
      objectKey: "exports/retry/account.json.enc",
      plaintextBytes: payload.byteLength,
      source: Readable.from([payload]),
    });
    await expect(
      store.verifyAuthenticatedByObject({
        expectedPlaintextBytes: metadata.plaintextBytes,
        expectedPlaintextSha256: metadata.plaintextSha256,
        mediaType: metadata.mediaType,
        objectKey: metadata.objectKey,
      }),
    ).resolves.toEqual(metadata);
    expect(await readdir(directory)).toEqual([]);
    await expect(
      store.verifyAuthenticatedByObject({
        expectedPlaintextBytes: metadata.plaintextBytes,
        expectedPlaintextSha256: "0".repeat(64),
        mediaType: metadata.mediaType,
        objectKey: metadata.objectKey,
      }),
    ).rejects.toBeInstanceOf(ArtifactAuthenticationError);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("artifact encryption key configuration", () => {
  it("loads a versioned 256-bit key ring and keeps older read keys", () => {
    const current = randomBytes(32).toString("base64");
    const old = randomBytes(32).toString("base64");
    const result = parseArtifactEncryptionKeyRing({
      currentKeyId: "key-v2",
      purpose: "export",
      serializedKeys: JSON.stringify({ "key-v1": old, "key-v2": current }),
    });
    expect(result.currentKeyId).toBe("key-v2");
    expect(result.keys.get("key-v1")).toHaveLength(32);
  });

  it.each([
    { currentKeyId: undefined, serializedKeys: undefined },
    {
      currentKeyId: "missing",
      serializedKeys: JSON.stringify({ present: randomBytes(32).toString("base64") }),
    },
    { currentKeyId: "bad key id", serializedKeys: "{}" },
    {
      currentKeyId: "short",
      serializedKeys: JSON.stringify({ short: Buffer.alloc(31).toString("base64") }),
    },
  ])("fails closed without one selected valid AES-256 key", (input) => {
    expect(() => parseArtifactEncryptionKeyRing({ ...input, purpose: "export" })).toThrow(
      ArtifactEncryptionConfigurationError,
    );
  });

  it("uses ledger-specific configuration fields", () => {
    expect(() =>
      parseArtifactEncryptionKeyRing({
        currentKeyId: undefined,
        purpose: "erasure_replay_ledger",
        serializedKeys: undefined,
      }),
    ).toThrowError(expect.objectContaining({ field: "ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID" }));
  });
});
