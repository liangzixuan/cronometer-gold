import { createHash } from "node:crypto";

import { type Kysely, sql } from "kysely";

import type { Database } from "./types.js";

export interface DatabaseRestoreTargetIdentity {
  readonly databaseName: string;
  readonly databaseOid: string;
}

/** The caller owns and pins this exclusive connection for the entire replay. */
export async function prepareDatabaseRestoreReplaySession(
  database: Kysely<Database>,
  expected: DatabaseRestoreTargetIdentity & { readonly expectedOwner: string },
): Promise<DatabaseRestoreTargetIdentity> {
  const fields = ["databaseName", "databaseOid", "expectedOwner"];
  if (
    !expected ||
    Object.getPrototypeOf(expected) !== Object.prototype ||
    Reflect.ownKeys(expected).length !== fields.length ||
    Reflect.ownKeys(expected).some((name) => typeof name !== "string" || !fields.includes(name))
  )
    throw new Error("Expected restore session is invalid");
  const values = fields.map((name) => Object.getOwnPropertyDescriptor(expected, name));
  if (values.some((value) => !value || !("value" in value)))
    throw new Error("Expected restore session is invalid");
  const [databaseName, databaseOid, expectedOwner] = values.map((value) => value?.value);
  if (
    !isCanonicalDatabaseIdentity(databaseName, databaseOid) ||
    typeof expectedOwner !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(expectedOwner)
  )
    throw new Error("Expected restore session is invalid");
  const identity = Object.freeze({
    databaseName: databaseName as string,
    databaseOid: databaseOid as string,
  });
  try {
    await sql`set role ${sql.id(expectedOwner)}`.execute(database);
    const result = await sql<{
      role: string;
    }>`select current_user::pg_catalog.text as role`.execute(database);
    if (
      result.rows.length !== 1 ||
      !result.rows[0] ||
      Reflect.ownKeys(result.rows[0]).length !== 1 ||
      Object.getOwnPropertyDescriptor(result.rows[0], "role")?.value !== expectedOwner
    )
      throw new Error("role");
  } catch {
    throw new Error("Restore session role is unavailable");
  }
  return assertDatabaseRestoreTargetIdentity(database, identity);
}

/** Observes cluster-local identity only; the caller must separately bind the connection and restore evidence. */
export async function assertDatabaseRestoreTargetIdentity(
  database: Kysely<Database>,
  expected: DatabaseRestoreTargetIdentity,
): Promise<DatabaseRestoreTargetIdentity> {
  const databaseName = expected?.databaseName;
  const databaseOid = expected?.databaseOid;
  if (!isCanonicalDatabaseIdentity(databaseName, databaseOid))
    throw new Error("Expected database identity is invalid");
  let observed: DatabaseRestoreTargetIdentity;
  try {
    observed = await loadDatabaseIdentity(database);
  } catch {
    throw new Error("Database target identity is unavailable");
  }
  if (!isCanonicalDatabaseIdentity(observed.databaseName, observed.databaseOid))
    throw new Error("Database target identity is unavailable");
  if (observed.databaseName !== databaseName || observed.databaseOid !== databaseOid)
    throw new Error("Database target identity does not match");
  return observed;
}

export interface DatabaseRestoreAttestationRecord {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly restoreEpochHash: string;
  readonly replayedSubjectCount: string;
  readonly reconciliationDigest: string;
  readonly completedAt: string;
}

export interface CompleteDatabaseRestoreReplayAttestationInput {
  readonly restoreEpoch: string;
  readonly replayedSubjectCount: bigint | number | string;
  readonly reconciliationDigest: string;
  readonly completedAt: string;
}

export class DatabaseRestoreReplayNotReadyError extends Error {
  constructor() {
    super("Database restore replay attestation is not current");
    this.name = "DatabaseRestoreReplayNotReadyError";
  }
}

export interface DatabaseRestoreReplayObservation {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly attestation:
    | {
        readonly restore_epoch_hash: string;
        readonly database_oid: string;
        readonly database_name: string;
      }
    | undefined;
}

/** The observation must come from the target, not an operator-supplied acceptance flag. */
export function assertDatabaseRestoreReplayObservation(
  observation: DatabaseRestoreReplayObservation,
  input: { readonly restoreEpoch: string },
): void {
  const epochHash = restoreEpochHash(input.restoreEpoch);
  if (!observation?.databaseName || !/^[1-9][0-9]*$/u.test(observation.databaseOid))
    throw new Error("Database identity is unavailable");
  assertRestoreReplayIdentity(observation, observation.attestation, epochHash);
}

function assertRestoreReplayIdentity(
  identity: { readonly databaseName: string; readonly databaseOid: string },
  attestation: DatabaseRestoreReplayObservation["attestation"],
  epochHash: string,
): void {
  if (
    !attestation ||
    attestation.restore_epoch_hash !== epochHash ||
    attestation.database_oid !== identity.databaseOid ||
    attestation.database_name !== identity.databaseName
  )
    throw new DatabaseRestoreReplayNotReadyError();
}

/** Fails closed unless this exact database instance was reconciled for the supplied restore epoch. */
export async function assertDatabaseRestoreReplayReady(
  database: Kysely<Database>,
  input: { readonly restoreEpoch: string },
): Promise<void> {
  const epochHash = restoreEpochHash(input.restoreEpoch);
  const identity = await loadDatabaseIdentity(database);
  const attestation = await database
    .selectFrom("database_restore_attestation")
    .select(["restore_epoch_hash", "database_oid", "database_name"])
    .where("singleton", "=", true)
    .executeTakeFirst();
  assertRestoreReplayIdentity(identity, attestation, epochHash);
}

/**
 * Offline-only finalization after every external ledger subject has replayed and reconciled.
 * The raw epoch is never persisted.
 */
export async function completeDatabaseRestoreReplayAttestation(
  database: Kysely<Database>,
  input: CompleteDatabaseRestoreReplayAttestationInput,
): Promise<DatabaseRestoreAttestationRecord> {
  const epochHash = restoreEpochHash(input.restoreEpoch);
  const completedAt = canonicalInstant(input.completedAt);
  const replayedSubjectCount = canonicalCount(input.replayedSubjectCount);
  if (!/^[0-9a-f]{64}$/u.test(input.reconciliationDigest))
    throw new Error("Restore reconciliation digest must be a SHA-256 digest");
  return database.transaction().execute(async (transaction) => {
    const identity = await loadDatabaseIdentity(transaction);
    const row = await transaction
      .insertInto("database_restore_attestation")
      .values({
        completed_at: completedAt,
        database_name: identity.databaseName,
        database_oid: identity.databaseOid,
        reconciliation_digest: input.reconciliationDigest,
        replayed_subject_count: replayedSubjectCount,
        restore_epoch_hash: epochHash,
      })
      .onConflict((conflict) =>
        conflict.column("singleton").doUpdateSet({
          completed_at: completedAt,
          database_name: identity.databaseName,
          database_oid: identity.databaseOid,
          reconciliation_digest: input.reconciliationDigest,
          replayed_subject_count: replayedSubjectCount,
          restore_epoch_hash: epochHash,
          updated_at: sql`clock_timestamp()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      completedAt: row.completed_at.toISOString(),
      databaseName: row.database_name,
      databaseOid: row.database_oid,
      reconciliationDigest: row.reconciliation_digest,
      replayedSubjectCount: row.replayed_subject_count,
      restoreEpochHash: row.restore_epoch_hash,
    };
  });
}

function isCanonicalDatabaseIdentity(databaseName: unknown, databaseOid: unknown): boolean {
  return (
    typeof databaseName === "string" &&
    databaseName.trim() === databaseName &&
    /^[a-z_][a-z0-9_]{0,62}$/u.test(databaseName) &&
    isCanonicalDatabaseOid(databaseOid)
  );
}

function isCanonicalDatabaseOid(databaseOid: unknown): boolean {
  return (
    typeof databaseOid === "string" &&
    databaseOid.trim() === databaseOid &&
    /^[1-9][0-9]{0,9}$/u.test(databaseOid) &&
    Number(databaseOid) <= 4_294_967_295
  );
}

async function loadDatabaseIdentity(
  database: Kysely<Database>,
): Promise<DatabaseRestoreTargetIdentity> {
  const result = await sql<{ database_name: string; database_oid: string }>`
    select pg_catalog.current_database() database_name,
           (select oid::pg_catalog.text from pg_catalog.pg_database where datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) database_oid
  `.execute(database);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    typeof row.database_name !== "string" ||
    row.database_name.length === 0 ||
    !isCanonicalDatabaseOid(row.database_oid)
  )
    throw new Error("Database identity is unavailable");
  return { databaseName: row.database_name, databaseOid: row.database_oid };
}

function restoreEpochHash(value: string): string {
  if (value.length < 32 || value.length > 500 || value.trim() !== value)
    throw new Error(
      "DATABASE_RESTORE_EPOCH must contain 32 to 500 non-whitespace-boundary characters",
    );
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalCount(value: bigint | number | string): string {
  const canonical = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(canonical))
    throw new Error("Restore replayed subject count must be a nonnegative integer");
  return canonical;
}

function canonicalInstant(value: string): Date {
  const instant = new Date(value);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.getUTCFullYear() < 1 ||
    instant.getUTCFullYear() > 9999
  )
    throw new Error("Restore attestation completion time is invalid");
  return instant;
}
