import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  AZURE_LEDGER_RESTORE_READ_BUDGET,
  AzureBlobRawArtifactStore,
  cleanupOrphanedAuthenticatedArtifactSpools,
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  type ErasureReplayLedgerEntry,
  erasureReplayLedgerEntryDigest,
  OciNativeObjectVersionResolver,
  parseArtifactEncryptionKeyRing,
  parseErasureLedgerLocatorKeyRing,
  type RawArtifactStore,
  S3RawArtifactStore,
  type SingletonObjectVersionResolver,
} from "@nutrition-tracker/artifact-store";
import {
  assertDatabaseMigrationLedgerReady,
  assertDatabaseReady,
  completeDatabaseRestoreReplayAttestation,
  createDatabaseFromEnvironment,
  type DatabaseRestoreAttestationRecord,
  prepareDatabaseRestoreReplaySession,
  reconcileErasedAccountRows,
  replayExternalErasureLedgerEntry,
} from "@nutrition-tracker/db";

import { loadOciApiSigningPrivateKey } from "./oci-api-key-file.js";
import { assertOciS3CompatibilityEndpoint } from "./oci-object-storage-config.js";

type RestoreDatabase = ReturnType<typeof createDatabaseFromEnvironment>;

const MAXIMUM_RESTORE_SUBJECTS = 10_000;
const SUBJECT_PAGE_SIZE = 500;
const MAXIMUM_SUBJECT_QUERIES = 21;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ErasureReplaySummary {
  readonly reconciliationDigest: string;
  readonly scannedSubjects: number;
  readonly replayedTombstones: number;
  readonly reconciled: true;
}

export interface ErasureRestoreResult extends ErasureReplaySummary {
  readonly attestation: DatabaseRestoreAttestationRecord;
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
}): Promise<ErasureReplaySummary> {
  const { signal, maximumConcurrency, subjects, ledger, apply } = input;
  if (
    !Number.isSafeInteger(maximumConcurrency) ||
    maximumConcurrency < 1 ||
    maximumConcurrency > 16
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
    const controller = new AbortController();
    const failure: { recorded: boolean; reason: unknown } = { recorded: false, reason: undefined };
    const fail = (reason: unknown) => {
      if (failure.recorded) return;
      failure.recorded = true;
      failure.reason = reason;
      controller.abort(new Error("Erasure restore batch cancelled"));
    };
    const onAbort = () => fail(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      // Each task consumes its rejection so every started sibling settles first.
      // The first observed task failure or external abort wins, including falsey reasons.
      const outcomes = await Promise.all(
        batch.map(async (subjectUserId) => {
          try {
            controller.signal.throwIfAborted();
            const result = await ledger.replaySubject({
              apply: (entry) => {
                controller.signal.throwIfAborted();
                return apply(entry);
              },
              subjectUserId,
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
            if (
              result !== null &&
              (result.reconciled !== true ||
                Object.values(result.remainingRows).some((value) => value !== "0"))
            ) {
              throw new Error("Erasure replay reconciliation failed");
            }
            return result === null ? 0 : 1;
          } catch (error) {
            fail(error);
            return 0;
          }
        }),
      );
      if (failure.recorded) throw failure.reason;
      for (const [index, subjectUserId] of batch.entries()) {
        reconciliation.update(`${subjectUserId}\t${outcomes[index] ?? 0}\n`, "utf8");
      }
      replayedTombstones += outcomes.reduce<number>((sum, value) => sum + value, 0);
      batch = [];
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
  signal?.throwIfAborted();
  for await (const subjectUserId of subjects) {
    signal?.throwIfAborted();
    if (scannedSubjects >= MAXIMUM_RESTORE_SUBJECTS) {
      throw new RangeError("Erasure restore subject budget exceeded");
    }
    if (!CANONICAL_UUID_PATTERN.test(subjectUserId)) {
      throw new TypeError("Restore database contains a noncanonical subject identifier");
    }
    if (previousSubject !== null && subjectUserId <= previousSubject) {
      throw new TypeError("Restore subject inventory is not strictly ordered");
    }
    previousSubject = subjectUserId;
    scannedSubjects += 1;
    batch.push(subjectUserId);
    if (batch.length >= maximumConcurrency) await processBatch();
  }
  if (batch.length) await processBatch();
  signal?.throwIfAborted();
  return {
    reconciled: true,
    reconciliationDigest: reconciliation.digest("hex"),
    replayedTombstones,
    scannedSubjects,
  };
}

async function* restoredSubjects(
  database: RestoreDatabase,
  signal: AbortSignal | undefined,
): AsyncGenerator<string> {
  let cursor: string | null = null;
  let yieldedSubjects = 0;
  let queryAttempts = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (queryAttempts >= MAXIMUM_SUBJECT_QUERIES) {
      throw new RangeError("Erasure restore subject query budget exceeded");
    }
    const remainingSubjects = MAXIMUM_RESTORE_SUBJECTS - yieldedSubjects;
    // One extra row distinguishes complete enumeration from a truncated success.
    const limit = Math.min(SUBJECT_PAGE_SIZE, remainingSubjects + 1);
    let query = database.selectFrom("app_user").select("id").orderBy("id").limit(limit);
    if (cursor !== null) query = query.where("id", ">", cursor);
    queryAttempts += 1;
    const rows = await query.execute();
    signal?.throwIfAborted();
    if (rows.length > limit || rows.length > remainingSubjects) {
      throw new RangeError("Erasure restore subject budget exceeded");
    }
    for (const row of rows) {
      signal?.throwIfAborted();
      yieldedSubjects += 1;
      yield row.id;
    }
    if (rows.length < limit) return;
    cursor = rows.at(-1)?.id ?? null;
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

const ATTESTATION_FIELDS = [
  "databaseName",
  "databaseOid",
  "restoreEpochHash",
  "replayedSubjectCount",
  "reconciliationDigest",
  "completedAt",
] as const;

function dataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("Invalid restore observation");
  const names = Reflect.ownKeys(value);
  if (
    names.length !== fields.length ||
    names.some((name) => typeof name !== "string" || !fields.includes(name))
  )
    throw new Error("Invalid restore observation");
  return Object.fromEntries(
    fields.map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor)) throw new Error("Invalid restore observation");
      return [name, descriptor.value];
    }),
  );
}

interface ExpectedReplayTarget {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly expectedOwner: string;
}

function replayTarget(value: unknown): ExpectedReplayTarget {
  const { databaseName, databaseOid, expectedOwner } = dataRecord(value, [
    "databaseName",
    "databaseOid",
    "expectedOwner",
  ]);
  if (
    typeof databaseName !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(databaseName) ||
    typeof databaseOid !== "string" ||
    !/^[1-9][0-9]{0,9}$/u.test(databaseOid) ||
    BigInt(databaseOid) > 4294967295n ||
    typeof expectedOwner !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(expectedOwner)
  )
    throw new Error("Invalid restore target");
  return Object.freeze({ databaseName, databaseOid, expectedOwner });
}

function attestationSnapshot(value: unknown, persisted = false): DatabaseRestoreAttestationRecord {
  const fields = dataRecord(value, ATTESTATION_FIELDS);
  if (persisted) {
    if (
      !(fields.completedAt instanceof Date) ||
      Object.getPrototypeOf(fields.completedAt) !== Date.prototype ||
      Reflect.ownKeys(fields.completedAt).length
    )
      throw new Error("Invalid restore observation");
    fields.completedAt = Date.prototype.toISOString.call(fields.completedAt);
  }
  const {
    databaseName,
    databaseOid,
    restoreEpochHash,
    replayedSubjectCount,
    reconciliationDigest,
    completedAt,
  } = fields;
  if (
    typeof databaseName !== "string" ||
    databaseName.length === 0 ||
    typeof databaseOid !== "string" ||
    !/^[1-9][0-9]{0,9}$/u.test(databaseOid) ||
    BigInt(databaseOid) > 4294967295n ||
    typeof restoreEpochHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(restoreEpochHash) ||
    typeof reconciliationDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(reconciliationDigest) ||
    typeof replayedSubjectCount !== "string" ||
    !/^(0|[1-9][0-9]{0,4})$/u.test(replayedSubjectCount) ||
    BigInt(replayedSubjectCount) > 10000n ||
    typeof completedAt !== "string" ||
    completedAt.length !== 24 ||
    new Date(completedAt).toISOString() !== completedAt
  )
    throw new Error("Invalid restore observation");
  return Object.freeze({
    databaseName,
    databaseOid,
    restoreEpochHash,
    replayedSubjectCount,
    reconciliationDigest,
    completedAt,
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
  readonly expectedTarget?: ExpectedReplayTarget;
}): Promise<ErasureRestoreResult> {
  const {
    database,
    ledger,
    maximumConcurrency,
    restoreEpoch,
    clock,
    signal,
    expectedTarget: requestedTarget,
  } = input;
  const expectedTarget = requestedTarget === undefined ? undefined : replayTarget(requestedTarget);
  signal?.throwIfAborted();
  if (expectedTarget) {
    if (maximumConcurrency !== 1) throw new Error("Qualified restore replay must be serial");
    await prepareDatabaseRestoreReplaySession(database, expectedTarget);
    signal?.throwIfAborted();
  }
  await assertDatabaseMigrationLedgerReady(database);
  const result = await replayErasureLedgerSubjects({
    apply: async (entry) => {
      const replayed = await replayExternalErasureLedgerEntry(database, {
        ackDigest: erasureReplayLedgerEntryDigest(entry),
        ledgerEntryId: entry.ledgerEntryId,
        recordedAt: entry.recordedAt,
        subjectUserId: entry.subjectUserId,
      });
      // A second independent query is the pre-traffic readiness assertion;
      // the command never reports success from the delete transaction alone.
      const verified = await reconcileErasedAccountRows(database, {
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
    ledger,
    maximumConcurrency,
    ...(signal ? { signal } : {}),
    subjects: restoredSubjects(database, signal),
  });
  signal?.throwIfAborted();
  const completedAt = (clock ?? (() => new Date()))().toISOString();
  signal?.throwIfAborted();
  const attestation = attestationSnapshot(
    await completeDatabaseRestoreReplayAttestation(database, {
      completedAt,
      reconciliationDigest: result.reconciliationDigest,
      replayedSubjectCount: result.replayedTombstones,
      restoreEpoch,
    }),
  );
  signal?.throwIfAborted();
  if (
    attestation.restoreEpochHash !== createHash("sha256").update(restoreEpoch).digest("hex") ||
    attestation.reconciliationDigest !== result.reconciliationDigest ||
    attestation.replayedSubjectCount !== String(result.replayedTombstones) ||
    (expectedTarget &&
      (attestation.databaseName !== expectedTarget.databaseName ||
        attestation.databaseOid !== expectedTarget.databaseOid))
  ) {
    throw new Error("Restore attestation does not match replay");
  }
  await assertDatabaseReady(database, {
    requireRestoreAttestation: true,
    restoreEpoch,
  });
  signal?.throwIfAborted();
  const rows = await database
    .withSchema("public")
    .selectFrom("database_restore_attestation")
    .select([
      "database_name as databaseName",
      "database_oid as databaseOid",
      "restore_epoch_hash as restoreEpochHash",
      "replayed_subject_count as replayedSubjectCount",
      "reconciliation_digest as reconciliationDigest",
      "completed_at as completedAt",
    ])
    .where("singleton", "=", true)
    .limit(2)
    .execute();
  signal?.throwIfAborted();
  if (rows.length !== 1) throw new Error("Restore attestation changed after readiness");
  const observed = attestationSnapshot(rows[0], true);
  if (ATTESTATION_FIELDS.some((name) => observed[name] !== attestation[name]))
    throw new Error("Restore attestation changed after readiness");
  return Object.freeze({ ...result, attestation: observed });
}

export async function createErasureRestoreRawStore(
  environment: NodeJS.ProcessEnv,
): Promise<RawArtifactStore> {
  const requestTimeoutMs = positiveInteger(
    environment.ERASURE_REPLAY_LEDGER_RESTORE_REQUEST_TIMEOUT_MS,
    30_000,
    300_000,
  );
  if (environment.ERASURE_REPLAY_LEDGER_STORE === "azure") {
    if (environment.ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER !== "azure_blob")
      throw new Error("Explicit Azure version inventory is required");
    for (const name of Object.keys(environment)) {
      if (
        environment[name] !== undefined &&
        (name.startsWith("ERASURE_REPLAY_LEDGER_RESTORE_OCI_") ||
          [
            "ERASURE_REPLAY_LEDGER_ENDPOINT",
            "ERASURE_REPLAY_LEDGER_BUCKET",
            "ERASURE_REPLAY_LEDGER_REGION",
            "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
            "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
            "ERASURE_REPLAY_LEDGER_RESTORE_SESSION_TOKEN",
            "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
            "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
            "ERASURE_REPLAY_LEDGER_WRITE_SESSION_TOKEN",
            "ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS",
            "ERASURE_REPLAY_LEDGER_AZURE_READ_SAS",
          ].includes(name))
      ) {
        throw new Error("Mixed erasure restore storage credentials are not permitted");
      }
    }
    return new AzureBlobRawArtifactStore({
      containerUrl: required(environment, "ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL"),
      prefix: required(environment, "ERASURE_REPLAY_LEDGER_AZURE_PREFIX"),
      sasToken: required(environment, "ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS"),
      role: "restore-reader",
      requestTimeoutMs,
      maximumObjectBytes: 16_384 + 128,
      restoreReadBudget: AZURE_LEDGER_RESTORE_READ_BUDGET,
    });
  }
  if (
    environment.ERASURE_REPLAY_LEDGER_STORE !== undefined &&
    environment.ERASURE_REPLAY_LEDGER_STORE !== "s3"
  )
    throw new Error("Invalid erasure restore storage provider");
  if (
    Object.keys(environment).some(
      (name) => name.startsWith("ERASURE_REPLAY_LEDGER_AZURE_") && environment[name] !== undefined,
    )
  )
    throw new Error("Azure restore must be explicitly selected");
  const endpointValue = required(environment, "ERASURE_REPLAY_LEDGER_ENDPOINT");
  const endpoint = new URL(endpointValue);
  if (environment.NODE_ENV === "production" && endpoint.protocol !== "https:") {
    throw new Error("HTTPS erasure replay ledger storage is required in production");
  }
  const bucket = required(environment, "ERASURE_REPLAY_LEDGER_BUCKET");
  const region = required(environment, "ERASURE_REPLAY_LEDGER_REGION");
  const singletonVersionResolver = await restoreVersionResolver(environment, {
    bucket,
    endpoint: endpointValue,
    region,
    requestTimeoutMs,
  });

  return new S3RawArtifactStore({
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
}

export async function runErasureLedgerRestoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ErasureRestoreResult> {
  const databaseRestoreEpoch = restoreEpoch(environment);
  const rawStore = await createErasureRestoreRawStore(environment);
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
  let work: { failed: false; result: ErasureRestoreResult } | { failed: true; reason: unknown };
  try {
    const result = await replayAndAttestErasureLedgerRestore({
      database,
      ledger,
      maximumConcurrency: positiveInteger(
        environment.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY,
        4,
        16,
      ),
      restoreEpoch: databaseRestoreEpoch,
    });
    work = { failed: false, result };
  } catch (error) {
    work = { failed: true, reason: error };
  }
  try {
    await database.destroy();
  } catch (error) {
    if (!work.failed) throw error;
  }
  if (work.failed) throw work.reason;
  return work.result;
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
