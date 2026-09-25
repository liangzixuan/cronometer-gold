import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ArtifactAuthenticationError,
  type EncryptedArtifactMetadata,
  EncryptedArtifactStore,
} from "./artifact-encryption.js";
import { parseErasureLedgerLocatorKeyRing } from "./erasure-ledger-locator.js";
import { EncryptedErasureReplayLedger } from "./erasure-replay-ledger.js";
import { S3ArtifactStoreError, S3RawArtifactStore } from "./s3-raw-artifact-store.js";

const enabled = process.env.RUN_ARTIFACT_STORE_INTEGRATION === "1";

function integrationCredentials(environment: Readonly<NodeJS.ProcessEnv>) {
  const pair = (prefix: string) => {
    const value = (suffix: string): string => {
      const name = `${prefix}_${suffix}`;
      const credential = environment[name];
      if (!credential?.trim()) throw new Error(`Missing integration credential: ${name}`);
      return credential;
    };
    return {
      accessKeyId: value("ACCESS_KEY_ID"),
      secretAccessKey: value("SECRET_ACCESS_KEY"),
    };
  };
  const credentials = {
    admin: pair("ARTIFACT_STORE_ADMIN"),
    exportWriter: pair("EXPORT_ARTIFACT_WRITE"),
    exportReader: pair("EXPORT_ARTIFACT_READ"),
    ledgerWriter: pair("ERASURE_REPLAY_LEDGER_WRITE"),
    ledgerRestore: pair("ERASURE_REPLAY_LEDGER_RESTORE"),
  };
  if (new Set(Object.values(credentials).map(({ accessKeyId }) => accessKeyId)).size !== 5) {
    throw new Error("Integration storage principals must be distinct");
  }
  return credentials;
}

describe("S3 integration credential prerequisites", () => {
  const environment = (): NodeJS.ProcessEnv =>
    Object.fromEntries(
      [
        "ARTIFACT_STORE_ADMIN",
        "EXPORT_ARTIFACT_WRITE",
        "EXPORT_ARTIFACT_READ",
        "ERASURE_REPLAY_LEDGER_WRITE",
        "ERASURE_REPLAY_LEDGER_RESTORE",
      ].flatMap((prefix) => [
        [`${prefix}_ACCESS_KEY_ID`, `${prefix}-test-id`],
        [`${prefix}_SECRET_ACCESS_KEY`, `${prefix}-test-secret`],
      ]),
    );

  it("requires explicit administrator credentials even if legacy root values exist", () => {
    const values = environment();
    delete values.ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID;
    values.MINIO_ROOT_USER = "legacy-root";
    values.MINIO_ROOT_PASSWORD = "legacy-secret";
    expect(() => integrationCredentials(values)).toThrow(
      "Missing integration credential: ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID",
    );
  });

  it("rejects an absent or blank role secret before opening any connection", () => {
    const values = environment();
    delete values.ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY;
    expect(() => integrationCredentials(values)).toThrow(
      "Missing integration credential: ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    );
    values.ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY = " ";
    expect(() => integrationCredentials(values)).toThrow(
      "Missing integration credential: ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    );
  });

  it("rejects reused principals and accepts five explicit distinct accounts", () => {
    const values = environment();
    expect(Object.keys(integrationCredentials(values))).toHaveLength(5);
    values.EXPORT_ARTIFACT_READ_ACCESS_KEY_ID = values.EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID;
    expect(() => integrationCredentials(values)).toThrow(
      "Integration storage principals must be distinct",
    );
  });
});

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
  let credentials: ReturnType<typeof integrationCredentials>;
  beforeAll(() => {
    credentials = integrationCredentials(process.env);
  });
  it("crosses worker-write/API-read credentials, rejects copied ciphertext, is immutable, and expires by deletion", async () => {
    const writerRaw = rawStore(
      credentials.exportWriter.accessKeyId,
      credentials.exportWriter.secretAccessKey,
      { deleteVersionPolicy: "suspended_null" },
    );
    const readerRaw = rawStore(
      credentials.exportReader.accessKeyId,
      credentials.exportReader.secretAccessKey,
    );
    const adminRaw = rawStore(credentials.admin.accessKeyId, credentials.admin.secretAccessKey);
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

      // The object exists and the valid reader can read it below. Authentication
      // rejection must be an actual 403, not a missing object or transport failure.
      const anonymousUrl = new URL(
        `/${process.env.EXPORT_ARTIFACT_BUCKET ?? "nutrition-private-exports"}/${objectKey}`,
        process.env.EXPORT_ARTIFACT_ENDPOINT ?? "http://127.0.0.1:9000",
      );
      const anonymous = await fetch(anonymousUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      try {
        expect(anonymous.status).toBe(403);
      } finally {
        await anonymous.body?.cancel();
      }
      const wrongSecret = rawStore(
        credentials.exportReader.accessKeyId,
        `${credentials.exportReader.secretAccessKey}-incorrect`,
      );
      await expect(wrongSecret.open({ objectKey })).rejects.toMatchObject({
        name: "S3ArtifactStoreError",
        statusCode: 403,
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
      credentials.ledgerWriter.accessKeyId,
      credentials.ledgerWriter.secretAccessKey,
      { bucket },
    );
    const restoreRaw = rawStore(
      credentials.ledgerRestore.accessKeyId,
      credentials.ledgerRestore.secretAccessKey,
      { bucket, readVersionPolicy: "require_singleton" },
    );
    const adminRaw = rawStore(credentials.admin.accessKeyId, credentials.admin.secretAccessKey, {
      bucket,
    });
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
    const versions = await adminRaw.listObjectVersions({ objectKey: receipt.reference });
    expect(versions).toEqual([expect.objectContaining({ deleteMarker: false, isLatest: true })]);
    const version = required(versions[0], "Missing immutable ledger version");
    expect(version.versionId).not.toBe("null");
    expect(version.versionId.length).toBeGreaterThan(0);
    expect(await restoreRaw.resolveSingletonVersion({ objectKey: receipt.reference })).toEqual({
      versionId: version.versionId,
    });
    const exact = required(
      await restoreRaw.open({ objectKey: receipt.reference }),
      "Missing exact ledger version",
    );
    try {
      // The strict S3 reader requests this version and rejects a different/missing
      // response header. Retain direct evidence from the real HTTP response too.
      expect(exact.stream).toHaveProperty(["headers", "x-amz-version-id"], version.versionId);
      expect((await collect(exact.stream)).byteLength).toBe(exact.contentLength);
    } finally {
      exact.stream.destroy();
    }

    await expect(writerRaw.delete({ objectKey: receipt.reference })).rejects.toMatchObject({
      name: "S3ArtifactStoreError",
      statusCode: 403,
    });

    // Test the prefix condition independently of a missing key or the singleton
    // reader's initial ListVersions request: this object exists outside the prefix.
    const outsideKey = `integration/${randomBytes(16).toString("hex")}/outside-ledger.enc`;
    const outsideBytes = Buffer.from("synthetic-outside-prefix-ciphertext");
    await adminRaw.put({
      contentLength: outsideBytes.byteLength,
      objectKey: outsideKey,
      source: Readable.from([outsideBytes]),
    });
    const outside = required(
      await adminRaw.open({ objectKey: outsideKey }),
      "Missing prefix fixture",
    );
    expect(await collect(outside.stream)).toEqual(outsideBytes);
    await expect(restoreRaw.listObjectVersions({ objectKey: outsideKey })).rejects.toMatchObject({
      name: "S3ArtifactStoreError",
      statusCode: 403,
    });
    const restoreDirect = rawStore(
      credentials.ledgerRestore.accessKeyId,
      credentials.ledgerRestore.secretAccessKey,
      { bucket },
    );
    await expect(restoreDirect.open({ objectKey: outsideKey })).rejects.toMatchObject({
      name: "S3ArtifactStoreError",
      statusCode: 403,
    });
    // The same direct reader is allowed inside the prefix, so the negative above
    // cannot pass merely because this principal lacks all GetObject authority.
    const allowed = required(
      await restoreDirect.open({ objectKey: receipt.reference }),
      "Missing permitted ledger object",
    );
    expect((await collect(allowed.stream)).byteLength).toBe(allowed.contentLength);
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
