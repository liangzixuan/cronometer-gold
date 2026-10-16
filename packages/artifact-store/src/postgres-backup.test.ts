import { createCipheriv, createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactEncryptionConfigurationError,
  type ArtifactEncryptionKeyRing,
  type ArtifactEncryptionPurpose,
  EncryptedArtifactStore,
  FileRawArtifactStore,
  POSTGRES_BACKUP_MEDIA_TYPE,
  parseArtifactEncryptionKeyRing,
  type RawArtifactStore,
} from "./artifact-encryption.js";
import {
  EncryptedPostgresBackupStore,
  type PostgresBackupExpectedIdentity,
  type PostgresBackupManifest,
} from "./postgres-backup.js";

const directories: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, chmod: vi.fn(actual.chmod) };
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const dumpBytes = Buffer.from(
  "PGDMP\u0001\u0010\u0000\u0004\u0008\u0001synthetic-private-database-payload",
  "utf8",
);
const sourceEvidence = Buffer.from("opaque-synthetic-source-evidence\u0000\ufffd", "utf8");
const backupId = "a0000000-0000-4000-8000-000000000001";
const revision = "a".repeat(40);
const snapshotId = "00000003-0000001B-1";
const reference = `postgres-backups/v2/${revision}/${backupId}.pgbackup.enc`;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function keyRing(
  purpose: ArtifactEncryptionPurpose = "postgres_backup",
  byte = 7,
): ArtifactEncryptionKeyRing {
  return {
    purpose,
    currentKeyId: "synthetic-backup-key",
    keys: new Map([["synthetic-backup-key", Buffer.alloc(32, byte)]]),
  };
}

function manifest(patch: Partial<PostgresBackupManifest> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      backupId,
      capturedAt: "2026-09-29T23:00:00.000Z",
      databaseName: "nourishing",
      deploymentTarget: "staging",
      dumpBytes: dumpBytes.byteLength,
      dumpSha256: hash(dumpBytes),
      formatVersion: "nutrition-postgres-backup-v2",
      snapshotId,
      sourceEvidenceBytes: sourceEvidence.byteLength,
      sourceEvidenceSha256: hash(sourceEvidence),
      sourceRevision: revision,
      ...patch,
    }),
  );
}

function expected(
  bytes = manifest(),
): PostgresBackupExpectedIdentity & { source: { kind: "unqualified" } } {
  return {
    backupId,
    databaseName: "nourishing",
    deploymentTarget: "staging",
    manifestSha256: hash(bytes),
    source: { kind: "unqualified" },
    snapshotId,
    sourceRevision: revision,
  };
}

function frame(bytes = manifest(), dump = dumpBytes, evidence = sourceEvidence): Buffer {
  const header = Buffer.alloc(12);
  header.write("NTPB0002", "ascii");
  header.writeUInt32BE(bytes.byteLength, 8);
  return Buffer.concat([header, bytes, evidence, dump]);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function requireValue<T>(value: T | null): T {
  if (value === null) throw new Error("Missing synthetic backup");
  return value;
}

class ImmutableMemoryStore implements RawArtifactStore {
  readonly objects = new Map<string, Buffer>();
  writes = 0;
  reads = 0;
  onPut?: () => void;
  async put(input: Parameters<RawArtifactStore["put"]>[0]): Promise<void> {
    this.writes++;
    this.onPut?.();
    if (this.objects.has(input.objectKey)) throw new Error("synthetic-create-only-conflict");
    const value = await collect(input.source);
    if (value.byteLength !== input.contentLength) throw new Error("synthetic-length-mismatch");
    this.objects.set(input.objectKey, value);
  }
  async open(input: Parameters<RawArtifactStore["open"]>[0]) {
    this.reads++;
    const value = this.objects.get(input.objectKey);
    return value
      ? { contentLength: value.byteLength, stream: Readable.from([Buffer.from(value)]) }
      : null;
  }
}

async function setup(raw: RawArtifactStore = new ImmutableMemoryStore(), ring = keyRing()) {
  const directory = await mkdtemp(join(tmpdir(), "nourishing-backup-library-"));
  directories.push(directory);
  const spool = join(directory, "spool");
  await mkdir(spool, { mode: 0o700 });
  const backup = new EncryptedPostgresBackupStore({
    rawStore: raw,
    keyRing: ring,
    temporaryDirectory: spool,
    maxDumpBytes: 1024,
  });
  return { raw, spool, directory, backup };
}

async function privateDescriptors(spool: string): Promise<string[]> {
  const names = await readdir("/proc/self/fd");
  const paths = await Promise.all(
    names.map((name) => readlink(`/proc/self/fd/${name}`).catch(() => "")),
  );
  return paths.filter((path) => path.startsWith(`${spool}/`));
}

async function putFramed(
  raw: RawArtifactStore,
  spool: string,
  bytes: Buffer,
  purpose: ArtifactEncryptionPurpose = "postgres_backup",
  objectKey = reference,
) {
  const encrypted = new EncryptedArtifactStore({
    rawStore: raw,
    keyRing: keyRing(purpose),
    temporaryDirectory: spool,
    maxPlaintextBytes: 20_000,
  });
  return encrypted.put({
    objectKey,
    mediaType: POSTGRES_BACKUP_MEDIA_TYPE,
    plaintextBytes: bytes.byteLength,
    source: Readable.from([bytes]),
  });
}

describe("encrypted PostgreSQL backup boundary", () => {
  it("encrypts manifest and dump together and exposes only a fully checked private dump range", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    const bytes = manifest();
    const metadata = await backup.publish({
      sourceEvidence,
      manifest: bytes,
      dump: Readable.from([dumpBytes.subarray(0, 2), dumpBytes.subarray(2)]),
    });
    expect(metadata.objectKey).toBe(reference);
    expect(metadata.mediaType).toBe(POSTGRES_BACKUP_MEDIA_TYPE);
    expect(metadata.plaintextSha256).toBe(hash(frame()));
    expect(raw.objects.get(reference)?.includes(Buffer.from("synthetic-private"))).toBe(false);
    const opened = requireValue(await backup.recover(expected()));
    expect(opened.manifestBytes).toEqual(bytes);
    expect(opened.sourceEvidence).toEqual(sourceEvidence);
    expect(opened.metadata).toEqual(metadata);
    expect(opened.readSource).toEqual({ kind: "unqualified" });
    const names = await readdir(spool);
    expect(names).toHaveLength(1);
    const folder = join(spool, names[0] as string);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await readdir(folder)).toEqual(["artifact.plaintext"]);
    expect((await stat(join(folder, "artifact.plaintext"))).mode & 0o777).toBe(0o600);
    expect(await collect(opened.dump)).toEqual(dumpBytes);
    await opened.dispose();
    await opened.dispose();
    expect(await readdir(spool)).toEqual([]);
    expect(await privateDescriptors(spool)).toEqual([]);
  });

  it("disposes abandoned returned streams and both private descriptors before resolving", async () => {
    const { raw, backup, spool } = await setup();
    await putFramed(raw, spool, frame());
    const opened = requireValue(await backup.recover(expected()));
    expect((await privateDescriptors(spool)).length).toBeGreaterThan(0);
    await opened.dispose();
    expect(opened.dump.destroyed).toBe(true);
    expect(await readdir(spool)).toEqual([]);
    expect(await privateDescriptors(spool)).toEqual([]);
  });

  it.each([1, 1_048_576])(
    "round-trips %i opaque evidence bytes at the inclusive size bounds",
    async (size) => {
      const raw = new ImmutableMemoryStore();
      const { backup, spool } = await setup(raw);
      const evidence = Buffer.alloc(size, 0xff);
      const bytes = manifest({ sourceEvidenceBytes: size, sourceEvidenceSha256: hash(evidence) });
      const metadata = await backup.publish({
        manifest: bytes,
        sourceEvidence: evidence,
        dump: Readable.from([dumpBytes]),
      });
      expect(metadata.plaintextBytes).toBe(12 + bytes.byteLength + size + dumpBytes.byteLength);
      const opened = requireValue(await backup.recover(expected(bytes)));
      expect(opened.sourceEvidence.equals(evidence)).toBe(true);
      expect(await collect(opened.dump)).toEqual(dumpBytes);
      await opened.dispose();
      expect(await readdir(spool)).toEqual([]);
      expect(await privateDescriptors(spool)).toEqual([]);
    },
  );

  it("rejects missing, invalid, oversized or mismatched evidence before any raw write", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    const candidates: unknown[] = [
      undefined,
      null,
      "not-a-buffer",
      new Uint8Array(sourceEvidence),
      Buffer.alloc(0),
      Buffer.alloc(1_048_577),
      sourceEvidence.subarray(1),
      Buffer.concat([sourceEvidence, Buffer.from([1])]),
      Buffer.alloc(sourceEvidence.byteLength, 0x7f),
    ];
    for (const candidate of candidates) {
      const dump = Readable.from([dumpBytes]);
      await expect(
        backup.publish({ manifest: manifest(), sourceEvidence: candidate as Buffer, dump }),
      ).rejects.toThrow();
      expect(dump.destroyed).toBe(true);
    }
    expect(raw.writes).toBe(0);
    expect(raw.objects.size).toBe(0);
    expect(await readdir(spool)).toEqual([]);
  });

  it("copies manifest and evidence before the raw adapter can mutate caller buffers", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    const callerManifest = manifest();
    const callerEvidence = Buffer.from(sourceEvidence);
    const originalManifest = Buffer.from(callerManifest);
    raw.onPut = () => {
      callerManifest.fill(0);
      callerEvidence.fill(0);
    };
    const metadata = await backup.publish({
      manifest: callerManifest,
      sourceEvidence: callerEvidence,
      dump: Readable.from([dumpBytes]),
    });
    expect(callerEvidence).not.toEqual(sourceEvidence);
    expect(metadata.plaintextSha256).toBe(hash(frame(originalManifest)));
    const opened = requireValue(await backup.recover(expected(originalManifest)));
    expect(opened.manifestBytes).toEqual(originalManifest);
    expect(opened.sourceEvidence).toEqual(sourceEvidence);
    expect(await collect(opened.dump)).toEqual(dumpBytes);
    await opened.dispose();
    expect(await readdir(spool)).toEqual([]);
    expect(await privateDescriptors(spool)).toEqual([]);
  });

  it.each([
    "altered",
    "substituted",
    "truncated",
    "wrong-size",
    "wrong-digest",
    "empty",
    "oversized",
  ])("rejects authenticated %s evidence without releasing evidence or dump bytes", async (kind) => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    const bytes =
      kind === "wrong-size"
        ? manifest({ sourceEvidenceBytes: sourceEvidence.byteLength - 1 })
        : kind === "wrong-digest"
          ? manifest({ sourceEvidenceSha256: "0".repeat(64) })
          : kind === "empty"
            ? manifest({ sourceEvidenceBytes: 0 })
            : kind === "oversized"
              ? manifest({ sourceEvidenceBytes: 1_048_577 })
              : manifest();
    const alternate = Buffer.alloc(sourceEvidence.byteLength, 0x42);
    let value = frame(bytes, dumpBytes, kind === "substituted" ? alternate : sourceEvidence);
    const offset = 12 + bytes.byteLength;
    if (kind === "altered") value[offset] = (value[offset] as number) ^ 1;
    if (kind === "truncated") value = value.subarray(0, offset + sourceEvidence.byteLength - 1);
    await putFramed(raw, spool, value);
    await expect(backup.recover(expected(bytes))).rejects.toThrow();
    expect(await readdir(spool)).toEqual([]);
    expect(await privateDescriptors(spool)).toEqual([]);
  });

  it("rejects unpublished v1 frames and manifests and never searches the old object prefix", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    const bytes = manifest();
    const oldMagic = frame(bytes);
    oldMagic.write("NTPB0001", "ascii");
    await putFramed(raw, spool, oldMagic);
    await expect(backup.recover(expected(bytes))).rejects.toThrow();
    const oldBytes = Buffer.from(
      bytes.toString().replace("nutrition-postgres-backup-v2", "nutrition-postgres-backup-v1"),
    );
    const other = new ImmutableMemoryStore();
    const otherBackup = (await setup(other)).backup;
    await putFramed(other, spool, frame(oldBytes));
    await expect(otherBackup.recover(expected(oldBytes))).rejects.toThrow();
    const legacy = new ImmutableMemoryStore();
    const legacyBackup = (await setup(legacy)).backup;
    await putFramed(legacy, spool, frame(), "postgres_backup", reference.replace("/v2/", "/v1/"));
    await expect(legacyBackup.recover(expected())).resolves.toBeNull();
    expect(await readdir(spool)).toEqual([]);
    expect(await privateDescriptors(spool)).toEqual([]);
  });

  it("cancels a returned dump before consumption and awaits private-file disposal", async () => {
    const { raw, backup, spool } = await setup();
    await putFramed(raw, spool, frame());
    const controller = new AbortController();
    const opened = requireValue(await backup.recover({ ...expected(), signal: controller.signal }));
    controller.abort();
    await opened.dispose();
    expect(opened.dump.destroyed).toBe(true);
    expect(await readdir(spool)).toEqual([]);
    expect(await privateDescriptors(spool)).toEqual([]);
  });

  it("uses actual FileRawArtifactStore create-only publication and preserves the first ciphertext", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nourishing-backup-file-"));
    directories.push(parent);
    const raw = new FileRawArtifactStore(join(parent, "objects"));
    const { backup, spool } = await setup(raw);
    await backup.publish({
      sourceEvidence,
      manifest: manifest(),
      dump: Readable.from([dumpBytes]),
    });
    const path = join(parent, "objects", reference);
    const original = await readFile(path);
    await expect(
      backup.publish({ sourceEvidence, manifest: manifest(), dump: Readable.from([dumpBytes]) }),
    ).rejects.toThrow();
    expect(await readFile(path)).toEqual(original);
    expect(await readdir(join(parent, "objects", "postgres-backups", "v2", revision))).toEqual([
      `${backupId}.pgbackup.enc`,
    ]);
    const opened = requireValue(await backup.recover(expected()));
    expect(await collect(opened.dump)).toEqual(dumpBytes);
    await opened.dispose();
    expect(await readdir(spool)).toEqual([]);
  });

  it.each(["tamper", "truncate"])(
    "rejects outer envelope %s before returning dump bytes",
    async (kind) => {
      const raw = new ImmutableMemoryStore();
      const { backup, spool } = await setup(raw);
      await backup.publish({
        sourceEvidence,
        manifest: manifest(),
        dump: Readable.from([dumpBytes]),
      });
      const value = Buffer.from(requireValue(raw.objects.get(reference) ?? null));
      if (kind === "tamper") value[value.length - 1] = (value.at(-1) as number) ^ 1;
      raw.objects.set(reference, kind === "truncate" ? value.subarray(0, value.length - 3) : value);
      await expect(backup.recover(expected())).rejects.toThrow();
      expect(await readdir(spool)).toEqual([]);
    },
  );

  it.each(["export", "erasure_replay_ledger"] as const)(
    "rejects shared key bytes under %s purpose",
    async (purpose) => {
      const raw = new ImmutableMemoryStore();
      const { backup, spool } = await setup(raw);
      await putFramed(raw, spool, frame(), purpose);
      await expect(backup.recover(expected())).rejects.toThrow();
      expect(await readdir(spool)).toEqual([]);
      expect(
        () =>
          new EncryptedPostgresBackupStore({
            rawStore: raw,
            keyRing: keyRing(purpose),
            temporaryDirectory: spool,
            maxDumpBytes: 1024,
          }),
      ).toThrow();
    },
  );

  it("rejects wrong key material and expected source/snapshot/target/database/manifest identity", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    await putFramed(raw, spool, frame());
    const wrong = new EncryptedPostgresBackupStore({
      rawStore: raw,
      keyRing: keyRing("postgres_backup", 8),
      temporaryDirectory: spool,
      maxDumpBytes: 1024,
    });
    await expect(wrong.recover(expected())).rejects.toThrow();
    for (const patch of [
      { snapshotId: "00000003-0000001B-2" },
      { databaseName: "other" },
      { deploymentTarget: "production" as const },
      { manifestSha256: "b".repeat(64) },
    ]) {
      await expect(backup.recover({ ...expected(), ...patch })).rejects.toThrow();
    }
    await expect(
      backup.recover({ ...expected(), sourceRevision: "b".repeat(40) }),
    ).resolves.toBeNull();
    const otherSource = manifest({ sourceRevision: "b".repeat(40) });
    const other = new ImmutableMemoryStore();
    await putFramed(other, spool, frame(otherSource));
    const foreign = new EncryptedPostgresBackupStore({
      rawStore: other,
      keyRing: keyRing(),
      temporaryDirectory: spool,
      maxDumpBytes: 1024,
    });
    await expect(
      foreign.recover({ ...expected(), manifestSha256: hash(otherSource) }),
    ).rejects.toThrow();
    expect(await readdir(spool)).toEqual([]);
  });

  it("rejects noncanonical, duplicate, unknown and malformed manifest fields before raw publication", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    const candidates = [
      Buffer.from(` ${manifest().toString()}`),
      Buffer.from(
        manifest().toString().replace('{"backupId":', `{"backupId":"${backupId}","backupId":`),
      ),
      Buffer.from(manifest().toString().replace("{", '{"extra":true,')),
      manifest({ databaseName: "Uppercase" }),
      manifest({ capturedAt: "2026-09-29T23:00:00Z" }),
      manifest({ dumpBytes: 1.5 }),
      manifest({ dumpBytes: 1025 }),
      manifest({ snapshotId: "not-a-snapshot" }),
      manifest({ sourceEvidenceBytes: 0 }),
      manifest({ sourceEvidenceBytes: 1.5 }),
      manifest({ sourceEvidenceBytes: 1_048_577 }),
      manifest({ sourceEvidenceSha256: "not-a-sha256" }),
      manifest({ sourceEvidenceSha256: "A".repeat(64) }),
      Buffer.alloc(16_385, 32),
    ];
    for (const bytes of candidates) {
      const source = Readable.from([dumpBytes]);
      await expect(
        backup.publish({ sourceEvidence, manifest: bytes, dump: source }),
      ).rejects.toThrow();
      expect(source.destroyed).toBe(true);
    }
    expect(raw.writes).toBe(0);
    expect(await readdir(spool)).toEqual([]);
  });

  it.each(["signature", "short", "long", "digest"])(
    "rejects %s dump mismatch without publishing",
    async (kind) => {
      const raw = new ImmutableMemoryStore();
      const { backup, spool } = await setup(raw);
      const dump =
        kind === "signature"
          ? Buffer.alloc(dumpBytes.length, 3)
          : kind === "short"
            ? dumpBytes.subarray(1)
            : kind === "long"
              ? Buffer.concat([dumpBytes, Buffer.from([1])])
              : dumpBytes;
      const bytes =
        kind === "signature"
          ? manifest({ dumpSha256: hash(dump) })
          : kind === "digest"
            ? manifest({ dumpSha256: "0".repeat(64) })
            : manifest();
      const source = Readable.from([dump]);
      await expect(
        backup.publish({ sourceEvidence, manifest: bytes, dump: source }),
      ).rejects.toThrow();
      expect(source.destroyed).toBe(true);
      expect(raw.objects.size).toBe(0);
      expect(await readdir(spool)).toEqual([]);
    },
  );

  it.each(["magic", "manifest-length", "trailing", "dump-hash", "duplicate-manifest"])(
    "rejects authenticated invalid inner %s before releasing dump",
    async (kind) => {
      const raw = new ImmutableMemoryStore();
      const { backup, spool } = await setup(raw);
      let bytes = manifest();
      if (kind === "duplicate-manifest")
        bytes = Buffer.from(
          bytes.toString().replace('{"backupId":', `{"backupId":"${backupId}","backupId":`),
        );
      let value = frame(bytes);
      if (kind === "magic") value[0] = 0;
      if (kind === "manifest-length") value.writeUInt32BE(16_385, 8);
      if (kind === "trailing") value = Buffer.concat([value, Buffer.from([1])]);
      if (kind === "dump-hash") value[value.length - 1] = (value.at(-1) as number) ^ 1;
      await putFramed(raw, spool, value);
      await expect(backup.recover(expected(bytes))).rejects.toThrow();
      expect(await readdir(spool)).toEqual([]);
      expect(await privateDescriptors(spool)).toEqual([]);
    },
  );

  it("pre-aborted operations never call raw storage and close supplied dump even with destroy error", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    const controller = new AbortController();
    controller.abort();
    const dump = new Readable({
      read() {},
      destroy(_error, done) {
        done(new Error("synthetic destroy error"));
      },
    });
    await expect(
      backup.publish({ sourceEvidence, manifest: manifest(), dump, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(backup.recover({ ...expected(), signal: controller.signal })).rejects.toThrow();
    expect(dump.destroyed).toBe(true);
    expect(raw.reads).toBe(0);
    expect(raw.writes).toBe(0);
    expect(await readdir(spool)).toEqual([]);
  });

  it("interrupts a stalled dump source and leaves no published object", async () => {
    const raw = new ImmutableMemoryStore();
    const { backup, spool } = await setup(raw);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    raw.onPut = entered;
    const source = new Readable({ read() {} });
    const controller = new AbortController();
    const pending = backup.publish({
      sourceEvidence,
      manifest: manifest(),
      dump: source,
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow();
    await started;
    controller.abort();
    await rejection;
    expect(source.destroyed).toBe(true);
    expect(raw.objects.size).toBe(0);
    expect(await readdir(spool)).toEqual([]);
  });

  it("interrupts a stalled raw download and removes its private authentication spool", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stream = new Readable({
      read() {
        entered();
      },
    });
    const raw: RawArtifactStore = {
      async put() {
        throw new Error("unused");
      },
      async open() {
        return { contentLength: 1024, stream, readIdentity: readIdentity(1024) };
      },
    };
    const { backup, spool } = await setup(raw);
    const controller = new AbortController();
    const pending = backup.recover({
      ...expected(),
      source: pinnedSource,
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow();
    await started;
    controller.abort();
    await rejection;
    expect(stream.destroyed).toBe(true);
    expect(await readdir(spool)).toEqual([]);
  });

  it("destroys the dump when raw publication fails before consuming the encryption stream", async () => {
    const raw: RawArtifactStore = {
      async put() {
        throw new Error("synthetic early failure");
      },
      async open() {
        return null;
      },
    };
    const { backup, spool } = await setup(raw);
    const source = new Readable({ read() {} });
    await expect(
      backup.publish({ sourceEvidence, manifest: manifest(), dump: source }),
    ).rejects.toThrow("synthetic early failure");
    expect(source.destroyed).toBe(true);
    expect(await readdir(spool)).toEqual([]);
  });

  it("requires explicit valid spool and bounded safe-integer size", async () => {
    const raw = new ImmutableMemoryStore();
    const { spool } = await setup(raw);
    for (const maxDumpBytes of [0, 4, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN]) {
      expect(
        () =>
          new EncryptedPostgresBackupStore({
            rawStore: raw,
            keyRing: keyRing(),
            temporaryDirectory: spool,
            maxDumpBytes,
          }),
      ).toThrow();
    }
    expect(
      () =>
        new EncryptedPostgresBackupStore({
          rawStore: raw,
          keyRing: keyRing(),
          temporaryDirectory: "relative",
          maxDumpBytes: 1024,
        }),
    ).toThrow();
  });

  it("reserves safe-integer space for both the backup frame and the largest encryption envelope", async () => {
    const raw = new ImmutableMemoryStore();
    const { spool } = await setup(raw);
    // Eight magic bytes, key-length byte, longest key id, nonce and GCM tag.
    const largestEnvelopeOverhead = 8 + 1 + 64 + 12 + 16;
    const maximum = Number.MAX_SAFE_INTEGER - 16_384 - 1_048_576 - 12 - largestEnvelopeOverhead;
    const input = { rawStore: raw, keyRing: keyRing(), temporaryDirectory: spool };
    expect(
      () => new EncryptedPostgresBackupStore({ ...input, maxDumpBytes: maximum }),
    ).not.toThrow();
    expect(
      () => new EncryptedPostgresBackupStore({ ...input, maxDumpBytes: maximum + 1 }),
    ).toThrow();
  });

  it("destroys the raw download and removes the created spool when private-directory setup fails", async () => {
    const memory = new ImmutableMemoryStore();
    let download: Readable | undefined;
    const raw: RawArtifactStore = {
      put: (input) => memory.put(input),
      async open(input) {
        const opened = await memory.open(input);
        download = opened?.stream;
        return opened;
      },
    };
    const { backup, spool } = await setup(raw);
    await backup.publish({
      sourceEvidence,
      manifest: manifest(),
      dump: Readable.from([dumpBytes]),
    });
    vi.mocked(chmod).mockRejectedValueOnce(new Error("synthetic chmod failure"));
    await expect(backup.recover(expected())).rejects.toThrow();
    expect(download?.destroyed).toBe(true);
    expect(await readdir(spool)).toEqual([]);
    expect(await privateDescriptors(spool)).toEqual([]);
  });
});

describe("backup encryption purpose extension", () => {
  it("uses separate configuration error fields and rejects unknown runtime purposes", () => {
    expect(() =>
      parseArtifactEncryptionKeyRing({
        purpose: "postgres_backup",
        currentKeyId: undefined,
        serializedKeys: undefined,
      }),
    ).toThrow("POSTGRES_BACKUP_CURRENT_KEY_ID");
    expect(() =>
      parseArtifactEncryptionKeyRing({
        purpose: "postgres_backup",
        currentKeyId: "backup-key",
        serializedKeys: "{}",
      }),
    ).toThrow("POSTGRES_BACKUP_ENCRYPTION_KEYS");
    expect(() =>
      parseArtifactEncryptionKeyRing({
        purpose: "unknown" as ArtifactEncryptionPurpose,
        currentKeyId: "backup-key",
        serializedKeys: "{}",
      }),
    ).toThrow(ArtifactEncryptionConfigurationError);
  });

  it.each([
    ["export", "nutrition-tracker-export-artifact-v1"],
    ["erasure_replay_ledger", "nutrition-tracker-erasure-replay-ledger-v1"],
  ] as const)("preserves exact existing %s envelope bytes", async (purpose, domain) => {
    const raw = new ImmutableMemoryStore();
    const plaintext = Buffer.from('{"unchanged":true}');
    const ring = keyRing(purpose);
    const nonce = Buffer.alloc(12, 9);
    const objectKey = "existing/object.json.enc";
    const store = new EncryptedArtifactStore({ rawStore: raw, keyRing: ring, nonce: () => nonce });
    await store.put({
      objectKey,
      mediaType: "application/json",
      plaintextBytes: plaintext.length,
      source: Readable.from([plaintext]),
    });
    const encoded = Buffer.from(ring.currentKeyId);
    const header = Buffer.concat([
      Buffer.from("NTAE0001"),
      Buffer.from([encoded.length]),
      encoded,
      nonce,
    ]);
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), nonce);
    cipher.setAAD(
      Buffer.concat([header, Buffer.from(`\0${domain}\0${objectKey}\0application/json`)]),
    );
    const expected = Buffer.concat([
      header,
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(raw.objects.get(objectKey)).toEqual(expected);
  });
});

describe("literal deployment-target backup identity", () => {
  const targets = ["development", "staging", "production"] as const;
  for (const deploymentTarget of targets) {
    it(`authenticates and preserves a ${deploymentTarget} backup`, async () => {
      const raw = new ImmutableMemoryStore();
      const { backup, spool } = await setup(raw);
      const bytes = manifest({ deploymentTarget });
      const metadata = await backup.publish({
        manifest: bytes,
        sourceEvidence,
        dump: Readable.from([dumpBytes]),
      });
      expect(metadata.objectKey).toBe(reference);
      const opened = requireValue(await backup.recover({ ...expected(bytes), deploymentTarget }));
      try {
        expect(opened.manifest.deploymentTarget).toBe(deploymentTarget);
        expect(opened.manifestBytes).toEqual(bytes);
        expect(opened.sourceEvidence).toEqual(sourceEvidence);
        expect(await collect(opened.dump)).toEqual(dumpBytes);
      } finally {
        await opened.dispose();
      }
      expect(await readdir(spool)).toEqual([]);
      expect(await privateDescriptors(spool)).toEqual([]);
    });
    for (const expectedTarget of targets.filter((target) => target !== deploymentTarget)) {
      it(`rejects authenticated ${deploymentTarget} bytes expected as ${expectedTarget}`, async () => {
        const raw = new ImmutableMemoryStore();
        const { backup, spool } = await setup(raw);
        const bytes = manifest({ deploymentTarget });
        await putFramed(raw, spool, frame(bytes));
        await expect(
          backup.recover({ ...expected(bytes), deploymentTarget: expectedTarget }),
        ).rejects.toThrow();
        expect(raw.reads).toBe(1);
        expect(await readdir(spool)).toEqual([]);
        expect(await privateDescriptors(spool)).toEqual([]);
      });
    }
  }
  for (const invalid of ["Development", "test"]) {
    it(`rejects unknown target ${invalid} before publication and raw recovery`, async () => {
      const raw = new ImmutableMemoryStore();
      const { backup, spool } = await setup(raw);
      const deploymentTarget = invalid as PostgresBackupManifest["deploymentTarget"];
      await expect(
        backup.publish({
          manifest: manifest({ deploymentTarget }),
          sourceEvidence,
          dump: Readable.from([dumpBytes]),
        }),
      ).rejects.toThrow();
      await expect(backup.recover({ ...expected(), deploymentTarget })).rejects.toThrow();
      expect(raw.writes).toBe(0);
      expect(raw.reads).toBe(0);
      expect(await readdir(spool)).toEqual([]);
    });
  }
});

const pinnedSource = {
  kind: "azure-blob-version" as const,
  containerUrl: "https://nourishingtest.blob.core.windows.net/backups",
  prefix: "development/Backups/",
};
function readIdentity(contentLength: number, versionId = "Opaque-V1") {
  return {
    ...pinnedSource,
    objectKey: reference,
    blobName: pinnedSource.prefix + reference,
    versionId,
    contentLength,
  };
}

describe("PostgreSQL authenticated read source", () => {
  it.each([
    undefined,
    null,
    {},
    { kind: "unqualified", extra: true },
    { kind: "azure-blob-current" },
    { ...pinnedSource, prefix: "../" },
    { ...pinnedSource, containerUrl: pinnedSource.containerUrl + "?sig=PRIVATE" },
  ])("requires an explicit valid expectation before raw open: %j", async (source) => {
    const memory = new ImmutableMemoryStore();
    const { backup, spool } = await setup(memory);
    await expect(
      backup.recover({ ...expected(), source } as Parameters<typeof backup.recover>[0]),
    ).rejects.toThrow();
    expect(memory.reads).toBe(0);
    expect(await readdir(spool)).toEqual([]);
  });

  it("captures the exact opened source before delayed authentication and survives disposal", async () => {
    const memory = new ImmutableMemoryStore();
    const source = { ...pinnedSource };
    const input = { ...expected(), source };
    let observed: ReturnType<typeof readIdentity> | undefined;
    let rawResult:
      | { stream: Readable; contentLength: number; readIdentity: ReturnType<typeof readIdentity> }
      | undefined;
    const raw: RawArtifactStore = {
      put: (value) => memory.put(value),
      async open(value) {
        memory.reads++;
        const ciphertext = memory.objects.get(value.objectKey);
        if (!ciphertext) return null;
        observed = readIdentity(ciphertext.length);
        const original = Buffer.from(ciphertext);
        const stream = Readable.from(
          (async function* () {
            source.prefix = "replaced/";
            input.sourceRevision = "b".repeat(40);
            if (!observed || !rawResult) throw new Error("fixture missing");
            observed.versionId = "PRIVATE-REPLACED";
            rawResult.contentLength = 1;
            rawResult.stream = Readable.from([Buffer.from("PRIVATE-REPLACED")]);
            yield original;
          })(),
        );
        rawResult = { stream, contentLength: ciphertext.length, readIdentity: observed };
        return rawResult;
      },
    };
    const { backup, spool } = await setup(raw);
    const metadata = await putFramed(raw, spool, frame());
    const result = requireValue(await backup.recover(input));
    expect(result.readSource).toEqual(readIdentity(metadata.ciphertextBytes));
    expect(result.readSource).not.toBe(observed);
    expect(Object.isFrozen(result.readSource)).toBe(true);
    expect(await collect(result.dump)).toEqual(dumpBytes);
    await result.dispose();
    expect(result.readSource).toEqual(readIdentity(metadata.ciphertextBytes));
    expect(memory.reads).toBe(1);
    expect(await readdir(spool)).toEqual([]);
  });

  it("isolates simultaneous recovery observations on one store", async () => {
    const memory = new ImmutableMemoryStore();
    const raw: RawArtifactStore = {
      put: (value) => memory.put(value),
      async open(value) {
        const opened = await memory.open(value);
        if (!opened) return null;
        return {
          ...opened,
          readIdentity: readIdentity(opened.contentLength, "version-" + memory.reads),
        };
      },
    };
    const { backup, spool } = await setup(raw);
    await putFramed(raw, spool, frame());
    // Capture distinct identities synchronously before the deferred reads resume.
    let sequence = 0;
    raw.open = async (value) => {
      const version = "version-" + ++sequence;
      const opened = await memory.open(value);
      return opened
        ? { ...opened, readIdentity: readIdentity(opened.contentLength, version) }
        : null;
    };
    const results = await Promise.all([
      backup.recover({ ...expected(), source: pinnedSource }),
      backup.recover({ ...expected(), source: pinnedSource }),
    ]);
    expect(results.map((r) => requireValue(r).readSource)).toEqual([
      readIdentity(memory.objects.get(reference)?.length ?? 0, "version-1"),
      readIdentity(memory.objects.get(reference)?.length ?? 0, "version-2"),
    ]);
    await Promise.all(results.map((r) => requireValue(r).dispose()));
    expect(memory.reads).toBe(2);
    expect(await readdir(spool)).toEqual([]);
  });

  it.each(["missing", "current", "key", "length", "location", "accessor", "record-accessor"])(
    "refuses %s raw identity and owns cleanup without retry",
    async (fault) => {
      const memory = new ImmutableMemoryStore();
      let stream: Readable | undefined;
      let getterCalls = 0;
      const raw: RawArtifactStore = {
        put: (value) => memory.put(value),
        async open(value) {
          const opened = await memory.open(value);
          if (!opened) return null;
          stream = opened.stream;
          const identity: Record<string, unknown> = readIdentity(opened.contentLength);
          if (fault === "current") identity.kind = "azure-blob-current";
          if (fault === "key") identity.objectKey = "wrong.enc";
          if (fault === "length") identity.contentLength = opened.contentLength + 1;
          if (fault === "location") identity.prefix = "other/";
          if (fault === "accessor")
            Object.defineProperty(identity, "versionId", {
              get() {
                getterCalls++;
                throw new Error("PRIVATE");
              },
            });
          if (fault === "missing") return opened;
          if (fault === "record-accessor")
            return Object.defineProperty(opened, "readIdentity", {
              get() {
                getterCalls++;
                throw new Error("PRIVATE");
              },
            });
          return { ...opened, readIdentity: identity };
        },
      };
      const { backup, spool } = await setup(raw);
      await putFramed(raw, spool, frame());
      await expect(backup.recover({ ...expected(), source: pinnedSource })).rejects.toThrow();
      expect(getterCalls).toBe(0);
      expect(stream?.destroyed).toBe(true);
      expect(memory.reads).toBe(1);
      expect(await readdir(spool)).toEqual([]);
      expect(await privateDescriptors(spool)).toEqual([]);
    },
  );

  it.each(["truncated", "oversized", "late-error", "authentication"])(
    "does not publish a qualified result after %s ciphertext",
    async (fault) => {
      const memory = new ImmutableMemoryStore();
      const raw: RawArtifactStore = {
        put: (value) => memory.put(value),
        async open(value) {
          memory.reads++;
          const bytes = memory.objects.get(value.objectKey);
          if (!bytes) return null;
          const copy = Buffer.from(bytes);
          if (fault === "authentication") copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
          const stream = Readable.from(
            (async function* () {
              yield fault === "truncated" ? copy.subarray(0, -1) : copy;
              if (fault === "oversized") yield Buffer.from([1]);
              if (fault === "late-error") throw new Error("PRIVATE-LATE-ERROR");
            })(),
          );
          return { stream, contentLength: bytes.length, readIdentity: readIdentity(bytes.length) };
        },
      };
      const { backup, spool } = await setup(raw);
      await putFramed(raw, spool, frame());
      await expect(backup.recover({ ...expected(), source: pinnedSource })).rejects.toThrow();
      expect(memory.reads).toBe(1);
      expect(await readdir(spool)).toEqual([]);
    },
  );

  it("does not upgrade explicit unqualified reads using incidental provider fields", async () => {
    const memory = new ImmutableMemoryStore();
    const raw: RawArtifactStore = {
      put: (v) => memory.put(v),
      async open(v) {
        const opened = await memory.open(v);
        return opened ? { ...opened, readIdentity: readIdentity(opened.contentLength) } : null;
      },
    };
    const { backup, spool } = await setup(raw);
    await putFramed(raw, spool, frame());
    const result = requireValue(await backup.recover(expected()));
    expect(result.readSource).toEqual({ kind: "unqualified" });
    await result.dispose();
  });
});
