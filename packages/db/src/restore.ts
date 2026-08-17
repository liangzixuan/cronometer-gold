import { createHash } from "node:crypto";

import { type Kysely, sql } from "kysely";

import type { Database } from "./types.js";

export interface DatabaseRestoreAttestationRecord {
  readonly databaseName: string;
  readonly databaseOid: string;
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
  if (
    !attestation ||
    attestation.restore_epoch_hash !== epochHash ||
    attestation.database_oid !== identity.databaseOid ||
    attestation.database_name !== identity.databaseName
  )
    throw new Error("Database restore replay attestation is not current");
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
    };
  });
}

async function loadDatabaseIdentity(database: Kysely<Database>): Promise<{
  databaseName: string;
  databaseOid: string;
}> {
  const result = await sql<{ database_name: string; database_oid: string }>`
    select current_database() database_name,
           (select oid::text from pg_database where datname=current_database()) database_oid
  `.execute(database);
  const row = result.rows[0];
  if (!row?.database_name || !/^[1-9][0-9]*$/u.test(row.database_oid))
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
