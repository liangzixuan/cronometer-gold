import { createHash } from "node:crypto";

import {
  canonicalizeRestoreAuthorityEvidence,
  RESTORE_AUTHORITY_POLICY_SHA256,
  validateRestoreAuthorityEvidence,
  validateRestoreMigrationLedger,
} from "./postgres-restore-drill.mjs";

export const POSTGRES_BACKUP_EVIDENCE_LIMITS = Object.freeze({
  bytes: 1_048_576,
  depth: 32,
  nodes: 50_000,
  arrayEntries: 4_096,
});

const FORMAT = "nutrition-postgres-restore-evidence-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const COUNT = /^(?:0|[1-9][0-9]{0,18})$/u;
const MAX_COUNT = 9_223_372_036_854_775_807n;
const COLLECTED_KEYS = [
  "authorityFingerprint",
  "authorityFingerprintSha256",
  "authorityPolicySha256",
  "migrationLedger",
  "tableCounts",
  "unvalidatedConstraints",
];
const RECORD_KEYS = [...COLLECTED_KEYS, "expectedOwner", "formatVersion"];
const AUTHORITY_KEYS = [
  "authorityConstraints",
  "authorityFrozenColumns",
  "authorityIndexes",
  "authorityViews",
  "columnAcls",
  "defaultAcls",
  "explicitColumnAclAttributeCount",
  "functions",
  "referenceIntegrityConstraints",
  "relations",
  "roles",
  "schema",
  "triggers",
  "types",
  "version",
];
const ACL_KEYS = ["grantable", "grantee", "grantor", "privilege"];
const RELATION_KEYS = ["acl", "acl_is_default", "kind", "name", "owner"];

export class PostgresBackupEvidenceError extends Error {
  constructor() {
    super("PostgreSQL backup source evidence is invalid");
    this.name = "PostgresBackupEvidenceError";
  }
}

function requireEvidence(condition) {
  if (!condition) throw new PostgresBackupEvidenceError();
}

function exactKeys(value, expected) {
  requireEvidence(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  requireEvidence(
    actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index]),
  );
}

// Bound traversal before calling the existing recursive canonicalizer. Parsed
// objects are data only; no policy decisions or SQL are implemented here.
function boundJson(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    nodes++;
    requireEvidence(
      nodes <= POSTGRES_BACKUP_EVIDENCE_LIMITS.nodes &&
        item.depth <= POSTGRES_BACKUP_EVIDENCE_LIMITS.depth,
    );
    const current = item.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      requireEvidence(
        current.isWellFormed() &&
          Buffer.byteLength(current, "utf8") <= POSTGRES_BACKUP_EVIDENCE_LIMITS.bytes,
      );
      continue;
    }
    if (typeof current === "number") {
      requireEvidence(Number.isFinite(current));
      continue;
    }
    requireEvidence(current !== null && typeof current === "object");
    const keys = Object.keys(current);
    if (Array.isArray(current)) {
      requireEvidence(
        Object.getPrototypeOf(current) === Array.prototype &&
          current.length <= POSTGRES_BACKUP_EVIDENCE_LIMITS.arrayEntries &&
          keys.length === current.length &&
          keys.every((key, index) => key === String(index)),
      );
    } else {
      requireEvidence([Object.prototype, null].includes(Object.getPrototypeOf(current)));
    }
    requireEvidence(nodes + pending.length + keys.length <= POSTGRES_BACKUP_EVIDENCE_LIMITS.nodes);
    for (const key of keys) {
      requireEvidence(
        key.isWellFormed() &&
          Buffer.byteLength(key, "utf8") <= POSTGRES_BACKUP_EVIDENCE_LIMITS.bytes,
      );
      pending.push({ value: current[key], depth: item.depth + 1 });
    }
  }
}

function canonicalDocument(text) {
  requireEvidence(
    typeof text === "string" &&
      text.length > 0 &&
      Buffer.byteLength(text, "utf8") <= POSTGRES_BACKUP_EVIDENCE_LIMITS.bytes,
  );
  const parsed = JSON.parse(text);
  boundJson(parsed);
  requireEvidence(canonicalizeRestoreAuthorityEvidence(parsed) === text);
  return parsed;
}

function uniqueIdentities(rows, fields) {
  const identities = new Set();
  for (const row of rows) {
    const identity = JSON.stringify(fields.map((field) => row[field]));
    requireEvidence(!identities.has(identity));
    identities.add(identity);
  }
}

function aclRows(value) {
  requireEvidence(Array.isArray(value));
  for (const row of value) {
    exactKeys(row, ACL_KEYS);
    requireEvidence(
      typeof row.grantable === "boolean" &&
        [row.grantee, row.grantor, row.privilege].every((entry) => typeof entry === "string"),
    );
  }
  uniqueIdentities(value, ["grantor", "grantee", "privilege"]);
}

function authorityProjection(authority) {
  exactKeys(authority, AUTHORITY_KEYS);
  requireEvidence(authority.version === 16 && authority.explicitColumnAclAttributeCount === "0");
  for (const key of AUTHORITY_KEYS) {
    if (!["version", "schema", "explicitColumnAclAttributeCount"].includes(key)) {
      requireEvidence(Array.isArray(authority[key]));
    }
  }
  exactKeys(authority.schema, ["acl", "acl_is_default", "name", "owner"]);
  aclRows(authority.schema.acl);
  for (const [rows, kinds] of [
    [authority.relations, ["r", "p", "S", "v", "m", "f"]],
    [authority.types, ["b", "c", "d", "e", "p", "r", "m"]],
  ]) {
    for (const row of rows) {
      exactKeys(row, RELATION_KEYS);
      requireEvidence(
        typeof row.acl_is_default === "boolean" &&
          [row.kind, row.name, row.owner].every((entry) => typeof entry === "string") &&
          kinds.includes(row.kind),
      );
      aclRows(row.acl);
    }
  }
  for (const row of authority.roles) {
    exactKeys(row, [
      "bypass_rls",
      "can_login",
      "create_database",
      "create_role",
      "incoming_memberships",
      "name",
      "outgoing_memberships",
      "owned_object_count",
      "replication",
      "superuser",
    ]);
  }
  for (const row of authority.functions) {
    exactKeys(row, [
      "acl",
      "acl_is_default",
      "arguments",
      "config",
      "language",
      "leakproof",
      "name",
      "owner",
      "parallel",
      "result_type",
      "security_definer",
      "source_sha256",
      "strict",
      "volatility",
    ]);
    requireEvidence(
      [
        row.arguments,
        row.language,
        row.name,
        row.owner,
        row.parallel,
        row.result_type,
        row.volatility,
      ].every((entry) => typeof entry === "string") &&
        [row.acl_is_default, row.leakproof, row.security_definer, row.strict].every(
          (entry) => typeof entry === "boolean",
        ) &&
        typeof row.source_sha256 === "string" &&
        SHA256.test(row.source_sha256) &&
        Array.isArray(row.config) &&
        row.config.every((entry) => typeof entry === "string"),
    );
    aclRows(row.acl);
  }
  for (const row of authority.triggers) {
    exactKeys(row, [
      "definition",
      "enabled",
      "function_arguments",
      "function_name",
      "function_schema",
      "name",
      "table_name",
      "table_schema",
    ]);
    requireEvidence(Object.values(row).every((entry) => typeof entry === "string"));
  }
  uniqueIdentities(authority.types, ["name"]);
  uniqueIdentities(authority.functions, ["name", "arguments"]);
  uniqueIdentities(authority.triggers, ["table_schema", "table_name", "name"]);
  // Exact policy-owned constraint, column, index and view projections are checked
  // by the existing validator, including their keys and order.
}

function validateRecord(record, expectedOwner) {
  requireEvidence(typeof expectedOwner === "string" && NAME.test(expectedOwner));
  exactKeys(record, RECORD_KEYS);
  requireEvidence(record.formatVersion === FORMAT && record.expectedOwner === expectedOwner);
  requireEvidence(record.authorityPolicySha256 === RESTORE_AUTHORITY_POLICY_SHA256);
  requireEvidence(
    typeof record.authorityFingerprintSha256 === "string" &&
      SHA256.test(record.authorityFingerprintSha256),
  );
  const authority = canonicalDocument(record.authorityFingerprint);
  authorityProjection(authority);
  requireEvidence(
    createHash("sha256").update(record.authorityFingerprint, "utf8").digest("hex") ===
      record.authorityFingerprintSha256,
  );
  validateRestoreAuthorityEvidence(authority, expectedOwner);
  canonicalDocument(record.migrationLedger);
  requireEvidence(
    validateRestoreMigrationLedger(record.migrationLedger) === record.migrationLedger,
  );
  requireEvidence(record.unvalidatedConstraints === "0");
  requireEvidence(Array.isArray(record.tableCounts));
  const tableCounts = new Map();
  let previous = "";
  for (const row of record.tableCounts) {
    exactKeys(row, ["count", "table"]);
    requireEvidence(typeof row.table === "string" && NAME.test(row.table) && row.table > previous);
    requireEvidence(typeof row.count === "string" && COUNT.test(row.count));
    requireEvidence(BigInt(row.count) <= MAX_COUNT);
    tableCounts.set(row.table, row.count);
    previous = row.table;
  }
  const tables = authority.relations
    .filter((row) => row.kind === "r" || row.kind === "p")
    .map((row) => row.name)
    .sort();
  requireEvidence(tables.length === tableCounts.size);
  requireEvidence(tables.every((table, index) => table === record.tableCounts[index].table));
  return {
    authorityFingerprint: record.authorityFingerprint,
    authorityFingerprintSha256: record.authorityFingerprintSha256,
    authorityPolicySha256: record.authorityPolicySha256,
    migrationLedger: record.migrationLedger,
    tableCounts,
    unvalidatedConstraints: record.unvalidatedConstraints,
  };
}

/** Serialize caller-collected evidence; this does not establish snapshot provenance. */
export function serializePostgresBackupEvidence(evidence, expectedOwner) {
  try {
    exactKeys(evidence, COLLECTED_KEYS);
    requireEvidence(
      evidence.tableCounts instanceof Map &&
        Object.getPrototypeOf(evidence.tableCounts) === Map.prototype &&
        evidence.tableCounts.size <= POSTGRES_BACKUP_EVIDENCE_LIMITS.arrayEntries,
    );
    for (const [table, count] of evidence.tableCounts) {
      requireEvidence(typeof table === "string" && NAME.test(table));
      requireEvidence(typeof count === "string" && COUNT.test(count));
    }
    const record = {
      ...evidence,
      expectedOwner,
      formatVersion: FORMAT,
      tableCounts: [...evidence.tableCounts]
        .map(([table, count]) => ({ count, table }))
        .sort((left, right) => (left.table < right.table ? -1 : left.table > right.table ? 1 : 0)),
    };
    boundJson(record);
    validateRecord(record, expectedOwner);
    const bytes = Buffer.from(canonicalizeRestoreAuthorityEvidence(record), "utf8");
    requireEvidence(bytes.length <= POSTGRES_BACKUP_EVIDENCE_LIMITS.bytes);
    return bytes;
  } catch {
    throw new PostgresBackupEvidenceError();
  }
}

/** Validate authenticated bytes against current policy and an independently supplied owner. */
export function parsePostgresBackupEvidence(bytes, expectedOwner) {
  try {
    requireEvidence(
      Buffer.isBuffer(bytes) &&
        bytes.length > 0 &&
        bytes.length <= POSTGRES_BACKUP_EVIDENCE_LIMITS.bytes,
    );
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const record = canonicalDocument(text);
    return validateRecord(record, expectedOwner);
  } catch {
    throw new PostgresBackupEvidenceError();
  }
}
