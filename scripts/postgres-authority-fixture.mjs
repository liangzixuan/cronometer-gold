import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canonicalizeRestoreAuthorityEvidence,
  RESTORE_AUTHORITY_POLICY_SHA256,
  RESTORE_EVIDENCE_QUERIES,
  RESTORE_EVIDENCE_VIEW_QUERIES,
  TRACKED_MIGRATION_LEDGER_JSON,
} from "./postgres-restore-drill.mjs";

/** Pure controlled authority/collector data. It grants no database or operational acceptance. */
export function postgresAuthorityFixture(expectedOwner = "nutrition_owner") {
  assert(/^[a-z][a-z0-9_]{0,62}$/u.test(expectedOwner));
  const pagedAuthorityPolicy = JSON.parse(
    readFileSync(
      new URL("../packages/db/src/catalogue-paged-authority-policy.json", import.meta.url),
      "utf8",
    ),
  );

  const capabilityRoles = [
    "nutrition_catalogue_stage",
    "nutrition_catalogue_validate",
    "nutrition_catalogue_approve_data",
    "nutrition_catalogue_approve_quality",
    "nutrition_catalogue_approve_rights",
    "nutrition_catalogue_promote_activate",
    "nutrition_catalogue_rollback",
  ];
  const approvalAuthorityConstraintDefinition =
    "CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND principal_id = database_principal AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =\nCASE approval_role\n    WHEN 'data'::text THEN 'nutrition_catalogue_approve_data'::text\n    WHEN 'quality'::text THEN 'nutrition_catalogue_approve_quality'::text\n    WHEN 'rights'::text THEN 'nutrition_catalogue_approve_rights'::text\n    ELSE NULL::text\nEND) IS TRUE)";
  const activationAuthorityConstraintDefinition =
    "CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND performed_by = database_principal AND database_capability_role IS NOT NULL AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =\nCASE\n    WHEN import_batch_id IS NOT NULL AND operation = 'activate'::text THEN 'nutrition_catalogue_promote_activate'::text\n    WHEN import_batch_id IS NULL AND (operation = ANY (ARRAY['deactivate'::text, 'rollback'::text])) THEN 'nutrition_catalogue_rollback'::text\n    ELSE NULL::text\nEND) IS TRUE)";
  const stageValidateAuthorityConstraintDefinition =
    "CHECK ((staged_database_principal IS NULL AND staged_database_capability_role IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR staged_database_principal IS NOT NULL AND octet_length(staged_database_principal) >= 1 AND octet_length(staged_database_principal) <= 63 AND staged_database_capability_role = 'nutrition_catalogue_stage'::text AND (validated_at IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR validated_at IS NOT NULL AND validated_database_principal IS NOT NULL AND octet_length(validated_database_principal) >= 1 AND octet_length(validated_database_principal) <= 63 AND validated_database_capability_role = 'nutrition_catalogue_validate'::text)) IS TRUE)";
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
  const referenceIntegrityConstraints = [
    {
      constraint_type: "c",
      definition_sha256: "872d15549977d02b3df53796476046edf9729b2d9ebbbfc88e219d0a1006785f",
      name: "nutrition_goal_target_reference_metadata_v1",
      table_name: "nutrition_goal_target",
      validated: true,
    },
    {
      constraint_type: "c",
      definition_sha256: "563e297e091034e9f88bac6835c14a75751be826673e84d0bef563538a3d82f9",
      name: "nutrition_goal_version_reference_identity_v1",
      table_name: "nutrition_goal_version",
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

  function validAuthorityEvidence() {
    return {
      authorityConstraints: structuredClone([
        ...authorityConstraints,
        ...pagedAuthorityPolicy.constraints.map((entry) => ({
          constraint_type: entry.constraintType,
          definition: entry.definition,
          name: entry.name,
          table_name: entry.tableName,
          validated: entry.validated,
        })),
      ]).sort((left, right) => (left.name < right.name ? -1 : left.name === right.name ? 0 : 1)),
      authorityFrozenColumns: structuredClone([
        ...authorityFrozenColumns.map((column) => ({
          identity_kind: "",
          generated_kind: "",
          ...column,
        })),
        ...pagedAuthorityPolicy.columns.map((entry) => ({
          identity_kind: entry.identityKind,
          generated_kind: entry.generatedKind,
          column_name: entry.columnName,
          data_type: entry.dataType,
          default_expression: entry.defaultExpression,
          not_null: entry.notNull,
          schema_name: entry.schemaName,
          table_name: entry.tableName,
        })),
      ]).sort(
        (left, right) =>
          left.table_name.localeCompare(right.table_name) ||
          left.column_name.localeCompare(right.column_name),
      ),
      authorityIndexes: structuredClone([
        ...authorityIndexes,
        ...pagedAuthorityPolicy.indexes.map((entry) => ({
          access_method: entry.accessMethod,
          definition: entry.definition,
          is_primary: entry.isPrimary,
          is_ready: entry.isReady,
          is_unique: entry.isUnique,
          is_valid: entry.isValid,
          key_attribute_count: entry.keyAttributeCount,
          key_expression: entry.keyExpression,
          name: entry.name,
          owner: expectedOwner,
          predicate: entry.predicate,
          schema_name: entry.schemaName,
          table_name: entry.tableName,
          total_attribute_count: entry.totalAttributeCount,
        })),
      ]).sort(
        (left, right) =>
          left.table_name.localeCompare(right.table_name) || left.name.localeCompare(right.name),
      ),
      columnAcls: [],
      defaultAcls: [],
      explicitColumnAclAttributeCount: "0",
      functions: validAuthorityFunctions(),
      relations: [
        {
          name: "promoted_food_search_catalogue_v1",
          kind: "v",
          owner: expectedOwner,
          acl_is_default: true,
          acl: [acl(expectedOwner, "SELECT")],
        },
        ...pagedAuthorityPolicy.tables.map((name) => ({
          acl: [
            "DELETE",
            "INSERT",
            "MAINTAIN",
            "REFERENCES",
            "SELECT",
            "TRIGGER",
            "TRUNCATE",
            "UPDATE",
          ].map((privilege) => acl(expectedOwner, privilege)),
          acl_is_default: false,
          kind: "r",
          name,
          owner: expectedOwner,
        })),
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
      referenceIntegrityConstraints: structuredClone(referenceIntegrityConstraints),
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
      authorityViews: [
        {
          name: "promoted_food_search_catalogue_v1",
          sourceSha256: "9fc070d1ac2427474187c4a035f77e7e5729ae867d0243202dd7fd1896c20f73",
          definitionMatches: true,
          options: [],
        },
      ],
      version: 16,
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
        "d9e807d9655adec93c649c5c9ee896de182c76a8d6ade0f7d9f01d1cf9b148bb",
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
        "reconcile_goal_reference_vector_v1",
        "cab5878b72b7aaaf94b7c7b50e39f6114e992afc395036e56418465fa67ed123",
      ],
      [
        "reconcile_recipe_components_v2",
        "bd19e74f953196ffeb733c466bdf6f3a46a903d5a86f0121b5ba0af588af7128",
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
      ...pagedAuthorityPolicy.functions.map((entry) => ({
        language: entry.language,
        leakproof: entry.leakproof,
        parallel: entry.parallel,
        result_type: entry.resultType,
        source_sha256: entry.sourceSha256,
        strict: entry.strict,
        volatility: entry.volatility,
        acl: [
          expectedOwner,
          ...(entry.executeGrantees === "owner-only"
            ? []
            : entry.executeGrantees === "default"
              ? ["PUBLIC"]
              : entry.executeGrantees),
        ].map((grantee) => acl(grantee, "EXECUTE")),
        acl_is_default: entry.executeGrantees === "default",
        arguments: entry.arguments,
        config:
          entry.configuration === "application-schema"
            ? ["search_path=pg_catalog, public, pg_temp"]
            : [],
        name: entry.name,
        owner: expectedOwner,
        security_definer: entry.securityDefiner,
      })),
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
          "3b6b5d6de655e09c4935379fbaa356429961dedb39264cb25913e16c3a2c2e59",
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
          "e7dbe4dc44ca8cef1183b966384000a3a252e4f92cc644091d46281e04d91822",
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
          "b0e547a757ad01f0a2c2360beea10607b5bfec9770fbbeb571598db7cf9ead69",
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
          "feb716548ef14da6dace4c12fd18b98d462766a9a59de0d71aff1b5b9c606ae3",
          "jsonb",
        ),
        acl: [
          acl(expectedOwner, "EXECUTE"),
          acl("nutrition_catalogue_promote_activate", "EXECUTE"),
        ],
        acl_is_default: false,
        arguments: "p_batch_id uuid, p_external_principal_id text, p_reason text",
        config: ["search_path=pg_catalog, public, pg_temp"],
        name: "catalogue_promote_import_batch",
        owner: expectedOwner,
        security_definer: true,
      },
      {
        ...functionSemantics(
          "95960c2b7a1a534fc006c07166638f98d5f558d0fa715662361f19bfda17b2b7",
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
          "e20221d5b0840248f0c8f97f56ff92f3d4a8a72aaddb8834a6258d92ce183aed",
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
          "9dfaa30970c3acfaaff6a1c1c4211cfd0b42c87824998841172429c4dcd5138f",
          "boolean",
        ),
        acl: [acl(expectedOwner, "EXECUTE")],
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
          "57a131aea73ba58d76f8d7cd867ea2cb2485567f65dc4c28c5a9ffe8963ca198",
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
          "b9bda857bcce39b37ee33728198fe8d15b112792fc9c1cb33c921a6ab1113d21",
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
          "be0b69606769894428896f4dac560ec59d7e58306d5c32bb533aa95561d539be",
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
          "59f39588711cb8c97d8178ad0d6992b531a12be8a9101924687e5718b282c806",
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
          "53771f5e5417fb1efc5fd42d2696def09a6fdb5e1540b93b80a38a42f2caeb6b",
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
          "70a9be43d627d15d456a5ba7c2af3da9527d6251c70089ac89ae419b5812e0c7",
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
          "e57096da8349e9efa58cdcc7293b36a895731a35ce7c8ad1dc55c1f4b4db9b66",
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
          "2a063eec6e102d0f69931b6f8a26d7179071e19fdd145e9039150a6ed35e6532",
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
          "8bdfb048a53a741ed7967c19c65669107753d66d1e5174bde7aeff32110ea599",
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
      ...pagedAuthorityPolicy.triggers.map((entry) => [
        entry.name,
        entry.tableName,
        entry.functionName,
        entry.definition,
      ]),
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
        "nutrition_goal_reference_vector_from_target_v1",
        "nutrition_goal_target",
        "reconcile_goal_reference_vector_v1",
        "CREATE CONSTRAINT TRIGGER nutrition_goal_reference_vector_from_target_v1 AFTER INSERT OR DELETE ON nutrition_goal_target DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_goal_reference_vector_v1()",
      ],
      [
        "nutrition_goal_reference_vector_from_version_v1",
        "nutrition_goal_version",
        "reconcile_goal_reference_vector_v1",
        "CREATE CONSTRAINT TRIGGER nutrition_goal_reference_vector_from_version_v1 AFTER INSERT ON nutrition_goal_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_goal_reference_vector_v1()",
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

  function acl(grantee, privilege, grantor = expectedOwner) {
    return { grantee, grantor, grantable: false, privilege };
  }

  function completeBackupEvidence({ observedAuthority, tableCounts } = {}) {
    const authority = structuredClone(observedAuthority ?? validAuthorityEvidence());
    const authorityFingerprint = canonicalizeRestoreAuthorityEvidence(authority);
    return {
      authorityFingerprint,
      authorityFingerprintSha256: createHash("sha256").update(authorityFingerprint).digest("hex"),
      authorityPolicySha256: RESTORE_AUTHORITY_POLICY_SHA256,
      migrationLedger: TRACKED_MIGRATION_LEDGER_JSON,
      tableCounts: new Map(
        tableCounts ??
          authority.relations
            .filter(({ kind }) => kind === "r" || kind === "p")
            .map(({ name }, index) => [name, String(index)]),
      ),
      unvalidatedConstraints: "0",
    };
  }

  function sharedCollectorAdapter({
    mutateEvidence = () => undefined,
    respond,
    onQuery,
    observedAuthority,
    tableCounts,
  } = {}) {
    const source = completeBackupEvidence({ observedAuthority, tableCounts });
    const authority = JSON.parse(source.authorityFingerprint);
    mutateEvidence(authority);
    const calls = [];
    const temporary = new Map();
    const identity = {
      backend: "1234",
      database: "nutrition",
      principal: expectedOwner,
      sessionPrincipal: expectedOwner,
      isolation: "repeatable read",
      readOnly: "on",
      snapshot: "100:110:105",
      transactionStartedAt: "2026-09-30 00:00:00+00",
      virtualTransaction: "3/21",
    };
    let phase = "idle";
    let inFlight = 0;
    let maximumInFlight = 0;
    const query = async (config) => {
      const call = { ...config, values: [...config.values], phase };
      calls.push(call);
      maximumInFlight = Math.max(maximumInFlight, ++inFlight);
      try {
        if (onQuery) await onQuery(call);
        let result;
        if (config.text === "begin read write") {
          phase = "prepare";
          result = { rows: [] };
        } else if (config.text === "rollback") {
          phase = "idle";
          temporary.clear();
          result = { rows: [] };
        } else if (config.text.startsWith("set local ")) result = { rows: [] };
        else if (config.text.includes("json_build_object('backend'")) {
          const observed = {
            ...identity,
            readOnly: phase === "prepare" ? "off" : identity.readOnly,
          };
          if (!config.text.includes("virtualTransaction")) delete observed.virtualTransaction;
          result = { rows: [[JSON.stringify(observed)]] };
        } else if (config.text.startsWith("create temporary view ")) {
          const name = config.text.split(" ")[3];
          const expected = RESTORE_EVIDENCE_VIEW_QUERIES.find((entry) =>
            config.text.endsWith(` as ${entry.query};`),
          );
          assert.ok(expected, "temporary view uses an exact reviewed query");
          temporary.set(`pg_temp.${name}`, `normalized:${expected.name}`);
          result = { rows: [] };
        } else if (config.text === "select pg_catalog.pg_get_viewdef($1::regclass,false)") {
          result = { rows: [[temporary.get(config.values[0])]] };
        } else if (
          config.text.startsWith("select pg_catalog.set_config('nutrition.expected_restore_owner'")
        ) {
          result = { rows: [[config.values[0]]] };
        } else if (config.text.startsWith("select pg_catalog.json_build_object('definition'")) {
          const view = authority.authorityViews.find((entry) => entry.name === config.values[0]);
          result = view
            ? {
                rows: [
                  [
                    JSON.stringify({
                      definition: `normalized:${view.name}`,
                      options: view.options,
                    }),
                  ],
                ],
              }
            : { rows: [] };
        } else {
          const entry = Object.entries(RESTORE_EVIDENCE_QUERIES).find(
            ([, value]) => value.parts.join(" ") === config.text,
          );
          if (entry)
            result = {
              rows: [
                [
                  entry[1].kind === "json"
                    ? JSON.stringify(authority[entry[0]])
                    : authority[entry[0]],
                ],
              ],
            };
          else if (config.text.includes("json_agg(row_to_json(m)"))
            result = { rows: [[source.migrationLedger]] };
          else if (config.text === "select count(*) from pg_constraint where not convalidated")
            result = { rows: [[source.unvalidatedConstraints]] };
          else if (config.text.includes("string_agg(tablename"))
            result = { rows: [[[...source.tableCounts.keys()].sort().join(",")]] };
          else {
            const table = config.text.match(
              /^select count\(\*\) from public\."([a-z0-9_]+)"$/u,
            )?.[1];
            assert.ok(table, "only reviewed evidence SQL executes");
            result = { rows: [[source.tableCounts.get(table)]] };
          }
        }
        return respond ? await respond(call, result) : result;
      } finally {
        inFlight--;
      }
    };
    return {
      query,
      calls,
      source,
      identity,
      snapshot() {
        phase = "collect";
      },
      get maximumInFlight() {
        return maximumInFlight;
      },
      get inFlight() {
        return inFlight;
      },
    };
  }

  return {
    pagedAuthorityPolicy,
    expectedOwner,
    authorityConstraints,
    referenceIntegrityConstraints,
    authorityFrozenColumns,
    authorityIndexes,
    validAuthorityEvidence,
    validAuthorityFunctions,
    validAuthorityTriggers,
    acl,
    completeBackupEvidence,
    sharedCollectorAdapter,
  };
}

export const {
  pagedAuthorityPolicy,
  expectedOwner,
  authorityConstraints,
  referenceIntegrityConstraints,
  authorityFrozenColumns,
  authorityIndexes,
  validAuthorityEvidence,
  validAuthorityFunctions,
  validAuthorityTriggers,
  acl,
  completeBackupEvidence,
  sharedCollectorAdapter,
} = postgresAuthorityFixture();
