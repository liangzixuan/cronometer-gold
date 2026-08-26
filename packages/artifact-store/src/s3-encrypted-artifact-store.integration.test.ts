import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  ArtifactAuthenticationError,
  type EncryptedArtifactMetadata,
  EncryptedArtifactStore,
} from "./artifact-encryption.js";
import { parseErasureLedgerLocatorKeyRing } from "./erasure-ledger-locator.js";
import { EncryptedErasureReplayLedger } from "./erasure-replay-ledger.js";
import { S3ArtifactStoreError, S3RawArtifactStore } from "./s3-raw-artifact-store.js";

const enabled = process.env.RUN_ARTIFACT_STORE_INTEGRATION === "1";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function rawStore(
  accessKeyId: string,
  secretAccessKey: string,
  options: {
    readonly bucket?: string;
    readonly deleteVersionPolicy?: "latest" | "suspended_null";
    readonly readVersionPolicy?: "latest" | "require_singleton";
  } = {},
) {
  return new S3RawArtifactStore({
    accessKeyId,
    bucket: options.bucket ?? process.env.EXPORT_ARTIFACT_BUCKET ?? "nutrition-private-exports",
    endpoint: process.env.EXPORT_ARTIFACT_ENDPOINT ?? "http://127.0.0.1:9000",
    ...(options.deleteVersionPolicy ? { deleteVersionPolicy: options.deleteVersionPolicy } : {}),
    ...(options.readVersionPolicy ? { readVersionPolicy: options.readVersionPolicy } : {}),
    region: process.env.EXPORT_ARTIFACT_REGION ?? "us-east-1",
    requestTimeoutMs: 5_000,
    secretAccessKey,
  });
}

describe.skipIf(!enabled)("live S3 encrypted artifact boundary", () => {
  it("crosses worker-write/API-read credentials, rejects copied ciphertext, is immutable, and expires by deletion", async () => {
    const writerRaw = rawStore(
      process.env.EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID ?? "nutrition_export_writer",
      process.env.EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY ?? "nutrition_export_writer_local_only",
      { deleteVersionPolicy: "suspended_null" },
    );
    const readerRaw = rawStore(
      process.env.EXPORT_ARTIFACT_READ_ACCESS_KEY_ID ?? "nutrition_export_reader",
      process.env.EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY ?? "nutrition_export_reader_local_only",
    );
    const adminRaw = rawStore(
      process.env.ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID ??
        process.env.MINIO_ROOT_USER ??
        "nutrition_local",
      process.env.ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY ??
        process.env.MINIO_ROOT_PASSWORD ??
        "nutrition_local_password_only",
    );
    const keyRing = {
      currentKeyId: "integration-export-key-v1",
      keys: new Map([["integration-export-key-v1", Buffer.alloc(32, 23)]]),
      purpose: "export",
    } as const;
    const writer = new EncryptedArtifactStore({ keyRing, rawStore: writerRaw });
    const reader = new EncryptedArtifactStore({ keyRing, rawStore: readerRaw });
    const suffix = randomBytes(16).toString("hex");
    const objectKey = `integration/${suffix}/account.json.enc`;
    const copiedKey = `integration/${suffix}/copied.json.enc`;
    const plaintext = Buffer.from(
      '{"exactDecimal":"72.125","privateHealthDetail":"encrypted"}\n',
      "utf8",
    );
    let metadata: EncryptedArtifactMetadata | null = null;
    try {
      metadata = await writer.put({
        mediaType: "application/json",
        objectKey,
        plaintextBytes: plaintext.byteLength,
        source: Readable.from([plaintext]),
      });

      // A second write to the same random key must fail instead of overwriting a
      // ready artifact, even when all plaintext metadata is identical.
      await expect(
        writer.put({
          mediaType: "application/json",
          objectKey,
          plaintextBytes: plaintext.byteLength,
          source: Readable.from([plaintext]),
        }),
      ).rejects.toBeInstanceOf(S3ArtifactStoreError);

      const opened = required(
        await reader.openAuthenticated(metadata),
        "Missing authenticated export artifact",
      );
      expect(await collect(opened.stream)).toEqual(plaintext);
      await opened.dispose();

      const encrypted = required(await writerRaw.open({ objectKey }), "Missing ciphertext object");
      const ciphertext = await collect(encrypted.stream);
      expect(ciphertext.includes(plaintext)).toBe(false);
      await writerRaw.put({
        contentLength: ciphertext.byteLength,
        objectKey: copiedKey,
        source: Readable.from([ciphertext]),
      });
      await expect(
        reader.openAuthenticated({ ...metadata, objectKey: copiedKey }),
      ).rejects.toBeInstanceOf(ArtifactAuthenticationError);

      // Expiry removes the sole ciphertext object (the export bucket deliberately
      // has versioning suspended); reader credentials cannot observe it afterward.
      await writerRaw.delete({ objectKey });
      expect(await reader.openAuthenticated(metadata)).toBeNull();
      expect(await adminRaw.listObjectVersions({ objectKey })).toEqual([]);

      await expect(
        readerRaw.put({
          contentLength: 1,
          objectKey: `${objectKey}.reader-put`,
          source: Readable.from([Buffer.from([1])]),
        }),
      ).rejects.toBeInstanceOf(S3ArtifactStoreError);
      await expect(readerRaw.delete({ objectKey: copiedKey })).rejects.toBeInstanceOf(
        S3ArtifactStoreError,
      );
      await expect(writerRaw.listObjectVersions({ objectKey: copiedKey })).rejects.toBeInstanceOf(
        S3ArtifactStoreError,
      );
    } finally {
      await writerRaw.delete?.({ objectKey }).catch(() => undefined);
      await writerRaw.delete?.({ objectKey: copiedKey }).catch(() => undefined);
    }
  });

  it("writes one immutable encrypted ledger version and enforces restore-only version-aware access", async () => {
    const bucket = process.env.ERASURE_REPLAY_LEDGER_BUCKET ?? "nutrition-erasure-ledger";
    const writerRaw = rawStore(
      process.env.ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID ?? "nutrition_erasure_writer",
      process.env.ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY ??
        "nutrition_erasure_writer_local_only",
      { bucket },
    );
    const restoreRaw = rawStore(
      process.env.ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID ?? "nutrition_erasure_restore",
      process.env.ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY ??
        "nutrition_erasure_restore_local_only",
      { bucket, readVersionPolicy: "require_singleton" },
    );
    const adminRaw = rawStore(
      process.env.ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID ??
        process.env.MINIO_ROOT_USER ??
        "nutrition_local",
      process.env.ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY ??
        process.env.MINIO_ROOT_PASSWORD ??
        "nutrition_local_password_only",
      { bucket },
    );
    const keyRing = {
      currentKeyId: "integration-ledger-key-v1",
      keys: new Map([["integration-ledger-key-v1", Buffer.alloc(32, 24)]]),
      purpose: "erasure_replay_ledger",
    } as const;
    const locatorKeyRing = parseErasureLedgerLocatorKeyRing({
      currentKeyId: "integration-locator-v1",
      serializedKeys: JSON.stringify({
        "integration-locator-v1": Buffer.alloc(32, 25).toString("base64"),
      }),
    });
    const writer = new EncryptedErasureReplayLedger({
      artifactStore: new EncryptedArtifactStore({ keyRing, rawStore: writerRaw }),
      locatorKeyRing,
    });
    const restore = new EncryptedErasureReplayLedger({
      artifactStore: new EncryptedArtifactStore({ keyRing, rawStore: restoreRaw }),
      locatorKeyRing,
    });
    const subjectUserId = randomUUID();
    const jobId = randomUUID();
    const restoreLocator = writer.locatorForSubject(subjectUserId);
    const receipt = await writer.append({
      jobId,
      recordedAt: "2026-08-16T12:00:00.000Z",
      restoreLocator,
      subjectUserId,
    });
    expect(await restore.findForSubject({ subjectUserId })).toMatchObject({ jobId, subjectUserId });
    expect(await adminRaw.listObjectVersions({ objectKey: receipt.reference })).toEqual([
      expect.objectContaining({ deleteMarker: false }),
    ]);
    await expect(
      writerRaw.put({
        contentLength: 1,
        objectKey: receipt.reference,
        source: Readable.from([Buffer.from([1])]),
      }),
    ).rejects.toBeInstanceOf(S3ArtifactStoreError);
    await expect(
      writerRaw.listObjectVersions({ objectKey: receipt.reference }),
    ).rejects.toBeInstanceOf(S3ArtifactStoreError);
    await expect(restoreRaw.delete({ objectKey: receipt.reference })).rejects.toBeInstanceOf(
      S3ArtifactStoreError,
    );
    await expect(
      restoreRaw.put({
        contentLength: 1,
        objectKey: `${receipt.reference}.restore-put`,
        source: Readable.from([Buffer.from([1])]),
      }),
    ).rejects.toBeInstanceOf(S3ArtifactStoreError);
    expect(await adminRaw.listObjectVersions({ objectKey: receipt.reference })).toHaveLength(1);
  });
});
