import { openOwnedPostgresSession } from "../packages/db/dist/index.js";

import { serializePostgresBackupEvidence } from "./postgres-backup-evidence.mjs";
import { preparePostgresRestoreEvidence } from "./postgres-restore-evidence-collector.mjs";

const OWNER = /^[a-z][a-z0-9_]{0,62}$/u;
const SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/u;
const failed = (phase) => new Error(`PostgreSQL backup snapshot ${phase} failed`);

/**
 * The consumer must await all its owned work and honor signal. This function
 * keeps the exporting transaction open through that settlement, then awaits
 * rollback and connection closure. It cannot terminate arbitrary JavaScript
 * that ignores cancellation, and it does not execute or attest pg_dump.
 */
export async function withPostgresBackupSnapshot(options, consume) {
  const { expectedOwner, ...connection } = options ?? {};
  if (
    typeof expectedOwner !== "string" ||
    !OWNER.test(expectedOwner) ||
    typeof consume !== "function"
  )
    throw failed("configuration");
  const session = await openOwnedPostgresSession(connection);
  let result;
  let primary;
  let primaryFailed = false;
  const cleanup = [];
  let phase = "preparation";
  try {
    const collector = await preparePostgresRestoreEvidence(session.query, {
      expectedOwner,
      signal: session.signal,
    });
    phase = "export";
    await session.query({
      text: "begin isolation level repeatable read read only",
      values: [],
      rowMode: "array",
      signal: session.signal,
    });
    const exported = await session.query({
      text: "select pg_catalog.pg_export_snapshot()",
      values: [],
      rowMode: "array",
      signal: session.signal,
    });
    const snapshotId = exported.rows?.[0]?.[0];
    if (
      exported.rows?.length !== 1 ||
      exported.rows[0]?.length !== 1 ||
      typeof snapshotId !== "string" ||
      !SNAPSHOT.test(snapshotId)
    )
      throw failed("export");
    phase = "collection";
    const evidence = await collector.collect({ signal: session.signal });
    const sourceEvidence = serializePostgresBackupEvidence(evidence, expectedOwner);
    if (session.signal.aborted) throw failed("cancellation");
    phase = "consumer";
    result = await consume(Object.freeze({ snapshotId, sourceEvidence, signal: session.signal }));
    if (session.signal.aborted) throw failed("cancellation");
  } catch (error) {
    primaryFailed = true;
    primary =
      phase === "preparation" &&
      error instanceof AggregateError &&
      error.message === "PostgreSQL evidence preparation and cleanup failed" &&
      error.errors.length === 2
        ? new AggregateError(
            [failed("preparation"), failed("preparation cleanup")],
            "PostgreSQL backup snapshot preparation and cleanup failed",
          )
        : failed(phase);
  } finally {
    try {
      await session.query({
        text: "rollback",
        values: [],
        rowMode: "array",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      cleanup.push(failed("rollback"));
    }
    try {
      await session.close();
    } catch {
      cleanup.push(failed("closure"));
    }
  }
  if (primaryFailed && cleanup.length)
    throw new AggregateError(
      [primary, ...cleanup],
      "PostgreSQL backup snapshot operation and cleanup failed",
    );
  if (primaryFailed) throw primary;
  if (cleanup.length)
    throw new AggregateError(cleanup, "PostgreSQL backup snapshot cleanup failed");
  return result;
}
