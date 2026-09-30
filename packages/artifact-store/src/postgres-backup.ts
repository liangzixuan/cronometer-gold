import { createHash } from "node:crypto";
import { constants, type ReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import { finished } from "node:stream/promises";

import {
  type ArtifactEncryptionKeyRing,
  type DiscoveredAuthenticatedArtifactRead,
  type EncryptedArtifactMetadata,
  EncryptedArtifactStore,
  MAX_ARTIFACT_ENVELOPE_OVERHEAD_BYTES,
  POSTGRES_BACKUP_MEDIA_TYPE,
  type RawArtifactStore,
} from "./artifact-encryption.js";

const MAGIC = Buffer.from("NTPB0002", "ascii");
const HEADER_BYTES = MAGIC.byteLength + 4;
const MAX_MANIFEST_BYTES = 16_384;
const MAX_SOURCE_EVIDENCE_BYTES = 1_048_576;
const DUMP_MAGIC = Buffer.from("PGDMP", "ascii");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/;
const DATABASE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Authenticated caller claims; this module does not collect or prove a SQL snapshot. */
export interface PostgresBackupManifest {
  readonly formatVersion: "nutrition-postgres-backup-v2";
  readonly backupId: string;
  readonly capturedAt: string;
  readonly databaseName: string;
  readonly deploymentTarget: "staging" | "production";
  readonly dumpBytes: number;
  readonly dumpSha256: string;
  readonly snapshotId: string;
  readonly sourceEvidenceBytes: number;
  readonly sourceEvidenceSha256: string;
  readonly sourceRevision: string;
}

export interface PostgresBackupExpectedIdentity {
  readonly backupId: string;
  readonly databaseName: string;
  readonly deploymentTarget: "staging" | "production";
  readonly manifestSha256: string;
  readonly snapshotId: string;
  readonly sourceRevision: string;
}

export interface RecoveredPostgresBackup {
  readonly manifest: PostgresBackupManifest;
  readonly manifestBytes: Buffer;
  readonly metadata: EncryptedArtifactMetadata;
  /** Authenticated opaque bytes; a separate restore adapter must validate their semantics. */
  readonly sourceEvidence: Buffer;
  readonly dump: ReadStream;
  /** Await disposal even after stream end or cancellation; removes the sole private spool. */
  dispose(): Promise<void>;
}

export class PostgresBackupAuthenticationError extends Error {
  constructor() {
    super("PostgreSQL backup authentication failed");
    this.name = "PostgresBackupAuthenticationError";
  }
}

function requireBackup(condition: unknown): asserts condition {
  if (!condition) throw new PostgresBackupAuthenticationError();
}

function validIdentity(value: {
  readonly backupId: unknown;
  readonly databaseName: unknown;
  readonly deploymentTarget: unknown;
  readonly snapshotId: unknown;
  readonly sourceRevision: unknown;
}): void {
  requireBackup(typeof value.backupId === "string" && UUID.test(value.backupId));
  requireBackup(typeof value.databaseName === "string" && DATABASE.test(value.databaseName));
  requireBackup(value.deploymentTarget === "staging" || value.deploymentTarget === "production");
  requireBackup(typeof value.snapshotId === "string" && SNAPSHOT.test(value.snapshotId));
  requireBackup(typeof value.sourceRevision === "string" && REVISION.test(value.sourceRevision));
}

function manifestBytes(manifest: PostgresBackupManifest): Buffer {
  return Buffer.from(
    JSON.stringify({
      backupId: manifest.backupId,
      capturedAt: manifest.capturedAt,
      databaseName: manifest.databaseName,
      deploymentTarget: manifest.deploymentTarget,
      dumpBytes: manifest.dumpBytes,
      dumpSha256: manifest.dumpSha256,
      formatVersion: manifest.formatVersion,
      snapshotId: manifest.snapshotId,
      sourceEvidenceBytes: manifest.sourceEvidenceBytes,
      sourceEvidenceSha256: manifest.sourceEvidenceSha256,
      sourceRevision: manifest.sourceRevision,
    }),
    "utf8",
  );
}

function parseManifest(bytes: Buffer, maximumDumpBytes: number): PostgresBackupManifest {
  requireBackup(bytes.byteLength > 0 && bytes.byteLength <= MAX_MANIFEST_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PostgresBackupAuthenticationError();
  }
  requireBackup(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  requireBackup(Object.getPrototypeOf(parsed) === Object.prototype);
  requireBackup(
    Object.keys(parsed).sort().join(",") ===
      "backupId,capturedAt,databaseName,deploymentTarget,dumpBytes,dumpSha256,formatVersion,snapshotId,sourceEvidenceBytes,sourceEvidenceSha256,sourceRevision",
  );
  const value = parsed as Record<string, unknown>;
  validIdentity({
    backupId: value.backupId,
    databaseName: value.databaseName,
    deploymentTarget: value.deploymentTarget,
    snapshotId: value.snapshotId,
    sourceRevision: value.sourceRevision,
  });
  requireBackup(value.formatVersion === "nutrition-postgres-backup-v2");
  requireBackup(
    typeof value.capturedAt === "string" &&
      Number.isFinite(Date.parse(value.capturedAt)) &&
      new Date(value.capturedAt).toISOString() === value.capturedAt,
  );
  requireBackup(
    typeof value.dumpBytes === "number" &&
      Number.isSafeInteger(value.dumpBytes) &&
      value.dumpBytes >= DUMP_MAGIC.byteLength &&
      value.dumpBytes <= maximumDumpBytes,
  );
  requireBackup(typeof value.dumpSha256 === "string" && SHA256.test(value.dumpSha256));
  requireBackup(
    typeof value.sourceEvidenceBytes === "number" &&
      Number.isSafeInteger(value.sourceEvidenceBytes) &&
      value.sourceEvidenceBytes > 0 &&
      value.sourceEvidenceBytes <= MAX_SOURCE_EVIDENCE_BYTES,
  );
  requireBackup(
    typeof value.sourceEvidenceSha256 === "string" && SHA256.test(value.sourceEvidenceSha256),
  );
  const manifest = value as unknown as PostgresBackupManifest;
  // Byte equality rejects duplicate keys, extra whitespace, alternate encodings
  // and noncanonical numbers without silently rewriting caller evidence.
  requireBackup(manifestBytes(manifest).equals(bytes));
  return Object.freeze(manifest);
}

function objectKey(identity: {
  readonly backupId: string;
  readonly sourceRevision: string;
}): string {
  return `postgres-backups/v2/${identity.sourceRevision}/${identity.backupId}.pgbackup.enc`;
}

function own(stream: Readable, signal: AbortSignal | undefined, streams: Set<Readable>): Readable {
  streams.add(stream);
  // Errors remain visible to async iteration without becoming unhandled before
  // a returned private stream has been attached to its consumer.
  stream.on("error", () => undefined);
  if (signal) addAbortSignal(signal, stream);
  return stream;
}

function chunkBytes(chunk: unknown, remaining: number): Buffer {
  requireBackup(chunk instanceof Uint8Array && chunk.byteLength <= remaining);
  return Buffer.from(chunk);
}

async function* frameDump(
  manifest: Buffer,
  sourceEvidence: Buffer,
  claims: PostgresBackupManifest,
  dump: Readable,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer> {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(manifest.byteLength, MAGIC.byteLength);
  yield header;
  yield manifest;
  yield sourceEvidence;
  let count = 0;
  let signature = Buffer.alloc(0);
  const digest = createHash("sha256");
  for await (const chunk of dump) {
    signal?.throwIfAborted();
    const bytes = chunkBytes(chunk, claims.dumpBytes - count);
    count += bytes.byteLength;
    if (signature.byteLength < DUMP_MAGIC.byteLength) {
      signature = Buffer.concat([
        signature,
        bytes.subarray(0, DUMP_MAGIC.byteLength - signature.byteLength),
      ]);
    }
    digest.update(bytes);
    yield bytes;
  }
  signal?.throwIfAborted();
  requireBackup(
    count === claims.dumpBytes &&
      signature.equals(DUMP_MAGIC) &&
      digest.digest("hex") === claims.dumpSha256,
  );
}

async function readExactly(
  file: FileHandle,
  length: number,
  position: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    signal?.throwIfAborted();
    const read = await file.read(bytes, count, length - count, position + count);
    requireBackup(read.bytesRead > 0);
    count += read.bytesRead;
  }
  signal?.throwIfAborted();
  return bytes;
}

/**
 * The supplied raw adapter must atomically reject existing keys, consume the
 * complete source before publishing, and honor AbortSignal. FileRawArtifactStore
 * supplies this locally; production needs separate provider/version qualification.
 * A rejected or aborted write is never deleted or retried by this layer.
 */
export class EncryptedPostgresBackupStore {
  readonly #rawStore: RawArtifactStore;
  readonly #keyRing: ArtifactEncryptionKeyRing;
  readonly #temporaryDirectory: string;
  readonly #maxDumpBytes: number;

  constructor(input: {
    readonly rawStore: RawArtifactStore;
    readonly keyRing: ArtifactEncryptionKeyRing;
    readonly temporaryDirectory: string;
    readonly maxDumpBytes: number;
  }) {
    requireBackup(input.keyRing.purpose === "postgres_backup");
    requireBackup(
      typeof input.temporaryDirectory === "string" && isAbsolute(input.temporaryDirectory),
    );
    requireBackup(
      Number.isSafeInteger(input.maxDumpBytes) &&
        input.maxDumpBytes >= DUMP_MAGIC.byteLength &&
        input.maxDumpBytes <=
          Number.MAX_SAFE_INTEGER -
            MAX_MANIFEST_BYTES -
            MAX_SOURCE_EVIDENCE_BYTES -
            HEADER_BYTES -
            MAX_ARTIFACT_ENVELOPE_OVERHEAD_BYTES,
    );
    this.#rawStore = input.rawStore;
    this.#keyRing = {
      purpose: "postgres_backup",
      currentKeyId: input.keyRing.currentKeyId,
      keys: new Map([...input.keyRing.keys].map(([id, bytes]) => [id, Buffer.from(bytes)])),
    };
    this.#temporaryDirectory = input.temporaryDirectory;
    this.#maxDumpBytes = input.maxDumpBytes;
  }

  #store(signal: AbortSignal | undefined, streams: Set<Readable>): EncryptedArtifactStore {
    const raw = this.#rawStore;
    return new EncryptedArtifactStore({
      keyRing: this.#keyRing,
      maxPlaintextBytes:
        this.#maxDumpBytes + MAX_MANIFEST_BYTES + MAX_SOURCE_EVIDENCE_BYTES + HEADER_BYTES,
      temporaryDirectory: this.#temporaryDirectory,
      rawStore: {
        async put(input) {
          const stream = own(input.source, signal, streams);
          try {
            signal?.throwIfAborted();
            await raw.put(input);
          } finally {
            stream.destroy();
          }
        },
        async open(input) {
          signal?.throwIfAborted();
          const opened = await raw.open(input);
          if (opened) own(opened.stream, signal, streams);
          signal?.throwIfAborted();
          return opened;
        },
      },
    });
  }

  async publish(input: {
    readonly manifest: Buffer;
    readonly sourceEvidence: Buffer;
    readonly dump: Readable;
    readonly signal?: AbortSignal;
  }): Promise<EncryptedArtifactMetadata> {
    const streams = new Set<Readable>();
    try {
      const dump = own(input.dump, input.signal, streams);
      input.signal?.throwIfAborted();
      requireBackup(
        Buffer.isBuffer(input.manifest) &&
          input.manifest.byteLength > 0 &&
          input.manifest.byteLength <= MAX_MANIFEST_BYTES,
      );
      requireBackup(
        Buffer.isBuffer(input.sourceEvidence) &&
          input.sourceEvidence.byteLength > 0 &&
          input.sourceEvidence.byteLength <= MAX_SOURCE_EVIDENCE_BYTES,
      );
      const bytes = Buffer.from(input.manifest);
      const sourceEvidence = Buffer.from(input.sourceEvidence);
      const manifest = parseManifest(bytes, this.#maxDumpBytes);
      requireBackup(
        sourceEvidence.byteLength === manifest.sourceEvidenceBytes &&
          createHash("sha256").update(sourceEvidence).digest("hex") ===
            manifest.sourceEvidenceSha256,
      );
      const source = own(
        Readable.from(frameDump(bytes, sourceEvidence, manifest, dump, input.signal)),
        input.signal,
        streams,
      );
      return await this.#store(input.signal, streams).put({
        mediaType: POSTGRES_BACKUP_MEDIA_TYPE,
        objectKey: objectKey(manifest),
        plaintextBytes:
          HEADER_BYTES + bytes.byteLength + sourceEvidence.byteLength + manifest.dumpBytes,
        source,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } finally {
      input.dump.destroy();
      for (const stream of streams) stream.destroy();
    }
  }

  async recover(
    input: PostgresBackupExpectedIdentity & {
      readonly signal?: AbortSignal;
    },
  ): Promise<RecoveredPostgresBackup | null> {
    const streams = new Set<Readable>();
    let authenticated: DiscoveredAuthenticatedArtifactRead | null = null;
    let file: FileHandle | null = null;
    let dump: ReadStream | null = null;
    let transferred = false;
    let disposePromise: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposePromise ??= (async () => {
        const dumpClosed = dump
          ? finished(dump, { cleanup: true }).catch(() => undefined)
          : undefined;
        dump?.destroy();
        for (const stream of streams) stream.destroy();
        try {
          await file?.close();
          await dumpClosed;
        } finally {
          if (authenticated) {
            const originalClosed = finished(authenticated.stream, { cleanup: true }).catch(
              () => undefined,
            );
            try {
              await authenticated.dispose();
            } finally {
              await originalClosed;
            }
          }
        }
      })();
      return disposePromise;
    };
    try {
      input.signal?.throwIfAborted();
      validIdentity(input);
      requireBackup(typeof input.manifestSha256 === "string" && SHA256.test(input.manifestSha256));
      authenticated = await this.#store(input.signal, streams).openAuthenticatedByObject({
        objectKey: objectKey(input),
        mediaType: POSTGRES_BACKUP_MEDIA_TYPE,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!authenticated) return null;
      // Keep the original stream paused and alive: its close handler removes the
      // authenticated spool. All parsing and the returned range share one new fd.
      authenticated.stream.on("error", () => undefined);
      input.signal?.throwIfAborted();
      file = await open(authenticated.stream.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await file.stat();
      requireBackup(
        before.isFile() &&
          before.nlink === 1 &&
          (before.mode & 0o777) === 0o600 &&
          before.size === authenticated.contentLength,
      );
      const header = await readExactly(file, HEADER_BYTES, 0, input.signal);
      requireBackup(header.subarray(0, MAGIC.byteLength).equals(MAGIC));
      const length = header.readUInt32BE(MAGIC.byteLength);
      requireBackup(
        length > 0 &&
          length <= MAX_MANIFEST_BYTES &&
          length < authenticated.contentLength - HEADER_BYTES,
      );
      const bytes = await readExactly(file, length, HEADER_BYTES, input.signal);
      const manifest = parseManifest(bytes, this.#maxDumpBytes);
      requireBackup(createHash("sha256").update(bytes).digest("hex") === input.manifestSha256);
      for (const key of [
        "backupId",
        "databaseName",
        "deploymentTarget",
        "snapshotId",
        "sourceRevision",
      ] as const) {
        requireBackup(manifest[key] === input[key]);
      }
      const evidenceOffset = HEADER_BYTES + bytes.byteLength;
      const offset = evidenceOffset + manifest.sourceEvidenceBytes;
      requireBackup(offset + manifest.dumpBytes === authenticated.contentLength);
      const sourceEvidence = await readExactly(
        file,
        manifest.sourceEvidenceBytes,
        evidenceOffset,
        input.signal,
      );
      requireBackup(
        createHash("sha256").update(sourceEvidence).digest("hex") === manifest.sourceEvidenceSha256,
      );
      let count = 0;
      let signature = Buffer.alloc(0);
      const digest = createHash("sha256");
      while (count < manifest.dumpBytes) {
        const value = await readExactly(
          file,
          Math.min(65_536, manifest.dumpBytes - count),
          offset + count,
          input.signal,
        );
        count += value.byteLength;
        if (signature.byteLength < DUMP_MAGIC.byteLength) {
          signature = Buffer.concat([
            signature,
            value.subarray(0, DUMP_MAGIC.byteLength - signature.byteLength),
          ]);
        }
        digest.update(value);
      }
      requireBackup(
        count === manifest.dumpBytes &&
          signature.equals(DUMP_MAGIC) &&
          digest.digest("hex") === manifest.dumpSha256,
      );
      const after = await file.stat();
      requireBackup(
        before.dev === after.dev &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs,
      );
      input.signal?.throwIfAborted();
      dump = file.createReadStream({
        start: offset,
        end: offset + manifest.dumpBytes - 1,
        autoClose: false,
      });
      own(dump, input.signal, streams);
      dump.once("close", () => {
        void dispose().catch(() => undefined);
      });
      transferred = true;
      return {
        manifest,
        manifestBytes: bytes,
        metadata: authenticated.metadata,
        sourceEvidence,
        dump,
        dispose,
      };
    } finally {
      if (!transferred) await dispose();
    }
  }
}
