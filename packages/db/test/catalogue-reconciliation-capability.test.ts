import { createHash } from "node:crypto";
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  type Selectable,
} from "kysely";
import { describe, expect, it } from "vitest";
import {
  type PreparedCatalogueValidationRequest,
  parsePreparedCatalogueValidationRequest,
} from "../src/catalogue-capability-validation.js";
import {
  type BatchRecordValidation,
  type BatchValidationPolicy,
  nutrientMappingRevisionDigest,
  reconcileCatalogueBatch,
} from "../src/catalogue-ingestion.js";
import {
  canonicalJson,
  sha256CanonicalJson,
  type ValidatedCatalogueFood,
  validateCatalogueRecord,
} from "../src/catalogue-validation.js";
import type {
  Database,
  FoodImportBatchTable,
  FoodImportParserReportTable,
  FoodImportRecordTable,
  FoodSourceReleaseTable,
  JsonObject,
  JsonValue,
} from "../src/types.js";

const BATCH = "12345678-1234-4234-8234-123456789abc";
const BASELINE_BATCH = "32345678-1234-4234-8234-123456789abc";
const RELEASE = "42345678-1234-4234-8234-123456789abc";
const REVISION = "22345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const TOKEN = "b".repeat(64);
const KEY = "FDC:2026-04-30:Foundation:123";
const POLICY: BatchValidationPolicy = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0,
  maximumQuarantinedRecords: 0,
  requireAtLeastOneValidRecord: true,
  requireDistinctApprovalPrincipals: true,
  requireMaterializedNutrientPerValidRecord: true,
};
const MAPPING = {
  canonicalUnit: "g",
  conversionMultiplier: "1.000000000000",
  nutrientCode: "protein",
  nutrientDimension: "mass",
  nutrientId: "1",
  nutrientName: "Protein",
  revisionId: REVISION,
  sourceNutrientKey: "1003",
  sourceUnit: "g",
};
const MAPPING_HASH = nutrientMappingRevisionDigest([MAPPING]);
const TIME = new Date("2026-09-21T00:00:00Z");
const EXPIRY = "2026-09-21T12:00:00+00:00";
type Mutable = { [key: string]: JsonValue };
function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}

function fixture(withBaseline = false) {
  const payload: JsonObject = {
    basis: { amount: "100", unit: "g" },
    idempotencyKey: KEY,
    identity: { brandOwner: null, description: "Oats", descriptionFr: null, gtin: null },
    nutrients: [
      {
        canonicalNutrientId: "protein",
        canonicalUnit: "g",
        originalUnit: "g",
        provenance: { dataPoints: 12, derivationCode: null },
        sourceName: "Protein",
        sourceNutrientId: "1003",
        value: { amount: "12.5", quality: "measured", state: "known" },
      },
    ],
    schemaVersion: 1,
    servings: [],
    source: {
      languageTag: "en",
      marketCode: "US",
      releaseKey: "2026-04-30",
      sourceCode: "USDA_FDC",
      sourceDataType: "Foundation",
      sourceModifiedAt: "2026-04-30T00:00:00.000Z",
      sourceRecordId: "123",
    },
    sourcePayloadHash: HASH,
    unlistedNutrientPolicy: "unknown_not_reported",
  };
  const result = validateCatalogueRecord(
    payload,
    {
      canonicalPayloadSha256: sha256CanonicalJson(payload),
      expectedReleaseKey: "2026-04-30",
      expectedSourceCode: "USDA_FDC",
      sourcePayloadSha256: HASH,
      sourceRecordKey: KEY,
      sourceRecordType: "Foundation",
    },
    new Map([
      [
        "1003",
        {
          canonicalUnit: "g",
          conversionMultiplier: "1",
          mappingRevisionId: REVISION,
          nutrientCode: "protein",
          nutrientId: "1",
          sourceNutrientId: "1003",
          sourceUnit: "g",
        },
      ],
    ]),
  );
  if (!result.food) throw new Error("Invalid fixture food");
  const foodDocument = canonicalJson(result.food as unknown as JsonValue);
  const recordsSha256 = sha(`${canonicalJson(payload)}\n`);
  const report: JsonObject = {
    schemaVersion: 1,
    sourceCode: "USDA_FDC",
    releaseKey: "2026-04-30",
    artifactSha256: HASH,
    nutrientMappingDigest: MAPPING_HASH,
    parserBuildSha256: HASH,
    parserPackage: "@nutrition-tracker/ingestion",
    parserVersion: "0.1.0",
    reportKind: "usda-fdc-full-csv-capability-stage-v1",
    portionCountBasis: "source-csv-portions-plus-emitted-derived-label-servings-v1",
    recordsExport: { byteSize: 1234, sha256: HASH, recordCount: 1, recordsSha256 },
    inspection: {
      semanticEvidence: { canonicalAcceptedRecords: { count: 1, sha256: recordsSha256 } },
    },
  };
  const parser: Selectable<FoodImportParserReportTable> = {
    batch_id: BATCH,
    report,
    report_sha256: sha256CanonicalJson(report),
    source_record_count: "1",
    emitted_record_count: "1",
    excluded_record_count: "0",
    source_nutrient_count: "1",
    emitted_nutrient_count: "1",
    excluded_nutrient_count: "0",
    source_portion_count: "0",
    emitted_portion_count: "0",
    excluded_portion_count: "0",
    created_at: TIME,
  };
  const record: Selectable<FoodImportRecordTable> = {
    id: "1",
    batch_id: BATCH,
    source_record_key: KEY,
    source_record_type: "Foundation",
    sequence_number: "0",
    source_payload_sha256: HASH,
    canonical_payload_sha256: sha256CanonicalJson(payload),
    canonical_payload: payload,
    validation_status: "valid",
    validation_issues: result.issues,
    validated_food_document: foodDocument,
    validated_food_sha256: sha(foodDocument),
    validated_food_contract_version: 1,
    nutrition_semantic_contract_version: 1,
    nutrition_semantic_sha256: HASH,
    food_version_id: null,
    created_at: TIME,
    validated_at: TIME,
    materialized_at: null,
  };
  const digestRecord: BatchRecordValidation = {
    canonicalPayloadSha256: record.canonical_payload_sha256,
    excludedNutrientCount: 0,
    issues: result.issues,
    nutrientInputCount: 1,
    nutrientMaterializableCount: 1,
    portionInputCount: 0,
    sourceRecordKey: KEY,
    status: "valid",
    validatedFoodContractVersion: 1,
    validatedFoodSha256: sha(foodDocument),
  };
  const digest: Mutable = {
    artifactSha256: HASH,
    batchId: BATCH,
    evidenceBundleSha256: HASH,
    evidenceBundleUri: `s3://fixture/sha256/${HASH}/evidence.json`,
    evidenceDecisionSha256: HASH,
    evidenceObjectVersionId: "v1",
    evidenceValidUntil: EXPIRY,
    nutrientMappingDigest: MAPPING_HASH,
    nutrientMappingRevisionIds: [REVISION],
    observationSha256: TOKEN,
    policy: POLICY,
    parserEvidence: {
      emittedRecordCount: 1,
      excludedRecordCount: 0,
      sourceRecordCount: 1,
      emittedNutrientCount: 1,
      excludedNutrientCount: 0,
      sourceNutrientCount: 1,
      emittedPortionCount: 0,
      excludedPortionCount: 0,
      sourcePortionCount: 0,
    },
    parserReportSha256: parser.report_sha256,
    records: [digestRecord as unknown as JsonValue],
    releaseClass: "fixture-nonrelease",
    rightsManifestSha256: HASH,
    validatedFoodContractVersion: 1,
  };
  const digestDocument = canonicalJson(digest);
  const validationDocument = canonicalJson({
    schemaVersion: 1,
    digestDocument,
    records: [
      {
        sourceRecordKey: KEY,
        validatedFoodDocument: foodDocument,
        validationIssuesDocument: canonicalJson(result.issues),
      },
    ],
  });
  const request = parsePreparedCatalogueValidationRequest({
    schemaVersion: 1,
    kind: "catalogue-fdc-csv-validation-request-v1",
    validatorDatabasePrincipal: "validator_fixture",
    batchId: BATCH,
    expectedStagingSealSha256: HASH,
    observationSha256: TOKEN,
    nutrientMappingDigest: MAPPING_HASH,
    parserReportSha256: parser.report_sha256,
    policy: POLICY,
    validationDocument,
    validationDocumentByteSize: Buffer.byteLength(validationDocument),
    validationDocumentSha256: sha(validationDocument),
    validationDigest: sha(digestDocument),
  });
  const batch: Selectable<FoodImportBatchTable> = {
    id: BATCH,
    food_source_id: "1",
    release_key: "2026-04-30",
    published_on: "2026-04-30",
    acquired_at: TIME,
    artifact_uri: "s3://fixture/source.zip",
    artifact_sha256: HASH,
    artifact_bytes: "1234",
    media_type: "application/zip",
    upstream_schema_version: null,
    parser_version: `0.1.0+build.${HASH}+mapping.${MAPPING_HASH}`,
    rights_manifest_uri: "s3://fixture/manifest.json",
    rights_manifest_sha256: HASH,
    release_class: "fixture-nonrelease",
    evidence_bundle_sha256: HASH,
    evidence_bundle_uri: `s3://fixture/sha256/${HASH}/evidence.json`,
    evidence_decision_sha256: HASH,
    evidence_object_version_id: "v1",
    evidence_valid_until: new Date(EXPIRY),
    status: "ready",
    staged_count: "1",
    valid_count: "1",
    quarantined_count: "0",
    unresolved_error_count: "0",
    warning_count: "0",
    nutrient_input_count: "1",
    nutrient_materializable_count: "1",
    nutrient_excluded_count: "0",
    materialized_count: "0",
    validation_policy: POLICY,
    validation_digest: request.validationDigest,
    validated_food_contract_version: 1,
    nutrient_mapping_digest: MAPPING_HASH,
    nutrient_mapping_revision_ids: [REVISION],
    nutrition_semantic_contract_version: 1,
    nutrition_semantic_sha256: HASH,
    staged_database_principal: "stager_fixture",
    staged_database_capability_role: "nutrition_catalogue_stage",
    staging_seal_sha256: HASH,
    staging_sealed_at: TIME,
    validated_database_principal: "validator_fixture",
    validated_database_capability_role: "nutrition_catalogue_validate",
    release_id: null,
    created_at: TIME,
    updated_at: TIME,
    validated_at: TIME,
    completed_at: null,
  };
  const mappingRows = [
    {
      source_nutrient_key: "1003",
      revision_id: REVISION,
      source_unit: "g",
      conversion_multiplier: "1.000000000000",
      nutrient_id: "1",
      nutrient_code: "protein",
      canonical_unit: "g",
      dimension: "mass",
      nutrient_name: "Protein",
    },
  ];
  const baseline = legacyBaselineFixture(batch, parser, record, result.food, digest);
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          let rows: unknown[];
          if (query.sql.includes('from "food_import_batch"'))
            rows = query.parameters.includes(RELEASE) ? [baseline.batch] : [batch];
          else if (query.sql.includes('from "food_source"'))
            rows = [
              { id: "1", code: "USDA_FDC", active_release_id: withBaseline ? RELEASE : null },
            ];
          else if (query.sql.includes('from "food_source_release"')) rows = [baseline.release];
          else if (query.sql.includes('from "food_import_parser_report"'))
            rows = query.parameters.includes(BASELINE_BATCH) ? [baseline.parser] : [parser];
          else if (query.sql.includes('from "source_nutrient_map"')) rows = mappingRows;
          else if (query.sql.includes('from "source_nutrient_map_revision"'))
            rows = mappingRows.map((row) => ({ ...row, id: row.revision_id, food_source_id: "1" }));
          else if (query.sql.includes('from "food_import_approval"')) rows = baseline.approvals;
          else if (query.sql.includes('inner join "food_version"')) rows = [baseline.version];
          else if (query.sql.includes('inner join "food_nutrient_value"'))
            rows = baseline.nutrients;
          else if (query.sql.includes('inner join "food_serving"')) rows = [];
          else if (query.sql.includes('inner join "food_barcode"')) rows = [];
          else if (query.sql.includes('from "food_import_record"'))
            rows = query.parameters.includes(BASELINE_BATCH) ? [baseline.record] : [record];
          else throw new Error(`Unexpected query: ${query.sql}`);
          return { rows: rows as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No stream");
        },
      };
    }
  }
  const database = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const input: Parameters<typeof reconcileCatalogueBatch>[1] & {
    validationRequest?: PreparedCatalogueValidationRequest;
  } = {
    batchId: BATCH,
    expectedCurrentReleaseId: withBaseline ? RELEASE : null,
    expectedValidationDigest: request.validationDigest,
    validationRequest: request,
  };
  return {
    database,
    queries,
    input,
    request,
    batch,
    parser,
    record,
    digest,
    mappingRows,
    baseline,
  };
}

// Model the supported historical all-null frozen-materialization contract. No
// capability identity or retained observation exists for this completed baseline.
function legacyBaselineFixture(
  candidate: Selectable<FoodImportBatchTable>,
  parser: Selectable<FoodImportParserReportTable>,
  record: Selectable<FoodImportRecordTable>,
  food: ValidatedCatalogueFood,
  candidateDigest: Mutable,
) {
  // This synthetic snapshot models an already-reviewed historical release. It
  // never promotes or reclassifies a fixture batch in a real database.
  const digest = {
    ...candidateDigest,
    batchId: BASELINE_BATCH,
    releaseClass: "live-reviewed",
  } as Mutable;
  delete digest.observationSha256;
  delete digest.validatedFoodContractVersion;
  digest.evidenceValidUntil = new Date(EXPIRY).toISOString();
  digest.records = (digest.records as readonly JsonObject[]).map((entry) => {
    const legacy = { ...entry };
    delete legacy.validatedFoodContractVersion;
    delete legacy.validatedFoodSha256;
    return legacy;
  });
  const validationDigest = sha256CanonicalJson(digest);
  const batch: Selectable<FoodImportBatchTable> = {
    ...candidate,
    id: BASELINE_BATCH,
    release_class: "live-reviewed",
    status: "completed",
    release_id: RELEASE,
    completed_at: TIME,
    materialized_count: "1",
    validation_digest: validationDigest,
    validated_food_contract_version: null,
    nutrient_mapping_digest: null,
    nutrient_mapping_revision_ids: null,
    nutrition_semantic_contract_version: null,
    nutrition_semantic_sha256: null,
    staged_database_principal: null,
    staged_database_capability_role: null,
    staging_seal_sha256: null,
    staging_sealed_at: null,
    validated_database_principal: null,
    validated_database_capability_role: null,
  };
  const release: Selectable<FoodSourceReleaseTable> = {
    id: RELEASE,
    food_source_id: batch.food_source_id,
    release_key: batch.release_key,
    published_on: batch.published_on,
    acquired_at: batch.acquired_at,
    artifact_uri: batch.artifact_uri,
    artifact_sha256: batch.artifact_sha256,
    artifact_bytes: batch.artifact_bytes,
    media_type: batch.media_type,
    upstream_schema_version: batch.upstream_schema_version,
    parser_version: batch.parser_version,
    status: "promoted",
    rights_manifest_uri: batch.rights_manifest_uri,
    rights_manifest_sha256: batch.rights_manifest_sha256,
    release_class: batch.release_class,
    evidence_bundle_sha256: batch.evidence_bundle_sha256,
    evidence_bundle_uri: batch.evidence_bundle_uri,
    evidence_decision_sha256: batch.evidence_decision_sha256,
    evidence_object_version_id: batch.evidence_object_version_id,
    evidence_valid_until: batch.evidence_valid_until,
    legacy_promotion_grandfathered_at: null,
    promoted_at: TIME,
    created_at: TIME,
    record_counts: {
      materializable: 1,
      nutrientInput: 1,
      nutrientMaterializable: 1,
      nutrientExcluded: 0,
      parserExcludedRecords: 0,
      quarantined: 0,
      sourcePortions: 0,
      sourceRecords: 1,
      staged: 1,
    },
    validation_summary: {
      recordErrors: 0,
      excludedNutrientFraction: 0,
      nutrientMappingDigest: MAPPING_HASH,
      nutrientMappingRevisionIds: [REVISION],
      parserExcludedNutrients: 0,
      parserExcludedPortions: 0,
      parserReportSha256: parser.report_sha256,
      unresolvedErrors: 0,
      validationDigest,
      warnings: 0,
    },
  };
  return {
    batch,
    release,
    parser: { ...parser, batch_id: BASELINE_BATCH },
    record: {
      ...record,
      id: "2",
      batch_id: BASELINE_BATCH,
      validation_status: "materialized",
      food_version_id: "7",
      materialized_at: TIME,
      validated_food_contract_version: null,
      validated_food_document: null,
      validated_food_sha256: null,
      nutrition_semantic_contract_version: null,
      nutrition_semantic_sha256: null,
    },
    approvals: ["data", "quality", "rights"].map((role) => ({
      batch_id: BASELINE_BATCH,
      approval_role: role,
      validation_digest: validationDigest,
      rights_manifest_sha256: HASH,
      principal_id: `legacy_${role}`,
      database_principal: null,
      database_capability_role: null,
    })),
    version: {
      record_source_record_key: KEY,
      record_source_record_type: record.source_record_type,
      record_source_payload_sha256: record.source_payload_sha256,
      record_canonical_payload_sha256: record.canonical_payload_sha256,
      record_canonical_payload: record.canonical_payload,
      version_id: "7",
      version_source_release_id: RELEASE,
      version_name: food.name,
      version_normalized_name: food.normalizedName,
      version_brand_name: food.brandName,
      version_description: food.description,
      version_ingredients_text: null,
      version_language_tag: food.languageTag,
      version_market_code: food.marketCode,
      version_data_quality: "provisional",
      version_basis_quantity: food.basisQuantity,
      version_basis_unit: "g",
      version_source_modified_at: food.sourceModifiedAt ? new Date(food.sourceModifiedAt) : null,
      version_attributes: {
        ...food.attributes,
        importBatchId: BASELINE_BATCH,
        canonicalPayloadSha256: record.canonical_payload_sha256,
      },
      version_created_by_user_id: null,
      food_kind: food.kind,
      food_source_id: "1",
      food_source_food_key: food.sourceFoodKey,
      food_owner_user_id: null,
      food_visibility: "public",
      food_current_version_id: "7",
      food_archived_at: null,
    },
    nutrients: food.nutrients.map((value) => ({
      record_source_record_key: KEY,
      amount: value.amount,
      unit: value.canonicalUnit,
      basis_quantity: food.basisQuantity,
      basis_unit: "g",
      source_amount: value.sourceAmount,
      source_unit: value.sourceUnit,
      source_basis_quantity: value.sourceBasisQuantity,
      source_basis_unit: value.sourceBasisUnit,
      value_status: value.valueStatus,
      derivation_code: value.derivationCode,
      confidence: null,
      metadata: value.metadata,
      nutrient_code: value.nutrientCode,
      nutrient_canonical_unit: value.canonicalUnit,
    })),
  };
}

describe("capability validation reconciliation", () => {
  it("preserves a complete legacy baseline without a retained baseline request", async () => {
    const f = fixture(true);
    expect(f.baseline.batch.validated_food_contract_version).toBeNull();
    expect(f.baseline.batch.staged_database_principal).toBeNull();
    const report = await reconcileCatalogueBatch(f.database, f.input);
    expect(report.evidence.baseline).toMatchObject({
      releaseId: RELEASE,
      batchId: BASELINE_BATCH,
      validationDigest: f.baseline.batch.validation_digest,
    });
    expect(report.evidence.counts).toMatchObject({
      baselineRecords: "1",
      candidateRecords: "1",
      addedRecords: "0",
      removedRecords: "0",
    });
    expect(f.queries.every((query) => query.sql.startsWith("select "))).toBe(true);
    expect(f.queries.some((query) => query.sql.includes('inner join "food_nutrient_value"'))).toBe(
      true,
    );
  });
  it("rejects a baseline release digest that differs from its completed batch", async () => {
    const f = fixture(true);
    f.baseline.release.validation_summary = {
      ...f.baseline.release.validation_summary,
      validationDigest: TOKEN,
    };
    // Preserve the old release/approval agreement so only the new completed-batch pin detects this drift.
    for (const approval of f.baseline.approvals) approval.validation_digest = TOKEN;
    await expect(reconcileCatalogueBatch(f.database, f.input)).rejects.toThrow(
      "Current release validation digest differs from its completed import batch",
    );
    expect(f.queries.every((query) => query.sql.startsWith("select "))).toBe(true);
  });

  it("reconciles a capability candidate using its retained exact observation-bound request", async () => {
    const f = fixture();
    const before = canonicalJson({
      batch: {
        ...f.batch,
        acquired_at: TIME.toISOString(),
        created_at: TIME.toISOString(),
        updated_at: TIME.toISOString(),
        validated_at: TIME.toISOString(),
        staging_sealed_at: TIME.toISOString(),
        evidence_valid_until: EXPIRY,
      },
      record: { ...f.record, created_at: TIME.toISOString(), validated_at: TIME.toISOString() },
    } as unknown as JsonValue);
    const report = await reconcileCatalogueBatch(f.database, f.input);
    expect(report.evidence.candidate).toMatchObject({
      validationDigest: f.request.validationDigest,
    });
    expect(report.evidence.counts).toMatchObject({ candidateRecords: "1", addedRecords: "1" });
    expect(f.queries.every((query) => query.sql.startsWith("select "))).toBe(true);
    expect(
      f.queries.some((query) => query.sql.includes("catalogue_observe_import_validation")),
    ).toBe(false);
    expect(
      canonicalJson({
        batch: {
          ...f.batch,
          acquired_at: TIME.toISOString(),
          created_at: TIME.toISOString(),
          updated_at: TIME.toISOString(),
          validated_at: TIME.toISOString(),
          staging_sealed_at: TIME.toISOString(),
          evidence_valid_until: EXPIRY,
        },
        record: { ...f.record, created_at: TIME.toISOString(), validated_at: TIME.toISOString() },
      } as unknown as JsonValue),
    ).toBe(before);
  });
  it("keeps the original mismatch fail-closed when a capability request is omitted", async () => {
    const f = fixture();
    delete f.input.validationRequest;
    await expect(reconcileCatalogueBatch(f.database, f.input)).rejects.toThrow("validation digest");
  });
  it("cannot bypass retained-request verification with a legacy-format caller digest", async () => {
    const f = fixture();
    delete f.input.validationRequest;
    delete f.digest.observationSha256;
    f.digest.evidenceValidUntil = new Date(EXPIRY).toISOString();
    f.input = { ...f.input, expectedValidationDigest: sha256CanonicalJson(f.digest) };
    await expect(reconcileCatalogueBatch(f.database, f.input)).rejects.toThrow("validation digest");
  });
  it("preserves a legacy owner candidate without a retained request", async () => {
    const f = fixture();
    delete f.input.validationRequest;
    delete f.digest.observationSha256;
    f.digest.evidenceValidUntil = new Date(EXPIRY).toISOString();
    f.batch.validation_digest = sha256CanonicalJson(f.digest);
    f.input = { ...f.input, expectedValidationDigest: f.batch.validation_digest };
    f.batch.staged_database_principal = null;
    f.batch.staged_database_capability_role = null;
    f.batch.staging_seal_sha256 = null;
    f.batch.staging_sealed_at = null;
    f.batch.validated_database_principal = null;
    f.batch.validated_database_capability_role = null;
    await expect(reconcileCatalogueBatch(f.database, f.input)).resolves.toMatchObject({
      evidence: { candidate: { validationDigest: f.batch.validation_digest } },
    });
  });
  it.each([
    "seal",
    "validator",
    "samePrincipal",
    "stageRole",
    "validatorRole",
    "unsealed",
    "batchDigest",
    "artifact",
    "evidence",
    "expiry",
    "policy",
    "parserKind",
    "parserHash",
    "mapping",
    "order",
    "issues",
    "food",
    "semanticRecord",
    "semanticBatch",
    "sourceHash",
  ])("rejects frozen/current %s drift", async (kind) => {
    const f = fixture();
    if (kind === "seal") f.batch.staging_seal_sha256 = TOKEN;
    if (kind === "validator") f.batch.validated_database_principal = "another_validator";
    if (kind === "samePrincipal") f.batch.staged_database_principal = "validator_fixture";
    if (kind === "stageRole")
      f.batch.staged_database_capability_role = "nutrition_catalogue_validate";
    if (kind === "validatorRole")
      f.batch.validated_database_capability_role = "nutrition_catalogue_stage";
    if (kind === "unsealed") f.batch.staging_sealed_at = null;
    if (kind === "batchDigest") f.batch.validation_digest = TOKEN;
    if (kind === "artifact") f.batch.artifact_sha256 = TOKEN;
    if (kind === "evidence") f.batch.evidence_object_version_id = "v2";
    if (kind === "expiry") f.batch.evidence_valid_until = new Date("2026-09-21T13:00:00Z");
    if (kind === "policy") f.batch.validation_policy = { ...POLICY, maximumQuarantinedRecords: 1 };
    if (kind === "parserKind") {
      f.parser.report = { ...f.parser.report, reportKind: "wrong-kind" };
      f.parser.report_sha256 = sha256CanonicalJson(f.parser.report);
    }
    if (kind === "parserHash") f.parser.report_sha256 = TOKEN;
    if (kind === "mapping") required(f.mappingRows[0]).nutrient_name = "Changed";
    if (kind === "order") f.record.sequence_number = "1";
    if (kind === "issues") f.record.validation_issues = [{ code: "ALTERED" }];
    if (kind === "food") f.record.validated_food_document = "{}";
    if (kind === "semanticRecord") f.record.nutrition_semantic_sha256 = null;
    if (kind === "semanticBatch") f.batch.nutrition_semantic_contract_version = null;
    if (kind === "sourceHash") f.record.source_payload_sha256 = TOKEN;
    await expect(reconcileCatalogueBatch(f.database, f.input)).rejects.toThrow();
  });
  it("rejects self-consistent replacement of the historical observation token", async () => {
    const f = fixture();
    const outer = JSON.parse(f.request.validationDocument);
    const digest = JSON.parse(outer.digestDocument);
    digest.observationSha256 = HASH;
    outer.digestDocument = canonicalJson(digest);
    const validationDocument = canonicalJson(outer);
    f.input.validationRequest = parsePreparedCatalogueValidationRequest({
      ...f.request,
      observationSha256: HASH,
      validationDocument,
      validationDocumentByteSize: Buffer.byteLength(validationDocument),
      validationDocumentSha256: sha(validationDocument),
      validationDigest: sha(outer.digestDocument),
    });
    await expect(reconcileCatalogueBatch(f.database, f.input)).rejects.toThrow();
  });
  it("rejects a retained request for an owner-compatible candidate", async () => {
    const f = fixture();
    f.batch.validated_database_principal = null;
    f.batch.validated_database_capability_role = null;
    await expect(reconcileCatalogueBatch(f.database, f.input)).rejects.toThrow();
  });
});
