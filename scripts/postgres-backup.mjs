import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { finished } from "node:stream/promises";

import {
  EncryptedPostgresBackupStore,
  FileRawArtifactStore,
} from "../packages/artifact-store/dist/index.js";
import {
  normalizePostgresBackupConnection,
  postgresBackupLibpqEnvironment,
  postgresBackupPasswordFile,
} from "../packages/db/dist/index.js";
import { withPostgresBackupSnapshot } from "./postgres-backup-snapshot.mjs";
import { ChildCleanupError, runTool, trustedPath } from "./postgres-operator-process.mjs";

const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TMPFS = 0x01021994;
const MAX_LIST_BYTES = 8_388_608;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (phase) => new Error("PostgreSQL local backup " + phase + " failed");
const requireValue = (condition) => {
  if (!condition) throw failure("configuration");
};

function inputSettings(input) {
  const allowed = [
    "connection",
    "expectedOwner",
    "sourceRevision",
    "deploymentTarget",
    "backupId",
    "tmpfsRoot",
    "outputDirectory",
    "tools",
    "keyRing",
    "maxDumpBytes",
    "timeoutMs",
    "signal",
  ];
  requireValue(
    input && typeof input === "object" && Object.keys(input).every((key) => allowed.includes(key)),
  );
  requireValue(process.platform === "linux" && typeof process.getuid === "function");
  requireValue(
    typeof input.expectedOwner === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(input.expectedOwner),
  );
  requireValue(
    typeof input.sourceRevision === "string" && /^[0-9a-f]{40}$/u.test(input.sourceRevision),
  );
  requireValue(["staging", "production"].includes(input.deploymentTarget));
  requireValue(typeof input.backupId === "string" && UUID.test(input.backupId));
  requireValue(
    Number.isSafeInteger(input.maxDumpBytes) &&
      input.maxDumpBytes >= 5 &&
      input.maxDumpBytes <= 2_147_483_648,
  );
  requireValue(
    Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 && input.timeoutMs <= 1_800_000,
  );
  requireValue(input.signal === undefined || input.signal instanceof AbortSignal);
  requireValue(input.tools && Object.keys(input.tools).sort().join(",") === "pgDump,pgRestore");
  const tools = {};
  for (const name of ["pgDump", "pgRestore"]) {
    const value = input.tools?.[name];
    requireValue(value && Object.keys(value).sort().join(",") === "path,sha256,version");
    requireValue(
      typeof value.path === "string" &&
        isAbsolute(value.path) &&
        resolve(value.path) === value.path,
    );
    requireValue(typeof value.sha256 === "string" && SHA.test(value.sha256));
    const prefix = name === "pgDump" ? "pg_dump" : "pg_restore";
    requireValue(
      typeof value.version === "string" &&
        new RegExp("^" + prefix + " \\(PostgreSQL\\) 17\\.[0-9]+$", "u").test(value.version),
    );
    tools[name] = Object.freeze({ ...value });
  }
  requireValue(
    tools.pgDump.version.split(" ").at(-1) === tools.pgRestore.version.split(" ").at(-1),
  );
  requireValue(input.keyRing?.purpose === "postgres_backup" && input.keyRing.keys instanceof Map);
  requireValue(input.keyRing.keys.size >= 1 && input.keyRing.keys.size <= 16);
  requireValue(
    typeof input.keyRing.currentKeyId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.keyRing.currentKeyId),
  );
  requireValue(input.keyRing.keys.has(input.keyRing.currentKeyId));
  const keys = new Map();
  for (const [id, bytes] of input.keyRing.keys) {
    requireValue(typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id));
    requireValue(bytes instanceof Uint8Array && bytes.byteLength === 32);
    keys.set(id, Buffer.from(bytes));
  }
  return Object.freeze({
    ...input,
    connection: normalizePostgresBackupConnection(input.connection),
    tools: Object.freeze(tools),
    keyRing: { purpose: "postgres_backup", currentKeyId: input.keyRing.currentKeyId, keys },
  });
}

async function ciphertextDirectory(root, revision) {
  await trustedPath(root, { directory: true, privateLeaf: true });
  let path = root;
  for (const part of ["postgres-backups", "v2", revision]) {
    path = join(path, part);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await trustedPath(path, { directory: true, privateLeaf: true });
  }
}

function manifestBytes(value) {
  return Buffer.from(
    JSON.stringify({
      backupId: value.backupId,
      capturedAt: value.capturedAt,
      databaseName: value.databaseName,
      deploymentTarget: value.deploymentTarget,
      dumpBytes: value.dumpBytes,
      dumpSha256: value.dumpSha256,
      formatVersion: "nutrition-postgres-backup-v2",
      snapshotId: value.snapshotId,
      sourceEvidenceBytes: value.sourceEvidenceBytes,
      sourceEvidenceSha256: value.sourceEvidenceSha256,
      sourceRevision: value.sourceRevision,
    }),
  );
}

/**
 * A local ciphertext artifact only. Callers must separately qualify the host,
 * native tools, real snapshot import, off-host recovery and restore/erasure replay.
 */
export async function runPostgresBackup(input) {
  const options = inputSettings(input);
  const controller = new AbortController();
  const cancel = () => controller.abort(failure("cancellation"));
  const externalSignal = options.signal;
  const timer = setTimeout(cancel, options.timeoutMs);
  externalSignal?.addEventListener("abort", cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  let directory;
  let primary, result;
  let childCleanup;
  let primaryFailed = false;
  const cleanup = [];
  let phase = "setup";
  try {
    controller.signal.throwIfAborted();
    await trustedPath(options.tmpfsRoot, { directory: true, privateLeaf: true });
    requireValue(Number((await statfs(options.tmpfsRoot)).type) === TMPFS);
    await ciphertextDirectory(options.outputDirectory, options.sourceRevision);
    directory = await mkdtemp(join(options.tmpfsRoot, "nutrition-pg-backup-"));
    await trustedPath(directory, { directory: true, privateLeaf: true });
    const environment = postgresBackupLibpqEnvironment(options.connection, directory);
    await writeFile(join(directory, "pgpass"), postgresBackupPasswordFile(options.connection), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(directory, "root.crt"), options.connection.caCertificate, {
      flag: "wx",
      mode: 0o600,
    });
    for (const tool of Object.values(options.tools)) {
      const version = await runTool(tool, ["--version"], {
        signal: controller.signal,
        env: environment,
        directory,
        limit: 1024,
      });
      requireValue(version.text?.trim() === tool.version);
    }
    const path = join(directory, "database.dump");
    phase = "snapshot";
    const captured = await withPostgresBackupSnapshot(
      {
        connection: options.connection,
        expectedOwner: options.expectedOwner,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
      },
      async ({ snapshotId, sourceEvidence, signal }) => {
        const capturedAt = new Date().toISOString();
        const dumped = await runTool(
          options.tools.pgDump,
          [
            "--format=custom",
            "--compress=9",
            "--no-owner",
            "--no-privileges",
            "--no-password",
            "--snapshot=" + snapshotId,
          ],
          { signal, env: environment, directory, limit: options.maxDumpBytes, outputPath: path },
        ).catch((error) => {
          if (error instanceof ChildCleanupError) childCleanup = error;
          throw error;
        });
        return { capturedAt, snapshotId, sourceEvidence, dumped };
      },
    );
    phase = "archive validation";
    const details = await lstat(path);
    requireValue(
      details.isFile() &&
        details.nlink === 1 &&
        (details.mode & 0o777) === 0o600 &&
        details.uid === process.getuid(),
    );
    requireValue(details.size === captured.dumped.bytes && details.size >= 5);
    await runTool(options.tools.pgRestore, ["--list", path], {
      signal: controller.signal,
      env: environment,
      directory,
      limit: MAX_LIST_BYTES,
    });
    const manifest = manifestBytes({
      backupId: options.backupId,
      capturedAt: captured.capturedAt,
      databaseName: options.connection.database,
      deploymentTarget: options.deploymentTarget,
      dumpBytes: captured.dumped.bytes,
      dumpSha256: captured.dumped.sha256,
      snapshotId: captured.snapshotId,
      sourceEvidenceBytes: captured.sourceEvidence.byteLength,
      sourceEvidenceSha256: digest(captured.sourceEvidence),
      sourceRevision: options.sourceRevision,
    });
    phase = "publication";
    const store = new EncryptedPostgresBackupStore({
      rawStore: new FileRawArtifactStore(options.outputDirectory),
      keyRing: options.keyRing,
      temporaryDirectory: directory,
      maxDumpBytes: options.maxDumpBytes,
    });
    const dump = createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW });
    const dumpClosed = finished(dump, { cleanup: true }).catch(() => undefined);
    let metadata;
    try {
      metadata = await store.publish({
        manifest,
        sourceEvidence: captured.sourceEvidence,
        dump,
        signal: controller.signal,
      });
    } finally {
      dump.destroy();
      await dumpClosed;
    }
    controller.signal.throwIfAborted();
    result = Object.freeze({
      kind: "nutrition-postgres-local-backup-v1",
      localOnly: true,
      manifest: JSON.parse(manifest.toString("utf8")),
      manifestSha256: digest(manifest),
      metadata,
      tools: Object.fromEntries(
        Object.entries(options.tools).map(([name, tool]) => [
          name,
          { sha256: tool.sha256, version: tool.version },
        ]),
      ),
    });
  } catch (error) {
    primaryFailed = true;
    primary = error instanceof ChildCleanupError ? error : failure(phase);
    if (phase === "snapshot" && error instanceof AggregateError)
      primary = new AggregateError(
        error.errors,
        "PostgreSQL local backup snapshot operation and cleanup failed",
      );
    if (childCleanup)
      primary = new AggregateError(
        [primary, childCleanup],
        "PostgreSQL local backup snapshot and child cleanup failed",
      );
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", cancel);
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: false });
      } catch {
        cleanup.push(failure("plaintext cleanup"));
      }
    }
    for (const bytes of options.keyRing.keys.values()) bytes.fill(0);
  }
  if (primaryFailed && cleanup.length)
    throw new AggregateError(
      [primary, ...cleanup],
      "PostgreSQL local backup operation and cleanup failed",
    );
  if (primaryFailed) throw primary;
  if (cleanup.length) throw new AggregateError(cleanup, "PostgreSQL local backup cleanup failed");
  return result;
}
