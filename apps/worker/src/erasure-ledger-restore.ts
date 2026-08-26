import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  cleanupOrphanedAuthenticatedArtifactSpools,
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  type ErasureReplayLedgerEntry,
  erasureReplayLedgerEntryDigest,
  OciNativeObjectVersionResolver,
  parseArtifactEncryptionKeyRing,
  parseErasureLedgerLocatorKeyRing,
  S3RawArtifactStore,
  type SingletonObjectVersionResolver,
} from "@nutrition-tracker/artifact-store";
import {
  assertDatabaseMigrationLedgerReady,
  assertDatabaseReady,
  completeDatabaseRestoreReplayAttestation,
  createDatabaseFromEnvironment,
  reconcileErasedAccountRows,
  replayExternalErasureLedgerEntry,
} from "@nutrition-tracker/db";

import { loadOciApiSigningPrivateKey } from "./oci-api-key-file.js";
import { assertOciS3CompatibilityEndpoint } from "./oci-object-storage-config.js";

type RestoreDatabase = ReturnType<typeof createDatabaseFromEnvironment>;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ErasureRestoreResult {
  readonly reconciliationDigest: string;
  readonly scannedSubjects: number;
  readonly replayedTombstones: number;
  readonly reconciled: true;
}

interface ErasureRestoreReconciliation {
  readonly reconciled: boolean;
  readonly remainingRows: Readonly<Record<string, string>>;
}

interface ErasureRestoreLedger {
  replaySubject(input: {
    readonly subjectUserId: string;
    readonly apply: (entry: ErasureReplayLedgerEntry) => Promise<ErasureRestoreReconciliation>;
    readonly signal?: AbortSignal;
  }): Promise<ErasureRestoreReconciliation | null>;
}

export async function replayErasureLedgerSubjects(input: {
  readonly subjects: AsyncIterable<string>;
  readonly ledger: ErasureRestoreLedger;
  readonly apply: (entry: ErasureReplayLedgerEntry) => Promise<ErasureRestoreReconciliation>;
  readonly maximumConcurrency: number;
  readonly signal?: AbortSignal;
}): Promise<ErasureRestoreResult> {
  if (
    !Number.isSafeInteger(input.maximumConcurrency) ||
    input.maximumConcurrency < 1 ||
    input.maximumConcurrency > 16
  ) {
    throw new RangeError("Invalid erasure restore concurrency");
  }
  let scannedSubjects = 0;
  let replayedTombstones = 0;
  let batch: string[] = [];
  let previousSubject: string | null = null;
  const reconciliation = createHash("sha256").update(
    "nutrition-tracker-erasure-restore-reconciliation-v1\n",
    "utf8",
  );
  const processBatch = async () => {
    const outcomes = await Promise.all(
      batch.map(async (subjectUserId) => {
        input.signal?.throwIfAborted();
        if (!CANONICAL_UUID_PATTERN.test(subjectUserId)) {
          throw new TypeError("Restore database contains a noncanonical subject identifier");
        }
        const result = await input.ledger.replaySubject({
          apply: input.apply,
          subjectUserId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (
          result !== null &&
          (result.reconciled !== true ||
            Object.values(result.remainingRows).some((value) => value !== "0"))
        ) {
          throw new Error("Erasure replay reconciliation failed");
        }
        return result === null ? 0 : 1;
      }),
    );
    for (const [index, subjectUserId] of batch.entries()) {
      reconciliation.update(`${subjectUserId}\t${outcomes[index] ?? 0}\n`, "utf8");
    }
    replayedTombstones += outcomes.reduce<number>((sum, value) => sum + value, 0);
    batch = [];
  };
  for await (const subjectUserId of input.subjects) {
    input.signal?.throwIfAborted();
    if (!CANONICAL_UUID_PATTERN.test(subjectUserId)) {
      throw new TypeError("Restore database contains a noncanonical subject identifier");
    }
    if (previousSubject !== null && subjectUserId <= previousSubject) {
      throw new TypeError("Restore subject inventory is not strictly ordered");
    }
    previousSubject = subjectUserId;
    scannedSubjects += 1;
    batch.push(subjectUserId);
    if (batch.length >= input.maximumConcurrency) await processBatch();
  }
  if (batch.length) await processBatch();
  return {
    reconciled: true,
    reconciliationDigest: reconciliation.digest("hex"),
    replayedTombstones,
    scannedSubjects,
  };
}

async function* restoredSubjects(database: RestoreDatabase): AsyncGenerator<string> {
  let cursor: string | null = null;
  for (;;) {
    let query = database.selectFrom("app_user").select("id").orderBy("id").limit(500);
    if (cursor !== null) query = query.where("id", ">", cursor);
    const rows = await query.execute();
    if (rows.length === 0) return;
    for (const row of rows) yield row.id;
    cursor = rows.at(-1)?.id ?? null;
    if (cursor === null || rows.length < 500) return;
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing restore configuration: ${name}`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("Invalid bounded restore configuration");
  }
  return parsed;
}

function safeDirectory(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value === parse(value).root) {
    throw new Error("Restore spool must be a safe absolute directory");
  }
  return value;
}

function restoreEpoch(environment: NodeJS.ProcessEnv): string {
  const value = required(environment, "DATABASE_RESTORE_EPOCH");
  if (value.length < 32 || value.length > 500 || value.trim() !== value) {
    throw new Error(
      "DATABASE_RESTORE_EPOCH must contain 32 to 500 non-whitespace-boundary characters",
    );
  }
  return value;
}

export async function restoreVersionResolver(
  environment: NodeJS.ProcessEnv,
  input: {
    readonly bucket: string;
    readonly endpoint: string;
    readonly region: string;
    readonly requestTimeoutMs: number;
  },
): Promise<SingletonObjectVersionResolver | undefined> {
  const provider =
    environment.ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER ??
    (environment.NODE_ENV === "production" ? undefined : "s3_compatible");
  if (provider === undefined) {
    throw new Error(
      "Missing restore configuration: ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER",
    );
  }
  if (provider === "s3_compatible") {
    return undefined;
  }
  if (provider !== "oci_native") {
    throw new Error("Invalid restore object version inventory provider");
  }
  const namespace = required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE");
  assertOciS3CompatibilityEndpoint({
    endpoint: input.endpoint,
    namespace,
    region: input.region,
  });
  return new OciNativeObjectVersionResolver({
    bucket: input.bucket,
    fingerprint: required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT"),
    namespace,
    privateKeyPem: await loadOciApiSigningPrivateKey(
      required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE"),
    ),
    region: input.region,
    requestTimeoutMs: input.requestTimeoutMs,
    tenancyOcid: required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID"),
    userOcid: required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID"),
  });
}

/** Offline pre-traffic restore phase. Runtimes remain unready until this commits. */
export async function replayAndAttestErasureLedgerRestore(input: {
  readonly database: RestoreDatabase;
  readonly ledger: ErasureRestoreLedger;
  readonly maximumConcurrency: number;
  readonly restoreEpoch: string;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
}): Promise<ErasureRestoreResult> {
  await assertDatabaseMigrationLedgerReady(input.database);
  const result = await replayErasureLedgerSubjects({
    apply: async (entry) => {
      const replayed = await replayExternalErasureLedgerEntry(input.database, {
        ackDigest: erasureReplayLedgerEntryDigest(entry),
        ledgerEntryId: entry.ledgerEntryId,
        recordedAt: entry.recordedAt,
        subjectUserId: entry.subjectUserId,
      });
      // A second independent query is the pre-traffic readiness assertion;
      // the command never reports success from the delete transaction alone.
      const verified = await reconcileErasedAccountRows(input.database, {
        userId: entry.subjectUserId,
      });
      if (
        replayed.reconciled !== true ||
        verified.reconciled !== true ||
        Object.values(verified.remainingRows).some((count) => count !== "0")
      ) {
        throw new Error("Erasure replay reconciliation failed");
      }
      return verified;
    },
    ledger: input.ledger,
    maximumConcurrency: input.maximumConcurrency,
    ...(input.signal ? { signal: input.signal } : {}),
    subjects: restoredSubjects(input.database),
  });
  await completeDatabaseRestoreReplayAttestation(input.database, {
    completedAt: (input.clock ?? (() => new Date()))().toISOString(),
    reconciliationDigest: result.reconciliationDigest,
    replayedSubjectCount: result.replayedTombstones,
    restoreEpoch: input.restoreEpoch,
  });
  await assertDatabaseReady(input.database, {
    requireRestoreAttestation: true,
    restoreEpoch: input.restoreEpoch,
  });
  return result;
}

export async function runErasureLedgerRestoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ErasureRestoreResult> {
  const databaseRestoreEpoch = restoreEpoch(environment);
  const endpointValue = required(environment, "ERASURE_REPLAY_LEDGER_ENDPOINT");
  const endpoint = new URL(endpointValue);
  if (environment.NODE_ENV === "production" && endpoint.protocol !== "https:") {
    throw new Error("HTTPS erasure replay ledger storage is required in production");
  }
  const spoolDirectory = safeDirectory(
    required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR"),
  );
  if (
    environment.NODE_ENV === "production" &&
    !["tmpfs", "encrypted_volume"].includes(
      required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_PROTECTION"),
    )
  ) {
    throw new Error("Protected erasure restore spool storage is required in production");
  }
  await mkdir(spoolDirectory, { mode: 0o700, recursive: true });
  const spoolDetails = await lstat(spoolDirectory);
  if (
    !spoolDetails.isDirectory() ||
    spoolDetails.isSymbolicLink() ||
    (spoolDetails.mode & 0o077) !== 0
  ) {
    throw new Error("Erasure restore spool directory is not private");
  }
  await chmod(spoolDirectory, 0o700);
  await cleanupOrphanedAuthenticatedArtifactSpools({
    directory: spoolDirectory,
    olderThanMs: positiveInteger(
      environment.ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_MAX_AGE_MS,
      3_600_000,
      86_400_000,
    ),
  });

  const bucket = required(environment, "ERASURE_REPLAY_LEDGER_BUCKET");
  const region = required(environment, "ERASURE_REPLAY_LEDGER_REGION");
  const requestTimeoutMs = positiveInteger(
    environment.ERASURE_REPLAY_LEDGER_RESTORE_REQUEST_TIMEOUT_MS,
    30_000,
    300_000,
  );
  const singletonVersionResolver = await restoreVersionResolver(environment, {
    bucket,
    endpoint: endpointValue,
    region,
    requestTimeoutMs,
  });

  const rawStore = new S3RawArtifactStore({
    accessKeyId: required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID"),
    bucket,
    endpoint: endpoint.href,
    readVersionPolicy: "require_singleton",
    region,
    requestTimeoutMs,
    secretAccessKey: required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY"),
    ...(singletonVersionResolver ? { singletonVersionResolver } : {}),
    ...(environment.ERASURE_REPLAY_LEDGER_RESTORE_SESSION_TOKEN
      ? { sessionToken: environment.ERASURE_REPLAY_LEDGER_RESTORE_SESSION_TOKEN }
      : {}),
  });
  const ledger = new EncryptedErasureReplayLedger({
    artifactStore: new EncryptedArtifactStore({
      keyRing: parseArtifactEncryptionKeyRing({
        currentKeyId: environment.ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID,
        purpose: "erasure_replay_ledger",
        serializedKeys: environment.ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS,
      }),
      maxPlaintextBytes: 16_384,
      rawStore,
      temporaryDirectory: spoolDirectory,
    }),
    locatorKeyRing: parseErasureLedgerLocatorKeyRing({
      currentKeyId: environment.ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID,
      serializedKeys: environment.ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS,
    }),
  });
  const database = createDatabaseFromEnvironment(environment);
  try {
    return await replayAndAttestErasureLedgerRestore({
      database,
      ledger,
      maximumConcurrency: positiveInteger(
        environment.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY,
        4,
        16,
      ),
      restoreEpoch: databaseRestoreEpoch,
    });
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runErasureLedgerRestoreFromEnvironment()
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ event: "erasure_restore.reconciled", level: "info", ...result })}\n`,
      );
    })
    .catch((error: unknown) => {
      const errorType =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
          ? error.name
          : "UnknownError";
      process.stderr.write(
        `${JSON.stringify({ event: "erasure_restore.failed", errorType, level: "fatal" })}\n`,
      );
      process.exitCode = 1;
    });
}
