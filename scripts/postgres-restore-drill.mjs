import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
const MIGRATION_DIRECTORY = new URL("../packages/db/migrations/", import.meta.url);
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const EXPECTED_AUTHORITY_POLICY_SHA256 =
  "2f8e3034057c482cf4e9ec6891aed7f613480795e58ec1dc6a31d1e9ae377646";
const CAPABILITY_ROLES = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
];
const PINNED_AUTHORITY_SEARCH_PATH = ["search_path=pg_catalog, public, pg_temp"];
const ACTIVATION_AUTHORITY_CONSTRAINT_DEFINITION =
  "CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND database_capability_role IS NOT NULL AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =\nCASE\n    WHEN import_batch_id IS NOT NULL AND operation = 'activate'::text THEN 'nutrition_catalogue_promote_activate'::text\n    WHEN import_batch_id IS NULL AND (operation = ANY (ARRAY['deactivate'::text, 'rollback'::text])) THEN 'nutrition_catalogue_rollback'::text\n    ELSE NULL::text\nEND) IS TRUE)";
const STAGE_VALIDATE_AUTHORITY_CONSTRAINT_DEFINITION =
  "CHECK ((staged_database_principal IS NULL AND staged_database_capability_role IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR staged_database_principal IS NOT NULL AND octet_length(staged_database_principal) >= 1 AND octet_length(staged_database_principal) <= 63 AND staged_database_capability_role = 'nutrition_catalogue_stage'::text AND (validated_at IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR validated_at IS NOT NULL AND validated_database_principal IS NOT NULL AND octet_length(validated_database_principal) >= 1 AND octet_length(validated_database_principal) <= 63 AND validated_database_capability_role = 'nutrition_catalogue_validate'::text AND validated_database_principal <> staged_database_principal)) IS TRUE)";
const STAGING_SEAL_CONSTRAINT_DEFINITION =
  "CHECK ((staging_seal_sha256 IS NULL AND staging_sealed_at IS NULL OR staging_seal_sha256 ~ '^[0-9a-f]{64}$'::text AND staging_sealed_at IS NOT NULL AND (staging_sealed_at <> ALL (ARRAY['-infinity'::timestamp with time zone, 'infinity'::timestamp with time zone]))) IS TRUE AND (validated_at IS NULL OR staged_database_principal IS NULL OR staging_seal_sha256 IS NOT NULL))";
const BATCH_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION =
  "CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (status = ANY (ARRAY['quarantined'::text, 'ready'::text, 'promoting'::text, 'completed'::text]))) IS TRUE)";
const RECORD_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION =
  "CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (validation_status = ANY (ARRAY['quarantined'::text, 'valid'::text, 'materialized'::text]))) IS TRUE)";
const AUTHORITY_CONSTRAINT_POLICY = [
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
    definition: BATCH_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION,
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
    definition: STAGE_VALIDATE_AUTHORITY_CONSTRAINT_DEFINITION,
    name: "food_import_batch_stage_validate_database_authority_check",
    table_name: "food_import_batch",
    validated: true,
  },
  {
    constraint_type: "c",
    definition: STAGING_SEAL_CONSTRAINT_DEFINITION,
    name: "food_import_batch_staging_seal_check",
    table_name: "food_import_batch",
    validated: true,
  },
  {
    constraint_type: "c",
    definition: RECORD_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION,
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
    definition: ACTIVATION_AUTHORITY_CONSTRAINT_DEFINITION,
    name: "food_source_release_activation_database_authority_check",
    table_name: "food_source_release_activation",
    validated: true,
  },
];
const AUTHORITY_FROZEN_COLUMN_POLICY = [
  {
    column_name: "nutrient_mapping_digest",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "nutrient_mapping_revision_ids",
    data_type: "jsonb",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "nutrition_semantic_contract_version",
    data_type: "smallint",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "nutrition_semantic_sha256",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "staged_database_capability_role",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "staged_database_principal",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "staging_seal_sha256",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "staging_sealed_at",
    data_type: "timestamp with time zone",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "validated_database_capability_role",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "validated_database_principal",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "validated_food_contract_version",
    data_type: "smallint",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_batch",
  },
  {
    column_name: "nutrition_semantic_contract_version",
    data_type: "smallint",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_record",
  },
  {
    column_name: "nutrition_semantic_sha256",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_record",
  },
  {
    column_name: "validated_food_contract_version",
    data_type: "smallint",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_record",
  },
  {
    column_name: "validated_food_document",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_record",
  },
  {
    column_name: "validated_food_sha256",
    data_type: "text",
    default_expression: null,
    not_null: false,
    schema_name: "public",
    table_name: "food_import_record",
  },
];
const AUTHORITY_INDEX_POLICY = [
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
    predicate: "import_batch_id IS NOT NULL",
    schema_name: "public",
    table_name: "food_source_release_activation",
    total_attribute_count: 1,
  },
];
const PROTECTED_CATALOGUE_TABLES = new Set([
  "food",
  "food_barcode",
  "food_import_approval",
  "food_import_batch",
  "food_import_checkpoint",
  "food_import_parser_report",
  "food_import_record",
  "food_nutrient_value",
  "food_search_projection_revision",
  "food_serving",
  "food_source",
  "food_source_release",
  "food_source_release_activation",
  "food_version",
  "outbox_event",
]);
const DEFAULT_AUTHORITY_FUNCTION_POLICY = {
  arguments: "",
  config: PINNED_AUTHORITY_SEARCH_PATH,
  executeGrantees: "default",
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
    "advance_food_search_projection_revision",
    {
      arguments: "",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "default",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "void",
      securityDefiner: false,
      sourceSha256: "d1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_attest_import_nutrition_semantics",
    {
      arguments: "p_batch_id uuid",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "e2c35dfabb653636a9640475227104a485a24129558b11511175831ef9bc5b8b",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_canonical_decimal_product",
    {
      arguments: "p_left text, p_right text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "plpgsql",
      leakproof: false,
      parallel: "s",
      resultType: "text",
      securityDefiner: false,
      sourceSha256: "299a2c88226123f167fe2d7001fdaf6a2e02425007f2426c8def9d0bb83a46c0",
      strict: true,
      volatility: "i",
    },
  ],
  [
    "catalogue_compute_import_staging_seal",
    {
      arguments: "p_batch_id uuid",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "text",
      securityDefiner: true,
      sourceSha256: "399d40c2913c2022c0a2921d5870a2d26a5dcd9949d81715882f70899db4f5f8",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_compute_record_nutrition_semantics",
    {
      arguments: "p_record_id bigint",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "41f048090dce80b794615f135f5368f7f501eaecfc3513471eb6d1f36c022783",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_evidence_bundle_uri_is_valid",
    {
      arguments: "value text, digest text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "default",
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
    "catalogue_observe_import_validation",
    {
      arguments: "p_batch_id uuid",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: ["nutrition_catalogue_validate"],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "0a87bc99f5df97282c48b6202799bcc75cdb914e7473c0c38e092aaf4a132acf",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_promote_import_batch",
    {
      arguments: "p_batch_id uuid, p_external_principal_id text, p_reason text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: ["nutrition_catalogue_promote_activate"],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "309861b6850a99bb565466981602ee19054b9c2500dfee21bf27edc6be382111",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_promote_import_batch_v1",
    {
      arguments: "p_batch_id uuid, p_external_principal_id text, p_reason text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "115fdc3ed1943dd77ce70d3a694495da3d2c62ade9c7b82812a89cef82b39f17",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_record_import_approval",
    {
      arguments:
        "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: [
        "nutrition_catalogue_approve_data",
        "nutrition_catalogue_approve_quality",
        "nutrition_catalogue_approve_rights",
      ],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "boolean",
      securityDefiner: true,
      sourceSha256: "abb0ca990b74fedffd4ec77cf666e404da89af8158f4b990b6c0de48cd3dfc41",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_record_import_approval_v1",
    {
      arguments:
        "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
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
    "catalogue_rollback_source_release",
    {
      arguments:
        "p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: ["nutrition_catalogue_rollback"],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "56e9fa2cce7f532c1f405658ff9f07908394d0fb9734b70d0bdb92a12292068a",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_rollback_source_release_v1",
    {
      arguments:
        "p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "3fe493ee5e0b27e43cc881854dddfe4dc12f862a1c4a242bf712c843b2792ff1",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_stage_import_batch",
    {
      arguments: "p_stage_document text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: ["nutrition_catalogue_stage"],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "11b0a983c9cf3d4a7451978d37e5fe997a40290a10e741ba0626b89bfd2611c4",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_stage_import_parser_report",
    {
      arguments: "p_batch_id uuid, p_parser_report_document text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: ["nutrition_catalogue_stage"],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "d89defb335e21228c38968ef69b2ed7342f5a5440762ae31f170969fbcc9c9e8",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_stage_import_record_chunk",
    {
      arguments: "p_batch_id uuid, p_expected_next_offset bigint, p_records_document text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: ["nutrition_catalogue_stage"],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "4cc2b310ba6fda051a125bb203c0cf2c6a5fbe227a55daf517a0376ab79e4c7f",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_utf16_length",
    {
      arguments: "p_value text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "sql",
      leakproof: false,
      parallel: "s",
      resultType: "bigint",
      securityDefiner: false,
      sourceSha256: "3a1759986b190b3ccac086e5da943ada91f3cc8c3a94ce6942657faae389ef39",
      strict: true,
      volatility: "i",
    },
  ],
  [
    "catalogue_validate_import_batch",
    {
      arguments:
        "p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: ["nutrition_catalogue_validate"],
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "10c59084d8e5c7debb581c6e749f6779dbc3f5867fc4cb18ffc009293f9f50a5",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "catalogue_validate_import_batch_v1",
    {
      arguments:
        "p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "owner-only",
      language: "plpgsql",
      leakproof: false,
      parallel: "u",
      resultType: "jsonb",
      securityDefiner: true,
      sourceSha256: "5b7ae15625fb0ae0d88a9512fe82fca69a9d0dd9e179af8bc1b2f42d1e85ac8a",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "enqueue_food_search_barcode_insert",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "4e888f3ef0b3af1e7eee14568069ae3fe06b65b88718614ed0e2c243a5d22318",
    },
  ],
  [
    "enqueue_food_search_barcode_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "9d7a90d0fee1a6923631c9b9018d9c813d3c8f7eea2df941fc32fbb4f5d453b0",
    },
  ],
  [
    "enqueue_food_search_food_eligibility_change",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "85ada305a6fd6b40cd5fb0652d64c240d1953033a243b0f7ce243caa9bc9c4de",
    },
  ],
  [
    "enqueue_food_search_serving_insert",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "223f2d1dc8f90c6bc04c4d85ec763bcb50727473f5576b0bcdbbf394c1c9d804",
    },
  ],
  [
    "enqueue_food_search_source_eligibility_change",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "3a88f24e4863d8150db21f93efadd528ea5d7811b5c79c6ff5cd38fdcb93ce87",
    },
  ],
  [
    "guard_active_nutrient_vector_size",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda",
    },
  ],
  [
    "guard_food_import_approval_authority",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      executeGrantees: "owner-only",
      sourceSha256: "f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd",
    },
  ],
  [
    "guard_custom_food_child_insert_v3",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "f2fc5d7cc06759696b2656f921d57502326ab4efbd6fe1b1554143b117152d88",
    },
  ],
  [
    "guard_custom_food_immutable_evidence_v3",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "5e450518bc31811221ad64826f6879b177ecec760d88abd0353b14c4aebe3317",
    },
  ],
  [
    "guard_imported_food_version_child_delete",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "4e36d3ee5cbd53dc6c98d9f457adbb5ee8cb6cbf8fc6b3e45d3133b4305e7cc1",
    },
  ],
  [
    "guard_food_barcode_validity_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "7b97f95dd7388565424bd3713081711106a5e3d0c206310a8d405b8772208ecc",
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
    "guard_food_import_batch_nutrition_semantics",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      executeGrantees: "owner-only",
      sourceSha256: "298b898cd252f08aa9a5f212e85750aeba79cc41616c71afcd3f129471a6cf5c",
    },
  ],
  [
    "guard_food_import_batch_stage_validate_authority",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      executeGrantees: "owner-only",
      sourceSha256: "f21dfa9d5455a40ab9f50bdbace02ffc19f53ab252e0eab99a4f50769f678eda",
    },
  ],
  [
    "guard_food_import_batch_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "8863eef0e6889a620deec204e249ac3d6efdc87310dcc9d25601e6d7f336101f",
    },
  ],
  [
    "guard_food_import_batch_validation_digest",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "c94c16cef462dfaca5c58908c2784e6d86b9f415c1c081f7b6c8a5ca434bddd7",
    },
  ],
  [
    "guard_food_import_record_insert_before_staging_seal",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      executeGrantees: "owner-only",
      sourceSha256: "2fc46ef24e03309e61832491438746967642911b02e97896f8a0bdf6fc5aa8bc",
    },
  ],
  [
    "guard_food_import_record_nutrition_semantics",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      executeGrantees: "owner-only",
      sourceSha256: "489c1c4b970c6ba369503854701c980ebcb1510c754050e78355fed94647e0e8",
    },
  ],
  [
    "guard_food_import_record_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "300e6853e7a9520b477256b3b32a4381f3143512b013a4e131a4c203ce524479",
    },
  ],
  [
    "guard_food_import_stage_checkpoint_before_staging_seal",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      executeGrantees: "owner-only",
      sourceSha256: "66e2078cf57d658268f547c25df26750ebe5b7b6402de9fcecdc2249c14f28ef",
    },
  ],
  [
    "guard_food_source_release_activation_authority",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      executeGrantees: "owner-only",
      sourceSha256: "d46f53aeffa6469eada5461ab59bd9c23d43bf9aab77704c61b21c44291ae028",
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
    "guard_source_barcode_delete",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "d4bea8e773166f82f291f1d89b20a7cfb52e2d8416ba80bb455642058d23e3cf",
    },
  ],
  [
    "lock_active_nutrient_registry_before_write",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de",
    },
  ],
  [
    "lock_active_nutrient_registry_for_read",
    {
      arguments: "",
      config: PINNED_AUTHORITY_SEARCH_PATH,
      executeGrantees: "default",
      language: "sql",
      leakproof: false,
      parallel: "u",
      resultType: "void",
      securityDefiner: false,
      sourceSha256: "22ab05f2e9749ecff7035e5188e1b9353d46533e7bc558748c76c43dbfc37ea5",
      strict: false,
      volatility: "v",
    },
  ],
  [
    "reconcile_recipe_components_v2",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a",
    },
  ],
  [
    "reject_new_legacy_unbound_catalogue_evidence",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e",
    },
  ],
  [
    "reject_immutable_row_update",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      config: [],
      sourceSha256: "631a42e27de6543bc09fd6b8d0f1b0fd336250270b47f13849a2483fd0786e6e",
    },
  ],
  [
    "set_row_updated_at",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "92fa7c305a8b856faea0575b27eaa33c1e39952cf9fe87b4c0cbf7d7eab556bd",
    },
  ],
  [
    "validate_food_version_child_insert",
    {
      ...DEFAULT_AUTHORITY_FUNCTION_POLICY,
      sourceSha256: "5362678168ed713e602e0fd87bc8b13dccd7817db1cf3d3470f09dcbe37e5f07",
    },
  ],
]);
const AUTHORITY_TRIGGER_POLICY = new Map([
  [
    "custom_food_nutrient_guard_delete_v3",
    {
      definition:
        "CREATE TRIGGER custom_food_nutrient_guard_delete_v3 BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
      functionName: "guard_custom_food_immutable_evidence_v3",
      tableName: "food_nutrient_value",
    },
  ],
  [
    "custom_food_nutrient_guard_insert_v3",
    {
      definition:
        "CREATE TRIGGER custom_food_nutrient_guard_insert_v3 BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()",
      functionName: "guard_custom_food_child_insert_v3",
      tableName: "food_nutrient_value",
    },
  ],
  [
    "custom_food_serving_guard_delete_v3",
    {
      definition:
        "CREATE TRIGGER custom_food_serving_guard_delete_v3 BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
      functionName: "guard_custom_food_immutable_evidence_v3",
      tableName: "food_serving",
    },
  ],
  [
    "custom_food_serving_guard_insert_v3",
    {
      definition:
        "CREATE TRIGGER custom_food_serving_guard_insert_v3 BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()",
      functionName: "guard_custom_food_child_insert_v3",
      tableName: "food_serving",
    },
  ],
  [
    "custom_food_version_guard_delete_v3",
    {
      definition:
        "CREATE TRIGGER custom_food_version_guard_delete_v3 BEFORE DELETE ON food_version FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
      functionName: "guard_custom_food_immutable_evidence_v3",
      tableName: "food_version",
    },
  ],
  [
    "food_barcode_guard_update",
    {
      definition:
        "CREATE TRIGGER food_barcode_guard_update BEFORE UPDATE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_food_barcode_validity_update()",
      functionName: "guard_food_barcode_validity_update",
      tableName: "food_barcode",
    },
  ],
  [
    "food_barcode_reject_delete",
    {
      definition:
        "CREATE TRIGGER food_barcode_reject_delete BEFORE DELETE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_source_barcode_delete()",
      functionName: "guard_source_barcode_delete",
      tableName: "food_barcode",
    },
  ],
  [
    "food_nutrient_value_reject_delete",
    {
      definition:
        "CREATE TRIGGER food_nutrient_value_reject_delete BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()",
      functionName: "guard_imported_food_version_child_delete",
      tableName: "food_nutrient_value",
    },
  ],
  [
    "food_nutrient_value_reject_update",
    {
      definition:
        "CREATE TRIGGER food_nutrient_value_reject_update BEFORE UPDATE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
      tableName: "food_nutrient_value",
    },
  ],
  [
    "food_nutrient_value_validate_insert",
    {
      definition:
        "CREATE TRIGGER food_nutrient_value_validate_insert BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()",
      functionName: "validate_food_version_child_insert",
      tableName: "food_nutrient_value",
    },
  ],
  [
    "food_serving_reject_delete",
    {
      definition:
        "CREATE TRIGGER food_serving_reject_delete BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()",
      functionName: "guard_imported_food_version_child_delete",
      tableName: "food_serving",
    },
  ],
  [
    "food_serving_reject_update",
    {
      definition:
        "CREATE TRIGGER food_serving_reject_update BEFORE UPDATE ON food_serving FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
      tableName: "food_serving",
    },
  ],
  [
    "food_serving_validate_insert",
    {
      definition:
        "CREATE TRIGGER food_serving_validate_insert BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()",
      functionName: "validate_food_version_child_insert",
      tableName: "food_serving",
    },
  ],
  [
    "food_set_updated_at",
    {
      definition:
        "CREATE TRIGGER food_set_updated_at BEFORE UPDATE ON food FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
      functionName: "set_row_updated_at",
      tableName: "food",
    },
  ],
  [
    "food_version_reject_update",
    {
      definition:
        "CREATE TRIGGER food_version_reject_update BEFORE UPDATE ON food_version FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
      tableName: "food_version",
    },
  ],
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
    "food_import_approval_reject_update",
    {
      definition:
        "CREATE TRIGGER food_import_approval_reject_update BEFORE DELETE OR UPDATE ON food_import_approval FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
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
    "food_import_batch_guard_nutrition_semantics",
    {
      definition:
        "CREATE TRIGGER food_import_batch_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_nutrition_semantics()",
      functionName: "guard_food_import_batch_nutrition_semantics",
      tableName: "food_import_batch",
    },
  ],
  [
    "food_import_batch_guard_stage_validate_authority",
    {
      definition:
        "CREATE TRIGGER food_import_batch_guard_stage_validate_authority BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_stage_validate_authority()",
      functionName: "guard_food_import_batch_stage_validate_authority",
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
    "food_import_checkpoint_guard_staging_seal",
    {
      definition:
        "CREATE TRIGGER food_import_checkpoint_guard_staging_seal BEFORE INSERT OR DELETE OR UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION guard_food_import_stage_checkpoint_before_staging_seal()",
      functionName: "guard_food_import_stage_checkpoint_before_staging_seal",
      tableName: "food_import_checkpoint",
    },
  ],
  [
    "food_import_checkpoint_set_updated_at",
    {
      definition:
        "CREATE TRIGGER food_import_checkpoint_set_updated_at BEFORE UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
      functionName: "set_row_updated_at",
      tableName: "food_import_checkpoint",
    },
  ],
  [
    "food_import_parser_report_reject_update",
    {
      definition:
        "CREATE TRIGGER food_import_parser_report_reject_update BEFORE DELETE OR UPDATE ON food_import_parser_report FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
      tableName: "food_import_parser_report",
    },
  ],
  [
    "food_import_record_guard_nutrition_semantics",
    {
      definition:
        "CREATE TRIGGER food_import_record_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_nutrition_semantics()",
      functionName: "guard_food_import_record_nutrition_semantics",
      tableName: "food_import_record",
    },
  ],
  [
    "food_import_record_guard_staging_seal",
    {
      definition:
        "CREATE TRIGGER food_import_record_guard_staging_seal BEFORE INSERT ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_insert_before_staging_seal()",
      functionName: "guard_food_import_record_insert_before_staging_seal",
      tableName: "food_import_record",
    },
  ],
  [
    "food_import_record_guard_update",
    {
      definition:
        "CREATE TRIGGER food_import_record_guard_update BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()",
      functionName: "guard_food_import_record_update",
      tableName: "food_import_record",
    },
  ],
  [
    "food_import_record_reject_delete",
    {
      definition:
        "CREATE TRIGGER food_import_record_reject_delete BEFORE DELETE ON food_import_record FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
      tableName: "food_import_record",
    },
  ],
  [
    "food_search_barcode_insert_outbox",
    {
      definition:
        "CREATE TRIGGER food_search_barcode_insert_outbox AFTER INSERT ON food_barcode REFERENCING NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()",
      functionName: "enqueue_food_search_barcode_insert",
      tableName: "food_barcode",
    },
  ],
  [
    "food_search_barcode_update_outbox",
    {
      definition:
        "CREATE TRIGGER food_search_barcode_update_outbox AFTER UPDATE ON food_barcode REFERENCING OLD TABLE AS old_food_search_barcodes NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_update()",
      functionName: "enqueue_food_search_barcode_update",
      tableName: "food_barcode",
    },
  ],
  [
    "food_search_eligibility_outbox",
    {
      definition:
        "CREATE TRIGGER food_search_eligibility_outbox AFTER UPDATE ON food REFERENCING OLD TABLE AS old_food_search_rows NEW TABLE AS new_food_search_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_food_eligibility_change()",
      functionName: "enqueue_food_search_food_eligibility_change",
      tableName: "food",
    },
  ],
  [
    "food_search_serving_insert_outbox",
    {
      definition:
        "CREATE TRIGGER food_search_serving_insert_outbox AFTER INSERT ON food_serving REFERENCING NEW TABLE AS new_food_search_servings FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_serving_insert()",
      functionName: "enqueue_food_search_serving_insert",
      tableName: "food_serving",
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
    "food_source_search_eligibility_outbox",
    {
      definition:
        "CREATE TRIGGER food_source_search_eligibility_outbox AFTER UPDATE OF active, active_release_id, code, display_name, license_expression, attribution_required, attribution_text, commercial_use_allowed, redistribution_allowed, rights_review_status, rights_reviewed_at, rights_reviewed_by ON food_source FOR EACH ROW EXECUTE FUNCTION enqueue_food_search_source_eligibility_change()",
      functionName: "enqueue_food_search_source_eligibility_change",
      tableName: "food_source",
    },
  ],
  [
    "food_source_set_updated_at",
    {
      definition:
        "CREATE TRIGGER food_source_set_updated_at BEFORE UPDATE ON food_source FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
      functionName: "set_row_updated_at",
      tableName: "food_source",
    },
  ],
  [
    "food_source_release_activation_guard_authority",
    {
      definition:
        "CREATE TRIGGER food_source_release_activation_guard_authority BEFORE INSERT ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_activation_authority()",
      functionName: "guard_food_source_release_activation_authority",
      tableName: "food_source_release_activation",
    },
  ],
  [
    "food_source_release_activation_reject_update",
    {
      definition:
        "CREATE TRIGGER food_source_release_activation_reject_update BEFORE DELETE OR UPDATE ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
      tableName: "food_source_release_activation",
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
    "food_source_release_reject_delete",
    {
      definition:
        "CREATE TRIGGER food_source_release_reject_delete BEFORE DELETE ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
      functionName: "reject_immutable_row_update",
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
  [
    "nutrient_active_vector_size_guard",
    {
      definition:
        "CREATE CONSTRAINT TRIGGER nutrient_active_vector_size_guard AFTER INSERT OR UPDATE OF active ON nutrient DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_active_nutrient_vector_size()",
      functionName: "guard_active_nutrient_vector_size",
      tableName: "nutrient",
    },
  ],
  [
    "nutrient_registry_lock_before_active_update",
    {
      definition:
        "CREATE TRIGGER nutrient_registry_lock_before_active_update BEFORE DELETE OR UPDATE ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
      functionName: "lock_active_nutrient_registry_before_write",
      tableName: "nutrient",
    },
  ],
  [
    "nutrient_registry_lock_before_insert",
    {
      definition:
        "CREATE TRIGGER nutrient_registry_lock_before_insert BEFORE INSERT ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
      functionName: "lock_active_nutrient_registry_before_write",
      tableName: "nutrient",
    },
  ],
  [
    "recipe_ingredient_reconcile_v2",
    {
      definition:
        "CREATE CONSTRAINT TRIGGER recipe_ingredient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_ingredient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
      functionName: "reconcile_recipe_components_v2",
      tableName: "recipe_ingredient",
    },
  ],
  [
    "recipe_nutrient_reconcile_v2",
    {
      definition:
        "CREATE CONSTRAINT TRIGGER recipe_nutrient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_nutrient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
      functionName: "reconcile_recipe_components_v2",
      tableName: "recipe_version_nutrient",
    },
  ],
  [
    "recipe_source_reconcile_v2",
    {
      definition:
        "CREATE CONSTRAINT TRIGGER recipe_source_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
      functionName: "reconcile_recipe_components_v2",
      tableName: "recipe_version_source",
    },
  ],
  [
    "recipe_version_components_reconcile_v2",
    {
      definition:
        "CREATE CONSTRAINT TRIGGER recipe_version_components_reconcile_v2 AFTER INSERT ON recipe_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
      functionName: "reconcile_recipe_components_v2",
      tableName: "recipe_version",
    },
  ],
]);
const SHARED_TRIGGER_FUNCTION_NAMES = new Set([
  "reject_immutable_row_update",
  "set_row_updated_at",
]);
const REVIEWED_AUTHORITY_TRIGGER_NAMES = new Set(AUTHORITY_TRIGGER_POLICY.keys());
// The shared helpers are intentionally bound throughout the application schema;
// their reviewed catalogue sites are selected by protected table and exact name.
// Every dedicated authority function is exclusive, so any extra binding of one
// must enter the fingerprint and fail the exact trigger-set check.
const REVIEWED_AUTHORITY_TRIGGER_FUNCTION_NAMES = new Set(
  [...AUTHORITY_TRIGGER_POLICY.values()]
    .map(({ functionName }) => functionName)
    .filter((functionName) => !SHARED_TRIGGER_FUNCTION_NAMES.has(functionName)),
);
const REVIEWED_AUTHORITY_TRIGGER_FUNCTION_SQL_LIST = [...REVIEWED_AUTHORITY_TRIGGER_FUNCTION_NAMES]
  .sort()
  .map((functionName) => `'${functionName}'`)
  .join(",");
const AUTHORITY_POLICY_SQL = readFileSync(AUTHORITY_POLICY_PATH, "utf8");

export const RESTORE_AUTHORITY_POLICY_SHA256 = assertRestoreAuthorityPolicyDigest(
  AUTHORITY_POLICY_SQL,
  EXPECTED_AUTHORITY_POLICY_SHA256,
);
export const TRACKED_MIGRATION_LEDGER_JSON = canonicalJson(loadTrackedMigrationLedger());

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

  // Refuse to copy a source that violates the reviewed authority manifest or
  // tracked migration ledger. These run before a dump or target is created.
  collectAuthorityFingerprint(run, options, options.sourceDatabase);
  const preDumpMigrationLedger = collectRestoreMigrationLedger(
    run,
    options,
    options.sourceDatabase,
  );

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
    if (source.migrationLedger !== preDumpMigrationLedger) {
      throw new Error("Source public migration ledger changed during the restore drill");
    }
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
  const migrationLedger = collectRestoreMigrationLedger(run, options, database);
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

export function collectRestoreMigrationLedger(run, options, database) {
  const migrationLedger = psqlScalar(run, options, database, [
    "select coalesce(json_agg(row_to_json(m) order by m.name)::text, '[]')",
    "from (select name, checksum from public.app_schema_migration order by name) m",
  ]);
  return validateRestoreMigrationLedger(migrationLedger);
}

export function validateRestoreMigrationLedger(migrationLedger) {
  let parsed;
  try {
    parsed = JSON.parse(migrationLedger);
  } catch {
    throw new Error("Public migration ledger returned malformed JSON");
  }
  if (!Array.isArray(parsed) || canonicalJson(parsed) !== TRACKED_MIGRATION_LEDGER_JSON) {
    throw new Error("Public migration ledger does not match the tracked migration manifest");
  }
  return canonicalJson(parsed);
}

function loadTrackedMigrationLedger() {
  const names = readdirSync(MIGRATION_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) throw new Error("No tracked database migrations were found");
  return names.map((name) => ({
    checksum: createHash("sha256")
      .update(readFileSync(new URL(name, MIGRATION_DIRECTORY), "utf8"))
      .digest("hex"),
    name,
  }));
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
      "and constraint_row.conname in ('food_import_batch_materialization_contract_check','food_import_batch_nutrition_semantic_contract_check','food_import_batch_promotable_contract_check','food_import_batch_stage_validate_database_authority_check','food_import_batch_staging_seal_check','food_import_record_nutrition_semantic_contract_check','food_import_record_validated_food_contract_check','food_source_release_activation_database_authority_check')",
      ") authority_constraint_policy",
    ]),
    authorityFrozenColumns: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(authority_frozen_column_policy) order by authority_frozen_column_policy.table_name, authority_frozen_column_policy.column_name)::text, '[]')",
      "from (",
      "select namespace_row.nspname as schema_name, class_row.relname as table_name, attribute_row.attname as column_name,",
      "pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) as data_type,",
      "attribute_row.attnotnull as not_null,",
      "pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid, true) as default_expression",
      "from pg_catalog.pg_attribute as attribute_row",
      "join pg_catalog.pg_class as class_row on class_row.oid = attribute_row.attrelid",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace",
      "left join pg_catalog.pg_attrdef as default_row on default_row.adrelid = attribute_row.attrelid and default_row.adnum = attribute_row.attnum",
      "where namespace_row.nspname = 'public'",
      "and ((class_row.relname = 'food_import_batch' and attribute_row.attname in ('nutrient_mapping_digest','nutrient_mapping_revision_ids','nutrition_semantic_contract_version','nutrition_semantic_sha256','validated_food_contract_version','staged_database_principal','staged_database_capability_role','staging_seal_sha256','staging_sealed_at','validated_database_principal','validated_database_capability_role'))",
      "or (class_row.relname = 'food_import_record' and attribute_row.attname in ('nutrition_semantic_contract_version','nutrition_semantic_sha256','validated_food_contract_version','validated_food_document','validated_food_sha256'))) ",
      ") authority_frozen_column_policy",
    ]),
    authorityIndexes: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(authority_index_policy) order by authority_index_policy.schema_name, authority_index_policy.table_name, authority_index_policy.name)::text, '[]')",
      "from (",
      "select namespace_row.nspname as schema_name, table_row.relname as table_name, index_row.relname as name,",
      "pg_catalog.pg_get_userbyid(index_row.relowner) as owner, access_method.amname as access_method,",
      "index_metadata.indisunique as is_unique, index_metadata.indisprimary as is_primary,",
      "index_metadata.indisvalid as is_valid, index_metadata.indisready as is_ready,",
      "index_metadata.indnkeyatts as key_attribute_count, index_metadata.indnatts as total_attribute_count,",
      "pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 1, true) as key_expression,",
      "pg_catalog.pg_get_expr(index_metadata.indpred, index_metadata.indrelid, true) as predicate,",
      "pg_catalog.pg_get_indexdef(index_metadata.indexrelid) as definition",
      "from pg_catalog.pg_index as index_metadata",
      "join pg_catalog.pg_class as index_row on index_row.oid = index_metadata.indexrelid",
      "join pg_catalog.pg_class as table_row on table_row.oid = index_metadata.indrelid",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = table_row.relnamespace",
      "join pg_catalog.pg_am as access_method on access_method.oid = index_row.relam",
      "where namespace_row.nspname = 'public'",
      "and index_row.relname = 'food_source_release_activation_import_batch_unique'",
      ") authority_index_policy",
    ]),
    columnAcls: psqlJson(run, options, database, [
      "select coalesce(json_agg(row_to_json(column_acl_policy) order by column_acl_policy.relation_name, column_acl_policy.column_name, column_acl_policy.grantee, column_acl_policy.grantor, column_acl_policy.privilege, column_acl_policy.grantable)::text, '[]')",
      "from (",
      "select class_row.relname as relation_name, attribute_row.attname as column_name,",
      "coalesce(grantee_role.rolname, 'PUBLIC') as grantee, coalesce(grantor_role.rolname, 'PUBLIC') as grantor,",
      "acl.privilege_type as privilege, acl.is_grantable as grantable",
      "from pg_catalog.pg_attribute as attribute_row",
      "join pg_catalog.pg_class as class_row on class_row.oid = attribute_row.attrelid",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace",
      "cross join lateral pg_catalog.aclexplode(attribute_row.attacl) as acl",
      "left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee",
      "left join pg_catalog.pg_roles as grantor_role on grantor_role.oid = acl.grantor",
      "where namespace_row.nspname = 'public'",
      "and attribute_row.attnum > 0 and not attribute_row.attisdropped",
      "and attribute_row.attacl is not null",
      ") column_acl_policy",
    ]),
    explicitColumnAclAttributeCount: psqlScalar(run, options, database, [
      "select count(*)::text as explicit_column_acl_attribute_count",
      "from pg_catalog.pg_attribute as attribute_row",
      "join pg_catalog.pg_class as class_row on class_row.oid = attribute_row.attrelid",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace",
      "where namespace_row.nspname = 'public'",
      "and attribute_row.attnum > 0 and not attribute_row.attisdropped",
      "and attribute_row.attacl is not null",
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
      "select coalesce(json_agg(row_to_json(trigger_policy) order by trigger_policy.table_schema, trigger_policy.name, trigger_policy.table_name, trigger_policy.function_schema, trigger_policy.function_name)::text, '[]')",
      "from (",
      "select trigger_row.tgname as name, namespace_row.nspname as table_schema, class_row.relname as table_name, procedure_namespace.nspname as function_schema, procedure_row.proname as function_name,",
      "pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as function_arguments,",
      "trigger_row.tgenabled as enabled, pg_catalog.pg_get_triggerdef(trigger_row.oid, true) as definition",
      "from pg_catalog.pg_trigger as trigger_row",
      "join pg_catalog.pg_class as class_row on class_row.oid = trigger_row.tgrelid",
      "join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace",
      "join pg_catalog.pg_proc as procedure_row on procedure_row.oid = trigger_row.tgfoid",
      "join pg_catalog.pg_namespace as procedure_namespace on procedure_namespace.oid = procedure_row.pronamespace",
      "where not trigger_row.tgisinternal and (",
      "namespace_row.nspname = 'public' or (",
      "procedure_namespace.nspname = 'public'",
      `and procedure_row.proname in (${REVIEWED_AUTHORITY_TRIGGER_FUNCTION_SQL_LIST})`,
      "))",
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
    version: 12,
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
  if (!evidence || typeof evidence !== "object" || evidence.version !== 12) {
    throw new Error("Database-authority fingerprint has an unsupported version");
  }

  const authorityConstraints = requiredArray(
    evidence.authorityConstraints,
    "catalogue authority constraints",
  );
  if (canonicalJson(authorityConstraints) !== canonicalJson(AUTHORITY_CONSTRAINT_POLICY)) {
    throw new Error(
      "Catalogue materialization, nutrition-semantic, or activation constraint differs from policy",
    );
  }
  const authorityFrozenColumns = requiredArray(
    evidence.authorityFrozenColumns,
    "catalogue frozen materialization and nutrition-semantic columns",
  );
  if (canonicalJson(authorityFrozenColumns) !== canonicalJson(AUTHORITY_FROZEN_COLUMN_POLICY)) {
    throw new Error(
      "Catalogue frozen materialization or nutrition-semantic column differs from policy",
    );
  }
  const authorityIndexes = requiredArray(evidence.authorityIndexes, "catalogue authority indexes");
  if (
    canonicalJson(authorityIndexes) !==
    canonicalJson(
      AUTHORITY_INDEX_POLICY.map((index) => ({
        ...index,
        owner: expectedOwner,
      })),
    )
  ) {
    throw new Error("Catalogue authority index differs from policy");
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
  const schemaAcl = requiredArray(schema.acl, "public schema ACL");
  if (schemaAcl.some((entry) => entry.grantor !== "pg_database_owner")) {
    throw new Error("Public schema ACL has an unexpected grantor");
  }
  assertExactAcl(
    schemaAcl,
    [
      ["PUBLIC", "USAGE"],
      ["nutrition_catalogue_stage", "USAGE"],
      ["nutrition_catalogue_validate", "USAGE"],
      ["nutrition_catalogue_approve_data", "USAGE"],
      ["nutrition_catalogue_approve_quality", "USAGE"],
      ["nutrition_catalogue_approve_rights", "USAGE"],
      ["nutrition_catalogue_promote_activate", "USAGE"],
      ["nutrition_catalogue_rollback", "USAGE"],
      ["pg_database_owner", "CREATE"],
      ["pg_database_owner", "USAGE"],
    ],
    "public schema",
  );

  if (
    requiredArray(evidence.columnAcls, "public column ACLs").length > 0 ||
    evidence.explicitColumnAclAttributeCount !== "0"
  ) {
    throw new Error("A public-schema column has an explicit ACL not versioned by policy");
  }

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
        canonicalJson(functionPolicy.config) !== canonicalJson(expectedFunction.config)
      ) {
        throw new Error(`Catalogue authority function ${functionPolicy.name} differs from policy`);
      }
      const executeGrantees = expectedFunction.executeGrantees;
      const aclIsDefault = executeGrantees === "default";
      if (functionPolicy.acl_is_default !== aclIsDefault) {
        throw new Error(`Catalogue authority function ${functionPolicy.name} ACL differs`);
      }
      const expectedAcl = aclIsDefault
        ? [
            ["PUBLIC", "EXECUTE"],
            [expectedOwner, "EXECUTE"],
          ]
        : executeGrantees === "owner-only"
          ? [[expectedOwner, "EXECUTE"]]
          : [[expectedOwner, "EXECUTE"], ...executeGrantees.map((grantee) => [grantee, "EXECUTE"])];
      assertExactAcl(
        functionPolicy.acl,
        expectedAcl,
        `catalogue authority function ${functionPolicy.name}`,
      );
      if (
        requiredArray(functionPolicy.acl, `${functionPolicy.name} ACL`).some(
          (entry) => entry.grantor !== expectedOwner,
        )
      ) {
        throw new Error(
          `Catalogue authority function ${functionPolicy.name} ACL has an unexpected grantor`,
        );
      }
      continue;
    }
    if (functionPolicy.security_definer !== false || functionPolicy.acl_is_default !== true) {
      throw new Error(`Non-authority function ${functionPolicy.name} has unexpected authority`);
    }
  }

  const triggers = requiredArray(evidence.triggers, "restore triggers");
  const authorityTriggers = triggers.filter(
    (entry) =>
      (entry.table_schema === "public" &&
        (PROTECTED_CATALOGUE_TABLES.has(entry.table_name) ||
          REVIEWED_AUTHORITY_TRIGGER_NAMES.has(entry.name))) ||
      (entry.function_schema === "public" &&
        REVIEWED_AUTHORITY_TRIGGER_FUNCTION_NAMES.has(entry.function_name)),
  );
  if (authorityTriggers.length !== AUTHORITY_TRIGGER_POLICY.size) {
    throw new Error("Catalogue authority trigger set has missing or unexpected entries");
  }
  for (const [name, expected] of AUTHORITY_TRIGGER_POLICY) {
    const matches = authorityTriggers.filter((entry) => entry.name === name);
    if (
      matches.length !== 1 ||
      matches[0].enabled !== "O" ||
      matches[0].table_schema !== "public" ||
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
