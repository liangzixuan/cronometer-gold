import { createHash } from "node:crypto";

import { canonicalJson } from "./catalogue-validation.js";
import type { JsonValue } from "./types.js";

export const CATALOGUE_CAPABILITY_ROLES = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
] as const;

export const CATALOGUE_REVIEWER_CAPABILITIES = {
  data: "nutrition_catalogue_approve_data",
  quality: "nutrition_catalogue_approve_quality",
  rights: "nutrition_catalogue_approve_rights",
} as const;

export type CatalogueCapabilityRole = (typeof CATALOGUE_CAPABILITY_ROLES)[number];

export type CatalogueFunctionExecuteGrantees =
  | "default"
  | "owner-only"
  | readonly CatalogueCapabilityRole[];

export const CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256 =
  "abb0ca990b74fedffd4ec77cf666e404da89af8158f4b990b6c0de48cd3dfc41";
export const CATALOGUE_APPROVAL_V1_FUNCTION_SOURCE_SHA256 =
  "89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac";
export const CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256 =
  "f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd";
export const CATALOGUE_PROMOTION_FUNCTION_SOURCE_SHA256 =
  "309861b6850a99bb565466981602ee19054b9c2500dfee21bf27edc6be382111";
export const CATALOGUE_PROMOTION_V1_FUNCTION_SOURCE_SHA256 =
  "115fdc3ed1943dd77ce70d3a694495da3d2c62ade9c7b82812a89cef82b39f17";
export const CATALOGUE_ROLLBACK_FUNCTION_SOURCE_SHA256 =
  "56e9fa2cce7f532c1f405658ff9f07908394d0fb9734b70d0bdb92a12292068a";
export const CATALOGUE_ROLLBACK_V1_FUNCTION_SOURCE_SHA256 =
  "3fe493ee5e0b27e43cc881854dddfe4dc12f862a1c4a242bf712c843b2792ff1";
export const CATALOGUE_ACTIVATION_GUARD_SOURCE_SHA256 =
  "d46f53aeffa6469eada5461ab59bd9c23d43bf9aab77704c61b21c44291ae028";
export const CATALOGUE_COMPUTE_STAGING_SEAL_FUNCTION_SOURCE_SHA256 =
  "399d40c2913c2022c0a2921d5870a2d26a5dcd9949d81715882f70899db4f5f8";
export const CATALOGUE_OBSERVE_VALIDATION_FUNCTION_SOURCE_SHA256 =
  "0a87bc99f5df97282c48b6202799bcc75cdb914e7473c0c38e092aaf4a132acf";
export const CATALOGUE_STAGE_BATCH_FUNCTION_SOURCE_SHA256 =
  "11b0a983c9cf3d4a7451978d37e5fe997a40290a10e741ba0626b89bfd2611c4";
export const CATALOGUE_STAGE_PARSER_REPORT_FUNCTION_SOURCE_SHA256 =
  "d89defb335e21228c38968ef69b2ed7342f5a5440762ae31f170969fbcc9c9e8";
export const CATALOGUE_STAGE_RECORD_CHUNK_FUNCTION_SOURCE_SHA256 =
  "4cc2b310ba6fda051a125bb203c0cf2c6a5fbe227a55daf517a0376ab79e4c7f";
export const CATALOGUE_VALIDATE_BATCH_FUNCTION_SOURCE_SHA256 =
  "10c59084d8e5c7debb581c6e749f6779dbc3f5867fc4cb18ffc009293f9f50a5";
export const CATALOGUE_VALIDATE_BATCH_V1_FUNCTION_SOURCE_SHA256 =
  "5b7ae15625fb0ae0d88a9512fe82fca69a9d0dd9e179af8bc1b2f42d1e85ac8a";
export const CATALOGUE_NUTRITION_ATTESTATION_FUNCTION_SOURCE_SHA256 =
  "e2c35dfabb653636a9640475227104a485a24129558b11511175831ef9bc5b8b";
export const CATALOGUE_NUTRITION_DECIMAL_PRODUCT_FUNCTION_SOURCE_SHA256 =
  "299a2c88226123f167fe2d7001fdaf6a2e02425007f2426c8def9d0bb83a46c0";
export const CATALOGUE_NUTRITION_UTF16_LENGTH_FUNCTION_SOURCE_SHA256 =
  "3a1759986b190b3ccac086e5da943ada91f3cc8c3a94ce6942657faae389ef39";
export const CATALOGUE_NUTRITION_COMPUTE_RECORD_FUNCTION_SOURCE_SHA256 =
  "41f048090dce80b794615f135f5368f7f501eaecfc3513471eb6d1f36c022783";
export const CATALOGUE_RECORD_NUTRITION_SEMANTIC_GUARD_SOURCE_SHA256 =
  "489c1c4b970c6ba369503854701c980ebcb1510c754050e78355fed94647e0e8";
export const CATALOGUE_BATCH_NUTRITION_SEMANTIC_GUARD_SOURCE_SHA256 =
  "298b898cd252f08aa9a5f212e85750aeba79cc41616c71afcd3f129471a6cf5c";
export const CATALOGUE_STAGE_VALIDATE_GUARD_SOURCE_SHA256 =
  "f21dfa9d5455a40ab9f50bdbace02ffc19f53ab252e0eab99a4f50769f678eda";
export const CATALOGUE_RECORD_STAGING_SEAL_GUARD_SOURCE_SHA256 =
  "2fc46ef24e03309e61832491438746967642911b02e97896f8a0bdf6fc5aa8bc";
export const CATALOGUE_CHECKPOINT_STAGING_SEAL_GUARD_SOURCE_SHA256 =
  "66e2078cf57d658268f547c25df26750ebe5b7b6402de9fcecdc2249c14f28ef";
export const CATALOGUE_ACTIVATION_AUTHORITY_CONSTRAINT_DEFINITION =
  "CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND database_capability_role IS NOT NULL AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =\nCASE\n    WHEN import_batch_id IS NOT NULL AND operation = 'activate'::text THEN 'nutrition_catalogue_promote_activate'::text\n    WHEN import_batch_id IS NULL AND (operation = ANY (ARRAY['deactivate'::text, 'rollback'::text])) THEN 'nutrition_catalogue_rollback'::text\n    ELSE NULL::text\nEND) IS TRUE)";
export const CATALOGUE_STAGE_VALIDATE_AUTHORITY_CONSTRAINT_DEFINITION =
  "CHECK ((staged_database_principal IS NULL AND staged_database_capability_role IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR staged_database_principal IS NOT NULL AND octet_length(staged_database_principal) >= 1 AND octet_length(staged_database_principal) <= 63 AND staged_database_capability_role = 'nutrition_catalogue_stage'::text AND (validated_at IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR validated_at IS NOT NULL AND validated_database_principal IS NOT NULL AND octet_length(validated_database_principal) >= 1 AND octet_length(validated_database_principal) <= 63 AND validated_database_capability_role = 'nutrition_catalogue_validate'::text AND validated_database_principal <> staged_database_principal)) IS TRUE)";
export const CATALOGUE_STAGING_SEAL_CONSTRAINT_DEFINITION =
  "CHECK ((staging_seal_sha256 IS NULL AND staging_sealed_at IS NULL OR staging_seal_sha256 ~ '^[0-9a-f]{64}$'::text AND staging_sealed_at IS NOT NULL AND (staging_sealed_at <> ALL (ARRAY['-infinity'::timestamp with time zone, 'infinity'::timestamp with time zone]))) IS TRUE AND (validated_at IS NULL OR staged_database_principal IS NULL OR staging_seal_sha256 IS NOT NULL))";
export const CATALOGUE_BATCH_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION =
  "CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (status = ANY (ARRAY['quarantined'::text, 'ready'::text, 'promoting'::text, 'completed'::text]))) IS TRUE)";
export const CATALOGUE_RECORD_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION =
  "CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (validation_status = ANY (ARRAY['quarantined'::text, 'valid'::text, 'materialized'::text]))) IS TRUE)";

export const CATALOGUE_AUTHORITY_CONSTRAINT_POLICY = [
  {
    constraintType: "c",
    definition:
      "CHECK ((validated_food_contract_version IS NULL AND nutrient_mapping_digest IS NULL AND nutrient_mapping_revision_ids IS NULL OR validated_food_contract_version = 1 AND nutrient_mapping_digest ~ '^[0-9a-f]{64}$'::text AND jsonb_typeof(nutrient_mapping_revision_ids) = 'array'::text AND validated_at IS NOT NULL) IS TRUE)",
    name: "food_import_batch_materialization_contract_check",
    tableName: "food_import_batch",
    validated: true,
  },
  {
    constraintType: "c",
    definition: CATALOGUE_BATCH_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION,
    name: "food_import_batch_nutrition_semantic_contract_check",
    tableName: "food_import_batch",
    validated: true,
  },
  {
    constraintType: "c",
    definition:
      "CHECK (((status <> ALL (ARRAY['ready'::text, 'promoting'::text])) OR validated_food_contract_version = 1 AND nutrient_mapping_digest IS NOT NULL AND nutrient_mapping_revision_ids IS NOT NULL) IS TRUE)",
    name: "food_import_batch_promotable_contract_check",
    tableName: "food_import_batch",
    validated: true,
  },
  {
    constraintType: "c",
    definition: CATALOGUE_STAGE_VALIDATE_AUTHORITY_CONSTRAINT_DEFINITION,
    name: "food_import_batch_stage_validate_database_authority_check",
    tableName: "food_import_batch",
    validated: true,
  },
  {
    constraintType: "c",
    definition: CATALOGUE_STAGING_SEAL_CONSTRAINT_DEFINITION,
    name: "food_import_batch_staging_seal_check",
    tableName: "food_import_batch",
    validated: true,
  },
  {
    constraintType: "c",
    definition: CATALOGUE_RECORD_NUTRITION_SEMANTIC_CONSTRAINT_DEFINITION,
    name: "food_import_record_nutrition_semantic_contract_check",
    tableName: "food_import_record",
    validated: true,
  },
  {
    constraintType: "c",
    definition:
      "CHECK ((validated_food_document IS NULL AND validated_food_sha256 IS NULL AND validated_food_contract_version IS NULL AND (validation_status = ANY (ARRAY['pending'::text, 'quarantined'::text, 'valid'::text, 'materialized'::text])) OR validated_food_document IS NOT NULL AND validated_food_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_food_contract_version = 1 AND (validation_status = ANY (ARRAY['valid'::text, 'materialized'::text])) AND jsonb_typeof(validated_food_document::jsonb) = 'object'::text AND validated_food_sha256 = encode(sha256(convert_to(validated_food_document, 'UTF8'::name)), 'hex'::text)) IS TRUE)",
    name: "food_import_record_validated_food_contract_check",
    tableName: "food_import_record",
    validated: true,
  },
  {
    constraintType: "c",
    definition: CATALOGUE_ACTIVATION_AUTHORITY_CONSTRAINT_DEFINITION,
    name: "food_source_release_activation_database_authority_check",
    tableName: "food_source_release_activation",
    validated: true,
  },
] as const;

export const CATALOGUE_AUTHORITY_FROZEN_COLUMN_POLICY = [
  {
    columnName: "nutrient_mapping_digest",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "nutrient_mapping_revision_ids",
    dataType: "jsonb",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "nutrition_semantic_contract_version",
    dataType: "smallint",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "nutrition_semantic_sha256",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "staged_database_capability_role",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "staged_database_principal",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "staging_seal_sha256",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "staging_sealed_at",
    dataType: "timestamp with time zone",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "validated_database_capability_role",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "validated_database_principal",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "validated_food_contract_version",
    dataType: "smallint",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_batch",
  },
  {
    columnName: "nutrition_semantic_contract_version",
    dataType: "smallint",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_record",
  },
  {
    columnName: "nutrition_semantic_sha256",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_record",
  },
  {
    columnName: "validated_food_contract_version",
    dataType: "smallint",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_record",
  },
  {
    columnName: "validated_food_document",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_record",
  },
  {
    columnName: "validated_food_sha256",
    dataType: "text",
    defaultExpression: null,
    notNull: false,
    schemaName: "public",
    tableName: "food_import_record",
  },
] as const;

export const CATALOGUE_AUTHORITY_INDEX_POLICY = [
  {
    accessMethod: "btree",
    definition:
      "CREATE UNIQUE INDEX food_source_release_activation_import_batch_unique ON public.food_source_release_activation USING btree (import_batch_id) WHERE (import_batch_id IS NOT NULL)",
    isPrimary: false,
    isReady: true,
    isUnique: true,
    isValid: true,
    keyAttributeCount: 1,
    keyExpression: "import_batch_id",
    name: "food_source_release_activation_import_batch_unique",
    predicate: "import_batch_id IS NOT NULL",
    schemaName: "public",
    tableName: "food_source_release_activation",
    totalAttributeCount: 1,
  },
] as const;

export interface CatalogueAuthorityFunctionPolicy {
  readonly arguments: string;
  readonly configuration: "application-schema" | "none";
  readonly executeGrantees: CatalogueFunctionExecuteGrantees;
  readonly language: "plpgsql" | "sql";
  readonly leakproof: boolean;
  readonly name: string;
  readonly parallel: string;
  readonly resultType: "bigint" | "boolean" | "jsonb" | "text" | "trigger" | "void";
  readonly securityDefiner: boolean;
  readonly sourceSha256: string;
  readonly strict: boolean;
  readonly volatility: string;
}

const TRIGGER_FUNCTION_POLICY = {
  arguments: "",
  configuration: "application-schema",
  executeGrantees: "default",
  language: "plpgsql",
  leakproof: false,
  parallel: "u",
  resultType: "trigger",
  securityDefiner: false,
  strict: false,
  volatility: "v",
} as const;

export const CATALOGUE_AUTHORITY_FUNCTION_POLICY: readonly CatalogueAuthorityFunctionPolicy[] = [
  {
    arguments: "",
    configuration: "application-schema",
    executeGrantees: "default",
    language: "plpgsql",
    leakproof: false,
    name: "advance_food_search_projection_revision",
    parallel: "u",
    resultType: "void",
    securityDefiner: false,
    sourceSha256: "d1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108",
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_batch_id uuid",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_attest_import_nutrition_semantics",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_NUTRITION_ATTESTATION_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_left text, p_right text",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_canonical_decimal_product",
    parallel: "s",
    resultType: "text",
    securityDefiner: false,
    sourceSha256: CATALOGUE_NUTRITION_DECIMAL_PRODUCT_FUNCTION_SOURCE_SHA256,
    strict: true,
    volatility: "i",
  },
  {
    arguments: "p_batch_id uuid",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_compute_import_staging_seal",
    parallel: "u",
    resultType: "text",
    securityDefiner: true,
    sourceSha256: CATALOGUE_COMPUTE_STAGING_SEAL_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_record_id bigint",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_compute_record_nutrition_semantics",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_NUTRITION_COMPUTE_RECORD_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "value text, digest text",
    configuration: "application-schema",
    executeGrantees: "default",
    language: "sql",
    leakproof: false,
    name: "catalogue_evidence_bundle_uri_is_valid",
    parallel: "u",
    resultType: "boolean",
    securityDefiner: false,
    sourceSha256: "5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e",
    strict: true,
    volatility: "i",
  },
  {
    arguments: "p_batch_id uuid",
    configuration: "application-schema",
    executeGrantees: ["nutrition_catalogue_validate"],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_observe_import_validation",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_OBSERVE_VALIDATION_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_batch_id uuid, p_external_principal_id text, p_reason text",
    configuration: "application-schema",
    executeGrantees: ["nutrition_catalogue_promote_activate"],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_promote_import_batch",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_PROMOTION_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_batch_id uuid, p_external_principal_id text, p_reason text",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_promote_import_batch_v1",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_PROMOTION_V1_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments:
      "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
    configuration: "application-schema",
    executeGrantees: [
      "nutrition_catalogue_approve_data",
      "nutrition_catalogue_approve_quality",
      "nutrition_catalogue_approve_rights",
    ],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_record_import_approval",
    parallel: "u",
    resultType: "boolean",
    securityDefiner: true,
    sourceSha256: CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments:
      "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_record_import_approval_v1",
    parallel: "u",
    resultType: "boolean",
    securityDefiner: true,
    sourceSha256: CATALOGUE_APPROVAL_V1_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments:
      "p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text",
    configuration: "application-schema",
    executeGrantees: ["nutrition_catalogue_rollback"],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_rollback_source_release",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_ROLLBACK_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments:
      "p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_rollback_source_release_v1",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_ROLLBACK_V1_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_stage_document text",
    configuration: "application-schema",
    executeGrantees: ["nutrition_catalogue_stage"],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_stage_import_batch",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_STAGE_BATCH_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_batch_id uuid, p_parser_report_document text",
    configuration: "application-schema",
    executeGrantees: ["nutrition_catalogue_stage"],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_stage_import_parser_report",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_STAGE_PARSER_REPORT_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_batch_id uuid, p_expected_next_offset bigint, p_records_document text",
    configuration: "application-schema",
    executeGrantees: ["nutrition_catalogue_stage"],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_stage_import_record_chunk",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_STAGE_RECORD_CHUNK_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments: "p_value text",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "sql",
    leakproof: false,
    name: "catalogue_utf16_length",
    parallel: "s",
    resultType: "bigint",
    securityDefiner: false,
    sourceSha256: CATALOGUE_NUTRITION_UTF16_LENGTH_FUNCTION_SOURCE_SHA256,
    strict: true,
    volatility: "i",
  },
  {
    arguments:
      "p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text",
    configuration: "application-schema",
    executeGrantees: ["nutrition_catalogue_validate"],
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_validate_import_batch",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_VALIDATE_BATCH_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    arguments:
      "p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text",
    configuration: "application-schema",
    executeGrantees: "owner-only",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_validate_import_batch_v1",
    parallel: "u",
    resultType: "jsonb",
    securityDefiner: true,
    sourceSha256: CATALOGUE_VALIDATE_BATCH_V1_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "enqueue_food_search_barcode_insert",
    sourceSha256: "4e888f3ef0b3af1e7eee14568069ae3fe06b65b88718614ed0e2c243a5d22318",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "enqueue_food_search_barcode_update",
    sourceSha256: "9d7a90d0fee1a6923631c9b9018d9c813d3c8f7eea2df941fc32fbb4f5d453b0",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "enqueue_food_search_food_eligibility_change",
    sourceSha256: "85ada305a6fd6b40cd5fb0652d64c240d1953033a243b0f7ce243caa9bc9c4de",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "enqueue_food_search_serving_insert",
    sourceSha256: "223f2d1dc8f90c6bc04c4d85ec763bcb50727473f5576b0bcdbbf394c1c9d804",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "enqueue_food_search_source_eligibility_change",
    sourceSha256: "3a88f24e4863d8150db21f93efadd528ea5d7811b5c79c6ff5cd38fdcb93ce87",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_active_nutrient_vector_size",
    sourceSha256: "24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    executeGrantees: "owner-only",
    name: "guard_food_source_release_activation_authority",
    sourceSha256: CATALOGUE_ACTIVATION_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_custom_food_child_insert_v3",
    sourceSha256: "f2fc5d7cc06759696b2656f921d57502326ab4efbd6fe1b1554143b117152d88",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_custom_food_immutable_evidence_v3",
    sourceSha256: "5e450518bc31811221ad64826f6879b177ecec760d88abd0353b14c4aebe3317",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_barcode_validity_update",
    sourceSha256: "7b97f95dd7388565424bd3713081711106a5e3d0c206310a8d405b8772208ecc",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    executeGrantees: "owner-only",
    name: "guard_food_import_approval_authority",
    sourceSha256: CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_batch_initial_state",
    sourceSha256: "2561714155de31151c79f95977156072a66451d1f13f7b5c6e85d13abe9ecb0c",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    executeGrantees: "owner-only",
    name: "guard_food_import_batch_nutrition_semantics",
    sourceSha256: CATALOGUE_BATCH_NUTRITION_SEMANTIC_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    executeGrantees: "owner-only",
    name: "guard_food_import_batch_stage_validate_authority",
    sourceSha256: CATALOGUE_STAGE_VALIDATE_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_batch_update",
    sourceSha256: "8863eef0e6889a620deec204e249ac3d6efdc87310dcc9d25601e6d7f336101f",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_batch_validation_digest",
    sourceSha256: "c94c16cef462dfaca5c58908c2784e6d86b9f415c1c081f7b6c8a5ca434bddd7",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    executeGrantees: "owner-only",
    name: "guard_food_import_record_insert_before_staging_seal",
    sourceSha256: CATALOGUE_RECORD_STAGING_SEAL_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    executeGrantees: "owner-only",
    name: "guard_food_import_record_nutrition_semantics",
    sourceSha256: CATALOGUE_RECORD_NUTRITION_SEMANTIC_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_record_update",
    sourceSha256: "300e6853e7a9520b477256b3b32a4381f3143512b013a4e131a4c203ce524479",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    executeGrantees: "owner-only",
    name: "guard_food_import_stage_checkpoint_before_staging_seal",
    sourceSha256: CATALOGUE_CHECKPOINT_STAGING_SEAL_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_imported_food_version_child_delete",
    sourceSha256: "4e36d3ee5cbd53dc6c98d9f457adbb5ee8cb6cbf8fc6b3e45d3133b4305e7cc1",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_active_release_authority",
    sourceSha256: "306eec1771a7bbf7961bd6d46ba752801fe98f07d27fbf96291a1c454750cd11",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_initial_active_release",
    sourceSha256: "e3cbc51f28aafd274ea2bc3b71b824d51180d8e741dbcfd22d0af9e21849be43",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_release_initial_state",
    sourceSha256: "797445724ddd8d37cdbcc1891c724e9bd8af543548d322db5cf9c3d22ac13b3d",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_release_legacy_promotion_grandfather",
    sourceSha256: "22340dfcbb5f98e1d0504703b0fb37830b31a4ecde5cbe81e55844968b86f214",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_release_update",
    sourceSha256: "191701f20750b6e98b8acf290a1df2417bf17bd9c3a4e5e87a7ac7ef56453726",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_new_food_source_release_authority",
    sourceSha256: "93f189e2c097009ac1cbf1129ce10a24d0c7fd2e4cee66c2ea5cdbb1537462b3",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_source_barcode_delete",
    sourceSha256: "d4bea8e773166f82f291f1d89b20a7cfb52e2d8416ba80bb455642058d23e3cf",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "lock_active_nutrient_registry_before_write",
    sourceSha256: "c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de",
  },
  {
    arguments: "",
    configuration: "application-schema",
    executeGrantees: "default",
    language: "sql",
    leakproof: false,
    name: "lock_active_nutrient_registry_for_read",
    parallel: "u",
    resultType: "void",
    securityDefiner: false,
    sourceSha256: "22ab05f2e9749ecff7035e5188e1b9353d46533e7bc558748c76c43dbfc37ea5",
    strict: false,
    volatility: "v",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "reconcile_recipe_components_v2",
    sourceSha256: "c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "reject_new_legacy_unbound_catalogue_evidence",
    sourceSha256: "f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    configuration: "none",
    name: "reject_immutable_row_update",
    sourceSha256: "631a42e27de6543bc09fd6b8d0f1b0fd336250270b47f13849a2483fd0786e6e",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "set_row_updated_at",
    sourceSha256: "92fa7c305a8b856faea0575b27eaa33c1e39952cf9fe87b4c0cbf7d7eab556bd",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "validate_food_version_child_insert",
    sourceSha256: "5362678168ed713e602e0fd87bc8b13dccd7817db1cf3d3470f09dcbe37e5f07",
  },
];

export const CATALOGUE_AUTHORITY_PROTECTED_TABLES = [
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
] as const;

export interface CatalogueAuthorityTriggerPolicy {
  readonly definition: string;
  readonly functionName: string;
  readonly name: string;
  readonly tableName: string;
}

export const CATALOGUE_AUTHORITY_TRIGGER_POLICY: readonly CatalogueAuthorityTriggerPolicy[] = [
  {
    definition:
      "CREATE TRIGGER custom_food_nutrient_guard_delete_v3 BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
    functionName: "guard_custom_food_immutable_evidence_v3",
    name: "custom_food_nutrient_guard_delete_v3",
    tableName: "food_nutrient_value",
  },
  {
    definition:
      "CREATE TRIGGER custom_food_nutrient_guard_insert_v3 BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()",
    functionName: "guard_custom_food_child_insert_v3",
    name: "custom_food_nutrient_guard_insert_v3",
    tableName: "food_nutrient_value",
  },
  {
    definition:
      "CREATE TRIGGER custom_food_serving_guard_delete_v3 BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
    functionName: "guard_custom_food_immutable_evidence_v3",
    name: "custom_food_serving_guard_delete_v3",
    tableName: "food_serving",
  },
  {
    definition:
      "CREATE TRIGGER custom_food_serving_guard_insert_v3 BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()",
    functionName: "guard_custom_food_child_insert_v3",
    name: "custom_food_serving_guard_insert_v3",
    tableName: "food_serving",
  },
  {
    definition:
      "CREATE TRIGGER custom_food_version_guard_delete_v3 BEFORE DELETE ON food_version FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()",
    functionName: "guard_custom_food_immutable_evidence_v3",
    name: "custom_food_version_guard_delete_v3",
    tableName: "food_version",
  },
  {
    definition:
      "CREATE TRIGGER food_barcode_guard_update BEFORE UPDATE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_food_barcode_validity_update()",
    functionName: "guard_food_barcode_validity_update",
    name: "food_barcode_guard_update",
    tableName: "food_barcode",
  },
  {
    definition:
      "CREATE TRIGGER food_barcode_reject_delete BEFORE DELETE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_source_barcode_delete()",
    functionName: "guard_source_barcode_delete",
    name: "food_barcode_reject_delete",
    tableName: "food_barcode",
  },
  {
    definition:
      "CREATE TRIGGER food_nutrient_value_reject_delete BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()",
    functionName: "guard_imported_food_version_child_delete",
    name: "food_nutrient_value_reject_delete",
    tableName: "food_nutrient_value",
  },
  {
    definition:
      "CREATE TRIGGER food_nutrient_value_reject_update BEFORE UPDATE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_nutrient_value_reject_update",
    tableName: "food_nutrient_value",
  },
  {
    definition:
      "CREATE TRIGGER food_nutrient_value_validate_insert BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()",
    functionName: "validate_food_version_child_insert",
    name: "food_nutrient_value_validate_insert",
    tableName: "food_nutrient_value",
  },
  {
    definition:
      "CREATE TRIGGER food_serving_reject_delete BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()",
    functionName: "guard_imported_food_version_child_delete",
    name: "food_serving_reject_delete",
    tableName: "food_serving",
  },
  {
    definition:
      "CREATE TRIGGER food_serving_reject_update BEFORE UPDATE ON food_serving FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_serving_reject_update",
    tableName: "food_serving",
  },
  {
    definition:
      "CREATE TRIGGER food_serving_validate_insert BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()",
    functionName: "validate_food_version_child_insert",
    name: "food_serving_validate_insert",
    tableName: "food_serving",
  },
  {
    definition:
      "CREATE TRIGGER food_set_updated_at BEFORE UPDATE ON food FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    functionName: "set_row_updated_at",
    name: "food_set_updated_at",
    tableName: "food",
  },
  {
    definition:
      "CREATE TRIGGER food_version_reject_update BEFORE UPDATE ON food_version FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_version_reject_update",
    tableName: "food_version",
  },
  {
    definition:
      "CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()",
    functionName: "guard_food_import_approval_authority",
    name: "food_import_approval_guard_authority",
    tableName: "food_import_approval",
  },
  {
    definition:
      "CREATE TRIGGER food_import_approval_reject_update BEFORE DELETE OR UPDATE ON food_import_approval FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_import_approval_reject_update",
    tableName: "food_import_approval",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_initial_state BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_initial_state()",
    functionName: "guard_food_import_batch_initial_state",
    name: "food_import_batch_guard_initial_state",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_nutrition_semantics()",
    functionName: "guard_food_import_batch_nutrition_semantics",
    name: "food_import_batch_guard_nutrition_semantics",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_stage_validate_authority BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_stage_validate_authority()",
    functionName: "guard_food_import_batch_stage_validate_authority",
    name: "food_import_batch_guard_stage_validate_authority",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()",
    functionName: "guard_food_import_batch_update",
    name: "food_import_batch_guard_update",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()",
    functionName: "guard_food_import_batch_validation_digest",
    name: "food_import_batch_guard_validation_digest",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_reject_new_legacy_unbound BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    functionName: "reject_new_legacy_unbound_catalogue_evidence",
    name: "food_import_batch_reject_new_legacy_unbound",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_checkpoint_guard_staging_seal BEFORE INSERT OR DELETE OR UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION guard_food_import_stage_checkpoint_before_staging_seal()",
    functionName: "guard_food_import_stage_checkpoint_before_staging_seal",
    name: "food_import_checkpoint_guard_staging_seal",
    tableName: "food_import_checkpoint",
  },
  {
    definition:
      "CREATE TRIGGER food_import_checkpoint_set_updated_at BEFORE UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    functionName: "set_row_updated_at",
    name: "food_import_checkpoint_set_updated_at",
    tableName: "food_import_checkpoint",
  },
  {
    definition:
      "CREATE TRIGGER food_import_parser_report_reject_update BEFORE DELETE OR UPDATE ON food_import_parser_report FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_import_parser_report_reject_update",
    tableName: "food_import_parser_report",
  },
  {
    definition:
      "CREATE TRIGGER food_import_record_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_nutrition_semantics()",
    functionName: "guard_food_import_record_nutrition_semantics",
    name: "food_import_record_guard_nutrition_semantics",
    tableName: "food_import_record",
  },
  {
    definition:
      "CREATE TRIGGER food_import_record_guard_staging_seal BEFORE INSERT ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_insert_before_staging_seal()",
    functionName: "guard_food_import_record_insert_before_staging_seal",
    name: "food_import_record_guard_staging_seal",
    tableName: "food_import_record",
  },
  {
    definition:
      "CREATE TRIGGER food_import_record_guard_update BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()",
    functionName: "guard_food_import_record_update",
    name: "food_import_record_guard_update",
    tableName: "food_import_record",
  },
  {
    definition:
      "CREATE TRIGGER food_import_record_reject_delete BEFORE DELETE ON food_import_record FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_import_record_reject_delete",
    tableName: "food_import_record",
  },
  {
    definition:
      "CREATE TRIGGER food_search_barcode_insert_outbox AFTER INSERT ON food_barcode REFERENCING NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()",
    functionName: "enqueue_food_search_barcode_insert",
    name: "food_search_barcode_insert_outbox",
    tableName: "food_barcode",
  },
  {
    definition:
      "CREATE TRIGGER food_search_barcode_update_outbox AFTER UPDATE ON food_barcode REFERENCING OLD TABLE AS old_food_search_barcodes NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_update()",
    functionName: "enqueue_food_search_barcode_update",
    name: "food_search_barcode_update_outbox",
    tableName: "food_barcode",
  },
  {
    definition:
      "CREATE TRIGGER food_search_eligibility_outbox AFTER UPDATE ON food REFERENCING OLD TABLE AS old_food_search_rows NEW TABLE AS new_food_search_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_food_eligibility_change()",
    functionName: "enqueue_food_search_food_eligibility_change",
    name: "food_search_eligibility_outbox",
    tableName: "food",
  },
  {
    definition:
      "CREATE TRIGGER food_search_serving_insert_outbox AFTER INSERT ON food_serving REFERENCING NEW TABLE AS new_food_search_servings FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_serving_insert()",
    functionName: "enqueue_food_search_serving_insert",
    name: "food_search_serving_insert_outbox",
    tableName: "food_serving",
  },
  {
    definition:
      "CREATE TRIGGER food_source_guard_active_release_authority BEFORE UPDATE OF active_release_id ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_active_release_authority()",
    functionName: "guard_food_source_active_release_authority",
    name: "food_source_guard_active_release_authority",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE TRIGGER food_source_guard_initial_active_release BEFORE INSERT ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_initial_active_release()",
    functionName: "guard_food_source_initial_active_release",
    name: "food_source_guard_initial_active_release",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE TRIGGER food_source_search_eligibility_outbox AFTER UPDATE OF active, active_release_id, code, display_name, license_expression, attribution_required, attribution_text, commercial_use_allowed, redistribution_allowed, rights_review_status, rights_reviewed_at, rights_reviewed_by ON food_source FOR EACH ROW EXECUTE FUNCTION enqueue_food_search_source_eligibility_change()",
    functionName: "enqueue_food_search_source_eligibility_change",
    name: "food_source_search_eligibility_outbox",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE TRIGGER food_source_set_updated_at BEFORE UPDATE ON food_source FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    functionName: "set_row_updated_at",
    name: "food_source_set_updated_at",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER nutrient_active_vector_size_guard AFTER INSERT OR UPDATE OF active ON nutrient DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_active_nutrient_vector_size()",
    functionName: "guard_active_nutrient_vector_size",
    name: "nutrient_active_vector_size_guard",
    tableName: "nutrient",
  },
  {
    definition:
      "CREATE TRIGGER nutrient_registry_lock_before_active_update BEFORE DELETE OR UPDATE ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
    functionName: "lock_active_nutrient_registry_before_write",
    name: "nutrient_registry_lock_before_active_update",
    tableName: "nutrient",
  },
  {
    definition:
      "CREATE TRIGGER nutrient_registry_lock_before_insert BEFORE INSERT ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
    functionName: "lock_active_nutrient_registry_before_write",
    name: "nutrient_registry_lock_before_insert",
    tableName: "nutrient",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER recipe_ingredient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_ingredient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    functionName: "reconcile_recipe_components_v2",
    name: "recipe_ingredient_reconcile_v2",
    tableName: "recipe_ingredient",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER recipe_nutrient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_nutrient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    functionName: "reconcile_recipe_components_v2",
    name: "recipe_nutrient_reconcile_v2",
    tableName: "recipe_version_nutrient",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER recipe_source_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    functionName: "reconcile_recipe_components_v2",
    name: "recipe_source_reconcile_v2",
    tableName: "recipe_version_source",
  },
  {
    definition:
      "CREATE CONSTRAINT TRIGGER recipe_version_components_reconcile_v2 AFTER INSERT ON recipe_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
    functionName: "reconcile_recipe_components_v2",
    name: "recipe_version_components_reconcile_v2",
    tableName: "recipe_version",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_initial_state BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_initial_state()",
    functionName: "guard_food_source_release_initial_state",
    name: "food_source_release_guard_initial_state",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_insert BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    functionName: "guard_food_source_release_legacy_promotion_grandfather",
    name: "food_source_release_guard_legacy_grandfather_insert",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_update BEFORE UPDATE OF legacy_promotion_grandfathered_at ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    functionName: "guard_food_source_release_legacy_promotion_grandfather",
    name: "food_source_release_guard_legacy_grandfather_update",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_new_authority BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_new_food_source_release_authority()",
    functionName: "guard_new_food_source_release_authority",
    name: "food_source_release_guard_new_authority",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_update BEFORE UPDATE ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_update()",
    functionName: "guard_food_source_release_update",
    name: "food_source_release_guard_update",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_reject_delete BEFORE DELETE ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_source_release_reject_delete",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_reject_new_legacy_unbound BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    functionName: "reject_new_legacy_unbound_catalogue_evidence",
    name: "food_source_release_reject_new_legacy_unbound",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_activation_guard_authority BEFORE INSERT ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_activation_authority()",
    functionName: "guard_food_source_release_activation_authority",
    name: "food_source_release_activation_guard_authority",
    tableName: "food_source_release_activation",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_activation_reject_update BEFORE DELETE OR UPDATE ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_source_release_activation_reject_update",
    tableName: "food_source_release_activation",
  },
];

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEWER_CLASSES = ["data", "quality", "rights"] as const;
const NON_REVIEWER_CLASSES = ["api", "unassigned", "worker"] as const;

export type CatalogueReviewerClass = (typeof REVIEWER_CLASSES)[number];
export type CatalogueNonReviewerClass = (typeof NON_REVIEWER_CLASSES)[number];

export interface CatalogueAuthorityDeploymentPolicy {
  readonly activationGuardSourceSha256: string;
  readonly applicationSchema: string;
  readonly applicationSchemaOwner: "pg_database_owner";
  readonly approvalFunctionSourceSha256: string;
  readonly approvalGuardSourceSha256: string;
  readonly databaseName: string;
  readonly databaseOwner: string;
  readonly effectiveLoginAllowlist: readonly string[];
  readonly nonReviewerLogins: Readonly<Record<CatalogueNonReviewerClass, string>>;
  readonly observeValidationFunctionSourceSha256: string;
  readonly policyKind: "catalogue-authority-deployment";
  readonly promotionFunctionSourceSha256: string;
  readonly reviewerLogins: Readonly<Record<CatalogueReviewerClass, string>>;
  readonly rollbackFunctionSourceSha256: string;
  readonly schemaVersion: 5;
  readonly stageBatchFunctionSourceSha256: string;
  readonly stageParserReportFunctionSourceSha256: string;
  readonly stageRecordChunkFunctionSourceSha256: string;
  readonly stageValidateGuardSourceSha256: string;
  readonly validateBatchFunctionSourceSha256: string;
}

export interface CatalogueRoleMembershipEvidence {
  readonly adminOption: boolean;
  readonly grantor: string;
  readonly inheritOption: boolean;
  readonly member: string;
  readonly role: string;
  readonly setOption: boolean;
}

export interface CatalogueAclEvidence {
  readonly grantable: boolean;
  readonly grantee: string;
  readonly grantor: string;
  readonly privilege: string;
}

export interface CatalogueCapabilityRoleEvidence {
  readonly bypassRls: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canLogin: boolean;
  readonly incomingMemberships: readonly CatalogueRoleMembershipEvidence[];
  readonly name: CatalogueCapabilityRole;
  readonly outgoingMemberships: readonly string[];
  readonly ownedObjectCount: number;
  readonly replication: boolean;
  readonly superuser: boolean;
}

export interface CatalogueLoginEvidence {
  readonly approvalFunctionExecute: boolean;
  readonly bypassRls: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canLogin: boolean;
  readonly effectiveColumnPrivileges: readonly string[];
  readonly effectiveSequencePrivileges: readonly string[];
  readonly effectiveTablePrivileges: readonly string[];
  readonly inherit: boolean;
  readonly memberships: readonly CatalogueRoleMembershipEvidence[];
  readonly name: string;
  readonly ownedObjectCount: number;
  readonly replication: boolean;
  readonly schemaCreate: boolean;
  readonly schemaUsage: boolean;
  readonly superuser: boolean;
}

export interface CatalogueFunctionEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly aclIsDefault: boolean;
  readonly arguments: string;
  readonly language: string;
  readonly leakproof: boolean;
  readonly name: string;
  readonly owner: string;
  readonly parallel: string;
  readonly publicExecute: boolean;
  readonly resultType: string;
  readonly searchPath: readonly string[];
  readonly securityDefiner: boolean;
  readonly sourceSha256: string;
  readonly strict: boolean;
  readonly volatility: string;
}

export interface CatalogueRelationEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly aclIsDefault: boolean;
  readonly kind: string;
  readonly name: string;
  readonly owner: string;
}

export interface CatalogueTypeEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly aclIsDefault: boolean;
  readonly kind: string;
  readonly name: string;
  readonly owner: string;
}

export interface CatalogueDefaultAclEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly objectType: string;
  readonly owner: string;
  readonly schemaName: string;
}

export interface CatalogueColumnAclEvidence extends CatalogueAclEvidence {
  readonly columnName: string;
  readonly relationName: string;
}

export interface CatalogueTriggerEvidence {
  readonly definition: string;
  readonly enabled: string;
  readonly functionArguments: string;
  readonly functionName: string;
  readonly functionSchema: string;
  readonly name: string;
  readonly tableName: string;
  readonly tableSchema: string;
}

export interface CatalogueAuthorityConstraintEvidence {
  readonly constraintType: string;
  readonly definition: string;
  readonly name: string;
  readonly tableName: string;
  readonly validated: boolean;
}

export interface CatalogueAuthorityFrozenColumnEvidence {
  readonly columnName: string;
  readonly dataType: string;
  readonly defaultExpression: string | null;
  readonly notNull: boolean;
  readonly schemaName: string;
  readonly tableName: string;
}

export interface CatalogueAuthorityIndexEvidence {
  readonly accessMethod: string;
  readonly definition: string;
  readonly isPrimary: boolean;
  readonly isReady: boolean;
  readonly isUnique: boolean;
  readonly isValid: boolean;
  readonly keyAttributeCount: number;
  readonly keyExpression: string;
  readonly name: string;
  readonly owner: string;
  readonly predicate: string | null;
  readonly schemaName: string;
  readonly tableName: string;
  readonly totalAttributeCount: number;
}

export interface CatalogueAuthorityDeploymentEvidence {
  readonly applicationSchema: {
    readonly acl: readonly CatalogueAclEvidence[];
    readonly name: string;
    readonly owner: string;
    readonly publicCreate: boolean;
  };
  readonly authorityConstraints: readonly CatalogueAuthorityConstraintEvidence[];
  readonly authorityFrozenColumns: readonly CatalogueAuthorityFrozenColumnEvidence[];
  readonly authorityIndexes: readonly CatalogueAuthorityIndexEvidence[];
  readonly functions: readonly CatalogueFunctionEvidence[];
  readonly triggers: readonly CatalogueTriggerEvidence[];
  readonly capabilityRoles: readonly CatalogueCapabilityRoleEvidence[];
  readonly columnAcls: readonly CatalogueColumnAclEvidence[];
  readonly database: {
    readonly acl: readonly CatalogueAclEvidence[];
    readonly effectiveLoginAllowlist: readonly string[];
    readonly name: string;
    readonly owner: string;
    readonly publicConnect: boolean;
    readonly unexpectedClientSessionCount: number;
    readonly verifierSessions: readonly {
      readonly applicationName: string;
      readonly login: string;
      readonly pid: number;
    }[];
  };
  readonly defaultAcls: readonly CatalogueDefaultAclEvidence[];
  readonly explicitColumnAclAttributeCount: number;
  readonly logins: readonly CatalogueLoginEvidence[];
  readonly memberships: readonly CatalogueRoleMembershipEvidence[];
  readonly nonSystemSchemas: readonly string[];
  readonly policySha256: string;
  readonly relations: readonly CatalogueRelationEvidence[];
  readonly schemaVersion: 5;
  readonly types: readonly CatalogueTypeEvidence[];
}

export interface CatalogueAuthorityStableVerifierSessionEvidence {
  readonly applicationName: string;
  readonly login: string;
}

export type CatalogueAuthorityDeploymentStructureEvidence = Omit<
  CatalogueAuthorityDeploymentEvidence,
  "database"
> & {
  readonly database: Omit<CatalogueAuthorityDeploymentEvidence["database"], "verifierSessions"> & {
    readonly verifierSessions: readonly CatalogueAuthorityStableVerifierSessionEvidence[];
  };
};

export type CatalogueAuthorityCanaryName =
  | "api-execute"
  | "data-direct-dml"
  | "data-matching"
  | "data-requesting-quality"
  | "quality-matching"
  | "rights-matching"
  | "unassigned-execute"
  | "worker-execute";

export interface CatalogueAuthorityCanaryEvidence {
  readonly afterApprovalRowCount: string;
  readonly afterStructureSha256: string;
  readonly beforeApprovalRowCount: string;
  readonly beforeStructureSha256: string;
  readonly policySha256: string;
  readonly results: readonly {
    readonly canary: CatalogueAuthorityCanaryName;
    readonly sqlstate: "23503" | "42501";
  }[];
  readonly schemaVersion: 5;
  readonly structure: CatalogueAuthorityDeploymentStructureEvidence;
}

export function parseCatalogueAuthorityDeploymentPolicy(
  value: unknown,
): CatalogueAuthorityDeploymentPolicy {
  const policy = exactRecord(value, "catalogue authority deployment policy", [
    "activationGuardSourceSha256",
    "applicationSchema",
    "applicationSchemaOwner",
    "approvalFunctionSourceSha256",
    "approvalGuardSourceSha256",
    "databaseName",
    "databaseOwner",
    "effectiveLoginAllowlist",
    "nonReviewerLogins",
    "observeValidationFunctionSourceSha256",
    "policyKind",
    "promotionFunctionSourceSha256",
    "reviewerLogins",
    "rollbackFunctionSourceSha256",
    "schemaVersion",
    "stageBatchFunctionSourceSha256",
    "stageParserReportFunctionSourceSha256",
    "stageRecordChunkFunctionSourceSha256",
    "stageValidateGuardSourceSha256",
    "validateBatchFunctionSourceSha256",
  ]);
  if (policy.policyKind !== "catalogue-authority-deployment" || policy.schemaVersion !== 5) {
    throw new Error("Catalogue authority deployment policy identity is unsupported");
  }
  if (
    policy.applicationSchema !== "public" ||
    policy.applicationSchemaOwner !== "pg_database_owner"
  ) {
    throw new Error(
      "Catalogue authority DEPLOY-0 requires the canonical public schema owned by pg_database_owner",
    );
  }
  const reviewerLogins = identifierMap(policy.reviewerLogins, REVIEWER_CLASSES, "reviewerLogins");
  const nonReviewerLogins = identifierMap(
    policy.nonReviewerLogins,
    NON_REVIEWER_CLASSES,
    "nonReviewerLogins",
  );
  const databaseOwner = identifier(policy.databaseOwner, "databaseOwner");
  const namedLogins = [
    databaseOwner,
    ...REVIEWER_CLASSES.map((role) => reviewerLogins[role]),
    ...NON_REVIEWER_CLASSES.map((role) => nonReviewerLogins[role]),
  ];
  if (new Set(namedLogins).size !== namedLogins.length) {
    throw new Error("Catalogue authority deployment login identifiers must be distinct");
  }
  const effectiveLoginAllowlist = identifierArray(
    policy.effectiveLoginAllowlist,
    "effectiveLoginAllowlist",
  );
  for (const login of namedLogins) {
    if (!effectiveLoginAllowlist.includes(login)) {
      throw new Error(`effectiveLoginAllowlist is missing required login ${login}`);
    }
  }
  const approvalFunctionSourceSha256 = sha256(
    policy.approvalFunctionSourceSha256,
    "approvalFunctionSourceSha256",
  );
  const approvalGuardSourceSha256 = sha256(
    policy.approvalGuardSourceSha256,
    "approvalGuardSourceSha256",
  );
  const promotionFunctionSourceSha256 = sha256(
    policy.promotionFunctionSourceSha256,
    "promotionFunctionSourceSha256",
  );
  const rollbackFunctionSourceSha256 = sha256(
    policy.rollbackFunctionSourceSha256,
    "rollbackFunctionSourceSha256",
  );
  const activationGuardSourceSha256 = sha256(
    policy.activationGuardSourceSha256,
    "activationGuardSourceSha256",
  );
  const observeValidationFunctionSourceSha256 = sha256(
    policy.observeValidationFunctionSourceSha256,
    "observeValidationFunctionSourceSha256",
  );
  const stageBatchFunctionSourceSha256 = sha256(
    policy.stageBatchFunctionSourceSha256,
    "stageBatchFunctionSourceSha256",
  );
  const stageParserReportFunctionSourceSha256 = sha256(
    policy.stageParserReportFunctionSourceSha256,
    "stageParserReportFunctionSourceSha256",
  );
  const stageRecordChunkFunctionSourceSha256 = sha256(
    policy.stageRecordChunkFunctionSourceSha256,
    "stageRecordChunkFunctionSourceSha256",
  );
  const stageValidateGuardSourceSha256 = sha256(
    policy.stageValidateGuardSourceSha256,
    "stageValidateGuardSourceSha256",
  );
  const validateBatchFunctionSourceSha256 = sha256(
    policy.validateBatchFunctionSourceSha256,
    "validateBatchFunctionSourceSha256",
  );
  if (
    approvalFunctionSourceSha256 !== CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256 ||
    approvalGuardSourceSha256 !== CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256 ||
    promotionFunctionSourceSha256 !== CATALOGUE_PROMOTION_FUNCTION_SOURCE_SHA256 ||
    rollbackFunctionSourceSha256 !== CATALOGUE_ROLLBACK_FUNCTION_SOURCE_SHA256 ||
    activationGuardSourceSha256 !== CATALOGUE_ACTIVATION_GUARD_SOURCE_SHA256 ||
    observeValidationFunctionSourceSha256 !== CATALOGUE_OBSERVE_VALIDATION_FUNCTION_SOURCE_SHA256 ||
    stageBatchFunctionSourceSha256 !== CATALOGUE_STAGE_BATCH_FUNCTION_SOURCE_SHA256 ||
    stageParserReportFunctionSourceSha256 !==
      CATALOGUE_STAGE_PARSER_REPORT_FUNCTION_SOURCE_SHA256 ||
    stageRecordChunkFunctionSourceSha256 !== CATALOGUE_STAGE_RECORD_CHUNK_FUNCTION_SOURCE_SHA256 ||
    stageValidateGuardSourceSha256 !== CATALOGUE_STAGE_VALIDATE_GUARD_SOURCE_SHA256 ||
    validateBatchFunctionSourceSha256 !== CATALOGUE_VALIDATE_BATCH_FUNCTION_SOURCE_SHA256
  ) {
    throw new Error("Catalogue authority deployment function digests differ from source policy");
  }
  return {
    activationGuardSourceSha256,
    applicationSchema: "public",
    applicationSchemaOwner: "pg_database_owner",
    approvalFunctionSourceSha256,
    approvalGuardSourceSha256,
    databaseName: identifier(policy.databaseName, "databaseName"),
    databaseOwner,
    effectiveLoginAllowlist,
    nonReviewerLogins,
    observeValidationFunctionSourceSha256,
    policyKind: "catalogue-authority-deployment",
    promotionFunctionSourceSha256,
    reviewerLogins,
    rollbackFunctionSourceSha256,
    schemaVersion: 5,
    stageBatchFunctionSourceSha256,
    stageParserReportFunctionSourceSha256,
    stageRecordChunkFunctionSourceSha256,
    stageValidateGuardSourceSha256,
    validateBatchFunctionSourceSha256,
  };
}

export function catalogueAuthorityDeploymentPolicySha256(
  policy: CatalogueAuthorityDeploymentPolicy,
): string {
  return digest(policy as unknown as JsonValue);
}

export function catalogueAuthorityDeploymentStructureSha256(
  evidence: CatalogueAuthorityDeploymentEvidence,
): string {
  return digest(catalogueAuthorityDeploymentStructure(evidence) as unknown as JsonValue);
}

export function catalogueAuthorityDeploymentStructure(
  evidence: CatalogueAuthorityDeploymentEvidence,
): CatalogueAuthorityDeploymentStructureEvidence {
  const verifierSessions = evidence.database.verifierSessions
    .map(({ applicationName, login }) => ({ applicationName, login }))
    .sort((left, right) => {
      if (left.applicationName !== right.applicationName) {
        return left.applicationName < right.applicationName ? -1 : 1;
      }
      if (left.login === right.login) return 0;
      return left.login < right.login ? -1 : 1;
    });
  return {
    applicationSchema: evidence.applicationSchema,
    authorityConstraints: evidence.authorityConstraints,
    authorityFrozenColumns: evidence.authorityFrozenColumns,
    authorityIndexes: evidence.authorityIndexes,
    capabilityRoles: evidence.capabilityRoles,
    columnAcls: evidence.columnAcls,
    database: {
      acl: evidence.database.acl,
      effectiveLoginAllowlist: evidence.database.effectiveLoginAllowlist,
      name: evidence.database.name,
      owner: evidence.database.owner,
      publicConnect: evidence.database.publicConnect,
      unexpectedClientSessionCount: evidence.database.unexpectedClientSessionCount,
      verifierSessions,
    },
    defaultAcls: evidence.defaultAcls,
    explicitColumnAclAttributeCount: evidence.explicitColumnAclAttributeCount,
    functions: evidence.functions,
    logins: evidence.logins,
    memberships: evidence.memberships,
    nonSystemSchemas: evidence.nonSystemSchemas,
    policySha256: evidence.policySha256,
    relations: evidence.relations,
    schemaVersion: evidence.schemaVersion,
    triggers: evidence.triggers,
    types: evidence.types,
  };
}

export function assertCatalogueAuthorityDeploymentEvidence(
  policy: CatalogueAuthorityDeploymentPolicy,
  evidence: CatalogueAuthorityDeploymentEvidence,
): void {
  if (
    evidence.schemaVersion !== 5 ||
    evidence.policySha256 !== catalogueAuthorityDeploymentPolicySha256(policy)
  ) {
    throw new Error("Catalogue authority deployment evidence identity differs");
  }
  if (
    evidence.database.name !== policy.databaseName ||
    evidence.database.owner !== policy.databaseOwner ||
    evidence.database.publicConnect
  ) {
    throw new Error("Catalogue authority database identity or CONNECT policy differs");
  }
  assertExactStrings(
    evidence.database.effectiveLoginAllowlist,
    policy.effectiveLoginAllowlist,
    "effective database login allowlist",
  );
  assertExactAcl(
    evidence.database.acl,
    [
      expectedAcl("PUBLIC", policy.databaseOwner, "TEMPORARY"),
      expectedAcl(policy.databaseOwner, policy.databaseOwner, "CONNECT"),
      expectedAcl(policy.databaseOwner, policy.databaseOwner, "CREATE"),
      expectedAcl(policy.databaseOwner, policy.databaseOwner, "TEMPORARY"),
      ...REVIEWER_CLASSES.map((role) =>
        expectedAcl(policy.reviewerLogins[role], policy.databaseOwner, "CONNECT"),
      ),
      ...NON_REVIEWER_CLASSES.map((role) =>
        expectedAcl(policy.nonReviewerLogins[role], policy.databaseOwner, "CONNECT"),
      ),
    ],
    "database ACL",
  );
  if (evidence.database.unexpectedClientSessionCount !== 0) {
    throw new Error("Catalogue authority deployment has unexpected database sessions");
  }
  assertVerifierSessions(evidence.database.verifierSessions, policy);
  assertExactStrings(
    evidence.nonSystemSchemas,
    [policy.applicationSchema],
    "non-system schema set",
  );
  if (
    evidence.applicationSchema.name !== policy.applicationSchema ||
    evidence.applicationSchema.owner !== policy.applicationSchemaOwner ||
    evidence.applicationSchema.publicCreate
  ) {
    throw new Error("Catalogue authority application schema policy differs");
  }
  assertExactAcl(
    evidence.applicationSchema.acl,
    [
      expectedAcl("PUBLIC", policy.applicationSchemaOwner, "USAGE"),
      ...REVIEWER_CLASSES.map((role) =>
        expectedAcl(CATALOGUE_REVIEWER_CAPABILITIES[role], policy.applicationSchemaOwner, "USAGE"),
      ),
      expectedAcl("nutrition_catalogue_stage", policy.applicationSchemaOwner, "USAGE"),
      expectedAcl("nutrition_catalogue_validate", policy.applicationSchemaOwner, "USAGE"),
      expectedAcl("nutrition_catalogue_promote_activate", policy.applicationSchemaOwner, "USAGE"),
      expectedAcl("nutrition_catalogue_rollback", policy.applicationSchemaOwner, "USAGE"),
      expectedAcl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "CREATE"),
      expectedAcl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "USAGE"),
    ],
    "application schema ACL",
  );

  const expectedMemberships = REVIEWER_CLASSES.map((reviewerClass) => ({
    adminOption: false,
    grantor: policy.databaseOwner,
    inheritOption: true,
    member: policy.reviewerLogins[reviewerClass],
    role: CATALOGUE_REVIEWER_CAPABILITIES[reviewerClass],
    setOption: false,
  }));
  assertExactMembershipGraph(evidence.memberships, expectedMemberships);
  assertCatalogueAuthorityStructure(policy, evidence);

  const roleByName = new Map(evidence.capabilityRoles.map((role) => [role.name, role]));
  if (
    roleByName.size !== CATALOGUE_CAPABILITY_ROLES.length ||
    evidence.capabilityRoles.length !== CATALOGUE_CAPABILITY_ROLES.length
  ) {
    throw new Error("Catalogue capability role set has missing or duplicate entries");
  }
  for (const roleName of CATALOGUE_CAPABILITY_ROLES) {
    const role = roleByName.get(roleName);
    if (
      !role ||
      role.canLogin ||
      role.superuser ||
      role.canCreateDatabase ||
      role.canCreateRole ||
      role.replication ||
      role.bypassRls ||
      role.ownedObjectCount !== 0
    ) {
      throw new Error(`Catalogue capability role ${roleName} is unsafe`);
    }
    if (role.outgoingMemberships.length !== 0) {
      throw new Error(`Catalogue capability role ${roleName} has outgoing membership`);
    }
    const reviewerClass = REVIEWER_CLASSES.find(
      (candidate) => CATALOGUE_REVIEWER_CAPABILITIES[candidate] === roleName,
    );
    assertMemberships(
      role.incomingMemberships,
      roleName,
      reviewerClass ? [policy.reviewerLogins[reviewerClass]] : [],
      policy.databaseOwner,
    );
  }

  const expectedLogins = [
    ...REVIEWER_CLASSES.map((role) => policy.reviewerLogins[role]),
    ...NON_REVIEWER_CLASSES.map((role) => policy.nonReviewerLogins[role]),
  ].sort();
  const loginByName = new Map(evidence.logins.map((login) => [login.name, login]));
  if (
    loginByName.size !== expectedLogins.length ||
    evidence.logins.length !== expectedLogins.length
  ) {
    throw new Error("Catalogue deployment login evidence has missing or duplicate entries");
  }
  for (const loginName of expectedLogins) {
    const login = loginByName.get(loginName);
    if (
      !login?.canLogin ||
      !login.inherit ||
      login.superuser ||
      login.canCreateDatabase ||
      login.canCreateRole ||
      login.replication ||
      login.bypassRls ||
      login.ownedObjectCount !== 0 ||
      login.schemaCreate ||
      !login.schemaUsage ||
      login.effectiveTablePrivileges.length !== 0 ||
      login.effectiveColumnPrivileges.length !== 0 ||
      login.effectiveSequencePrivileges.length !== 0
    ) {
      throw new Error(`Catalogue deployment login ${loginName} is unsafe`);
    }
    const reviewerClass = REVIEWER_CLASSES.find(
      (candidate) => policy.reviewerLogins[candidate] === loginName,
    );
    if (reviewerClass) {
      if (!login.approvalFunctionExecute) {
        throw new Error(`Reviewer login ${loginName} cannot execute its approval function`);
      }
      assertMemberships(
        login.memberships,
        CATALOGUE_REVIEWER_CAPABILITIES[reviewerClass],
        [loginName],
        policy.databaseOwner,
      );
    } else {
      if (login.approvalFunctionExecute) {
        throw new Error(`Non-reviewer login ${loginName} can execute the approval function`);
      }
      if (login.memberships.length !== 0) {
        throw new Error(`Non-reviewer login ${loginName} has a catalogue capability`);
      }
    }
  }
}

export function assertCatalogueAuthorityCanaryEvidence(
  policy: CatalogueAuthorityDeploymentPolicy,
  evidence: CatalogueAuthorityCanaryEvidence,
): void {
  if (
    evidence.schemaVersion !== 5 ||
    evidence.policySha256 !== catalogueAuthorityDeploymentPolicySha256(policy)
  ) {
    throw new Error("Catalogue authority canary evidence identity differs");
  }
  if (
    evidence.beforeStructureSha256 !== evidence.afterStructureSha256 ||
    evidence.beforeApprovalRowCount !== evidence.afterApprovalRowCount
  ) {
    throw new Error("Catalogue authority canaries changed protected database state");
  }
  const persistedStructureSha256 = digest(evidence.structure as unknown as JsonValue);
  if (evidence.beforeStructureSha256 !== persistedStructureSha256) {
    throw new Error("Catalogue authority canary structure digest binding differs");
  }
  assertCatalogueAuthorityDeploymentStructureEvidence(policy, evidence.structure);
  const expected = new Map<CatalogueAuthorityCanaryName, "23503" | "42501">([
    ["data-matching", "23503"],
    ["quality-matching", "23503"],
    ["rights-matching", "23503"],
    ["data-requesting-quality", "42501"],
    ["unassigned-execute", "42501"],
    ["api-execute", "42501"],
    ["worker-execute", "42501"],
    ["data-direct-dml", "42501"],
  ]);
  if (evidence.results.length !== expected.size) {
    throw new Error("Catalogue authority canary result set differs");
  }
  for (const result of evidence.results) {
    if (expected.get(result.canary) !== result.sqlstate) {
      throw new Error(`Catalogue authority canary ${result.canary} did not fail closed`);
    }
    expected.delete(result.canary);
  }
  if (expected.size !== 0) throw new Error("Catalogue authority canary result is missing");
}

function assertCatalogueAuthorityDeploymentStructureEvidence(
  policy: CatalogueAuthorityDeploymentPolicy,
  structure: CatalogueAuthorityDeploymentStructureEvidence,
): void {
  const deploymentEvidence: CatalogueAuthorityDeploymentEvidence = {
    ...structure,
    database: {
      ...structure.database,
      verifierSessions: structure.database.verifierSessions.map((session, index) => ({
        ...session,
        pid: index + 1,
      })),
    },
  };
  assertCatalogueAuthorityDeploymentEvidence(policy, deploymentEvidence);
  if (
    canonicalJson(
      catalogueAuthorityDeploymentStructure(deploymentEvidence) as unknown as JsonValue,
    ) !== canonicalJson(structure as unknown as JsonValue)
  ) {
    throw new Error("Catalogue authority canary structure is not canonical");
  }
}

function assertCatalogueAuthorityStructure(
  policy: CatalogueAuthorityDeploymentPolicy,
  evidence: CatalogueAuthorityDeploymentEvidence,
): void {
  if (
    canonicalJson(evidence.authorityConstraints as unknown as JsonValue) !==
    canonicalJson(CATALOGUE_AUTHORITY_CONSTRAINT_POLICY as unknown as JsonValue)
  ) {
    throw new Error("Catalogue materialization or activation constraint differs from policy");
  }
  if (
    canonicalJson(evidence.authorityFrozenColumns as unknown as JsonValue) !==
    canonicalJson(CATALOGUE_AUTHORITY_FROZEN_COLUMN_POLICY as unknown as JsonValue)
  ) {
    throw new Error("Catalogue frozen materialization column differs from policy");
  }
  if (
    canonicalJson(evidence.authorityIndexes as unknown as JsonValue) !==
    canonicalJson(
      CATALOGUE_AUTHORITY_INDEX_POLICY.map((index) => ({
        ...index,
        owner: policy.databaseOwner,
      })) as unknown as JsonValue,
    )
  ) {
    throw new Error("Catalogue authority index differs from policy");
  }
  if (evidence.defaultAcls.length !== 0) {
    throw new Error("Catalogue authority database has unreviewed default ACLs");
  }
  if (evidence.columnAcls.length !== 0 || evidence.explicitColumnAclAttributeCount !== 0) {
    throw new Error("Catalogue authority database has explicit column ACLs");
  }

  const relationByName = new Map(evidence.relations.map((relation) => [relation.name, relation]));
  if (
    relationByName.size !== evidence.relations.length ||
    !evidence.relations.some((relation) => relation.kind === "S") ||
    !evidence.relations.some((relation) => relation.kind === "r" || relation.kind === "p")
  ) {
    throw new Error("Catalogue authority relation set is malformed");
  }
  for (const [name, kind] of [
    ["food_import_batch", "r"],
    ["food_import_approval", "r"],
    ["food_import_record", "r"],
    ["food_source", "r"],
    ["food_source_release", "r"],
    ["food_source_release_activation", "r"],
    ["food_import_approval_id_seq", "S"],
    ["food_source_release_activation_id_seq", "S"],
  ] as const) {
    if (relationByName.get(name)?.kind !== kind) {
      throw new Error(`Catalogue authority relation ${name} is unavailable`);
    }
  }
  for (const relation of evidence.relations) {
    if (
      relation.owner !== policy.databaseOwner ||
      !relation.aclIsDefault ||
      relation.acl.some(
        (entry) =>
          entry.grantee !== policy.databaseOwner ||
          entry.grantor !== policy.databaseOwner ||
          entry.grantable,
      )
    ) {
      throw new Error(`Catalogue relation ${relation.name} owner or ACL differs from policy`);
    }
  }

  if (
    evidence.types.length === 0 ||
    new Set(evidence.types.map((type) => `${type.name}:${type.kind}`)).size !==
      evidence.types.length
  ) {
    throw new Error("Catalogue authority type set is malformed");
  }
  for (const type of evidence.types) {
    if (
      type.owner !== policy.databaseOwner ||
      !type.aclIsDefault ||
      type.acl.some(
        (entry) =>
          ![policy.databaseOwner, "PUBLIC"].includes(entry.grantee) ||
          entry.grantor !== policy.databaseOwner ||
          entry.privilege !== "USAGE" ||
          entry.grantable,
      )
    ) {
      throw new Error(`Catalogue type ${type.name} owner or ACL differs from policy`);
    }
  }

  const authorityFunctionNames = new Set(
    CATALOGUE_AUTHORITY_FUNCTION_POLICY.map((entry) => entry.name),
  );
  const authorityFunctions = evidence.functions.filter((entry) =>
    authorityFunctionNames.has(entry.name),
  );
  const functionByName = new Map(
    authorityFunctions.map((authorityFunction) => [authorityFunction.name, authorityFunction]),
  );
  if (
    functionByName.size !== CATALOGUE_AUTHORITY_FUNCTION_POLICY.length ||
    authorityFunctions.length !== CATALOGUE_AUTHORITY_FUNCTION_POLICY.length ||
    new Set(evidence.functions.map((entry) => `${entry.name}(${entry.arguments})`)).size !==
      evidence.functions.length
  ) {
    throw new Error("Catalogue authority function set has missing or unexpected overloads");
  }
  for (const actual of evidence.functions) {
    if (actual.owner !== policy.databaseOwner) {
      throw new Error(`Catalogue function ${actual.name} has an unexpected owner`);
    }
    const expected = CATALOGUE_AUTHORITY_FUNCTION_POLICY.find(
      (entry) => entry.name === actual.name,
    );
    if (!expected) {
      if (actual.securityDefiner || !actual.aclIsDefault) {
        throw new Error(`Non-authority function ${actual.name} has unexpected authority`);
      }
      continue;
    }
    const expectedSearchPath =
      expected.configuration === "application-schema"
        ? [`search_path=pg_catalog, ${policy.applicationSchema}, pg_temp`]
        : [];
    if (
      actual.arguments !== expected.arguments ||
      actual.resultType !== expected.resultType ||
      actual.language !== expected.language ||
      actual.volatility !== expected.volatility ||
      actual.strict !== expected.strict ||
      actual.leakproof !== expected.leakproof ||
      actual.parallel !== expected.parallel ||
      actual.securityDefiner !== expected.securityDefiner ||
      actual.sourceSha256 !== expected.sourceSha256 ||
      canonicalJson(actual.searchPath as unknown as JsonValue) !== canonicalJson(expectedSearchPath)
    ) {
      throw new Error(`Catalogue authority function ${expected.name} differs from policy`);
    }
    const aclIsDefault = expected.executeGrantees === "default";
    if (actual.aclIsDefault !== aclIsDefault || actual.publicExecute !== aclIsDefault) {
      throw new Error(`Catalogue authority function ${expected.name} ACL representation differs`);
    }
    const grantees =
      expected.executeGrantees === "default"
        ? ["PUBLIC", policy.databaseOwner]
        : expected.executeGrantees === "owner-only"
          ? [policy.databaseOwner]
          : [policy.databaseOwner, ...expected.executeGrantees];
    assertExactAcl(
      actual.acl,
      grantees.map((grantee) => expectedAcl(grantee, policy.databaseOwner, "EXECUTE")),
      `${expected.name} ACL`,
    );
  }

  const triggerByName = new Map(evidence.triggers.map((trigger) => [trigger.name, trigger]));
  if (
    triggerByName.size !== CATALOGUE_AUTHORITY_TRIGGER_POLICY.length ||
    evidence.triggers.length !== CATALOGUE_AUTHORITY_TRIGGER_POLICY.length
  ) {
    throw new Error("Catalogue authority trigger set has missing or unexpected entries");
  }
  for (const expected of CATALOGUE_AUTHORITY_TRIGGER_POLICY) {
    const actual = triggerByName.get(expected.name);
    if (
      !actual ||
      actual.tableSchema !== policy.applicationSchema ||
      actual.tableName !== expected.tableName ||
      actual.functionSchema !== policy.applicationSchema ||
      actual.functionName !== expected.functionName ||
      actual.functionArguments !== "" ||
      actual.enabled !== "O" ||
      actual.definition !== expected.definition
    ) {
      throw new Error(`Catalogue authority trigger ${expected.name} differs from policy`);
    }
  }
}

function assertMemberships(
  actual: readonly CatalogueRoleMembershipEvidence[],
  role: CatalogueCapabilityRole,
  expectedMembers: readonly string[],
  expectedGrantor: string,
): void {
  if (actual.length !== expectedMembers.length) {
    throw new Error(`Catalogue capability ${role} membership differs`);
  }
  const members = actual.map((membership) => {
    if (
      membership.role !== role ||
      membership.grantor !== expectedGrantor ||
      membership.adminOption ||
      !membership.inheritOption ||
      membership.setOption
    ) {
      throw new Error(`Catalogue capability ${role} membership options differ`);
    }
    return membership.member;
  });
  assertExactStrings(members, expectedMembers, `${role} members`);
}

function assertExactMembershipGraph(
  actual: readonly CatalogueRoleMembershipEvidence[],
  expected: readonly CatalogueRoleMembershipEvidence[],
): void {
  const tokens = (memberships: readonly CatalogueRoleMembershipEvidence[]) =>
    memberships.map((membership) => canonicalJson(membership as unknown as JsonValue));
  assertExactStrings(tokens(actual), tokens(expected), "catalogue membership graph");
}

function assertVerifierSessions(
  actual: CatalogueAuthorityDeploymentEvidence["database"]["verifierSessions"],
  policy: CatalogueAuthorityDeploymentPolicy,
): void {
  const expected = [
    { applicationName: "catalogue-authority-deploy-zero-owner", login: policy.databaseOwner },
    ...REVIEWER_CLASSES.map((role) => ({
      applicationName: `catalogue-authority-deploy-zero-${role}`,
      login: policy.reviewerLogins[role],
    })),
    ...NON_REVIEWER_CLASSES.map((role) => ({
      applicationName: `catalogue-authority-deploy-zero-${role}`,
      login: policy.nonReviewerLogins[role],
    })),
  ];
  if (
    actual.length !== expected.length ||
    new Set(actual.map((session) => session.pid)).size !== expected.length ||
    actual.some((session) => !Number.isSafeInteger(session.pid) || session.pid <= 0)
  ) {
    throw new Error("Catalogue authority verifier session set differs");
  }
  assertExactStrings(
    actual.map((session) => `${session.login}:${session.applicationName}`),
    expected.map((session) => `${session.login}:${session.applicationName}`),
    "catalogue authority verifier sessions",
  );
}

function expectedAcl(grantee: string, grantor: string, privilege: string): CatalogueAclEvidence {
  return { grantable: false, grantee, grantor, privilege };
}

function assertExactAcl(
  actual: readonly CatalogueAclEvidence[],
  expected: readonly CatalogueAclEvidence[],
  label: string,
): void {
  const tokens = (entries: readonly CatalogueAclEvidence[]) =>
    entries.map((entry) => canonicalJson(entry as unknown as JsonValue));
  assertExactStrings(tokens(actual), tokens(expected), label);
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  assertExactStrings(Object.keys(record), keys, `${label} fields`);
  return record;
}

function identifierMap<K extends string>(
  value: unknown,
  keys: readonly K[],
  label: string,
): Readonly<Record<K, string>> {
  const record = exactRecord(value, label, keys);
  return Object.fromEntries(
    keys.map((key) => [key, identifier(record[key], `${label}.${key}`)]),
  ) as Readonly<Record<K, string>>;
}

function identifierArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be non-empty`);
  const result = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique`);
  const sorted = [...result].sort();
  if (result.some((entry, index) => entry !== sorted[index])) {
    throw new Error(`${label} must be sorted`);
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || value.startsWith("pg_")) {
    throw new Error(`${label} must be a safe PostgreSQL identifier`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertExactStrings(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} differs from policy`);
  }
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
