import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProtectedDumpDestination,
  assertRegularDumpArtifact,
  assertRestoreAuthorityPolicyDigest,
  canonicalizeRestoreAuthorityEvidence,
  collectRestoreMigrationLedger,
  compareRestoreEvidence,
  parseRestoreDrillArguments,
  RESTORE_AUTHORITY_POLICY_SHA256,
  removeDumpArtifact,
  runPostgresRestoreDrill,
  TRACKED_MIGRATION_LEDGER_JSON,
  validateDumpArtifactAttestation,
  validateRestoreAuthorityEvidence,
  validateTargetDatabaseBoundary,
} from "./postgres-restore-drill.mjs";

const capabilityRoles = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
];
const expectedOwner = "nutrition_owner";
const approvalAuthorityConstraintDefinition =
  "CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND principal_id = database_principal AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =\nCASE approval_role\n    WHEN 'data'::text THEN 'nutrition_catalogue_approve_data'::text\n    WHEN 'quality'::text THEN 'nutrition_catalogue_approve_quality'::text\n    WHEN 'rights'::text THEN 'nutrition_catalogue_approve_rights'::text\n    ELSE NULL::text\nEND) IS TRUE)";
const activationAuthorityConstraintDefinition =
  "CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND performed_by = database_principal AND database_capability_role IS NOT NULL AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =\nCASE\n    WHEN import_batch_id IS NOT NULL AND operation = 'activate'::text THEN 'nutrition_catalogue_promote_activate'::text\n    WHEN import_batch_id IS NULL AND (operation = ANY (ARRAY['deactivate'::text, 'rollback'::text])) THEN 'nutrition_catalogue_rollback'::text\n    ELSE NULL::text\nEND) IS TRUE)";
const stageValidateAuthorityConstraintDefinition =
  "CHECK ((staged_database_principal IS NULL AND staged_database_capability_role IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR staged_database_principal IS NOT NULL AND octet_length(staged_database_principal) >= 1 AND octet_length(staged_database_principal) <= 63 AND staged_database_capability_role = 'nutrition_catalogue_stage'::text AND (validated_at IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR validated_at IS NOT NULL AND validated_database_principal IS NOT NULL AND octet_length(validated_database_principal) >= 1 AND octet_length(validated_database_principal) <= 63 AND validated_database_capability_role = 'nutrition_catalogue_validate'::text AND validated_database_principal <> staged_database_principal)) IS TRUE)";
const stagingSealConstraintDefinition =
  "CHECK ((staging_seal_sha256 IS NULL AND staging_sealed_at IS NULL OR staging_seal_sha256 ~ '^[0-9a-f]{64}$'::text AND staging_sealed_at IS NOT NULL AND (staging_sealed_at <> ALL (ARRAY['-infinity'::timestamp with time zone, 'infinity'::timestamp with time zone]))) IS TRUE AND (validated_at IS NULL OR staged_database_principal IS NULL OR staging_seal_sha256 IS NOT NULL))";
const batchNutritionSemanticConstraintDefinition =
  "CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (status = ANY (ARRAY['quarantined'::text, 'ready'::text, 'promoting'::text, 'completed'::text]))) IS TRUE)";
const recordNutritionSemanticConstraintDefinition =
  "CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (validation_status = ANY (ARRAY['quarantined'::text, 'valid'::text, 'materialized'::text]))) IS TRUE)";
const authorityConstraints = [
  {
    constraint_type: "c",
    definition: approvalAuthorityConstraintDefinition,
    name: "food_import_approval_database_authority_check",
    table_name: "food_import_approval",
    validated: true,
  },
  {
    constraint_type: "c",
    definition:
      "CHECK ((validated_food_contract_version IS NULL AND nutrient_mapping_digest IS NULL AND nutrient_mapping_revision_ids IS NULL OR validated_food_contract_version = 1 AND nutrient_mapping_digest ~ '^[0-9a-f]{64}$'::text AND jsonb_typeof(nutrient_mapping_revision_ids) = 'array'::text AND validated_at IS NOT NULL) IS TRUE)",
    name: "food_import_batch_materialization_contract_check",
    table_name: "food_import_batch",
    validated: true,
  },
  {
    constraint_type: "c",
    definition: batchNutritionSemanticConstraintDefinition,
    name: "food_import_batch_nutrition_semantic_contract_check",
    table_name: "food_import_batch",
    validated: true,
  },
  {
    constraint_type: "c",
    definition:
      "CHECK (((status <> ALL (ARRAY['ready'::text, 'promoting'::text])) OR validated_food_contract_version = 1 AND nutrient_mapping_digest IS NOT NULL AND nutrient_mapping_revision_ids IS NOT NULL) IS TRUE)",
    name: "food_import_batch_promotable_contract_check",
    table_name: "food_import_batch",
    validated: true,
  },
  {
    constraint_type: "c",
    definition: stageValidateAuthorityConstraintDefinition,
    name: "food_import_batch_stage_validate_database_authority_check",
    table_name: "food_import_batch",
    validated: true,
  },
  {
    constraint_type: "c",
    definition: stagingSealConstraintDefinition,
    name: "food_import_batch_staging_seal_check",
    table_name: "food_import_batch",
    validated: true,
  },
  {
    constraint_type: "c",
    definition: recordNutritionSemanticConstraintDefinition,
    name: "food_import_record_nutrition_semantic_contract_check",
    table_name: "food_import_record",
    validated: true,
  },
  {
    constraint_type: "c",
    definition:
      "CHECK ((validated_food_document IS NULL AND validated_food_sha256 IS NULL AND validated_food_contract_version IS NULL AND (validation_status = ANY (ARRAY['pending'::text, 'quarantined'::text, 'valid'::text, 'materialized'::text])) OR validated_food_document IS NOT NULL AND validated_food_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_food_contract_version = 1 AND (validation_status = ANY (ARRAY['valid'::text, 'materialized'::text])) AND jsonb_typeof(validated_food_document::jsonb) = 'object'::text AND validated_food_sha256 = encode(sha256(convert_to(validated_food_document, 'UTF8'::name)), 'hex'::text)) IS TRUE)",
    name: "food_import_record_validated_food_contract_check",
    table_name: "food_import_record",
    validated: true,
  },
  {
    constraint_type: "c",
    definition: activationAuthorityConstraintDefinition,
    name: "food_source_release_activation_database_authority_check",
    table_name: "food_source_release_activation",
    validated: true,
  },
];
const authorityFrozenColumns = [
  ["food_import_batch", "nutrient_mapping_digest", "text"],
  ["food_import_batch", "nutrient_mapping_revision_ids", "jsonb"],
  ["food_import_batch", "nutrition_semantic_contract_version", "smallint"],
  ["food_import_batch", "nutrition_semantic_sha256", "text"],
  ["food_import_batch", "staged_database_capability_role", "text"],
  ["food_import_batch", "staged_database_principal", "text"],
  ["food_import_batch", "staging_seal_sha256", "text"],
  ["food_import_batch", "staging_sealed_at", "timestamp with time zone"],
  ["food_import_batch", "validated_database_capability_role", "text"],
  ["food_import_batch", "validated_database_principal", "text"],
  ["food_import_batch", "validated_food_contract_version", "smallint"],
  ["food_import_record", "nutrition_semantic_contract_version", "smallint"],
  ["food_import_record", "nutrition_semantic_sha256", "text"],
  ["food_import_record", "validated_food_contract_version", "smallint"],
  ["food_import_record", "validated_food_document", "text"],
  ["food_import_record", "validated_food_sha256", "text"],
].map(([tableName, columnName, dataType]) => ({
  column_name: columnName,
  data_type: dataType,
  default_expression: null,
  not_null: false,
  schema_name: "public",
  table_name: tableName,
}));
const authorityIndexes = [
  {
    access_method: "btree",
    definition:
      "CREATE UNIQUE INDEX food_source_release_activation_import_batch_unique ON public.food_source_release_activation USING btree (import_batch_id) WHERE (import_batch_id IS NOT NULL)",
    is_primary: false,
    is_ready: true,
    is_unique: true,
    is_valid: true,
    key_attribute_count: 1,
    key_expression: "import_batch_id",
    name: "food_source_release_activation_import_batch_unique",
    owner: expectedOwner,
    predicate: "import_batch_id IS NOT NULL",
    schema_name: "public",
    table_name: "food_source_release_activation",
    total_attribute_count: 1,
  },
];

test("accepts only an explicit isolated restore target and owner", () => {
  assert.deepEqual(
    parseRestoreDrillArguments([
      "--container",
      "postgres-test-1",
      "--connect-allowlist",
      expectedOwner,
      "--dump-directory",
      "/dev/shm",
      "--dump-protection",
      "tmpfs",
      "--expected-owner",
      expectedOwner,
      "--source-db",
      "nutrition_source",
      "--target-db",
      "nutrition_restore_ci_20260816",
      "--user",
      "nutrition",
    ]),
    {
      connectAllowlist: [expectedOwner],
      container: "postgres-test-1",
      dumpDirectory: "/dev/shm",
      dumpProtection: "tmpfs",
      expectedOwner,
      sourceDatabase: "nutrition_source",
      targetDatabase: "nutrition_restore_ci_20260816",
      user: "nutrition",
    },
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_source",
      ]),
    /Restore target/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci;drop_database",
      ]),
    /bounded/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/tmp",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /protected absolute directory/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/approved/backup",
        "--dump-protection",
        "unverified",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /tmpfs or encrypted_volume/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        "unsafe-owner;set-role",
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /expected PostgreSQL owner/,
  );
});

test("requires exact migration, constraint, table, row-count, policy, and authority evidence", () => {
  const fingerprint = canonicalizeRestoreAuthorityEvidence(validAuthorityEvidence());
  const source = {
    authorityFingerprint: fingerprint,
    authorityPolicySha256: RESTORE_AUTHORITY_POLICY_SHA256,
    migrationLedger: '[{"name":"0001.sql","checksum":"abc"}]',
    tableCounts: new Map([
      ["app_user", "2"],
      ["diary", "4"],
    ]),
    unvalidatedConstraints: "0",
  };
  compareRestoreEvidence(source, {
    ...source,
    tableCounts: new Map(source.tableCounts),
  });
  assert.throws(
    () => compareRestoreEvidence(source, { ...source, authorityFingerprint: `${fingerprint}x` }),
    /fingerprint/,
  );
  assert.throws(
    () => compareRestoreEvidence(source, { ...source, authorityPolicySha256: "0".repeat(64) }),
    /policy digest/,
  );
  assert.throws(
    () =>
      compareRestoreEvidence(source, {
        ...source,
        tableCounts: new Map([
          ["app_user", "2"],
          ["diary", "3"],
        ]),
      }),
    /diary/,
  );
  assert.throws(
    () => compareRestoreEvidence(source, { ...source, unvalidatedConstraints: "1" }),
    /unvalidated/,
  );
});

test("rejects an incomplete public ledger despite a complete owner-schema shadow", () => {
  const completeShadowLedger = '[{"name":"0001_initial_domain_schema.sql","checksum":"fake"}]';
  const calls = [];
  assert.throws(
    () =>
      collectRestoreMigrationLedger(
        (_command, arguments_) => {
          calls.push(arguments_);
          const sql = arguments_.at(-1) ?? "";
          return sql.includes("from public.app_schema_migration")
            ? "[]\n"
            : `${completeShadowLedger}\n`;
        },
        restoreOptions(),
        "nutrition_source",
      ),
    /does not match the tracked migration manifest/,
  );

  assert.equal(calls.length, 1);
  assert.match(
    calls[0].at(-1) ?? "",
    /from \(select name, checksum from public\.app_schema_migration order by name\) m/,
  );
  assert.doesNotMatch(calls[0].at(-1) ?? "", /from app_schema_migration/);
});

test("tracks migration 0022 in the exact restore ledger", () => {
  const migrationLedger = JSON.parse(TRACKED_MIGRATION_LEDGER_JSON);

  assert.equal(migrationLedger.length, 22);
  assert.equal(migrationLedger.at(-1)?.name, "0022_catalogue_authenticated_actor_binding.sql");
  assert.equal(
    migrationLedger.at(-1)?.checksum,
    "72b4a284b22e7ed497c759fe087ece6a97c5d459ecbac6a79e32ba5a50cb76ca",
  );
});

test("orchestration rejects public-ledger drift before creating a dump", () => {
  const { calls, run } = authorityEvidenceRunner(validAuthorityEvidence(), {
    publicMigrationLedger: "[]",
  });

  assert.throws(
    () => runPostgresRestoreDrill(restoreOptions(), { run }),
    /does not match the tracked migration manifest/,
  );
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("pg_dump")),
    false,
  );
  const ledgerQuery = calls
    .map((arguments_) => arguments_.at(-1) ?? "")
    .find((sql) => sql.includes("app_schema_migration"));
  assert.match(ledgerQuery ?? "", /from public\.app_schema_migration/);
});

test("rejects PUBLIC execute and wrong fixed-purpose capability grants", () => {
  const publicExecute = validAuthorityEvidence();
  authorityFunction(publicExecute).acl.push({
    grantee: "PUBLIC",
    grantor: expectedOwner,
    grantable: false,
    privilege: "EXECUTE",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(publicExecute, expectedOwner),
    /authority function .*ACL/,
  );

  const missingReviewer = validAuthorityEvidence();
  authorityFunction(missingReviewer).acl = authorityFunction(missingReviewer).acl.filter(
    (entry) => entry.grantee !== "nutrition_catalogue_approve_rights",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingReviewer, expectedOwner),
    /authority function .*ACL/,
  );

  const wrongApprovalGrantor = validAuthorityEvidence();
  authorityFunction(wrongApprovalGrantor).acl[0].grantor = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongApprovalGrantor, expectedOwner),
    /authority function .*ACL has an unexpected grantor/,
  );

  const publicGuardExecute = validAuthorityEvidence();
  approvalGuardFunction(publicGuardExecute).acl.push({
    grantee: "PUBLIC",
    grantor: expectedOwner,
    grantable: false,
    privilege: "EXECUTE",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(publicGuardExecute, expectedOwner),
    /authority function .*ACL/,
  );

  const wrongGuardGrantor = validAuthorityEvidence();
  approvalGuardFunction(wrongGuardGrantor).acl[0].grantor = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongGuardGrantor, expectedOwner),
    /authority function .*ACL has an unexpected grantor/,
  );

  const wrongPromotionGrantee = validAuthorityEvidence();
  const promotion = authorityFunctionNamed(wrongPromotionGrantee, "catalogue_promote_import_batch");
  promotion.acl = promotion.acl.map((entry) =>
    entry.grantee === "nutrition_catalogue_promote_activate"
      ? { ...entry, grantee: "nutrition_catalogue_rollback" }
      : entry,
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongPromotionGrantee, expectedOwner),
    /authority function .*ACL/,
  );

  const missingRollbackCapability = validAuthorityEvidence();
  const rollback = authorityFunctionNamed(
    missingRollbackCapability,
    "catalogue_rollback_source_release",
  );
  rollback.acl = rollback.acl.filter((entry) => entry.grantee !== "nutrition_catalogue_rollback");
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingRollbackCapability, expectedOwner),
    /authority function .*ACL/,
  );

  const publicActivationGuardExecute = validAuthorityEvidence();
  authorityFunctionNamed(
    publicActivationGuardExecute,
    "guard_food_source_release_activation_authority",
  ).acl.push(acl("PUBLIC", "EXECUTE"));
  assert.throws(
    () => validateRestoreAuthorityEvidence(publicActivationGuardExecute, expectedOwner),
    /authority function .*ACL/,
  );

  const wrongStageGrantee = validAuthorityEvidence();
  const stageBatch = authorityFunctionNamed(wrongStageGrantee, "catalogue_stage_import_batch");
  stageBatch.acl = stageBatch.acl.map((entry) =>
    entry.grantee === "nutrition_catalogue_stage"
      ? { ...entry, grantee: "nutrition_catalogue_validate" }
      : entry,
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongStageGrantee, expectedOwner),
    /authority function .*ACL/,
  );

  const publicSealHelper = validAuthorityEvidence();
  authorityFunctionNamed(publicSealHelper, "catalogue_compute_import_staging_seal").acl.push(
    acl("PUBLIC", "EXECUTE"),
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(publicSealHelper, expectedOwner),
    /authority function .*ACL/,
  );

  const missingValidateSchemaUsage = validAuthorityEvidence();
  missingValidateSchemaUsage.schema.acl = missingValidateSchemaUsage.schema.acl.filter(
    (entry) => entry.grantee !== "nutrition_catalogue_validate",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingValidateSchemaUsage, expectedOwner),
    /public schema ACL/,
  );
});

test("rejects unsafe role attributes and every incoming membership option", () => {
  const unsafeAttribute = validAuthorityEvidence();
  unsafeAttribute.roles[0].superuser = true;
  assert.throws(
    () => validateRestoreAuthorityEvidence(unsafeAttribute, expectedOwner),
    /unsafe attributes/,
  );

  const unsafeMembership = validAuthorityEvidence();
  unsafeMembership.roles[1].incoming_memberships.push({
    admin_option: false,
    inherit_option: false,
    member: "unreviewed_login",
    set_option: false,
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(unsafeMembership, expectedOwner),
    /unsafe incoming membership/,
  );
});

test("pins all validated 0022 materialization, semantic, stage/validate, and authenticated-actor constraints", () => {
  const missingConstraint = validAuthorityEvidence();
  missingConstraint.authorityConstraints = [];
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingConstraint, expectedOwner),
    /materialization, nutrition-semantic, stage\/validate, or authenticated-actor constraint/,
  );

  for (const expectedConstraint of authorityConstraints) {
    const evidence = validAuthorityEvidence();
    evidence.authorityConstraints = evidence.authorityConstraints.map((constraint) =>
      constraint.name === expectedConstraint.name
        ? { ...constraint, definition: "CHECK (false)" }
        : constraint,
    );
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /materialization, nutrition-semantic, stage\/validate, or authenticated-actor constraint/,
      expectedConstraint.name,
    );
  }
});

test("pins frozen materialization columns and the activation import-batch index", () => {
  for (const expectedColumn of authorityFrozenColumns) {
    const evidence = validAuthorityEvidence();
    evidence.authorityFrozenColumns = evidence.authorityFrozenColumns.map((column) =>
      column.table_name === expectedColumn.table_name &&
      column.column_name === expectedColumn.column_name
        ? { ...column, default_expression: "'unsafe'::text" }
        : column,
    );
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /frozen materialization or nutrition-semantic column/,
      `${expectedColumn.table_name}.${expectedColumn.column_name}`,
    );
  }

  for (const drift of [
    { owner: "unexpected_owner" },
    { predicate: "import_batch_id IS NULL" },
    { is_primary: true },
    { key_attribute_count: 2 },
  ]) {
    const evidence = validAuthorityEvidence();
    evidence.authorityIndexes = evidence.authorityIndexes.map((index) => ({
      ...index,
      ...drift,
    }));
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /authority index/,
    );
  }
});

test("rejects authority fingerprints from the pre-authenticated-actor evidence version", () => {
  const evidence = validAuthorityEvidence();
  evidence.version = 12;
  assert.throws(
    () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
    /unsupported version/,
  );
});

test("rejects nonempty and non-NULL empty public column ACL state", () => {
  const baseline = canonicalizeRestoreAuthorityEvidence(validAuthorityEvidence());
  const explicitPrivilege = validAuthorityEvidence();
  explicitPrivilege.columnAcls.push({
    column_name: "id",
    grantable: false,
    grantee: "nutrition_catalogue_approve_data",
    grantor: expectedOwner,
    privilege: "SELECT",
    relation_name: "food_import_batch",
  });
  assert.notEqual(canonicalizeRestoreAuthorityEvidence(explicitPrivilege), baseline);
  assert.throws(
    () => validateRestoreAuthorityEvidence(explicitPrivilege, expectedOwner),
    /column has an explicit ACL/,
  );

  const nonNullEmptyAttacl = validAuthorityEvidence();
  nonNullEmptyAttacl.explicitColumnAclAttributeCount = "1";
  assert.notEqual(canonicalizeRestoreAuthorityEvidence(nonNullEmptyAttacl), baseline);
  assert.throws(
    () => validateRestoreAuthorityEvidence(nonNullEmptyAttacl, expectedOwner),
    /column has an explicit ACL/,
  );
});

test("rejects wrong owners, search paths, and non-definer authority functions", () => {
  const wrongRelationOwner = validAuthorityEvidence();
  wrongRelationOwner.relations[0].owner = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongRelationOwner, expectedOwner),
    /wrong owner/,
  );

  const wrongFunctionOwner = validAuthorityEvidence();
  authorityFunction(wrongFunctionOwner).owner = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongFunctionOwner, expectedOwner),
    /wrong owner/,
  );

  const wrongSearchPath = validAuthorityEvidence();
  authorityFunction(wrongSearchPath).config = ["search_path=pg_catalog, pg_temp, public"];
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongSearchPath, expectedOwner),
    /authority function.*differs from policy/,
  );

  for (const functionName of [
    "advance_food_search_projection_revision",
    "enqueue_food_search_source_eligibility_change",
  ]) {
    const foodSearchPathDrift = validAuthorityEvidence();
    const functionPolicy = foodSearchPathDrift.functions.find(
      (entry) => entry.name === functionName,
    );
    if (!functionPolicy) throw new Error(`${functionName} fixture is missing`);
    functionPolicy.config = [];
    assert.throws(
      () => validateRestoreAuthorityEvidence(foodSearchPathDrift, expectedOwner),
      new RegExp(`authority function ${functionName} differs from policy`),
    );
  }

  const invokerFunction = validAuthorityEvidence();
  authorityFunction(invokerFunction).security_definer = false;
  assert.throws(
    () => validateRestoreAuthorityEvidence(invokerFunction, expectedOwner),
    /authority function.*differs from policy/,
  );
});

test("requires pg_database_owner as the exact public schema ACL grantor", () => {
  const wrongGrantor = validAuthorityEvidence();
  wrongGrantor.schema.acl[0].grantor = expectedOwner;
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongGrantor, expectedOwner),
    /Public schema ACL has an unexpected grantor/,
  );
});

test("rejects unexpected table or sequence DML authority", () => {
  for (const kind of ["r", "S"]) {
    const evidence = validAuthorityEvidence();
    const relation = evidence.relations.find((entry) => entry.kind === kind);
    relation.acl_is_default = false;
    relation.acl.push({
      grantee: "nutrition_catalogue_stage",
      grantor: expectedOwner,
      grantable: false,
      privilege: kind === "S" ? "USAGE" : "INSERT",
    });
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /explicit DML privileges/,
    );
  }
});

test("pins every reviewed authority function and trigger", () => {
  assert.equal(
    validAuthorityFunctions().filter((entry) => entry.name !== "ordinary_function").length,
    54,
  );
  assert.equal(validAuthorityTriggers().length, 54);

  for (const [property, value] of [
    ["source_sha256", "0".repeat(64)],
    ["result_type", "text"],
    ["language", "sql"],
    ["volatility", "s"],
    ["strict", true],
    ["leakproof", true],
    ["parallel", "s"],
  ]) {
    const evidence = validAuthorityEvidence();
    authorityFunction(evidence)[property] = value;
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /executable semantics/,
    );
  }

  for (const reviewedFunction of validAuthorityEvidence().functions.filter(
    (entry) => entry.name !== "ordinary_function",
  )) {
    const bodyDrift = validAuthorityEvidence();
    bodyDrift.functions.find((entry) => entry.name === reviewedFunction.name).source_sha256 =
      "0".repeat(64);
    assert.throws(
      () => validateRestoreAuthorityEvidence(bodyDrift, expectedOwner),
      /authority function.*executable semantics/,
      reviewedFunction.name,
    );
  }

  const immutableBodyDrift = validAuthorityEvidence();
  immutableBodyDrift.functions.find(
    (entry) => entry.name === "reject_immutable_row_update",
  ).source_sha256 = "0".repeat(64);
  assert.throws(
    () => validateRestoreAuthorityEvidence(immutableBodyDrift, expectedOwner),
    /authority function.*executable semantics/,
  );

  const immutableConfigDrift = validAuthorityEvidence();
  immutableConfigDrift.functions.find(
    (entry) => entry.name === "reject_immutable_row_update",
  ).config = ["search_path=pg_catalog, public, pg_temp"];
  assert.throws(
    () => validateRestoreAuthorityEvidence(immutableConfigDrift, expectedOwner),
    /authority function.*differs from policy/,
  );

  const signatureDrift = validAuthorityEvidence();
  signatureDrift.functions.find(
    (entry) => entry.name === "catalogue_evidence_bundle_uri_is_valid",
  ).arguments = "digest text, value text";
  assert.throws(
    () => validateRestoreAuthorityEvidence(signatureDrift, expectedOwner),
    /unexpected signature/,
  );

  const missingFunction = validAuthorityEvidence();
  missingFunction.functions = missingFunction.functions.filter(
    (entry) => entry.name !== "guard_food_source_release_update",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingFunction, expectedOwner),
    /function set/,
  );

  const missingNutrientReaderFunction = validAuthorityEvidence();
  missingNutrientReaderFunction.functions = missingNutrientReaderFunction.functions.filter(
    (entry) => entry.name !== "lock_active_nutrient_registry_for_read",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingNutrientReaderFunction, expectedOwner),
    /function set/,
  );

  const disabledTrigger = validAuthorityEvidence();
  disabledTrigger.triggers[0].enabled = "D";
  assert.throws(
    () => validateRestoreAuthorityEvidence(disabledTrigger, expectedOwner),
    /trigger.*differs from policy/,
  );

  const crossSchemaTrigger = validAuthorityEvidence();
  crossSchemaTrigger.triggers[0].function_schema = "untrusted_shadow";
  assert.throws(
    () => validateRestoreAuthorityEvidence(crossSchemaTrigger, expectedOwner),
    /trigger.*differs from policy/,
  );

  for (const reviewedTrigger of validAuthorityEvidence().triggers) {
    const triggerDefinitionDrift = validAuthorityEvidence();
    triggerDefinitionDrift.triggers.find(
      (entry) => entry.name === reviewedTrigger.name,
    ).definition += " WHEN (true)";
    assert.throws(
      () => validateRestoreAuthorityEvidence(triggerDefinitionDrift, expectedOwner),
      /trigger.*differs from policy/,
      reviewedTrigger.name,
    );
  }

  const missingImmutableTrigger = validAuthorityEvidence();
  missingImmutableTrigger.triggers = missingImmutableTrigger.triggers.filter(
    (entry) => entry.name !== "food_import_approval_reject_update",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingImmutableTrigger, expectedOwner),
    /trigger set/,
  );

  const missingNutrientWriterTrigger = validAuthorityEvidence();
  missingNutrientWriterTrigger.triggers = missingNutrientWriterTrigger.triggers.filter(
    (entry) => entry.name !== "nutrient_registry_lock_before_active_update",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingNutrientWriterTrigger, expectedOwner),
    /trigger set/,
  );

  const staleNutrientWriterTrigger = validAuthorityEvidence();
  const nutrientWriterTrigger = staleNutrientWriterTrigger.triggers.find(
    (entry) => entry.name === "nutrient_registry_lock_before_active_update",
  );
  if (!nutrientWriterTrigger) throw new Error("Nutrient writer trigger fixture is missing");
  nutrientWriterTrigger.definition =
    "CREATE TRIGGER nutrient_registry_lock_before_active_update BEFORE UPDATE OF active ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()";
  assert.throws(
    () => validateRestoreAuthorityEvidence(staleNutrientWriterTrigger, expectedOwner),
    /trigger.*differs from policy/,
  );

  const extraProtectedTrigger = validAuthorityEvidence();
  extraProtectedTrigger.triggers.push({
    definition:
      "CREATE TRIGGER unreviewed_approval_trigger BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION ordinary_function()",
    enabled: "O",
    function_arguments: "",
    function_name: "ordinary_function",
    function_schema: "public",
    name: "unreviewed_approval_trigger",
    table_schema: "public",
    table_name: "food_import_approval",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(extraProtectedTrigger, expectedOwner),
    /trigger set/,
  );

  for (const protectedTable of ["food_import_checkpoint", "food_import_parser_report"]) {
    const extraStageEvidenceTrigger = validAuthorityEvidence();
    extraStageEvidenceTrigger.triggers.push({
      definition: `CREATE TRIGGER unreviewed_${protectedTable}_trigger BEFORE INSERT ON ${protectedTable} FOR EACH ROW EXECUTE FUNCTION ordinary_function()`,
      enabled: "O",
      function_arguments: "",
      function_name: "ordinary_function",
      function_schema: "public",
      name: `unreviewed_${protectedTable}_trigger`,
      table_schema: "public",
      table_name: protectedTable,
    });
    assert.throws(
      () => validateRestoreAuthorityEvidence(extraStageEvidenceTrigger, expectedOwner),
      /trigger set/,
      protectedTable,
    );
  }

  const reboundReviewedTrigger = validAuthorityEvidence();
  reboundReviewedTrigger.triggers.push({
    definition:
      "CREATE TRIGGER rebound_food_search_trigger AFTER INSERT ON unrelated_table FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()",
    enabled: "O",
    function_arguments: "",
    function_name: "enqueue_food_search_barcode_insert",
    function_schema: "public",
    name: "rebound_food_search_trigger",
    table_schema: "public",
    table_name: "unrelated_table",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(reboundReviewedTrigger, expectedOwner),
    /trigger set/,
  );

  const unrelatedTrigger = validAuthorityEvidence();
  unrelatedTrigger.triggers.push({
    definition:
      "CREATE TRIGGER unrelated_trigger BEFORE INSERT ON unrelated_table FOR EACH ROW EXECUTE FUNCTION ordinary_function()",
    enabled: "O",
    function_arguments: "",
    function_name: "ordinary_function",
    function_schema: "public",
    name: "unrelated_trigger",
    table_schema: "public",
    table_name: "unrelated_table",
  });
  assert.doesNotThrow(() => validateRestoreAuthorityEvidence(unrelatedTrigger, expectedOwner));

  const unrelatedSharedHelperTrigger = validAuthorityEvidence();
  unrelatedSharedHelperTrigger.triggers.push({
    definition:
      "CREATE TRIGGER unrelated_updated_at BEFORE UPDATE ON unrelated_table FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    enabled: "O",
    function_arguments: "",
    function_name: "set_row_updated_at",
    function_schema: "public",
    name: "unrelated_updated_at",
    table_schema: "public",
    table_name: "unrelated_table",
  });
  assert.doesNotThrow(() =>
    validateRestoreAuthorityEvidence(unrelatedSharedHelperTrigger, expectedOwner),
  );

  const reboundReviewedName = validAuthorityEvidence();
  reboundReviewedName.triggers.push({
    definition:
      "CREATE TRIGGER food_source_set_updated_at BEFORE UPDATE ON unrelated_table FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    enabled: "O",
    function_arguments: "",
    function_name: "set_row_updated_at",
    function_schema: "public",
    name: "food_source_set_updated_at",
    table_schema: "public",
    table_name: "unrelated_table",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(reboundReviewedName, expectedOwner),
    /trigger set/,
  );

  const persistentForeignSchemaBinding = validAuthorityEvidence();
  persistentForeignSchemaBinding.triggers.push({
    definition:
      "CREATE TRIGGER arbitrary_archive_trigger AFTER INSERT ON authority_archive.food_archive FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()",
    enabled: "O",
    function_arguments: "",
    function_name: "enqueue_food_search_barcode_insert",
    function_schema: "public",
    name: "arbitrary_archive_trigger",
    table_schema: "authority_archive",
    table_name: "food_archive",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(persistentForeignSchemaBinding, expectedOwner),
    /trigger set/,
  );
});

test("rejects public type and global or public-schema default ACL drift", () => {
  const explicitTypeAcl = validAuthorityEvidence();
  explicitTypeAcl.types[0].acl_is_default = false;
  assert.throws(
    () => validateRestoreAuthorityEvidence(explicitTypeAcl, expectedOwner),
    /type.*explicit privileges/,
  );

  const defaultAcl = validAuthorityEvidence();
  defaultAcl.defaultAcls.push({
    acl: [acl("nutrition_catalogue_stage", "INSERT")],
    object_type: "r",
    owner: "unreviewed_owner",
    schema_name: "public",
  });
  assert.throws(() => validateRestoreAuthorityEvidence(defaultAcl, expectedOwner), /default ACL/);
});

test("requires the exact database owner, ACL, effective CONNECT allowlist, and isolation", () => {
  const options = { connectAllowlist: [expectedOwner], expectedOwner };
  const boundary = validDatabaseBoundary();
  validateTargetDatabaseBoundary(boundary, options);

  assert.throws(
    () => validateTargetDatabaseBoundary({ ...boundary, owner: "restore_operator" }, options),
    /wrong owner/,
  );
  assert.throws(
    () =>
      validateTargetDatabaseBoundary(
        { ...boundary, acl: [...boundary.acl, acl("PUBLIC", "CONNECT")] },
        options,
      ),
    /database ACL/,
  );
  assert.throws(
    () =>
      validateTargetDatabaseBoundary(
        { ...boundary, effectiveConnectRoles: [expectedOwner, "runtime_login"] },
        options,
      ),
    /CONNECT login allowlist/,
  );
  assert.throws(
    () => validateTargetDatabaseBoundary({ ...boundary, otherClientSessions: "1" }, options),
    /client session/,
  );
});

test("fails closed on unverifiable or unsafe dump storage and mandatory cleanup", () => {
  const dumpPath = "/dev/shm/nutrition_restore_ci.dump";
  const options = {
    container: "postgres-test-1",
    dumpDirectory: "/dev/shm",
    dumpProtection: "tmpfs",
  };
  const calls = [];
  const run = (_command, arguments_) => {
    calls.push(arguments_);
    if (arguments_.includes("restore-dump-preflight")) return "/dev/shm\n";
    if (arguments_.includes("restore-dump-artifact")) {
      return dumpAttestationOutput(validDumpAttestation(dumpPath));
    }
    return "";
  };

  assertProtectedDumpDestination(run, options, dumpPath);
  assertRegularDumpArtifact(run, options, dumpPath);
  removeDumpArtifact(run, options, dumpPath);
  assert.match(calls[0].join(" "), /readlink -f/);
  assert.match(calls[0].join(" "), /stat -f -c %T/);
  assert.match(calls[0].join(" "), /\[ ! -e "\$dump_path" \]/);
  assert.match(calls[0].join(" "), /\[ ! -L "\$dump_path" \]/);
  assert.match(calls[1].join(" "), /stat -c %a/);
  assert.match(calls[1].join(" "), /stat -f -c %T/);
  assert.deepEqual(calls[2].slice(-4), ["rm", "-f", "--", dumpPath]);
  assert.match(calls[3].join(" "), /\[ ! -e "\$1" \].*\[ ! -L "\$1" \]/);

  assert.throws(
    () =>
      assertProtectedDumpDestination(
        () => "",
        { ...options, dumpProtection: "encrypted_volume" },
        dumpPath,
      ),
    /not independently verifiable/,
  );
  assert.throws(
    () => assertProtectedDumpDestination(() => "/run/not-tmpfs\n", options, dumpPath),
    /exact verified tmpfs/,
  );
  assert.throws(
    () =>
      removeDumpArtifact(
        (_command, arguments_) => {
          if (arguments_.includes("restore-dump-cleanup")) throw new Error("artifact remains");
          return "";
        },
        options,
        dumpPath,
      ),
    /artifact remains/,
  );

  for (const [property, value] of [
    ["mountType", "ext2/ext3"],
    ["ownerUid", "1001"],
    ["ownerGid", "1001"],
    ["mode", "640"],
    ["linkCount", "2"],
    ["fileType", "symbolic link"],
  ]) {
    assert.throws(
      () =>
        validateDumpArtifactAttestation(
          { ...validDumpAttestation(dumpPath), [property]: value },
          options,
          dumpPath,
        ),
      /exact private tmpfs policy/,
      property,
    );
  }
});

test("orchestration rejects source body drift before dump creation", () => {
  const evidence = validAuthorityEvidence();
  authorityFunction(evidence).source_sha256 = "0".repeat(64);
  const { calls, run } = authorityEvidenceRunner(evidence);

  assert.throws(() => runPostgresRestoreDrill(restoreOptions(), { run }), /executable semantics/);
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("pg_dump")),
    false,
  );
});

test("orchestration rejects cross-schema trigger drift before dump creation", () => {
  const evidence = validAuthorityEvidence();
  evidence.triggers[0].function_schema = "untrusted_shadow";
  const { calls, run } = authorityEvidenceRunner(evidence);

  assert.throws(
    () => runPostgresRestoreDrill(restoreOptions(), { run }),
    /trigger.*differs from policy/,
  );
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("pg_dump")),
    false,
  );
});

test("orchestration collects and rejects persistent foreign-schema authority bindings", () => {
  const evidence = validAuthorityEvidence();
  evidence.triggers.push({
    definition:
      "CREATE TRIGGER arbitrary_archive_trigger AFTER INSERT ON authority_archive.food_archive FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()",
    enabled: "O",
    function_arguments: "",
    function_name: "enqueue_food_search_barcode_insert",
    function_schema: "public",
    name: "arbitrary_archive_trigger",
    table_schema: "authority_archive",
    table_name: "food_archive",
  });
  const { calls, run } = authorityEvidenceRunner(evidence);

  assert.throws(() => runPostgresRestoreDrill(restoreOptions(), { run }), /trigger set/);
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("pg_dump")),
    false,
  );
  const triggerQuery = calls
    .map((arguments_) => arguments_.at(-1) ?? "")
    .find((sql) => sql.includes("trigger_policy"));
  assert.match(triggerQuery ?? "", /namespace_row\.nspname as table_schema/);
  assert.match(
    triggerQuery ?? "",
    /namespace_row\.nspname = 'public' or \( procedure_namespace\.nspname = 'public'/,
  );
  assert.match(triggerQuery ?? "", /enqueue_food_search_barcode_insert/);
  assert.match(triggerQuery ?? "", /lock_active_nutrient_registry_before_write/);
  assert.match(triggerQuery ?? "", /reconcile_recipe_components_v2/);
});

test("orchestration rejects explicit public column ACL state before dump creation", () => {
  const explicitPrivilege = validAuthorityEvidence();
  explicitPrivilege.columnAcls.push({
    column_name: "id",
    grantable: false,
    grantee: "nutrition_catalogue_approve_data",
    grantor: expectedOwner,
    privilege: "SELECT",
    relation_name: "food_import_batch",
  });
  const nonNullEmptyAttacl = validAuthorityEvidence();
  nonNullEmptyAttacl.explicitColumnAclAttributeCount = "1";

  for (const evidence of [explicitPrivilege, nonNullEmptyAttacl]) {
    const { calls, run } = authorityEvidenceRunner(evidence);
    assert.throws(
      () => runPostgresRestoreDrill(restoreOptions(), { run }),
      /column has an explicit ACL/,
    );
    assert.equal(
      calls.some((arguments_) => arguments_.join(" ").includes("pg_dump")),
      false,
    );
    const countQuery = calls
      .map((arguments_) => arguments_.at(-1) ?? "")
      .find((sql) => sql.includes("explicit_column_acl_attribute_count"));
    assert.match(countQuery ?? "", /attribute_row\.attacl is not null/);
  }
});

test("orchestration makes cleanup failure-terminal after a post-dump policy failure", () => {
  const cleanupError = new Error("cleanup verification failed");
  const { calls, run } = authorityEvidenceRunner(validAuthorityEvidence(), {
    cleanupError,
    policyError: new Error("policy rejected authority drift"),
  });

  assert.throws(
    () => runPostgresRestoreDrill(restoreOptions(), { run }),
    /cleanup verification failed/,
  );
  assert.equal(
    calls.some(
      (arguments_) =>
        arguments_.slice(-4).join(" ") ===
        "rm -f -- /dev/shm/nutrition_restore_ci_orchestration.dump",
    ),
    true,
  );
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("umask 077")),
    true,
  );
});

test("pins the exact versioned policy bytes", () => {
  assert.equal(RESTORE_AUTHORITY_POLICY_SHA256.length, 64);
  assert.throws(
    () => assertRestoreAuthorityPolicyDigest("begin; commit;\n", RESTORE_AUTHORITY_POLICY_SHA256),
    /policy digest/,
  );
});

function validAuthorityEvidence() {
  return {
    authorityConstraints: structuredClone(authorityConstraints),
    authorityFrozenColumns: structuredClone(authorityFrozenColumns),
    authorityIndexes: structuredClone(authorityIndexes),
    columnAcls: [],
    defaultAcls: [],
    explicitColumnAclAttributeCount: "0",
    functions: validAuthorityFunctions(),
    relations: [
      {
        acl: [acl(expectedOwner, "SELECT")],
        acl_is_default: true,
        kind: "r",
        name: "food_import_batch",
        owner: expectedOwner,
      },
      {
        acl: [acl(expectedOwner, "USAGE")],
        acl_is_default: true,
        kind: "S",
        name: "food_import_approval_id_seq",
        owner: expectedOwner,
      },
    ],
    roles: capabilityRoles.map((name) => ({
      bypass_rls: false,
      can_login: false,
      create_database: false,
      create_role: false,
      incoming_memberships: [],
      name,
      outgoing_memberships: [],
      owned_object_count: "0",
      replication: false,
      superuser: false,
    })),
    schema: {
      acl: [
        acl("PUBLIC", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_stage", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_validate", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_approve_data", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_approve_quality", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_approve_rights", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_promote_activate", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_rollback", "USAGE", "pg_database_owner"),
        acl("pg_database_owner", "CREATE", "pg_database_owner"),
        acl("pg_database_owner", "USAGE", "pg_database_owner"),
      ],
      acl_is_default: false,
      name: "public",
      owner: "pg_database_owner",
    },
    triggers: validAuthorityTriggers(),
    types: [
      {
        acl: [acl("PUBLIC", "USAGE"), acl(expectedOwner, "USAGE")],
        acl_is_default: true,
        kind: "e",
        name: "food_import_state",
        owner: expectedOwner,
      },
    ],
    version: 13,
  };
}

function functionSemantics(sourceSha256, resultType) {
  return {
    language: "plpgsql",
    leakproof: false,
    parallel: "u",
    result_type: resultType,
    source_sha256: sourceSha256,
    strict: false,
    volatility: "v",
  };
}

function validAuthorityFunctions() {
  const triggerFunctions = [
    [
      "enqueue_food_search_barcode_insert",
      "4e888f3ef0b3af1e7eee14568069ae3fe06b65b88718614ed0e2c243a5d22318",
    ],
    [
      "enqueue_food_search_barcode_update",
      "9d7a90d0fee1a6923631c9b9018d9c813d3c8f7eea2df941fc32fbb4f5d453b0",
    ],
    [
      "enqueue_food_search_food_eligibility_change",
      "85ada305a6fd6b40cd5fb0652d64c240d1953033a243b0f7ce243caa9bc9c4de",
    ],
    [
      "enqueue_food_search_serving_insert",
      "223f2d1dc8f90c6bc04c4d85ec763bcb50727473f5576b0bcdbbf394c1c9d804",
    ],
    [
      "guard_active_nutrient_vector_size",
      "24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda",
    ],
    [
      "guard_custom_food_child_insert_v3",
      "f2fc5d7cc06759696b2656f921d57502326ab4efbd6fe1b1554143b117152d88",
    ],
    [
      "guard_custom_food_immutable_evidence_v3",
      "5e450518bc31811221ad64826f6879b177ecec760d88abd0353b14c4aebe3317",
    ],
    [
      "guard_food_barcode_validity_update",
      "7b97f95dd7388565424bd3713081711106a5e3d0c206310a8d405b8772208ecc",
    ],
    [
      "guard_food_import_approval_authority",
      "f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd",
    ],
    [
      "guard_food_import_batch_initial_state",
      "2561714155de31151c79f95977156072a66451d1f13f7b5c6e85d13abe9ecb0c",
    ],
    [
      "guard_food_import_batch_nutrition_semantics",
      "298b898cd252f08aa9a5f212e85750aeba79cc41616c71afcd3f129471a6cf5c",
    ],
    [
      "guard_food_import_batch_stage_validate_authority",
      "f21dfa9d5455a40ab9f50bdbace02ffc19f53ab252e0eab99a4f50769f678eda",
    ],
    [
      "guard_food_import_batch_update",
      "8863eef0e6889a620deec204e249ac3d6efdc87310dcc9d25601e6d7f336101f",
    ],
    [
      "guard_food_import_batch_validation_digest",
      "c94c16cef462dfaca5c58908c2784e6d86b9f415c1c081f7b6c8a5ca434bddd7",
    ],
    [
      "guard_food_import_record_insert_before_staging_seal",
      "2fc46ef24e03309e61832491438746967642911b02e97896f8a0bdf6fc5aa8bc",
    ],
    [
      "guard_food_import_record_nutrition_semantics",
      "489c1c4b970c6ba369503854701c980ebcb1510c754050e78355fed94647e0e8",
    ],
    [
      "guard_food_import_record_update",
      "300e6853e7a9520b477256b3b32a4381f3143512b013a4e131a4c203ce524479",
    ],
    [
      "guard_food_import_stage_checkpoint_before_staging_seal",
      "66e2078cf57d658268f547c25df26750ebe5b7b6402de9fcecdc2249c14f28ef",
    ],
    [
      "guard_imported_food_version_child_delete",
      "4e36d3ee5cbd53dc6c98d9f457adbb5ee8cb6cbf8fc6b3e45d3133b4305e7cc1",
    ],
    [
      "guard_food_source_active_release_authority",
      "306eec1771a7bbf7961bd6d46ba752801fe98f07d27fbf96291a1c454750cd11",
    ],
    [
      "guard_food_source_initial_active_release",
      "e3cbc51f28aafd274ea2bc3b71b824d51180d8e741dbcfd22d0af9e21849be43",
    ],
    [
      "guard_food_source_release_initial_state",
      "797445724ddd8d37cdbcc1891c724e9bd8af543548d322db5cf9c3d22ac13b3d",
    ],
    [
      "guard_food_source_release_legacy_promotion_grandfather",
      "22340dfcbb5f98e1d0504703b0fb37830b31a4ecde5cbe81e55844968b86f214",
    ],
    [
      "guard_food_source_release_update",
      "191701f20750b6e98b8acf290a1df2417bf17bd9c3a4e5e87a7ac7ef56453726",
    ],
    [
      "guard_new_food_source_release_authority",
      "93f189e2c097009ac1cbf1129ce10a24d0c7fd2e4cee66c2ea5cdbb1537462b3",
    ],
    [
      "guard_source_barcode_delete",
      "d4bea8e773166f82f291f1d89b20a7cfb52e2d8416ba80bb455642058d23e3cf",
    ],
    [
      "lock_active_nutrient_registry_before_write",
      "c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de",
    ],
    [
      "reconcile_recipe_components_v2",
      "c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a",
    ],
    [
      "reject_new_legacy_unbound_catalogue_evidence",
      "f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e",
    ],
    [
      "validate_food_version_child_insert",
      "5362678168ed713e602e0fd87bc8b13dccd7817db1cf3d3470f09dcbe37e5f07",
    ],
  ].map(([name, sourceSha256]) => ({
    ...functionSemantics(sourceSha256, "trigger"),
    acl: [
      "guard_food_import_approval_authority",
      "guard_food_import_batch_nutrition_semantics",
      "guard_food_import_batch_stage_validate_authority",
      "guard_food_import_record_insert_before_staging_seal",
      "guard_food_import_record_nutrition_semantics",
      "guard_food_import_stage_checkpoint_before_staging_seal",
    ].includes(name)
      ? [acl(expectedOwner, "EXECUTE")]
      : [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
    acl_is_default: ![
      "guard_food_import_approval_authority",
      "guard_food_import_batch_nutrition_semantics",
      "guard_food_import_batch_stage_validate_authority",
      "guard_food_import_record_insert_before_staging_seal",
      "guard_food_import_record_nutrition_semantics",
      "guard_food_import_stage_checkpoint_before_staging_seal",
    ].includes(name),
    arguments: "",
    config: ["search_path=pg_catalog, public, pg_temp"],
    name,
    owner: expectedOwner,
    security_definer: false,
  }));
  return [
    {
      ...functionSemantics(
        "d1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108",
        "void",
      ),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "advance_food_search_projection_revision",
      owner: expectedOwner,
      security_definer: false,
    },
    {
      ...functionSemantics(
        "e2c35dfabb653636a9640475227104a485a24129558b11511175831ef9bc5b8b",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments: "p_batch_id uuid",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_attest_import_nutrition_semantics",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "299a2c88226123f167fe2d7001fdaf6a2e02425007f2426c8def9d0bb83a46c0",
        "text",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments: "p_left text, p_right text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_canonical_decimal_product",
      owner: expectedOwner,
      parallel: "s",
      security_definer: false,
      strict: true,
      volatility: "i",
    },
    {
      ...functionSemantics(
        "399d40c2913c2022c0a2921d5870a2d26a5dcd9949d81715882f70899db4f5f8",
        "text",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments: "p_batch_id uuid",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_compute_import_staging_seal",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "41f048090dce80b794615f135f5368f7f501eaecfc3513471eb6d1f36c022783",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments: "p_record_id bigint",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_compute_record_nutrition_semantics",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "bd8f0714717baf626507a2d40799cea75085f20e9df7295b77fb5899529f2142",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE"), acl("nutrition_catalogue_promote_activate", "EXECUTE")],
      acl_is_default: false,
      arguments: "p_batch_id uuid, p_external_principal_id text, p_reason text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_promote_import_batch",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "115fdc3ed1943dd77ce70d3a694495da3d2c62ade9c7b82812a89cef82b39f17",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments: "p_batch_id uuid, p_external_principal_id text, p_reason text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_promote_import_batch_v1",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "0a87bc99f5df97282c48b6202799bcc75cdb914e7473c0c38e092aaf4a132acf",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE"), acl("nutrition_catalogue_validate", "EXECUTE")],
      acl_is_default: false,
      arguments: "p_batch_id uuid",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_observe_import_validation",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "73314f5d97251a648093a82d8d9f6d3575a8f3b571d16349ca60a9795de04719",
        "boolean",
      ),
      acl: [
        acl(expectedOwner, "EXECUTE"),
        acl("nutrition_catalogue_approve_data", "EXECUTE"),
        acl("nutrition_catalogue_approve_quality", "EXECUTE"),
        acl("nutrition_catalogue_approve_rights", "EXECUTE"),
      ],
      acl_is_default: false,
      arguments:
        "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_record_import_approval",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac",
        "boolean",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments:
        "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_record_import_approval_v1",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e",
        "boolean",
      ),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "value text, digest text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      language: "sql",
      name: "catalogue_evidence_bundle_uri_is_valid",
      owner: expectedOwner,
      security_definer: false,
      strict: true,
      volatility: "i",
    },
    {
      ...functionSemantics(
        "a6b7cce658727edcfc889eac7272e65b094592361459130c815436c8f1cc14d7",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE"), acl("nutrition_catalogue_rollback", "EXECUTE")],
      acl_is_default: false,
      arguments:
        "p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_rollback_source_release",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "3fe493ee5e0b27e43cc881854dddfe4dc12f862a1c4a242bf712c843b2792ff1",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments:
        "p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_rollback_source_release_v1",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "11b0a983c9cf3d4a7451978d37e5fe997a40290a10e741ba0626b89bfd2611c4",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE"), acl("nutrition_catalogue_stage", "EXECUTE")],
      acl_is_default: false,
      arguments: "p_stage_document text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_stage_import_batch",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "d89defb335e21228c38968ef69b2ed7342f5a5440762ae31f170969fbcc9c9e8",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE"), acl("nutrition_catalogue_stage", "EXECUTE")],
      acl_is_default: false,
      arguments: "p_batch_id uuid, p_parser_report_document text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_stage_import_parser_report",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "4cc2b310ba6fda051a125bb203c0cf2c6a5fbe227a55daf517a0376ab79e4c7f",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE"), acl("nutrition_catalogue_stage", "EXECUTE")],
      acl_is_default: false,
      arguments: "p_batch_id uuid, p_expected_next_offset bigint, p_records_document text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_stage_import_record_chunk",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "3a1759986b190b3ccac086e5da943ada91f3cc8c3a94ce6942657faae389ef39",
        "bigint",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments: "p_value text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      language: "sql",
      name: "catalogue_utf16_length",
      owner: expectedOwner,
      parallel: "s",
      security_definer: false,
      strict: true,
      volatility: "i",
    },
    {
      ...functionSemantics(
        "10c59084d8e5c7debb581c6e749f6779dbc3f5867fc4cb18ffc009293f9f50a5",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE"), acl("nutrition_catalogue_validate", "EXECUTE")],
      acl_is_default: false,
      arguments:
        "p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_validate_import_batch",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "5b7ae15625fb0ae0d88a9512fe82fca69a9d0dd9e179af8bc1b2f42d1e85ac8a",
        "jsonb",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments:
        "p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_validate_import_batch_v1",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "d46f53aeffa6469eada5461ab59bd9c23d43bf9aab77704c61b21c44291ae028",
        "trigger",
      ),
      acl: [acl(expectedOwner, "EXECUTE")],
      acl_is_default: false,
      arguments: "",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "guard_food_source_release_activation_authority",
      owner: expectedOwner,
      security_definer: false,
    },
    {
      ...functionSemantics(
        "22ab05f2e9749ecff7035e5188e1b9353d46533e7bc558748c76c43dbfc37ea5",
        "void",
      ),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "",
      config: ["search_path=pg_catalog, public, pg_temp"],
      language: "sql",
      name: "lock_active_nutrient_registry_for_read",
      owner: expectedOwner,
      security_definer: false,
    },
    ...triggerFunctions,
    {
      ...functionSemantics(
        "3a88f24e4863d8150db21f93efadd528ea5d7811b5c79c6ff5cd38fdcb93ce87",
        "trigger",
      ),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "enqueue_food_search_source_eligibility_change",
      owner: expectedOwner,
      security_definer: false,
    },
    {
      ...functionSemantics(
        "631a42e27de6543bc09fd6b8d0f1b0fd336250270b47f13849a2483fd0786e6e",
        "trigger",
      ),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "",
      config: [],
      name: "reject_immutable_row_update",
      owner: expectedOwner,
      security_definer: false,
    },
    {
      ...functionSemantics(
        "92fa7c305a8b856faea0575b27eaa33c1e39952cf9fe87b4c0cbf7d7eab556bd",
        "trigger",
      ),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "set_row_updated_at",
      owner: expectedOwner,
      security_definer: false,
    },
    {
      ...functionSemantics("a".repeat(64), "boolean"),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "",
      config: [],
      name: "ordinary_function",
      owner: expectedOwner,
      security_definer: false,
    },
  ];
}

function validAuthorityTriggers() {
  return [
    [
      "custom_food_nutrient_guard_delete_v3",
      "food_nutrient_value",
      "guard_custom_food_immutable_evidence_v3",
      "CREATE TRIGGER custom_food_nutrient_guard_delete_v3 BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
    ],
    [
      "custom_food_nutrient_guard_insert_v3",
      "food_nutrient_value",
      "guard_custom_food_child_insert_v3",
      "CREATE TRIGGER custom_food_nutrient_guard_insert_v3 BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()",
    ],
    [
      "custom_food_serving_guard_delete_v3",
      "food_serving",
      "guard_custom_food_immutable_evidence_v3",
      "CREATE TRIGGER custom_food_serving_guard_delete_v3 BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
    ],
    [
      "custom_food_serving_guard_insert_v3",
      "food_serving",
      "guard_custom_food_child_insert_v3",
      "CREATE TRIGGER custom_food_serving_guard_insert_v3 BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()",
    ],
    [
      "custom_food_version_guard_delete_v3",
      "food_version",
      "guard_custom_food_immutable_evidence_v3",
      "CREATE TRIGGER custom_food_version_guard_delete_v3 BEFORE DELETE ON food_version FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
    ],
    [
      "food_barcode_guard_update",
      "food_barcode",
      "guard_food_barcode_validity_update",
      "CREATE TRIGGER food_barcode_guard_update BEFORE UPDATE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_food_barcode_validity_update()",
    ],
    [
      "food_barcode_reject_delete",
      "food_barcode",
      "guard_source_barcode_delete",
      "CREATE TRIGGER food_barcode_reject_delete BEFORE DELETE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_source_barcode_delete()",
    ],
    [
      "food_nutrient_value_reject_delete",
      "food_nutrient_value",
      "guard_imported_food_version_child_delete",
      "CREATE TRIGGER food_nutrient_value_reject_delete BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()",
    ],
    [
      "food_nutrient_value_reject_update",
      "food_nutrient_value",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_nutrient_value_reject_update BEFORE UPDATE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_nutrient_value_validate_insert",
      "food_nutrient_value",
      "validate_food_version_child_insert",
      "CREATE TRIGGER food_nutrient_value_validate_insert BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()",
    ],
    [
      "food_serving_reject_delete",
      "food_serving",
      "guard_imported_food_version_child_delete",
      "CREATE TRIGGER food_serving_reject_delete BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()",
    ],
    [
      "food_serving_reject_update",
      "food_serving",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_serving_reject_update BEFORE UPDATE ON food_serving FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_serving_validate_insert",
      "food_serving",
      "validate_food_version_child_insert",
      "CREATE TRIGGER food_serving_validate_insert BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()",
    ],
    [
      "food_set_updated_at",
      "food",
      "set_row_updated_at",
      "CREATE TRIGGER food_set_updated_at BEFORE UPDATE ON food FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    ],
    [
      "food_version_reject_update",
      "food_version",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_version_reject_update BEFORE UPDATE ON food_version FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_import_approval_guard_authority",
      "food_import_approval",
      "guard_food_import_approval_authority",
      "CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()",
    ],
    [
      "food_import_approval_reject_update",
      "food_import_approval",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_import_approval_reject_update BEFORE DELETE OR UPDATE ON food_import_approval FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_import_batch_guard_initial_state",
      "food_import_batch",
      "guard_food_import_batch_initial_state",
      "CREATE TRIGGER food_import_batch_guard_initial_state BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_initial_state()",
    ],
    [
      "food_import_batch_guard_nutrition_semantics",
      "food_import_batch",
      "guard_food_import_batch_nutrition_semantics",
      "CREATE TRIGGER food_import_batch_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_nutrition_semantics()",
    ],
    [
      "food_import_batch_guard_stage_validate_authority",
      "food_import_batch",
      "guard_food_import_batch_stage_validate_authority",
      "CREATE TRIGGER food_import_batch_guard_stage_validate_authority BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_stage_validate_authority()",
    ],
    [
      "food_import_batch_guard_update",
      "food_import_batch",
      "guard_food_import_batch_update",
      "CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()",
    ],
    [
      "food_import_batch_guard_validation_digest",
      "food_import_batch",
      "guard_food_import_batch_validation_digest",
      "CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()",
    ],
    [
      "food_import_batch_reject_new_legacy_unbound",
      "food_import_batch",
      "reject_new_legacy_unbound_catalogue_evidence",
      "CREATE TRIGGER food_import_batch_reject_new_legacy_unbound BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    ],
    [
      "food_import_checkpoint_guard_staging_seal",
      "food_import_checkpoint",
      "guard_food_import_stage_checkpoint_before_staging_seal",
      "CREATE TRIGGER food_import_checkpoint_guard_staging_seal BEFORE INSERT OR DELETE OR UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION guard_food_import_stage_checkpoint_before_staging_seal()",
    ],
    [
      "food_import_checkpoint_set_updated_at",
      "food_import_checkpoint",
      "set_row_updated_at",
      "CREATE TRIGGER food_import_checkpoint_set_updated_at BEFORE UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    ],
    [
      "food_import_parser_report_reject_update",
      "food_import_parser_report",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_import_parser_report_reject_update BEFORE DELETE OR UPDATE ON food_import_parser_report FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_import_record_guard_nutrition_semantics",
      "food_import_record",
      "guard_food_import_record_nutrition_semantics",
      "CREATE TRIGGER food_import_record_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_nutrition_semantics()",
    ],
    [
      "food_import_record_guard_staging_seal",
      "food_import_record",
      "guard_food_import_record_insert_before_staging_seal",
      "CREATE TRIGGER food_import_record_guard_staging_seal BEFORE INSERT ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_insert_before_staging_seal()",
    ],
    [
      "food_import_record_guard_update",
      "food_import_record",
      "guard_food_import_record_update",
      "CREATE TRIGGER food_import_record_guard_update BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()",
    ],
    [
      "food_import_record_reject_delete",
      "food_import_record",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_import_record_reject_delete BEFORE DELETE ON food_import_record FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_search_barcode_insert_outbox",
      "food_barcode",
      "enqueue_food_search_barcode_insert",
      "CREATE TRIGGER food_search_barcode_insert_outbox AFTER INSERT ON food_barcode REFERENCING NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()",
    ],
    [
      "food_search_barcode_update_outbox",
      "food_barcode",
      "enqueue_food_search_barcode_update",
      "CREATE TRIGGER food_search_barcode_update_outbox AFTER UPDATE ON food_barcode REFERENCING OLD TABLE AS old_food_search_barcodes NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_update()",
    ],
    [
      "food_search_eligibility_outbox",
      "food",
      "enqueue_food_search_food_eligibility_change",
      "CREATE TRIGGER food_search_eligibility_outbox AFTER UPDATE ON food REFERENCING OLD TABLE AS old_food_search_rows NEW TABLE AS new_food_search_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_food_eligibility_change()",
    ],
    [
      "food_search_serving_insert_outbox",
      "food_serving",
      "enqueue_food_search_serving_insert",
      "CREATE TRIGGER food_search_serving_insert_outbox AFTER INSERT ON food_serving REFERENCING NEW TABLE AS new_food_search_servings FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_serving_insert()",
    ],
    [
      "food_source_guard_active_release_authority",
      "food_source",
      "guard_food_source_active_release_authority",
      "CREATE TRIGGER food_source_guard_active_release_authority BEFORE UPDATE OF active_release_id ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_active_release_authority()",
    ],
    [
      "food_source_guard_initial_active_release",
      "food_source",
      "guard_food_source_initial_active_release",
      "CREATE TRIGGER food_source_guard_initial_active_release BEFORE INSERT ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_initial_active_release()",
    ],
    [
      "food_source_search_eligibility_outbox",
      "food_source",
      "enqueue_food_search_source_eligibility_change",
      "CREATE TRIGGER food_source_search_eligibility_outbox AFTER UPDATE OF active, active_release_id, code, display_name, license_expression, attribution_required, attribution_text, commercial_use_allowed, redistribution_allowed, rights_review_status, rights_reviewed_at, rights_reviewed_by ON food_source FOR EACH ROW EXECUTE FUNCTION enqueue_food_search_source_eligibility_change()",
    ],
    [
      "food_source_set_updated_at",
      "food_source",
      "set_row_updated_at",
      "CREATE TRIGGER food_source_set_updated_at BEFORE UPDATE ON food_source FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    ],
    [
      "food_source_release_activation_guard_authority",
      "food_source_release_activation",
      "guard_food_source_release_activation_authority",
      "CREATE TRIGGER food_source_release_activation_guard_authority BEFORE INSERT ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_activation_authority()",
    ],
    [
      "food_source_release_activation_reject_update",
      "food_source_release_activation",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_source_release_activation_reject_update BEFORE DELETE OR UPDATE ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_source_release_guard_initial_state",
      "food_source_release",
      "guard_food_source_release_initial_state",
      "CREATE TRIGGER food_source_release_guard_initial_state BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_initial_state()",
    ],
    [
      "food_source_release_guard_legacy_grandfather_insert",
      "food_source_release",
      "guard_food_source_release_legacy_promotion_grandfather",
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_insert BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    ],
    [
      "food_source_release_guard_legacy_grandfather_update",
      "food_source_release",
      "guard_food_source_release_legacy_promotion_grandfather",
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_update BEFORE UPDATE OF legacy_promotion_grandfathered_at ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    ],
    [
      "food_source_release_guard_new_authority",
      "food_source_release",
      "guard_new_food_source_release_authority",
      "CREATE TRIGGER food_source_release_guard_new_authority BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_new_food_source_release_authority()",
    ],
    [
      "food_source_release_guard_update",
      "food_source_release",
      "guard_food_source_release_update",
      "CREATE TRIGGER food_source_release_guard_update BEFORE UPDATE ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_update()",
    ],
    [
      "food_source_release_reject_delete",
      "food_source_release",
      "reject_immutable_row_update",
      "CREATE TRIGGER food_source_release_reject_delete BEFORE DELETE ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    ],
    [
      "food_source_release_reject_new_legacy_unbound",
      "food_source_release",
      "reject_new_legacy_unbound_catalogue_evidence",
      "CREATE TRIGGER food_source_release_reject_new_legacy_unbound BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    ],
    [
      "nutrient_active_vector_size_guard",
      "nutrient",
      "guard_active_nutrient_vector_size",
      "CREATE CONSTRAINT TRIGGER nutrient_active_vector_size_guard AFTER INSERT OR UPDATE OF active ON nutrient DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_active_nutrient_vector_size()",
    ],
    [
      "nutrient_registry_lock_before_active_update",
      "nutrient",
      "lock_active_nutrient_registry_before_write",
      "CREATE TRIGGER nutrient_registry_lock_before_active_update BEFORE DELETE OR UPDATE ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
    ],
    [
      "nutrient_registry_lock_before_insert",
      "nutrient",
      "lock_active_nutrient_registry_before_write",
      "CREATE TRIGGER nutrient_registry_lock_before_insert BEFORE INSERT ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
    ],
    [
      "recipe_ingredient_reconcile_v2",
      "recipe_ingredient",
      "reconcile_recipe_components_v2",
      "CREATE CONSTRAINT TRIGGER recipe_ingredient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_ingredient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    ],
    [
      "recipe_nutrient_reconcile_v2",
      "recipe_version_nutrient",
      "reconcile_recipe_components_v2",
      "CREATE CONSTRAINT TRIGGER recipe_nutrient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_nutrient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    ],
    [
      "recipe_source_reconcile_v2",
      "recipe_version_source",
      "reconcile_recipe_components_v2",
      "CREATE CONSTRAINT TRIGGER recipe_source_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    ],
    [
      "recipe_version_components_reconcile_v2",
      "recipe_version",
      "reconcile_recipe_components_v2",
      "CREATE CONSTRAINT TRIGGER recipe_version_components_reconcile_v2 AFTER INSERT ON recipe_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    ],
  ].map(([name, tableName, functionName, definition]) => ({
    definition,
    enabled: "O",
    function_arguments: "",
    function_name: functionName,
    function_schema: "public",
    name,
    table_schema: "public",
    table_name: tableName,
  }));
}

function validDatabaseBoundary() {
  return {
    acl: [
      acl("PUBLIC", "TEMPORARY"),
      acl(expectedOwner, "CONNECT"),
      acl(expectedOwner, "CREATE"),
      acl(expectedOwner, "TEMPORARY"),
    ],
    effectiveConnectRoles: [expectedOwner],
    otherClientSessions: "0",
    owner: expectedOwner,
  };
}

function restoreOptions() {
  return {
    connectAllowlist: [expectedOwner],
    container: "postgres-test-1",
    dumpDirectory: "/dev/shm",
    dumpProtection: "tmpfs",
    expectedOwner,
    sourceDatabase: "nutrition_source",
    targetDatabase: "nutrition_restore_ci_orchestration",
    user: "nutrition",
  };
}

function validDumpAttestation(dumpPath) {
  return {
    executorGid: "0",
    executorUid: "0",
    fileType: "regular file",
    linkCount: "1",
    mode: "600",
    mountType: "tmpfs",
    ownerGid: "0",
    ownerUid: "0",
    resolvedArtifact: dumpPath,
    resolvedDirectory: "/dev/shm",
  };
}

function dumpAttestationOutput(attestation) {
  return `${[
    attestation.resolvedDirectory,
    attestation.mountType,
    attestation.resolvedArtifact,
    attestation.ownerUid,
    attestation.ownerGid,
    attestation.mode,
    attestation.linkCount,
    attestation.fileType,
    attestation.executorUid,
    attestation.executorGid,
  ].join("\n")}\n`;
}

function authorityEvidenceRunner(evidence, failures = {}) {
  const calls = [];
  const dumpPath = "/dev/shm/nutrition_restore_ci_orchestration.dump";
  const boundary = validDatabaseBoundary();
  const run = (_command, arguments_) => {
    calls.push(arguments_);
    const commandText = arguments_.join(" ");
    const sql = arguments_.at(-1) ?? "";

    if (arguments_.includes("restore-dump-preflight")) return "/dev/shm\n";
    if (arguments_.includes("restore-dump-artifact")) {
      return dumpAttestationOutput(validDumpAttestation(dumpPath));
    }
    if (arguments_.includes("restore-dump-cleanup")) {
      if (failures.cleanupError) throw failures.cleanupError;
      return "";
    }
    if (arguments_.includes("sha256sum")) return `${"a".repeat(64)}  ${dumpPath}\n`;
    if (commandText.includes("pg_dump") || arguments_.includes("createdb")) return "";
    if (arguments_.includes("pg_restore")) return "";
    if (arguments_.slice(-4).join(" ") === `rm -f -- ${dumpPath}`) return "";

    if (sql.includes("set role")) {
      if (failures.policyError) throw failures.policyError;
      return "";
    }
    if (sql.includes("select count(*) from pg_database")) return "0\n";
    if (sql.includes("database_acl")) return `${JSON.stringify(boundary.acl)}\n`;
    if (sql.includes("has_database_privilege")) {
      return `${JSON.stringify(boundary.effectiveConnectRoles)}\n`;
    }
    if (sql.includes("pg_stat_activity")) return `${boundary.otherClientSessions}\n`;
    if (sql.includes("pg_get_userbyid(database_row.datdba)")) return `${boundary.owner}\n`;
    if (sql.includes("authority_constraint_policy")) {
      return `${JSON.stringify(evidence.authorityConstraints)}\n`;
    }
    if (sql.includes("authority_frozen_column_policy")) {
      return `${JSON.stringify(evidence.authorityFrozenColumns)}\n`;
    }
    if (sql.includes("authority_index_policy")) {
      return `${JSON.stringify(evidence.authorityIndexes)}\n`;
    }
    if (sql.includes("column_acl_policy")) return `${JSON.stringify(evidence.columnAcls)}\n`;
    if (sql.includes("default_policy")) return `${JSON.stringify(evidence.defaultAcls)}\n`;
    if (sql.includes("explicit_column_acl_attribute_count")) {
      return `${evidence.explicitColumnAclAttributeCount}\n`;
    }
    if (sql.includes("function_policy")) return `${JSON.stringify(evidence.functions)}\n`;
    if (sql.includes("relation_policy")) return `${JSON.stringify(evidence.relations)}\n`;
    if (sql.includes("role_policy")) return `${JSON.stringify(evidence.roles)}\n`;
    if (sql.includes("schema_policy")) return `${JSON.stringify(evidence.schema)}\n`;
    if (sql.includes("trigger_policy")) return `${JSON.stringify(evidence.triggers)}\n`;
    if (sql.includes("type_policy")) return `${JSON.stringify(evidence.types)}\n`;
    if (sql.includes("from public.app_schema_migration")) {
      return `${failures.publicMigrationLedger ?? TRACKED_MIGRATION_LEDGER_JSON}\n`;
    }
    if (sql.includes("revoke connect")) return "";
    throw new Error(`Unexpected mocked restore command: ${commandText}`);
  };
  return { calls, run };
}

function authorityFunction(evidence) {
  const functionPolicy = evidence.functions.find(
    (entry) => entry.name === "catalogue_record_import_approval",
  );
  if (!functionPolicy) throw new Error("Catalogue approval function fixture is missing");
  return functionPolicy;
}

function approvalGuardFunction(evidence) {
  const guardFunction = evidence.functions.find(
    (entry) => entry.name === "guard_food_import_approval_authority",
  );
  if (!guardFunction) throw new Error("Approval guard function fixture is missing");
  return guardFunction;
}

function authorityFunctionNamed(evidence, functionName) {
  const functionPolicy = evidence.functions.find((entry) => entry.name === functionName);
  if (!functionPolicy) throw new Error(`Authority function fixture ${functionName} is missing`);
  return functionPolicy;
}

function acl(grantee, privilege, grantor = expectedOwner) {
  return { grantee, grantor, grantable: false, privilege };
}
