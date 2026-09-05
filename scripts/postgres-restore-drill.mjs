import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_DATABASE = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_RESTORE_DATABASE = /^nutrition_restore_[a-z0-9_]{1,45}$/;
const SAFE_ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_ABSOLUTE_DIRECTORY = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const PROTECTED_DUMP_STORAGE = new Set(["encrypted_volume", "tmpfs"]);
const AUTHORITY_POLICY_PATH = new URL(
  "../packages/db/restore/0014_catalogue_authority_policy.sql",
  import.meta.url,
);
const EXPECTED_AUTHORITY_POLICY_SHA256 =
  "7f099eeab83f4d028e8c48abbc904aaacf3d610fe10ce5644a0bce155ff8b7ef";
const CAPABILITY_ROLES = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
];
const DEFAULT_AUTHORITY_FUNCTION_POLICY = {
  arguments: "",
  language: "plpgsql",
  leakproof: false,
  parallel: "u",
  resultType: "trigger",
  securityDefiner: false,
  strict: false,
  volatility: "v",
};
const AUTHORITY_FUNCTION_POLICY = new Map([
  [
    "catalogue_evidence_bundle_uri_is_valid",
    {
      arguments: "value text, digest text",
      language: "sql",
      leakproof: false,
      parallel: "u",
      resultType: "boolean",
      securityDefiner: false,
      sourceSha256: "5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e",
      strict: true,
      volatility: "i",
    },
  ],
  [
    "catalogue_record_import_approval",
    {
      arguments:
        "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "boolean",
      securityDefiner: true,
      sourceSha256: "89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "guard_food_import_approval_authority",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd",
    },
  ],
  [
    "guard_food_import_batch_initial_state",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "2561714155de31151c79f95977156072a66451d1f13f7b5c6e85d13abe9ecb0c",
    },
  ],
  [
    "guard_food_import_batch_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "59dc41d73ec62b554caa721e13a2581a75327688f840cab922fddad0ca7be249",
    },
  ],
  [
    "guard_food_import_batch_validation_digest",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "511c01c16477a31c2de7639a5b48c65e421167c129dfd83377f9256210288ba2",
    },
  ],
  [
    "guard_food_import_record_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "b111a6db4f4bd43bf2e9183ecf0ee8b19ccda1ed3679c598ef2f73d58d9cb2d9",
    },
  ],
  [
    "guard_food_source_active_release_authority",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "306eec1771a7bbf7961bd6d46ba752801fe98f07d27fbf96291a1c454750cd11",
    },
  ],
  [
    "guard_food_source_initial_active_release",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "e3cbc51f28aafd274ea2bc3b71b824d51180d8e741dbcfd22d0af9e21849be43",
    },
  ],
  [
    "guard_food_source_release_initial_state",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "797445724ddd8d37cdbcc1891c724e9bd8af543548d322db5cf9c3d22ac13b3d",
    },
  ],
  [
    "guard_food_source_release_legacy_promotion_grandfather",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "22340dfcbb5f98e1d0504703b0fb37830b31a4ecde5cbe81e55844968b86f214",
    },
  ],
  [
    "guard_food_source_release_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "191701f20750b6e98b8acf290a1df2417bf17bd9c3a4e5e87a7ac7ef56453726",
    },
  ],
  [
    "guard_new_food_source_release_authority",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "93f189e2c097009ac1cbf1129ce10a24d0c7fd2e4cee66c2ea5cdbb1537462b3",
    },
  ],
  [
    "reject_new_legacy_unbound_catalogue_evidence",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e",
    },
  ],
]);
const AUTHORITY_TRIGGER_POLICY = new Map([
  [
    "food_import_approval_guard_authority",
    {
      definition:
        "CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()",
      functionName: "guard_food_import_approval_authority",
      tableName: "food_import_approval",
    },
  ],
  [
    "food_import_batch_guard_initial_state",
    {
      definition:
        "CREATE TRIGGER food_import_batch_guard_initial_state BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_initial_state()",
      functionName: "guard_food_import_batch_initial_state",
      tableName: "food_import_batch",
    },
  ],
  [
    "food_import_batch_guard_update",
    {
      definition:
        "CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()",
      functionName: "guard_food_import_batch_update",
      tableName: "food_import_batch",
    },
  ],
  [
    "food_import_batch_guard_validation_digest",
    {
      definition:
        "CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()",
      functionName: "guard_food_import_batch_validation_digest",
      tableName: "food_import_batch",
    },
  ],
  [
    "food_import_batch_reject_new_legacy_unbound",
    {
      definition:
        "CREATE TRIGGER food_import_batch_reject_new_legacy_unbound BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
      functionName: "reject_new_legacy_unbound_catalogue_evidence",
      tableName: "food_import_batch",
    },
  ],
  [
    "food_import_record_guard_update",
    {
      definition:
        "CREATE TRIGGER food_import_record_guard_update BEFORE UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()",
      functionName: "guard_food_import_record_update",
      tableName: "food_import_record",
    },
  ],
  [
    "food_source_guard_active_release_authority",
    {
      definition:
        "CREATE TRIGGER food_source_guard_active_release_authority BEFORE UPDATE OF active_release_id ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_active_release_authority()",
      functionName: "guard_food_source_active_release_authority",
      tableName: "food_source",
    },
  ],
  [
    "food_source_guard_initial_active_release",
    {
      definition:
        "CREATE TRIGGER food_source_guard_initial_active_release BEFORE INSERT ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_initial_active_release()",
      functionName: "guard_food_source_initial_active_release",
      tableName: "food_source",
    },
  ],
  [
    "food_source_release_guard_initial_state",
    {
      definition:
        "CREATE TRIGGER food_source_release_guard_initial_state BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_initial_state()",
      functionName: "guard_food_source_release_initial_state",
      tableName: "food_source_release",
    },
  ],
  [
    "food_source_release_guard_legacy_grandfather_insert",
    {
      definition:
        "CREATE TRIGGER food_source_release_guard_legacy_grandfather_insert BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
      functionName: "guard_food_source_release_legacy_promotion_grandfather",
      tableName: "food_source_release",
    },
  ],
  [
    "food_source_release_guard_legacy_grandfather_update",
    {
      definition:
        "CREATE TRIGGER food_source_release_guard_legacy_grandfather_update BEFORE UPDATE OF legacy_promotion_grandfathered_at ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
      functionName: "guard_food_source_release_legacy_promotion_grandfather",
      tableName: "food_source_release",
    },
  ],
  [
    "food_source_release_guard_new_authority",
    {
      definition:
        "CREATE TRIGGER food_source_release_guard_new_authority BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_new_food_source_release_authority()",
      functionName: "guard_new_food_source_release_authority",
      tableName: "food_source_release",
    },
  ],
  [
    "food_source_release_guard_update",
    {
      definition:
        "CREATE TRIGGER food_source_release_guard_update BEFORE UPDATE ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_update()",
      functionName: "guard_food_source_release_update",
      tableName: "food_source_release",
    },
  ],
  [
    "food_source_release_reject_new_legacy_unbound",
    {
      definition:
        "CREATE TRIGGER food_source_release_reject_new_legacy_unbound BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
      functionName: "reject_new_legacy_unbound_catalogue_evidence",
      tableName: "food_source_release",
    },
  ],
]);
const AUTHORITY_POLICY_SQL = readFileSync(AUTHORITY_POLICY_PATH, "utf8");

export const RESTORE_AUTHORITY_POLICY_SHA256 = assertRestoreAuthorityPolicyDigest(
  AUTHORITY_POLICY_SQL,
  EXPECTED_AUTHORITY_POLICY_SHA256,
);

export function parseRestoreDrillArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Restore drill arguments must be --name value pairs");
    }
    if (values.has(flag)) throw new Error(`Duplicate restore drill argument: ${flag}`);
    values.set(flag, value);
  }

  const allowed = new Set([
    "--container",
    "--connect-allowlist",
    "--dump-directory",
    "--dump-protection",
    "--expected-owner",
    "--source-db",
    "--target-db",
    "--user",
  ]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`Unknown restore drill argument: ${flag}`);
  }

  const container = required(values, "--container");
  const connectAllowlistValue = required(values, "--connect-allowlist");
  const sourceDatabase = required(values, "--source-db");
  const targetDatabase = required(values, "--target-db");
  const user = values.get("--user") ?? "nutrition";
  const dumpDirectory = required(values, "--dump-directory");
  const dumpProtection = required(values, "--dump-protection");
  const expectedOwner = required(values, "--expected-owner");

  if (!SAFE_CONTAINER.test(container)) throw new Error("Invalid Docker container identifier");
  const connectAllowlist = [...new Set(connectAllowlistValue.split(","))].sort();
  if (
    connectAllowlist.length === 0 ||
    connectAllowlist.some((role) => !SAFE_ROLE.test(role)) ||
    connectAllowlist.join(",") !== connectAllowlistValue
  ) {
    throw new Error("CONNECT allowlist must contain unique, sorted, safe PostgreSQL login roles");
  }
  if (!SAFE_DATABASE.test(sourceDatabase)) throw new Error("Invalid source database name");
  if (!SAFE_RESTORE_DATABASE.test(targetDatabase)) {
    throw new Error("Restore target must be a bounded nutrition_restore_* database name");
  }
  if (sourceDatabase === targetDatabase) throw new Error("Source and restore target must differ");
  if (!SAFE_ROLE.test(user)) throw new Error("Invalid PostgreSQL role name");
  if (!SAFE_ROLE.test(expectedOwner)) throw new Error("Invalid expected PostgreSQL owner name");
  if (
    !SAFE_ABSOLUTE_DIRECTORY.test(dumpDirectory) ||
    dumpDirectory === "/tmp" ||
    dumpDirectory.startsWith("/tmp/") ||
    dumpDirectory.includes("/../")
  ) {
    throw new Error("Dump directory must be an explicit protected absolute directory");
  }
  if (!PROTECTED_DUMP_STORAGE.has(dumpProtection)) {
    throw new Error("Dump protection must be tmpfs or encrypted_volume");
  }

  return {
    container,
    connectAllowlist,
    dumpDirectory,
    dumpProtection,
    expectedOwner,
    sourceDatabase,
    targetDatabase,
    user,
  };
}

export function compareRestoreEvidence(source, target) {
  if (
    source.authorityPolicySha256 !== RESTORE_AUTHORITY_POLICY_SHA256 ||
    target.authorityPolicySha256 !== RESTORE_AUTHORITY_POLICY_SHA256
  ) {
    throw new Error("Restore authority policy digest does not match the pinned version");
  }
  if (source.authorityFingerprint !== target.authorityFingerprint) {
    throw new Error("Restored database-authority fingerprint does not match the source");
  }
  if (source.migrationLedger !== target.migrationLedger) {
    throw new Error("Restored migration ledger does not match the source");
  }
  if (source.unvalidatedConstraints !== "0" || target.unvalidatedConstraints !== "0") {
    throw new Error("Source or restore contains an unvalidated constraint");
  }
  if (source.tableCounts.size !== target.tableCounts.size) {
    throw new Error("Restored public-table set does not match the source");
  }
  for (const [table, sourceCount] of source.tableCounts) {
    const targetCount = target.tableCounts.get(table);
    if (targetCount !== sourceCount) {
      throw new Error(`Restored row count does not match for ${table}`);
    }
  }
}

export function runPostgresRestoreDrill(options, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const startedAt = new Date();
  const dumpPath = `${options.dumpDirectory}/${options.targetDatabase}.dump`;
  assertProtectedDumpDestination(run, options, dumpPath);
  const targetExists = psqlScalar(
    run,
    options,
    "postgres",
    [
      "select count(*) from pg_database where datname = current_setting('nutrition.restore_target')",
    ],
    [["PGOPTIONS", `-c nutrition.restore_target=${options.targetDatabase}`]],
  );
  if (targetExists !== "0") {
    throw new Error(`Restore target ${options.targetDatabase} already exists`);
  }

  // Refuse to copy a source that violates the reviewed migrations 0014-0015
  // authority manifest. This runs before a dump or target is created.
  collectAuthorityFingerprint(run, options, options.sourceDatabase);

  try {
    docker(run, options.container, [
      "sh",
      "-ceu",
      'umask 077\nexec pg_dump "$@"',
      "restore-private-pg-dump",
      "--username",
      options.user,
      "--dbname",
      options.sourceDatabase,
      "--format=custom",
      "--compress=9",
      "--no-owner",
      "--no-privileges",
      "--file",
      dumpPath,
    ]);
    const dumpAttestation = assertRegularDumpArtifact(run, options, dumpPath);
    const sha256 = docker(run, options.container, ["sha256sum", dumpPath]).trim().split(/\s+/u)[0];
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
      throw new Error("Backup artifact did not produce a SHA-256 digest");
    }

    docker(run, options.container, [
      "createdb",
      "--username",
      options.user,
      "--owner",
      options.expectedOwner,
      options.targetDatabase,
    ]);
    psqlCommand(run, options, "postgres", [
      `revoke connect on database "${options.targetDatabase}" from public`,
    ]);
    assertTargetDatabaseBoundary(run, options);
    docker(run, options.container, [
      "pg_restore",
      "--username",
      options.user,
      "--role",
      options.expectedOwner,
      "--dbname",
      options.targetDatabase,
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      dumpPath,
    ]);

    psqlCommand(
      run,
      options,
      options.targetDatabase,
      [`set role "${options.expectedOwner}";`, AUTHORITY_POLICY_SQL],
      [["PGOPTIONS", `-c nutrition.expected_restore_owner=${options.expectedOwner}`]],
    );

    const source = collectEvidence(run, options, options.sourceDatabase);
    const target = collectEvidence(run, options, options.targetDatabase);
    compareRestoreEvidence(source, target);
    const finalDatabaseBoundary = assertTargetDatabaseBoundary(run, options);

    return {
      artifactSha256: sha256,
      artifactFileMode: dumpAttestation.mode,
      artifactOwnerGid: dumpAttestation.ownerGid,
      artifactOwnerUid: dumpAttestation.ownerUid,
      artifactStorageType: dumpAttestation.mountType,
      authorityFingerprintSha256: source.authorityFingerprintSha256,
      authorityPolicySha256: RESTORE_AUTHORITY_POLICY_SHA256,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      migrationCount: JSON.parse(source.migrationLedger).length,
      sourceDatabase: options.sourceDatabase,
      tableCount: source.tableCounts.size,
      targetDatabase: options.targetDatabase,
      targetDatabaseAcl: finalDatabaseBoundary.acl,
      targetDatabaseOwner: finalDatabaseBoundary.owner,
      targetEffectiveConnectRoles: finalDatabaseBoundary.effectiveConnectRoles,
      totalRows: [...source.tableCounts.values()]
        .reduce((total, value) => total + BigInt(value), 0n)
        .toString(),
    };
  } finally {
    removeDumpArtifact(run, options, dumpPath);
  }
}

function collectEvidence(run, options, database) {
  const authority = collectAuthorityFingerprint(run, options, database);
  const migrationLedger = psqlScalar(run, options, database, [
    "select coalesce(json_agg(row_to_json(m) order by m.name)::text, '[]')",
    "from (select name, checksum from app_schema_migration order by name) m",
  ]);
  const unvalidatedConstraints = psqlScalar(run, options, database, [
    "select count(*) from pg_constraint where not convalidated",
  ]);
  const tables = psqlScalar(run, options, database, [
    "select coalesce(string_agg(tablename, ',' order by tablename), '')",
    "from pg_tables where schemaname = 'public'",
  ]);
  const tableCounts = new Map();
  for (const table of tables === "" ? [] : tables.split(",")) {
    if (!SAFE_DATABASE.test(table)) throw new Error("Database returned an unsafe table name");
    tableCounts.set(
      table,
      psqlScalar(run, options, database, [`select count(*) from public."${table}"`]),
    );
  }
  return {
    authorityFingerprint: authority.fingerprint,
    authorityFingerprintSha256: authority.sha256,
    authorityPolicySha256: RESTORE_AUTHORITY_POLICY_SHA256,
    migrationLedger,
    tableCounts,
    unvalidatedConstraints,
  };
}

function collectAuthorityFingerprint(run, options, database) {
  const evidence = {
    authorityConstraints: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(authority_constraint_policy) order by authority_constraint_policy.name)::text, '[]')",
      "from (",
      "select constraint_row.conname as name, class_row.relname as table_name,",
      "constraint_row.contype as constraint_type, constraint_row.convalidated as validated,",
      "pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition",
      "from pg_catalog.pg_constraint as constraint_row",
      "join pg_catalog.pg_class as class_row on class_row.oid = constraint_row.conrelid",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace",
      "where namespace_row.nspname = 'public'",
      "and class_row.relname = 'food_source_release_activation'",
      "and constraint_row.conname = 'food_source_release_activation_expand_audit_null_check'",
      ") authority_constraint_policy",
    ]),
    defaultAcls: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(default_policy) order by default_policy.owner, default_policy.schema_name, default_policy.object_type)::text, '[]')",
      "from (",
      "select owner_role.rolname as owner, coalesce(namespace_row.nspname, '*') as schema_name,",
      "default_acl.defaclobjtype as object_type,",
      "coalesce((select json_agg(row_to_json(acl_policy) order by acl_policy.grantee, acl_policy.privilege, acl_policy.grantable) from (",
      "select coalesce(grantee_role.rolname, 'PUBLIC') as grantee, coalesce(grantor_role.rolname, 'PUBLIC') as grantor,",
      "acl.privilege_type as privilege, acl.is_grantable as grantable",
      "from pg_catalog.aclexplode(default_acl.defaclacl) as acl",
      "left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee",
      "left join pg_catalog.pg_roles as grantor_role on grantor_role.oid = acl.grantor",
      ") acl_policy), '[]'::json) as acl",
      "from pg_catalog.pg_default_acl as default_acl",
      "join pg_catalog.pg_roles as owner_role on owner_role.oid = default_acl.defaclrole",
      "left join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = default_acl.defaclnamespace",
      "where default_acl.defaclnamespace = 0 or namespace_row.nspname = 'public'",
      ") default_policy",
    ]),
    functions: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(function_policy) order by function_policy.name, function_policy.arguments)::text, '[]')",
      "from (",
      "select procedure_row.proname as name, pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as arguments,",
      "pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner, procedure_row.prosecdef as security_definer,",
      "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')), 'hex') as source_sha256,",
      "pg_catalog.pg_get_function_result(procedure_row.oid) as result_type, language_row.lanname as language,",
      "procedure_row.provolatile as volatility, procedure_row.proisstrict as strict,",
      "procedure_row.proleakproof as leakproof, procedure_row.proparallel as parallel,",
      "coalesce(procedure_row.proconfig, array[]::text[]) as config, procedure_row.proacl is null as acl_is_default,",
      "coalesce((select json_agg(row_to_json(acl_policy) order by acl_policy.grantee, acl_policy.privilege, acl_policy.grantable) from (",
      "select coalesce(grantee_role.rolname, 'PUBLIC') as grantee, coalesce(grantor_role.rolname, 'PUBLIC') as grantor,",
      "acl.privilege_type as privilege, acl.is_grantable as grantable",
      "from pg_catalog.aclexplode(coalesce(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))) as acl",
      "left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee",
      "left join pg_catalog.pg_roles as grantor_role on grantor_role.oid = acl.grantor",
      ") acl_policy), '[]'::json) as acl",
      "from pg_catalog.pg_proc as procedure_row",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = procedure_row.pronamespace",
      "join pg_catalog.pg_language as language_row on language_row.oid = procedure_row.prolang",
      "where namespace_row.nspname = 'public'",
      ") function_policy",
    ]),
    relations: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(relation_policy) order by relation_policy.name, relation_policy.kind)::text, '[]')",
      "from (",
      "select class_row.relname as name, class_row.relkind as kind, pg_catalog.pg_get_userbyid(class_row.relowner) as owner,",
      "class_row.relacl is null as acl_is_default,",
      "coalesce((select json_agg(row_to_json(acl_policy) order by acl_policy.grantee, acl_policy.privilege, acl_policy.grantable) from (",
      "select coalesce(grantee_role.rolname, 'PUBLIC') as grantee, coalesce(grantor_role.rolname, 'PUBLIC') as grantor,",
      "acl.privilege_type as privilege, acl.is_grantable as grantable",
      "from pg_catalog.aclexplode(coalesce(class_row.relacl, pg_catalog.acldefault((case when class_row.relkind = 'S' then 's' else 'r' end)::\"char\", class_row.relowner))) as acl",
      "left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee",
      "left join pg_catalog.pg_roles as grantor_role on grantor_role.oid = acl.grantor",
      ") acl_policy), '[]'::json) as acl",
      "from pg_catalog.pg_class as class_row",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace",
      "where namespace_row.nspname = 'public' and class_row.relkind in ('r', 'p', 'S', 'v', 'm', 'f')",
      ") relation_policy",
    ]),
    roles: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(role_policy) order by role_policy.name)::text, '[]')",
      "from (",
      "select role_row.rolname as name, role_row.rolcanlogin as can_login, role_row.rolsuper as superuser,",
      "role_row.rolcreatedb as create_database, role_row.rolcreaterole as create_role,",
      "role_row.rolreplication as replication, role_row.rolbypassrls as bypass_rls,",
      "coalesce((select json_agg(json_build_object('role', parent_role.rolname, 'admin_option', membership.admin_option, 'inherit_option', membership.inherit_option, 'set_option', membership.set_option) order by parent_role.rolname) from pg_catalog.pg_auth_members membership join pg_catalog.pg_roles parent_role on parent_role.oid = membership.roleid where membership.member = role_row.oid), '[]'::json) as outgoing_memberships,",
      "coalesce((select json_agg(json_build_object('member', member_role.rolname, 'admin_option', membership.admin_option, 'inherit_option', membership.inherit_option, 'set_option', membership.set_option) order by member_role.rolname) from pg_catalog.pg_auth_members membership join pg_catalog.pg_roles member_role on member_role.oid = membership.member where membership.roleid = role_row.oid), '[]'::json) as incoming_memberships,",
      "(select count(*)::text from pg_catalog.pg_shdepend dependency where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and dependency.refobjid = role_row.oid and dependency.deptype = 'o') as owned_object_count",
      "from pg_catalog.pg_roles as role_row",
      "where role_row.rolname = any (array['nutrition_catalogue_stage','nutrition_catalogue_validate','nutrition_catalogue_approve_data','nutrition_catalogue_approve_quality','nutrition_catalogue_approve_rights','nutrition_catalogue_promote_activate','nutrition_catalogue_rollback'])",
      ") role_policy",
    ]),
    schema: psqlJson(run, options, database, [
      "select row_to_json(schema_policy)::text",
      "from (",
      "select namespace_row.nspname as name, pg_catalog.pg_get_userbyid(namespace_row.nspowner) as owner,",
      "namespace_row.nspacl is null as acl_is_default,",
      "coalesce((select json_agg(row_to_json(acl_policy) order by acl_policy.grantee, acl_policy.privilege, acl_policy.grantable) from (",
      "select coalesce(grantee_role.rolname, 'PUBLIC') as grantee, coalesce(grantor_role.rolname, 'PUBLIC') as grantor,",
      "acl.privilege_type as privilege, acl.is_grantable as grantable",
      "from pg_catalog.aclexplode(coalesce(namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner))) as acl",
      "left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee",
      "left join pg_catalog.pg_roles as grantor_role on grantor_role.oid = acl.grantor",
      ") acl_policy), '[]'::json) as acl",
      "from pg_catalog.pg_namespace as namespace_row where namespace_row.nspname = 'public'",
      ") schema_policy",
    ]),
    triggers: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(trigger_policy) order by trigger_policy.name)::text, '[]')",
      "from (",
      "select trigger_row.tgname as name, class_row.relname as table_name, procedure_namespace.nspname as function_schema, procedure_row.proname as function_name,",
      "pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as function_arguments,",
      "trigger_row.tgenabled as enabled, pg_catalog.pg_get_triggerdef(trigger_row.oid, true) as definition",
      "from pg_catalog.pg_trigger as trigger_row",
      "join pg_catalog.pg_class as class_row on class_row.oid = trigger_row.tgrelid",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace",
      "join pg_catalog.pg_proc as procedure_row on procedure_row.oid = trigger_row.tgfoid",
      "join pg_catalog.pg_namespace as procedure_namespace on procedure_namespace.oid = procedure_row.pronamespace",
      "where namespace_row.nspname = 'public' and not trigger_row.tgisinternal",
      ") trigger_policy",
    ]),
    types: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(type_policy) order by type_policy.name, type_policy.kind)::text, '[]')",
      "from (",
      "select type_row.typname as name, type_row.typtype as kind, pg_catalog.pg_get_userbyid(type_row.typowner) as owner,",
      "type_row.typacl is null as acl_is_default,",
      "coalesce((select json_agg(row_to_json(acl_policy) order by acl_policy.grantee, acl_policy.privilege, acl_policy.grantable) from (",
      "select coalesce(grantee_role.rolname, 'PUBLIC') as grantee, coalesce(grantor_role.rolname, 'PUBLIC') as grantor,",
      "acl.privilege_type as privilege, acl.is_grantable as grantable",
      "from pg_catalog.aclexplode(coalesce(type_row.typacl, pg_catalog.acldefault('T', type_row.typowner))) as acl",
      "left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee",
      "left join pg_catalog.pg_roles as grantor_role on grantor_role.oid = acl.grantor",
      ") acl_policy), '[]'::json) as acl",
      "from pg_catalog.pg_type as type_row",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = type_row.typnamespace",
      "where namespace_row.nspname = 'public'",
      ") type_policy",
    ]),
    version: 4,
  };
  validateRestoreAuthorityEvidence(evidence, options.expectedOwner);
  const fingerprint = canonicalJson(evidence);
  return {
    evidence,
    fingerprint,
    sha256: createHash("sha256").update(fingerprint, "utf8").digest("hex"),
  };
}

export function validateRestoreAuthorityEvidence(evidence, expectedOwner) {
  if (!SAFE_ROLE.test(expectedOwner)) throw new Error("Invalid expected PostgreSQL owner name");
  if (!evidence || typeof evidence !== "object" || evidence.version !== 4) {
    throw new Error("Database-authority fingerprint has an unsupported version");
  }

  const authorityConstraints = requiredArray(
    evidence.authorityConstraints,
    "catalogue authority constraints",
  );
  const activationAuthorityConstraint = authorityConstraints[0];
  if (
    authorityConstraints.length !== 1 ||
    activationAuthorityConstraint?.name !==
      "food_source_release_activation_expand_audit_null_check" ||
    activationAuthorityConstraint.table_name !== "food_source_release_activation" ||
    activationAuthorityConstraint.constraint_type !== "c" ||
    activationAuthorityConstraint.validated !== true ||
    activationAuthorityConstraint.definition !==
      "CHECK (database_principal IS NULL AND database_capability_role IS NULL)"
  ) {
    throw new Error("Catalogue activation authority constraint differs from policy");
  }

  const roles = requiredArray(evidence.roles, "capability roles");
  if (
    canonicalJson(roles.map((role) => role.name).sort()) !==
    canonicalJson([...CAPABILITY_ROLES].sort())
  ) {
    throw new Error("Database-authority fingerprint has missing or unexpected capability roles");
  }
  for (const role of roles) {
    if (
      role.can_login !== false ||
      role.superuser !== false ||
      role.create_database !== false ||
      role.create_role !== false ||
      role.replication !== false ||
      role.bypass_rls !== false ||
      role.owned_object_count !== "0"
    ) {
      throw new Error(`Capability role ${role.name} has unsafe attributes or ownership`);
    }
    if (requiredArray(role.outgoing_memberships, `${role.name} outgoing memberships`).length > 0) {
      throw new Error(`Capability role ${role.name} has an unsafe outgoing membership`);
    }
    if (requiredArray(role.incoming_memberships, `${role.name} incoming memberships`).length > 0) {
      throw new Error(`Capability role ${role.name} has an unsafe incoming membership`);
    }
  }

  const schema = evidence.schema;
  if (
    schema?.name !== "public" ||
    schema.owner !== "pg_database_owner" ||
    schema.acl_is_default !== false
  ) {
    throw new Error("Public schema owner or ACL representation differs from policy");
  }
  assertExactAcl(
    schema.acl,
    [
      ["PUBLIC", "USAGE"],
      ["nutrition_catalogue_approve_data", "USAGE"],
      ["nutrition_catalogue_approve_quality", "USAGE"],
      ["nutrition_catalogue_approve_rights", "USAGE"],
      ["pg_database_owner", "CREATE"],
      ["pg_database_owner", "USAGE"],
    ],
    "public schema",
  );

  const relations = requiredArray(evidence.relations, "public relations");
  if (
    !relations.some((relation) => relation.kind === "S") ||
    !relations.some((relation) => relation.kind === "r" || relation.kind === "p")
  ) {
    throw new Error("Database-authority fingerprint is missing tables or sequences");
  }
  for (const relation of relations) {
    if (relation.owner !== expectedOwner) {
      throw new Error(`Restored relation ${relation.name} has the wrong owner`);
    }
    if (relation.acl_is_default !== true) {
      throw new Error(`Restored relation ${relation.name} has unexpected explicit DML privileges`);
    }
    if (
      requiredArray(relation.acl, `${relation.name} ACL`).some(
        (entry) => entry.grantee !== expectedOwner,
      )
    ) {
      throw new Error(`Restored relation ${relation.name} exposes an unexpected principal`);
    }
  }

  const types = requiredArray(evidence.types, "public types");
  if (types.length === 0) {
    throw new Error("Database-authority fingerprint is missing public types");
  }
  for (const typePolicy of types) {
    if (typePolicy.owner !== expectedOwner) {
      throw new Error(`Restored type ${typePolicy.name} has the wrong owner`);
    }
    if (typePolicy.acl_is_default !== true) {
      throw new Error(`Restored type ${typePolicy.name} has unexpected explicit privileges`);
    }
    requiredArray(typePolicy.acl, `${typePolicy.name} ACL`);
  }

  if (requiredArray(evidence.defaultAcls, "default ACLs").length > 0) {
    throw new Error("A global or public-schema default ACL is not versioned by policy");
  }

  const functions = requiredArray(evidence.functions, "public functions");
  const authorityFunctionNames = new Set(AUTHORITY_FUNCTION_POLICY.keys());
  const authorityFunctions = functions.filter((entry) => authorityFunctionNames.has(entry.name));
  if (authorityFunctions.length !== AUTHORITY_FUNCTION_POLICY.size) {
    throw new Error("Catalogue authority function set has missing or unexpected overloads");
  }
  for (const functionPolicy of functions) {
    if (functionPolicy.owner !== expectedOwner) {
      throw new Error(`Restored function ${functionPolicy.name} has the wrong owner`);
    }
    const expectedFunction = AUTHORITY_FUNCTION_POLICY.get(functionPolicy.name);
    if (expectedFunction !== undefined) {
      if (functionPolicy.arguments !== expectedFunction.arguments) {
        throw new Error(
          `Catalogue authority function ${functionPolicy.name} has an unexpected signature`,
        );
      }
      assertFunctionExecutableSemantics(
        functionPolicy,
        expectedFunction,
        `catalogue authority function ${functionPolicy.name}`,
      );
      if (
        functionPolicy.security_definer !== expectedFunction.securityDefiner ||
        canonicalJson(functionPolicy.config) !==
          canonicalJson(["search_path=pg_catalog, public, pg_temp"])
      ) {
        throw new Error(`Catalogue authority function ${functionPolicy.name} differs from policy`);
      }
      if (functionPolicy.name === "catalogue_record_import_approval") {
        if (functionPolicy.acl_is_default !== false) {
          throw new Error("Catalogue approval authority function retained its default PUBLIC ACL");
        }
        assertExactAcl(
          functionPolicy.acl,
          [
            [expectedOwner, "EXECUTE"],
            ["nutrition_catalogue_approve_data", "EXECUTE"],
            ["nutrition_catalogue_approve_quality", "EXECUTE"],
            ["nutrition_catalogue_approve_rights", "EXECUTE"],
          ],
          "catalogue approval authority function",
        );
        if (
          requiredArray(functionPolicy.acl, "catalogue approval authority function ACL").some(
            (entry) => entry.grantor !== expectedOwner,
          )
        ) {
          throw new Error("Catalogue approval authority function ACL has an unexpected grantor");
        }
      } else if (functionPolicy.name === "guard_food_import_approval_authority") {
        if (functionPolicy.acl_is_default !== false) {
          throw new Error("Catalogue approval guard function retained its default PUBLIC ACL");
        }
        assertExactAcl(
          functionPolicy.acl,
          [[expectedOwner, "EXECUTE"]],
          "catalogue approval guard function",
        );
        if (
          requiredArray(functionPolicy.acl, "catalogue approval guard function ACL").some(
            (entry) => entry.grantor !== expectedOwner,
          )
        ) {
          throw new Error("Catalogue approval guard function ACL has an unexpected grantor");
        }
      } else if (functionPolicy.acl_is_default !== true) {
        throw new Error(
          `Catalogue authority function ${functionPolicy.name} has unexpected explicit privileges`,
        );
      }
      continue;
    }
    if (functionPolicy.security_definer !== false || functionPolicy.acl_is_default !== true) {
      throw new Error(`Non-authority function ${functionPolicy.name} has unexpected authority`);
    }
  }

  const triggers = requiredArray(evidence.triggers, "public triggers");
  const authorityTriggers = triggers.filter(
    (entry) =>
      AUTHORITY_TRIGGER_POLICY.has(entry.name) || authorityFunctionNames.has(entry.function_name),
  );
  if (authorityTriggers.length !== AUTHORITY_TRIGGER_POLICY.size) {
    throw new Error("Catalogue authority trigger set has missing or unexpected entries");
  }
  for (const [name, expected] of AUTHORITY_TRIGGER_POLICY) {
    const matches = authorityTriggers.filter((entry) => entry.name === name);
    if (
      matches.length !== 1 ||
      matches[0].enabled !== "O" ||
      matches[0].table_name !== expected.tableName ||
      matches[0].function_schema !== "public" ||
      matches[0].function_name !== expected.functionName ||
      matches[0].function_arguments !== "" ||
      matches[0].definition !== expected.definition
    ) {
      throw new Error(`Catalogue authority trigger ${name} differs from policy`);
    }
  }
}

export function canonicalizeRestoreAuthorityEvidence(evidence) {
  return canonicalJson(evidence);
}

export function assertRestoreAuthorityPolicyDigest(policySql, expectedSha256) {
  const actualSha256 = createHash("sha256").update(policySql, "utf8").digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Restore authority policy digest does not match the pinned version");
  }
  return actualSha256;
}

function assertFunctionExecutableSemantics(actual, expected, label) {
  if (
    actual.source_sha256 !== expected.sourceSha256 ||
    actual.result_type !== expected.resultType ||
    actual.language !== expected.language ||
    actual.volatility !== expected.volatility ||
    actual.strict !== expected.strict ||
    actual.leakproof !== expected.leakproof ||
    actual.parallel !== expected.parallel
  ) {
    throw new Error(`${label} executable semantics differ from policy`);
  }
}

function assertExactAcl(actualValue, expectedPairs, label) {
  const actual = requiredArray(actualValue, `${label} ACL`);
  const actualTokens = actual
    .map((entry) => {
      if (entry.grantable !== false) throw new Error(`${label} contains a grant option`);
      return `${entry.grantee}:${entry.privilege}`;
    })
    .sort();
  const expectedTokens = expectedPairs
    .map(([grantee, privilege]) => `${grantee}:${privilege}`)
    .sort();
  if (canonicalJson(actualTokens) !== canonicalJson(expectedTokens)) {
    throw new Error(`${label} ACL differs from the exact reviewed policy`);
  }
}

export function assertProtectedDumpDestination(run, options, dumpPath) {
  if (options.dumpProtection !== "tmpfs") {
    throw new Error(
      "encrypted_volume dump protection is not independently verifiable; use a verified tmpfs",
    );
  }
  const resolvedDirectory = docker(run, options.container, [
    "sh",
    "-ceu",
    [
      'directory="$1"',
      'dump_path="$2"',
      'resolved_directory="$(readlink -f -- "$directory")"',
      '[ "$resolved_directory" = "$directory" ]',
      '[ "$(stat -f -c %T -- "$resolved_directory")" = "tmpfs" ]',
      '[ ! -e "$dump_path" ]',
      '[ ! -L "$dump_path" ]',
      'printf "%s" "$resolved_directory"',
    ].join("\n"),
    "restore-dump-preflight",
    options.dumpDirectory,
    dumpPath,
  ]).trim();
  if (resolvedDirectory !== options.dumpDirectory) {
    throw new Error("Dump directory did not resolve to the exact verified tmpfs path");
  }
}

export function assertRegularDumpArtifact(run, options, dumpPath) {
  const fields = docker(run, options.container, [
    "sh",
    "-ceu",
    [
      'directory="$1"',
      'dump_path="$2"',
      '[ -f "$dump_path" ]',
      '[ ! -L "$dump_path" ]',
      'resolved_directory="$(readlink -f -- "$directory")"',
      'mount_type="$(stat -f -c %T -- "$resolved_directory")"',
      'resolved_artifact="$(readlink -f -- "$dump_path")"',
      'owner_uid="$(stat -c %u -- "$dump_path")"',
      'owner_gid="$(stat -c %g -- "$dump_path")"',
      'mode="$(stat -c %a -- "$dump_path")"',
      'link_count="$(stat -c %h -- "$dump_path")"',
      'file_type="$(LC_ALL=C stat -c %F -- "$dump_path")"',
      'executor_uid="$(id -u)"',
      'executor_gid="$(id -g)"',
      'printf "%s\\n" "$resolved_directory" "$mount_type" "$resolved_artifact" "$owner_uid" "$owner_gid" "$mode" "$link_count" "$file_type" "$executor_uid" "$executor_gid"',
    ].join("\n"),
    "restore-dump-artifact",
    options.dumpDirectory,
    dumpPath,
  ])
    .trim()
    .split("\n");
  validateDumpArtifactAttestation(
    {
      executorGid: fields[9],
      executorUid: fields[8],
      fileType: fields[7],
      linkCount: fields[6],
      mode: fields[5],
      mountType: fields[1],
      ownerGid: fields[4],
      ownerUid: fields[3],
      resolvedArtifact: fields[2],
      resolvedDirectory: fields[0],
    },
    options,
    dumpPath,
  );
  return {
    executorGid: fields[9],
    executorUid: fields[8],
    fileType: fields[7],
    linkCount: fields[6],
    mode: fields[5],
    mountType: fields[1],
    ownerGid: fields[4],
    ownerUid: fields[3],
    resolvedArtifact: fields[2],
    resolvedDirectory: fields[0],
  };
}

export function validateDumpArtifactAttestation(attestation, options, dumpPath) {
  if (
    attestation.resolvedDirectory !== options.dumpDirectory ||
    attestation.mountType !== "tmpfs" ||
    attestation.resolvedArtifact !== dumpPath ||
    attestation.ownerUid !== attestation.executorUid ||
    attestation.ownerGid !== attestation.executorGid ||
    attestation.mode !== "600" ||
    attestation.linkCount !== "1" ||
    attestation.fileType !== "regular file"
  ) {
    throw new Error("Backup artifact does not satisfy the exact private tmpfs policy");
  }
}

export function removeDumpArtifact(run, options, dumpPath) {
  docker(run, options.container, ["rm", "-f", "--", dumpPath]);
  docker(run, options.container, [
    "sh",
    "-ceu",
    '[ ! -e "$1" ] && [ ! -L "$1" ]',
    "restore-dump-cleanup",
    dumpPath,
  ]);
}

export function assertTargetDatabaseBoundary(run, options) {
  const environment = [["PGOPTIONS", `-c nutrition.restore_target=${options.targetDatabase}`]];
  const boundary = {
    acl: psqlJson(
      run,
      options,
      "postgres",
      [
        "select coalesce(json_agg(row_to_json(database_acl) order by database_acl.grantee, database_acl.privilege)::text, '[]')",
        "from (",
        "select coalesce(grantee_role.rolname, 'PUBLIC') as grantee, coalesce(grantor_role.rolname, 'PUBLIC') as grantor,",
        "acl.privilege_type as privilege, acl.is_grantable as grantable",
        "from pg_catalog.pg_database as database_row",
        "cross join lateral pg_catalog.aclexplode(coalesce(database_row.datacl, pg_catalog.acldefault('d', database_row.datdba))) as acl",
        "left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee",
        "left join pg_catalog.pg_roles as grantor_role on grantor_role.oid = acl.grantor",
        "where database_row.datname = current_setting('nutrition.restore_target')",
        ") database_acl",
      ],
      environment,
    ),
    effectiveConnectRoles: psqlJson(
      run,
      options,
      "postgres",
      [
        "select coalesce(json_agg(role_policy.name order by role_policy.name)::text, '[]')",
        "from (select role_row.rolname as name from pg_catalog.pg_roles as role_row",
        "where role_row.rolcanlogin",
        "and pg_catalog.has_database_privilege(role_row.oid, current_setting('nutrition.restore_target'), 'CONNECT')) role_policy",
      ],
      environment,
    ),
    otherClientSessions: psqlScalar(
      run,
      options,
      "postgres",
      [
        "select count(*) from pg_catalog.pg_stat_activity",
        "where datname = current_setting('nutrition.restore_target')",
        "and backend_type = 'client backend' and pid <> pg_catalog.pg_backend_pid()",
      ],
      environment,
    ),
    owner: psqlScalar(
      run,
      options,
      "postgres",
      [
        "select pg_catalog.pg_get_userbyid(database_row.datdba)",
        "from pg_catalog.pg_database as database_row",
        "where database_row.datname = current_setting('nutrition.restore_target')",
      ],
      environment,
    ),
  };
  validateTargetDatabaseBoundary(boundary, options);
  return boundary;
}

export function validateTargetDatabaseBoundary(boundary, options) {
  if (boundary?.owner !== options.expectedOwner) {
    throw new Error("Restore target database has the wrong owner");
  }
  assertExactAcl(
    boundary.acl,
    [
      ["PUBLIC", "TEMPORARY"],
      [options.expectedOwner, "CONNECT"],
      [options.expectedOwner, "CREATE"],
      [options.expectedOwner, "TEMPORARY"],
    ],
    "restore target database",
  );
  if (
    requiredArray(boundary.acl, "restore target database ACL").some(
      (entry) => entry.grantor !== options.expectedOwner,
    )
  ) {
    throw new Error("Restore target database ACL has an unexpected grantor");
  }
  if (
    canonicalJson(requiredArray(boundary.effectiveConnectRoles, "effective CONNECT roles")) !==
    canonicalJson(options.connectAllowlist)
  ) {
    throw new Error("Restore target effective CONNECT login allowlist differs from policy");
  }
  if (boundary.otherClientSessions !== "0") {
    throw new Error("Restore target has a pre-existing client session");
  }
}

function psqlJson(run, options, database, sqlParts, environment = []) {
  const inheritedPgOptions = environment.find(([name]) => name === "PGOPTIONS")?.[1] ?? "";
  const value = psqlScalar(run, options, database, sqlParts, [
    ...environment.filter(([name]) => name !== "PGOPTIONS"),
    [
      "PGOPTIONS",
      `${inheritedPgOptions} -c nutrition.expected_restore_owner=${options.expectedOwner}`.trim(),
    ],
  ]);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Database returned malformed authority evidence");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Database-authority ${label} is malformed`);
  return value;
}

function psqlScalar(run, options, database, sqlParts, environment = []) {
  const command = [
    "psql",
    "--username",
    options.user,
    "--dbname",
    database,
    "--tuples-only",
    "--no-align",
    "--command",
    sqlParts.join(" "),
  ];
  prependEnvironment(command, environment);
  return docker(run, options.container, command).trim();
}

function psqlCommand(run, options, database, sqlParts, environment = []) {
  const command = [
    "psql",
    "--username",
    options.user,
    "--dbname",
    database,
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    sqlParts.join(" "),
  ];
  prependEnvironment(command, environment);
  docker(run, options.container, command);
}

function prependEnvironment(command, environment) {
  if (environment.length > 0) {
    command.unshift("env", ...environment.map(([name, value]) => `${name}=${value}`));
  }
}

function docker(run, container, command, options = {}) {
  return run("docker", ["exec", container, ...command], options);
}

function runCommand(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const safeError = result.stderr.trim().split("\n")[0] || "command failed";
    throw new Error(`${command} exited ${result.status}: ${safeError}`);
  }
  return result.stdout;
}

function required(values, flag) {
  const value = values.get(flag);
  if (!value) throw new Error(`Missing required restore drill argument: ${flag}`);
  return value;
}

async function main() {
  const options = parseRestoreDrillArguments(process.argv.slice(2));
  const result = runPostgresRestoreDrill(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
