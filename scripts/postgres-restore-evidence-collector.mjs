import { createHash, randomUUID } from "node:crypto";

import {
  POSTGRES_BACKUP_EVIDENCE_LIMITS,
  parsePostgresBackupEvidence,
  serializePostgresBackupEvidence,
} from "./postgres-backup-evidence.mjs";
import {
  canonicalizeRestoreAuthorityEvidence,
  RESTORE_AUTHORITY_POLICY_SHA256,
  RESTORE_EVIDENCE_QUERIES,
  RESTORE_EVIDENCE_VIEW_QUERIES,
} from "./postgres-restore-drill.mjs";
import {
  RESTORE_MIGRATION_LEDGER_QUERY,
  RESTORE_TABLE_LIST_QUERY,
  RESTORE_UNVALIDATED_CONSTRAINTS_QUERY,
  restoreTableCountQuery,
} from "./postgres-restore-evidence-queries.mjs";

const NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const MAX_RESULT_BYTES = POSTGRES_BACKUP_EVIDENCE_LIMITS.bytes;
const MAX_TOTAL_RESULT_BYTES = 4 * MAX_RESULT_BYTES;
const IDENTITY_QUERY = [
  "select pg_catalog.json_build_object('backend',pg_catalog.pg_backend_pid()::text,",
  "'database',pg_catalog.current_database(),'principal',current_user,'sessionPrincipal',session_user,",
  "'isolation',pg_catalog.current_setting('transaction_isolation'),",
  "'readOnly',pg_catalog.current_setting('transaction_read_only'),",
  "'snapshot',pg_catalog.pg_current_snapshot()::text,'transactionStartedAt',pg_catalog.transaction_timestamp()::text,",
  "'virtualTransaction',(select virtualxid from pg_catalog.pg_locks where pid=pg_catalog.pg_backend_pid()",
  "and locktype='virtualxid' and mode='ExclusiveLock' and granted))::text",
].join(" ");
const IDENTITY_KEYS = [
  "backend",
  "database",
  "principal",
  "sessionPrincipal",
  "isolation",
  "readOnly",
  "snapshot",
  "transactionStartedAt",
  "virtualTransaction",
];
const VIEW_QUERY = [
  "select pg_catalog.json_build_object('definition',pg_catalog.pg_get_viewdef(actual.oid,false),",
  "'options',coalesce(actual.reloptions,array[]::text[]))::text",
  "from pg_catalog.pg_class actual join pg_catalog.pg_namespace namespace on namespace.oid=actual.relnamespace",
  "where namespace.nspname='public' and actual.relname=$1 and actual.relkind='v'",
].join(" ");

function invalid() {
  return new Error("PostgreSQL restore evidence collection is invalid");
}

function requireValue(condition) {
  if (!condition) throw invalid();
}

function checkSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid();
  if (signal?.aborted) throw new Error("PostgreSQL restore evidence collection was aborted");
}

// The input byte limit is enforced before JSON.parse. Bound its parsed structure
// before invoking the existing recursive canonicalizer or policy validators.
function parseBoundedJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    requireValue(++nodes <= POSTGRES_BACKUP_EVIDENCE_LIMITS.nodes);
    requireValue(entry.depth <= POSTGRES_BACKUP_EVIDENCE_LIMITS.depth);
    if (entry.value !== null && typeof entry.value === "object") {
      const children = Object.values(entry.value);
      requireValue(children.length <= POSTGRES_BACKUP_EVIDENCE_LIMITS.arrayEntries);
      for (const child of children) pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return value;
}

function sessionMatches(left, right) {
  return ["backend", "database", "principal", "sessionPrincipal"].every(
    (key) => left[key] === right[key],
  );
}

function validateIdentity(value) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  requireValue(Object.keys(value).length === IDENTITY_KEYS.length);
  for (const key of IDENTITY_KEYS) {
    requireValue(typeof value[key] === "string" && value[key].length > 0);
  }
  requireValue(/^[1-9][0-9]{0,9}$/u.test(value.backend));
  requireValue(/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/u.test(value.snapshot));
  requireValue(value.transactionStartedAt.length <= 100);
  requireValue(/^[0-9]+\/[0-9]+$/u.test(value.virtualTransaction));
  return value;
}

function executor(query, signal) {
  let bytes = 0;
  return async (text, values = [], scalar = true) => {
    checkSignal(signal);
    // signal is this adapter's cancellation contract, not a pg.QueryConfig field.
    // Await every started query; a timeout race could leave the session running.
    const result = await query({ text, values, rowMode: "array", signal });
    checkSignal(signal);
    requireValue(result !== null && typeof result === "object" && Array.isArray(result.rows));
    if (!scalar) {
      requireValue(result.rows.length === 0);
      return undefined;
    }
    requireValue(
      result.rows.length === 1 && Array.isArray(result.rows[0]) && result.rows[0].length === 1,
    );
    const value = result.rows[0][0];
    requireValue(typeof value === "string" && value.length <= MAX_RESULT_BYTES);
    const length = Buffer.byteLength(value, "utf8");
    bytes += length;
    requireValue(length <= MAX_RESULT_BYTES && bytes <= MAX_TOTAL_RESULT_BYTES);
    return value;
  };
}

/**
 * query must represent one newly owned, idle PostgreSQL connection, never a
 * pooled adapter or a connection with an existing transaction. Ownership and
 * idle protocol state must be established by the owner, not by SQL here. Its
 * adapter must bound results, implement actual cancellation, and own connection
 * closure. Passing pg.Client.query directly does not satisfy that contract.
 *
 * Preparation owns a short writable transaction and always awaits ROLLBACK.
 * Its expected view definitions are derived from reviewed queries before the
 * caller starts the exported READ ONLY REPEATABLE READ snapshot. A failed
 * rollback leaves the connection unusable; the caller must close it.
 */
export async function preparePostgresRestoreEvidence(query, { expectedOwner, signal } = {}) {
  requireValue(
    typeof query === "function" && typeof expectedOwner === "string" && NAME.test(expectedOwner),
  );
  checkSignal(signal);
  const execute = executor(query, signal);
  const views = [];
  let preparedIdentity;
  let primaryError;
  let cleanupError;
  let preparationFailed = false;
  let cleanupFailed = false;
  try {
    await execute("begin read write", [], false);
    preparedIdentity = validateIdentity(parseBoundedJson(await execute(IDENTITY_QUERY)));
    requireValue(preparedIdentity.readOnly === "off");
    await execute("set local search_path = pg_catalog, public, pg_temp", [], false);
    for (const policy of RESTORE_EVIDENCE_VIEW_QUERIES) {
      const temporaryName = `catalogue_expected_${randomUUID().replaceAll("-", "")}`;
      await execute(`create temporary view ${temporaryName} as ${policy.query};`, [], false);
      const definition = await execute("select pg_catalog.pg_get_viewdef($1::regclass,false)", [
        `pg_temp.${temporaryName}`,
      ]);
      requireValue(definition.length > 0);
      views.push(
        Object.freeze({ name: policy.name, sourceSha256: policy.sourceSha256, definition }),
      );
    }
  } catch (error) {
    primaryError = error;
    preparationFailed = true;
  } finally {
    try {
      // Cleanup receives its own bound even when the operation signal is aborted.
      // The adapter must honor it; this module cannot interrupt a dishonest driver.
      await executor(query, AbortSignal.timeout(5_000))("rollback", [], false);
    } catch (error) {
      cleanupError = error;
      cleanupFailed = true;
    }
  }
  if (preparationFailed && cleanupFailed) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "PostgreSQL evidence preparation and cleanup failed",
    );
  }
  if (cleanupFailed) throw cleanupError;
  if (preparationFailed) throw primaryError;
  checkSignal(signal);

  let used = false;
  return Object.freeze({
    /**
     * Single use, including failures. The caller starts and owns the exported
     * read-only repeatable-read transaction before invoking collect, and holds
     * it through pg_dump. These guards do not prove export or dump import.
     */
    async collect({ signal: collectionSignal } = {}) {
      requireValue(!used);
      used = true;
      checkSignal(collectionSignal);
      const read = executor(query, collectionSignal);
      const initial = validateIdentity(parseBoundedJson(await read(IDENTITY_QUERY)));
      requireValue(sessionMatches(preparedIdentity, initial));
      requireValue(initial.readOnly === "on" && initial.isolation === "repeatable read");
      await read("set local search_path = pg_catalog, public, pg_temp", [], false);
      requireValue(
        (await read("select pg_catalog.set_config('nutrition.expected_restore_owner',$1,true)", [
          expectedOwner,
        ])) === expectedOwner,
      );

      const authority = {};
      for (const [name, definition] of Object.entries(RESTORE_EVIDENCE_QUERIES)) {
        const value = await read(definition.parts.join(" "));
        authority[name] = definition.kind === "json" ? parseBoundedJson(value) : value;
      }
      authority.authorityViews = [];
      for (const expected of views) {
        const actual = parseBoundedJson(await read(VIEW_QUERY, [expected.name]));
        requireValue(actual !== null && typeof actual === "object" && !Array.isArray(actual));
        requireValue(
          Object.keys(actual).length === 2 &&
            typeof actual.definition === "string" &&
            Array.isArray(actual.options),
        );
        authority.authorityViews.push({
          name: expected.name,
          sourceSha256: expected.sourceSha256,
          definitionMatches: actual.definition === expected.definition,
          options: actual.options,
        });
      }
      authority.version = 16;
      const authorityFingerprint = canonicalizeRestoreAuthorityEvidence(authority);
      const migrationLedgerRaw = await read(RESTORE_MIGRATION_LEDGER_QUERY.join(" "));
      const migrationLedger = canonicalizeRestoreAuthorityEvidence(
        parseBoundedJson(migrationLedgerRaw),
      );
      const unvalidatedConstraints = await read(RESTORE_UNVALIDATED_CONSTRAINTS_QUERY.join(" "));
      const tableList = await read(RESTORE_TABLE_LIST_QUERY.join(" "));
      const tables = tableList === "" ? [] : tableList.split(",");
      requireValue(tables.length <= POSTGRES_BACKUP_EVIDENCE_LIMITS.arrayEntries);
      requireValue(new Set(tables).size === tables.length);
      const tableCounts = new Map();
      for (const table of tables) {
        requireValue(NAME.test(table));
        tableCounts.set(table, await read(restoreTableCountQuery(table).join(" ")));
      }
      const final = validateIdentity(parseBoundedJson(await read(IDENTITY_QUERY)));
      requireValue(IDENTITY_KEYS.every((key) => initial[key] === final[key]));
      const evidence = {
        authorityFingerprint,
        authorityFingerprintSha256: createHash("sha256")
          .update(authorityFingerprint, "utf8")
          .digest("hex"),
        authorityPolicySha256: RESTORE_AUTHORITY_POLICY_SHA256,
        migrationLedger,
        tableCounts,
        unvalidatedConstraints,
      };
      checkSignal(collectionSignal);
      return parsePostgresBackupEvidence(
        serializePostgresBackupEvidence(evidence, expectedOwner),
        expectedOwner,
      );
    },
  });
}
