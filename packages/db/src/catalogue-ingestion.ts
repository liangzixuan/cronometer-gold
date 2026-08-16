import { randomUUID } from "node:crypto";

import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";

import {
  type CatalogueRecordValidationResult,
  type CatalogueValidationIssue,
  canonicalJson,
  type ReviewedCatalogueNutrientMapping,
  sha256CanonicalJson,
  validateCatalogueRecord,
} from "./catalogue-validation.js";
import type {
  Database,
  FoodImportBatchStatus,
  FoodImportBatchTable,
  FoodImportCheckpointStage,
  FoodImportParserReportTable,
  FoodImportRecordTable,
  JsonArray,
  JsonObject,
  JsonValue,
} from "./types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_LOCK_NAMESPACE = "nutrition-tracker:catalogue-source:v1";
const NUTRIENT_REGISTRY_LOCK_NAMESPACE = "nutrition-tracker:active-nutrient-registry:v1";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
type BatchRow = Selectable<FoodImportBatchTable>;
type RecordRow = Selectable<FoodImportRecordTable>;

export interface StageBatchInput {
  readonly acquiredAt: Date | string;
  readonly artifactBytes: bigint | number | string;
  readonly artifactSha256: string;
  readonly artifactUri: string;
  readonly mediaType: string;
  readonly parserVersion: string;
  readonly publishedOn?: string | null;
  readonly releaseKey: string;
  readonly rightsManifestSha256: string;
  readonly rightsManifestUri: string;
  readonly sourceCode: string;
  readonly upstreamSchemaVersion?: string | null;
}

export interface RegisterFoodSourceInput {
  readonly accessUrl?: string | null;
  readonly active?: boolean;
  readonly attributionRequired: boolean;
  readonly attributionText: string;
  readonly code: string;
  readonly commercialUseAllowed: boolean;
  readonly databaseRightsNotes?: string | null;
  readonly displayName: string;
  readonly homepageUrl: string;
  readonly kind: "commercial" | "government" | "open" | "partner";
  readonly licenseExpression: string;
  readonly licenseUrl: string;
  readonly redistributionAllowed: boolean | null;
  readonly rightsReviewStatus: "approved" | "restricted";
  readonly rightsReviewedAt: Date | string;
  readonly rightsReviewedBy: string;
  readonly termsUrl?: string | null;
}

export interface StagedCatalogueRecordInput {
  readonly canonicalPayload: JsonValue;
  readonly canonicalPayloadSha256?: string;
  readonly sequenceNumber: bigint | number | string;
  readonly sourcePayloadSha256: string;
  readonly sourceRecordKey: string;
  readonly sourceRecordType: string;
}

export interface StageBatchResult {
  readonly batchId: string;
  readonly resumed: boolean;
  readonly status: FoodImportBatchStatus;
}

export interface StageBatchRecordsResult {
  readonly inserted: number;
  readonly replayed: number;
  readonly stagedCount: string;
}

export interface BatchValidationPolicy extends JsonObject {
  readonly maximumExcludedNutrientFraction: number;
  readonly maximumQuarantineFraction: number;
  readonly maximumQuarantinedRecords: number;
  readonly requireDistinctApprovalPrincipals: boolean;
  readonly requireAtLeastOneValidRecord: boolean;
  readonly requireMaterializedNutrientPerValidRecord: boolean;
}

export interface BatchRecordValidation {
  readonly canonicalPayloadSha256: string;
  readonly issues: readonly CatalogueValidationIssue[];
  readonly nutrientInputCount: number;
  readonly nutrientMaterializableCount: number;
  readonly portionInputCount: number;
  readonly excludedNutrientCount: number;
  readonly sourceRecordKey: string;
  readonly status: "quarantined" | "valid";
}

export interface BatchValidationSummary {
  readonly excludedNutrientCount: number;
  readonly excludedNutrientFraction: number;
  readonly nutrientInputCount: number;
  readonly nutrientMaterializableCount: number;
  readonly nutrientMappingDigest: string;
  readonly parserExcludedNutrientCount: number;
  readonly parserExcludedPortionCount: number;
  readonly parserExcludedRecordCount: number;
  readonly parserReportSha256: string;
  readonly portionInputCount: number;
  readonly promotionEligible: boolean;
  readonly quarantinedCount: number;
  readonly recordErrorCount: number;
  readonly records: readonly BatchRecordValidation[];
  readonly stagedCount: number;
  readonly unresolvedErrorCount: number;
  readonly validCount: number;
  readonly validationDigest: string;
  readonly validationPolicy: BatchValidationPolicy;
  readonly warningCount: number;
}

export interface BatchPolicyEvaluation {
  readonly excludedNutrientCount: number;
  readonly excludedNutrientFraction: number;
  readonly nutrientInputCount: number;
  readonly nutrientMaterializableCount: number;
  readonly promotionEligible: boolean;
  readonly quarantinedCount: number;
  readonly recordErrorCount: number;
  readonly unresolvedErrorCount: number;
  readonly validCount: number;
  readonly warningCount: number;
}

export interface ParserCountEvidence {
  readonly emittedNutrientCount: number;
  readonly emittedPortionCount: number;
  readonly emittedRecordCount: number;
  readonly excludedNutrientCount: number;
  readonly excludedPortionCount: number;
  readonly excludedRecordCount: number;
  readonly sourceNutrientCount: number;
  readonly sourcePortionCount: number;
  readonly sourceRecordCount: number;
}

export function evaluateBatchPolicy(
  records: readonly BatchRecordValidation[],
  policy: BatchValidationPolicy,
  parserEvidence?: ParserCountEvidence,
): BatchPolicyEvaluation {
  const validCount = records.filter((record) => record.status === "valid").length;
  const quarantinedCount = records.length - validCount + (parserEvidence?.excludedRecordCount ?? 0);
  const warningCount = records.reduce(
    (total, record) => total + record.issues.filter((entry) => entry.severity === "warning").length,
    0,
  );
  const recordErrorCount = records.reduce(
    (total, record) => total + record.issues.filter((entry) => entry.severity === "error").length,
    0,
  );
  const emittedNutrientCount = records.reduce(
    (total, record) => total + record.nutrientInputCount,
    0,
  );
  const nutrientMaterializableCount = records.reduce(
    (total, record) => total + record.nutrientMaterializableCount,
    0,
  );
  const excludedNutrientCount =
    records.reduce((total, record) => total + record.excludedNutrientCount, 0) +
    (parserEvidence?.excludedNutrientCount ?? 0);
  const nutrientInputCount = parserEvidence?.sourceNutrientCount ?? emittedNutrientCount;
  const excludedNutrientFraction =
    nutrientInputCount === 0 ? 1 : excludedNutrientCount / nutrientInputCount;
  const sourceRecordCount = parserEvidence?.sourceRecordCount ?? records.length;
  const quarantineFraction = sourceRecordCount === 0 ? 1 : quarantinedCount / sourceRecordCount;
  let unresolvedErrorCount = 0;
  if (policy.requireAtLeastOneValidRecord && validCount === 0) unresolvedErrorCount += 1;
  if (quarantinedCount > policy.maximumQuarantinedRecords) unresolvedErrorCount += 1;
  if (quarantineFraction > policy.maximumQuarantineFraction) unresolvedErrorCount += 1;
  if (excludedNutrientFraction > policy.maximumExcludedNutrientFraction) {
    unresolvedErrorCount += 1;
  }
  if (
    policy.requireMaterializedNutrientPerValidRecord &&
    records.some((record) => record.status === "valid" && record.nutrientMaterializableCount === 0)
  ) {
    unresolvedErrorCount += 1;
  }
  return {
    excludedNutrientCount,
    excludedNutrientFraction,
    nutrientInputCount,
    nutrientMaterializableCount,
    promotionEligible: unresolvedErrorCount === 0,
    quarantinedCount,
    recordErrorCount,
    unresolvedErrorCount,
    validCount,
    warningCount,
  };
}

export interface ApproveBatchInput {
  readonly approvalRole: "data" | "quality" | "rights";
  readonly approvalReference: string;
  readonly batchId: string;
  readonly principalId: string;
  readonly rightsManifestSha256: string;
  readonly validationDigest: string;
}

export interface RecordBatchParserReportInput {
  readonly batchId: string;
  readonly emittedNutrientCount: bigint | number | string;
  readonly emittedPortionCount: bigint | number | string;
  readonly emittedRecordCount: bigint | number | string;
  readonly excludedNutrientCount: bigint | number | string;
  readonly excludedPortionCount: bigint | number | string;
  readonly excludedRecordCount: bigint | number | string;
  readonly report: JsonObject;
  readonly reportSha256?: string;
  readonly sourceNutrientCount: bigint | number | string;
  readonly sourcePortionCount: bigint | number | string;
  readonly sourceRecordCount: bigint | number | string;
}

export interface ReviewedNutrientMappingInput {
  readonly canonicalNutrient: {
    readonly code: string;
    readonly dimension: "amount" | "energy" | "mass" | "ratio" | "volume";
    readonly name: string;
    readonly unit: string;
  };
  readonly conversionMultiplier?: string;
  readonly mappingNotes?: string | null;
  readonly sourceName: string;
  readonly sourceNutrientKey: string;
  readonly sourceUnit: string;
}

export interface RegisterSourceNutrientMappingsInput {
  readonly mappings: readonly ReviewedNutrientMappingInput[];
  readonly reviewedAt: Date | string;
  readonly reviewedBy: string;
  readonly sourceCode: string;
}

export interface SupersedeSourceNutrientMappingInput {
  readonly changeReason: string;
  readonly expectedCurrentRevisionId: string;
  readonly mapping: ReviewedNutrientMappingInput;
  readonly reviewedAt: Date | string;
  readonly reviewedBy: string;
  readonly sourceCode: string;
}

export interface SaveBatchCheckpointInput {
  readonly batchId: string;
  readonly cursor: JsonObject;
  readonly lastSequenceNumber?: bigint | number | string | null;
  readonly processedCount: bigint | number | string;
  readonly stage: FoodImportCheckpointStage;
}

export interface BatchCheckpoint {
  readonly cursor: JsonObject;
  readonly lastSequenceNumber: string | null;
  readonly processedCount: string;
  readonly stage: FoodImportCheckpointStage;
  readonly updatedAt: Date;
}

export interface PromoteBatchOptions {
  readonly batchId: string;
  readonly performedBy: string;
  readonly reason?: string;
}

export interface PromoteBatchResult {
  readonly activatedReleaseId: string;
  readonly materializedCount: number;
  readonly previousReleaseId: string | null;
  readonly wasAlreadyCompleted: boolean;
}

export interface RollbackSourceReleaseInput {
  readonly performedBy: string;
  readonly reason: string;
  readonly sourceCode: string;
  /** null deactivates the complete source catalogue. */
  readonly targetReleaseId: string | null;
}

export interface RollbackSourceReleaseResult {
  readonly activeReleaseId: string | null;
  readonly changed: boolean;
  readonly previousReleaseId: string | null;
}

/** Create/replay a rights-reviewed source registry entry from manifest fields. */
export async function registerFoodSourceFromReviewedManifest(
  database: Kysely<Database>,
  input: RegisterFoodSourceInput,
): Promise<string> {
  requireText(input.code, "code");
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(input.code)) {
    throw new Error("code must be a canonical uppercase source code");
  }
  requireBoundedText(input.displayName, "displayName", 200);
  requireText(input.homepageUrl, "homepageUrl");
  requireBoundedText(input.licenseExpression, "licenseExpression", 256);
  requireText(input.licenseUrl, "licenseUrl");
  requireBoundedText(input.attributionText, "attributionText", 2_000);
  const reviewedBy = stablePrincipalId(input.rightsReviewedBy, "rightsReviewedBy");
  const inserted = await database
    .insertInto("food_source")
    .values({
      access_url: input.accessUrl ?? null,
      active: input.active ?? true,
      attribution_required: input.attributionRequired,
      attribution_text: input.attributionText,
      code: input.code,
      commercial_use_allowed: input.commercialUseAllowed,
      database_rights_notes: input.databaseRightsNotes ?? null,
      display_name: input.displayName,
      homepage_url: input.homepageUrl,
      kind: input.kind,
      license_expression: input.licenseExpression,
      license_url: input.licenseUrl,
      redistribution_allowed: input.redistributionAllowed,
      rights_review_status: input.rightsReviewStatus,
      rights_reviewed_at: input.rightsReviewedAt,
      rights_reviewed_by: reviewedBy,
      terms_url: input.termsUrl ?? null,
    })
    .onConflict((conflict) => conflict.column("code").doNothing())
    .returningAll()
    .executeTakeFirst();
  const source =
    inserted ??
    (await database
      .selectFrom("food_source")
      .selectAll()
      .where("code", "=", input.code)
      .executeTakeFirstOrThrow());
  const same =
    source.display_name === input.displayName &&
    source.kind === input.kind &&
    source.homepage_url === input.homepageUrl &&
    source.access_url === (input.accessUrl ?? null) &&
    source.license_expression === input.licenseExpression &&
    source.license_url === input.licenseUrl &&
    source.terms_url === (input.termsUrl ?? null) &&
    source.attribution_text === input.attributionText &&
    source.attribution_required === input.attributionRequired &&
    source.commercial_use_allowed === input.commercialUseAllowed &&
    source.redistribution_allowed === input.redistributionAllowed &&
    source.database_rights_notes === (input.databaseRightsNotes ?? null) &&
    source.rights_review_status === input.rightsReviewStatus &&
    source.rights_reviewed_by === reviewedBy &&
    source.rights_reviewed_at?.toISOString() === new Date(input.rightsReviewedAt).toISOString() &&
    source.active === (input.active ?? true);
  if (!same) throw new Error(`Food source ${input.code} already has different reviewed metadata`);
  return source.id;
}

/** Create or resume the one batch identified by immutable artifact provenance. */
export async function stageBatch(
  database: Kysely<Database>,
  input: StageBatchInput,
): Promise<StageBatchResult> {
  assertSha256(input.artifactSha256, "artifactSha256");
  assertSha256(input.rightsManifestSha256, "rightsManifestSha256");
  requireText(input.sourceCode, "sourceCode");
  requireText(input.releaseKey, "releaseKey");
  requireText(input.parserVersion, "parserVersion");
  requireText(input.artifactUri, "artifactUri");
  requireText(input.rightsManifestUri, "rightsManifestUri");

  const source = await database
    .selectFrom("food_source")
    .select(["id", "code"])
    .where("code", "=", input.sourceCode)
    .executeTakeFirst();
  if (!source) throw new Error(`Unknown food source ${input.sourceCode}`);

  const inserted = await database
    .insertInto("food_import_batch")
    .values({
      acquired_at: input.acquiredAt,
      artifact_bytes: input.artifactBytes,
      artifact_sha256: input.artifactSha256,
      artifact_uri: input.artifactUri,
      food_source_id: source.id,
      media_type: input.mediaType,
      parser_version: input.parserVersion,
      published_on: input.publishedOn ?? null,
      release_key: input.releaseKey,
      rights_manifest_sha256: input.rightsManifestSha256,
      rights_manifest_uri: input.rightsManifestUri,
      upstream_schema_version: input.upstreamSchemaVersion ?? null,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["food_source_id", "release_key", "artifact_sha256", "parser_version"])
        .doNothing(),
    )
    .returningAll()
    .executeTakeFirst();

  const batch =
    inserted ??
    (await database
      .selectFrom("food_import_batch")
      .selectAll()
      .where("food_source_id", "=", source.id)
      .where("release_key", "=", input.releaseKey)
      .where("artifact_sha256", "=", input.artifactSha256)
      .where("parser_version", "=", input.parserVersion)
      .executeTakeFirstOrThrow());
  assertBatchProvenance(batch, input);
  return { batchId: batch.id, resumed: !inserted, status: batch.status };
}

/**
 * Register reviewed ontology and source mappings independently of staged data.
 * Staged canonical IDs never create or alter nutrients or mappings.
 */
export async function registerSourceNutrientMappings(
  database: Kysely<Database>,
  input: RegisterSourceNutrientMappingsInput,
): Promise<void> {
  requireText(input.sourceCode, "sourceCode");
  const reviewedBy = stablePrincipalId(input.reviewedBy, "reviewedBy");
  await database.transaction().execute(async (transaction) => {
    const source = await transaction
      .selectFrom("food_source")
      .select(["id", "code"])
      .where("code", "=", input.sourceCode)
      .forUpdate()
      .executeTakeFirst();
    if (!source) throw new Error(`Unknown food source ${input.sourceCode}`);
    await lockSource(transaction, source.id);
    await lockNutrientRegistry(transaction);

    const mappings = [...input.mappings].sort(
      (left, right) =>
        left.canonicalNutrient.code.localeCompare(right.canonicalNutrient.code) ||
        left.sourceNutrientKey.localeCompare(right.sourceNutrientKey),
    );
    for (const mapping of mappings) {
      validateMappingInput(mapping);
      const multiplier = mapping.conversionMultiplier ?? "1";
      const nutrient = await ensureCanonicalNutrient(transaction, mapping, reviewedBy);
      const existing = await selectCurrentMapping(
        transaction,
        source.id,
        mapping.sourceNutrientKey,
      );
      if (existing) {
        if (
          existing.nutrient_id !== nutrient.id ||
          existing.source_name !== mapping.sourceName ||
          existing.source_unit !== mapping.sourceUnit ||
          normalizeDatabaseDecimal(String(existing.conversion_multiplier)) !==
            normalizeDatabaseDecimal(multiplier) ||
          existing.mapping_notes !== (mapping.mappingNotes ?? null) ||
          existing.reviewed_by !== reviewedBy ||
          existing.reviewed_at.toISOString() !== new Date(input.reviewedAt).toISOString()
        ) {
          throw new Error(
            `Reviewed mapping ${input.sourceCode}:${mapping.sourceNutrientKey} differs; use supersedeSourceNutrientMapping with the current revision`,
          );
        }
        continue;
      }

      const revisionId = randomUUID();
      await transaction
        .insertInto("source_nutrient_map")
        .values({
          conversion_multiplier: multiplier,
          current_revision_id: revisionId,
          food_source_id: source.id,
          mapping_notes: mapping.mappingNotes ?? null,
          nutrient_id: nutrient.id,
          reviewed_at: input.reviewedAt,
          reviewed_by: reviewedBy,
          source_name: mapping.sourceName,
          source_nutrient_key: mapping.sourceNutrientKey,
          source_unit: mapping.sourceUnit,
        })
        .execute();
      await transaction
        .insertInto("source_nutrient_map_revision")
        .values({
          change_reason: "Initial reviewed source nutrient mapping",
          conversion_multiplier: multiplier,
          food_source_id: source.id,
          id: revisionId,
          mapping_notes: mapping.mappingNotes ?? null,
          nutrient_id: nutrient.id,
          reviewed_at: input.reviewedAt,
          reviewed_by: reviewedBy,
          source_name: mapping.sourceName,
          source_nutrient_key: mapping.sourceNutrientKey,
          source_unit: mapping.sourceUnit,
          supersedes_revision_id: null,
        })
        .execute();
    }
  });
}

/** Append a reviewed correction and atomically move only the active mapping pointer. */
export async function supersedeSourceNutrientMapping(
  database: Kysely<Database>,
  input: SupersedeSourceNutrientMappingInput,
): Promise<string> {
  requireText(input.sourceCode, "sourceCode");
  requireText(input.changeReason, "changeReason");
  const reviewedBy = stablePrincipalId(input.reviewedBy, "reviewedBy");
  validateMappingInput(input.mapping);
  return database.transaction().execute(async (transaction) => {
    const source = await transaction
      .selectFrom("food_source")
      .select(["id", "code"])
      .where("code", "=", input.sourceCode)
      .forUpdate()
      .executeTakeFirst();
    if (!source) throw new Error(`Unknown food source ${input.sourceCode}`);
    await lockSource(transaction, source.id);
    await lockNutrientRegistry(transaction);
    const current = await selectCurrentMapping(
      transaction,
      source.id,
      input.mapping.sourceNutrientKey,
    );
    if (!current) {
      throw new Error(
        `No current mapping for ${input.sourceCode}:${input.mapping.sourceNutrientKey}`,
      );
    }
    if (current.id !== input.expectedCurrentRevisionId) {
      throw new Error("Source nutrient mapping revision changed; review the latest revision");
    }
    const nutrient = await ensureCanonicalNutrient(transaction, input.mapping, reviewedBy);
    const revisionId = randomUUID();
    await transaction
      .insertInto("source_nutrient_map_revision")
      .values({
        change_reason: input.changeReason,
        conversion_multiplier: input.mapping.conversionMultiplier ?? "1",
        food_source_id: source.id,
        id: revisionId,
        mapping_notes: input.mapping.mappingNotes ?? null,
        nutrient_id: nutrient.id,
        reviewed_at: input.reviewedAt,
        reviewed_by: reviewedBy,
        source_name: input.mapping.sourceName,
        source_nutrient_key: input.mapping.sourceNutrientKey,
        source_unit: input.mapping.sourceUnit,
        supersedes_revision_id: current.id,
      })
      .execute();
    const updated = await transaction
      .updateTable("source_nutrient_map")
      .set({ current_revision_id: revisionId })
      .where("food_source_id", "=", source.id)
      .where("source_nutrient_key", "=", input.mapping.sourceNutrientKey)
      .where("current_revision_id", "=", input.expectedCurrentRevisionId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new Error("Source nutrient mapping revision changed during correction");
    }
    return revisionId;
  });
}

/**
 * Append canonical records. Replaying an identical chunk is a no-op; reusing a
 * record key or sequence for different bytes fails closed.
 */
export async function stageBatchRecords(
  database: Kysely<Database>,
  batchId: string,
  records: readonly StagedCatalogueRecordInput[],
): Promise<StageBatchRecordsResult> {
  return database.transaction().execute(async (transaction) => {
    const batch = await selectBatchForUpdate(transaction, batchId);
    if (batch.status !== "staging") {
      throw new Error(`Batch ${batchId} cannot accept records while ${batch.status}`);
    }

    let inserted = 0;
    let replayed = 0;
    for (const record of records) {
      requireText(record.sourceRecordKey, "sourceRecordKey");
      requireText(record.sourceRecordType, "sourceRecordType");
      assertSha256(record.sourcePayloadSha256, "sourcePayloadSha256");
      const canonicalPayloadSha256 = sha256CanonicalJson(record.canonicalPayload);
      if (
        record.canonicalPayloadSha256 &&
        record.canonicalPayloadSha256 !== canonicalPayloadSha256
      ) {
        throw new Error(`Canonical payload checksum mismatch for ${record.sourceRecordKey}`);
      }

      const created = await transaction
        .insertInto("food_import_record")
        .values({
          batch_id: batchId,
          canonical_payload: sql<JsonValue>`${canonicalJson(record.canonicalPayload)}::jsonb`,
          canonical_payload_sha256: canonicalPayloadSha256,
          sequence_number: record.sequenceNumber,
          source_payload_sha256: record.sourcePayloadSha256,
          source_record_key: record.sourceRecordKey,
          source_record_type: record.sourceRecordType,
        })
        .onConflict((conflict) => conflict.columns(["batch_id", "source_record_key"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (created) {
        inserted += 1;
        continue;
      }

      const existing = await transaction
        .selectFrom("food_import_record")
        .select([
          "canonical_payload_sha256",
          "sequence_number",
          "source_payload_sha256",
          "source_record_type",
        ])
        .where("batch_id", "=", batchId)
        .where("source_record_key", "=", record.sourceRecordKey)
        .executeTakeFirstOrThrow();
      if (
        existing.canonical_payload_sha256 !== canonicalPayloadSha256 ||
        String(existing.sequence_number) !== String(record.sequenceNumber) ||
        existing.source_payload_sha256 !== record.sourcePayloadSha256 ||
        existing.source_record_type !== record.sourceRecordType
      ) {
        throw new Error(`Idempotency conflict for staged record ${record.sourceRecordKey}`);
      }
      replayed += 1;
    }

    const count = await sql<{ count: string }>`
      select count(*)::text as count from food_import_record where batch_id = ${batchId}
    `.execute(transaction);
    const stagedCount = count.rows[0]?.count ?? "0";
    await transaction
      .updateTable("food_import_batch")
      .set({ staged_count: stagedCount })
      .where("id", "=", batchId)
      .execute();
    return { inserted, replayed, stagedCount };
  });
}

/** Persist the parser's immutable exclusion evidence before batch validation. */
export async function recordBatchParserReport(
  database: Kysely<Database>,
  input: RecordBatchParserReportInput,
): Promise<string> {
  const reportSha256 = sha256CanonicalJson(input.report);
  if (input.reportSha256 && input.reportSha256 !== reportSha256) {
    throw new Error("Parser report checksum does not match its canonical JSON");
  }
  const counts = parserCountsFromInput(input);
  assertParserCountSums(counts);
  return database.transaction().execute(async (transaction) => {
    const batch = await selectBatchForUpdate(transaction, input.batchId);
    if (batch.status !== "staging") {
      throw new Error(`Batch ${input.batchId} cannot record parser evidence while ${batch.status}`);
    }
    const inserted = await transaction
      .insertInto("food_import_parser_report")
      .values({
        batch_id: input.batchId,
        emitted_nutrient_count: counts.emittedNutrientCount,
        emitted_portion_count: counts.emittedPortionCount,
        emitted_record_count: counts.emittedRecordCount,
        excluded_nutrient_count: counts.excludedNutrientCount,
        excluded_portion_count: counts.excludedPortionCount,
        excluded_record_count: counts.excludedRecordCount,
        report: input.report,
        report_sha256: reportSha256,
        source_nutrient_count: counts.sourceNutrientCount,
        source_portion_count: counts.sourcePortionCount,
        source_record_count: counts.sourceRecordCount,
      })
      .onConflict((conflict) => conflict.column("batch_id").doNothing())
      .returning("batch_id")
      .executeTakeFirst();
    if (!inserted) {
      const existing = await transaction
        .selectFrom("food_import_parser_report")
        .selectAll()
        .where("batch_id", "=", input.batchId)
        .executeTakeFirstOrThrow();
      if (
        existing.report_sha256 !== reportSha256 ||
        String(existing.source_record_count) !== String(counts.sourceRecordCount) ||
        String(existing.emitted_record_count) !== String(counts.emittedRecordCount) ||
        String(existing.excluded_record_count) !== String(counts.excludedRecordCount) ||
        String(existing.source_nutrient_count) !== String(counts.sourceNutrientCount) ||
        String(existing.emitted_nutrient_count) !== String(counts.emittedNutrientCount) ||
        String(existing.excluded_nutrient_count) !== String(counts.excludedNutrientCount) ||
        String(existing.source_portion_count) !== String(counts.sourcePortionCount) ||
        String(existing.emitted_portion_count) !== String(counts.emittedPortionCount) ||
        String(existing.excluded_portion_count) !== String(counts.excludedPortionCount)
      ) {
        throw new Error(`Batch ${input.batchId} already has different immutable parser evidence`);
      }
    }
    return reportSha256;
  });
}

export async function saveBatchCheckpoint(
  database: Kysely<Database>,
  input: SaveBatchCheckpointInput,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const batch = await selectBatchForUpdate(transaction, input.batchId);
    if (batch.status !== "staging" && batch.status !== "ready") {
      throw new Error(`Batch ${input.batchId} cannot checkpoint while ${batch.status}`);
    }
    await transaction
      .insertInto("food_import_checkpoint")
      .values({
        batch_id: input.batchId,
        cursor_data: input.cursor,
        last_sequence_number: input.lastSequenceNumber ?? null,
        processed_count: input.processedCount,
        stage: input.stage,
      })
      .onConflict((conflict) =>
        conflict.columns(["batch_id", "stage"]).doUpdateSet({
          cursor_data: input.cursor,
          last_sequence_number: input.lastSequenceNumber ?? null,
          processed_count: input.processedCount,
        }),
      )
      .execute();
  });
}

export async function getBatchCheckpoint(
  database: Kysely<Database>,
  batchId: string,
  stage: FoodImportCheckpointStage,
): Promise<BatchCheckpoint | null> {
  const row = await database
    .selectFrom("food_import_checkpoint")
    .selectAll()
    .where("batch_id", "=", batchId)
    .where("stage", "=", stage)
    .executeTakeFirst();
  return row
    ? {
        cursor: row.cursor_data,
        lastSequenceNumber: row.last_sequence_number,
        processedCount: row.processed_count,
        stage: row.stage,
        updatedAt: row.updated_at,
      }
    : null;
}

/** Read-only validation for release review/diff tooling. */
export async function previewBatchValidation(
  database: DatabaseExecutor,
  batchId: string,
  policy: Partial<BatchValidationPolicy> = {},
): Promise<BatchValidationSummary> {
  const batch = await selectBatch(database, batchId);
  return buildValidationSummary(database, batch, normalizePolicy(policy));
}

/** Classify every staged row once and freeze the exact validation summary. */
export async function validateBatch(
  database: Kysely<Database>,
  batchId: string,
  policy: Partial<BatchValidationPolicy> = {},
): Promise<BatchValidationSummary> {
  return database.transaction().execute(async (transaction) => {
    const batch = await selectBatchForUpdate(transaction, batchId);
    if (batch.status !== "staging") {
      const savedPolicy = normalizePolicy(batch.validation_policy);
      return buildValidationSummary(transaction, batch, savedPolicy);
    }
    const normalizedPolicy = normalizePolicy(policy);
    const summary = await buildValidationSummary(transaction, batch, normalizedPolicy);
    const validatedAt = new Date();
    for (const record of summary.records) {
      await transaction
        .updateTable("food_import_record")
        .set({
          validated_at: validatedAt,
          validation_issues: sql<JsonArray>`${canonicalJson(record.issues as JsonValue)}::jsonb`,
          validation_status: record.status,
        })
        .where("batch_id", "=", batchId)
        .where("source_record_key", "=", record.sourceRecordKey)
        .where("validation_status", "=", "pending")
        .execute();
    }
    await transaction
      .updateTable("food_import_batch")
      .set({
        quarantined_count: summary.quarantinedCount,
        nutrient_excluded_count: summary.excludedNutrientCount,
        nutrient_input_count: summary.nutrientInputCount,
        nutrient_materializable_count: summary.nutrientMaterializableCount,
        status: summary.promotionEligible ? "ready" : "quarantined",
        unresolved_error_count: summary.unresolvedErrorCount,
        valid_count: summary.validCount,
        validated_at: validatedAt,
        validation_policy: normalizedPolicy,
        warning_count: summary.warningCount,
      })
      .where("id", "=", batchId)
      .execute();
    return summary;
  });
}

/** Bind a human/service approval to the exact post-validation digest. */
export async function approveBatch(
  database: Kysely<Database>,
  input: ApproveBatchInput,
): Promise<void> {
  assertSha256(input.validationDigest, "validationDigest");
  assertSha256(input.rightsManifestSha256, "rightsManifestSha256");
  const principalId = stablePrincipalId(input.principalId, "principalId");
  requireText(input.approvalReference, "approvalReference");
  await database.transaction().execute(async (transaction) => {
    const batch = await selectBatchForUpdate(transaction, input.batchId);
    if (batch.status !== "ready") {
      throw new Error(`Batch ${input.batchId} cannot be approved while ${batch.status}`);
    }
    const summary = await buildValidationSummary(
      transaction,
      batch,
      normalizePolicy(batch.validation_policy),
    );
    if (summary.validationDigest !== input.validationDigest) {
      throw new Error("Approval digest does not match the current validation evidence");
    }
    if (input.rightsManifestSha256 !== batch.rights_manifest_sha256) {
      throw new Error("Approval rights-manifest digest does not match the staged batch");
    }
    const inserted = await transaction
      .insertInto("food_import_approval")
      .values({
        approval_role: input.approvalRole,
        approval_reference: input.approvalReference,
        batch_id: input.batchId,
        principal_id: principalId,
        rights_manifest_sha256: input.rightsManifestSha256,
        validation_digest: input.validationDigest,
      })
      .onConflict((conflict) => conflict.columns(["batch_id", "approval_role"]).doNothing())
      .returning("batch_id")
      .executeTakeFirst();
    if (!inserted) {
      const approval = await transaction
        .selectFrom("food_import_approval")
        .selectAll()
        .where("batch_id", "=", input.batchId)
        .where("approval_role", "=", input.approvalRole)
        .executeTakeFirstOrThrow();
      if (
        approval.validation_digest !== input.validationDigest ||
        approval.rights_manifest_sha256 !== input.rightsManifestSha256 ||
        approval.principal_id !== principalId ||
        approval.approval_reference !== input.approvalReference
      ) {
        throw new Error(`Batch ${input.batchId} already has a different immutable approval`);
      }
    }
  });
}

/**
 * Materialize and activate a validated batch in one transaction. Any failure
 * rolls back release rows, versions, pointers, and workflow state together.
 */
export async function promoteBatch(
  database: Kysely<Database>,
  options: PromoteBatchOptions,
): Promise<PromoteBatchResult> {
  const performedBy = stablePrincipalId(options.performedBy, "performedBy");
  return database.transaction().execute(async (transaction) => {
    const initialBatch = await selectBatchForUpdate(transaction, options.batchId);
    const source = await selectAndLockSource(transaction, initialBatch.food_source_id);
    await lockSource(transaction, source.id);

    if (initialBatch.status === "completed") {
      if (!initialBatch.release_id) throw new Error("Completed batch is missing its release");
      const originalActivation = await transaction
        .selectFrom("food_source_release_activation")
        .select("previous_release_id")
        .where("import_batch_id", "=", initialBatch.id)
        .executeTakeFirstOrThrow();
      return {
        activatedReleaseId: initialBatch.release_id,
        materializedCount: Number(initialBatch.materialized_count),
        previousReleaseId: originalActivation.previous_release_id,
        wasAlreadyCompleted: true,
      };
    }
    assertSourceMayActivate(source);
    if (initialBatch.status !== "ready" || Number(initialBatch.unresolved_error_count) !== 0) {
      throw new Error(`Batch ${options.batchId} is not promotion-ready`);
    }

    const summary = await buildValidationSummary(
      transaction,
      initialBatch,
      normalizePolicy(initialBatch.validation_policy),
    );
    if (!summary.promotionEligible || summary.unresolvedErrorCount !== 0) {
      throw new Error("Validation evidence no longer satisfies promotion policy");
    }
    const approvals = await transaction
      .selectFrom("food_import_approval")
      .selectAll()
      .where("batch_id", "=", options.batchId)
      .execute();
    const roles = new Set(approvals.map((approval) => approval.approval_role));
    const approvalsMatch = approvals.every(
      (approval) =>
        approval.validation_digest === summary.validationDigest &&
        approval.rights_manifest_sha256 === initialBatch.rights_manifest_sha256,
    );
    if (!approvalsMatch || !roles.has("data") || !roles.has("quality") || !roles.has("rights")) {
      throw new Error("Data, quality, and rights approvals for current evidence are required");
    }
    if (
      summary.validationPolicy.requireDistinctApprovalPrincipals &&
      new Set(approvals.map((approval) => approval.principal_id)).size !== approvals.length
    ) {
      throw new Error("Promotion policy requires distinct approval principals");
    }

    const release = await createOrLoadRelease(transaction, initialBatch, summary);
    await transaction
      .updateTable("food_import_batch")
      .set({ release_id: release.id, status: "promoting" })
      .where("id", "=", initialBatch.id)
      .execute();

    const nutrientRegistry = await loadNutrientMappings(transaction, source.id);
    const forbiddenGtins = await loadForbiddenGtins(transaction, source.id);
    const validRecords = await transaction
      .selectFrom("food_import_record")
      .selectAll()
      .where("batch_id", "=", options.batchId)
      .where("validation_status", "=", "valid")
      .orderBy("sequence_number")
      .execute();
    if (validRecords.length !== summary.validCount) {
      throw new Error("Validated record count changed before promotion");
    }

    const materialized: Array<{
      foodId: string;
      foodVersionId: string;
      gtin: string | null;
      marketCode: string;
    }> = [];
    for (const record of validRecords) {
      const validation = validateRecordRow(
        record,
        initialBatch,
        source.code,
        nutrientRegistry.mappings,
        forbiddenGtins,
      );
      if (!validation.recordIsValid || !validation.food) {
        throw new Error(`Validated record ${record.source_record_key} no longer materializes`);
      }
      const linked = await materializeRecord(
        transaction,
        initialBatch,
        release.id,
        record,
        validation,
      );
      materialized.push(linked);
    }

    const previousReleaseId = source.active_release_id;
    await activateCataloguePointers(transaction, source.id, release.id);
    await replaceActiveBarcodes(transaction, source.id, release.id, materialized);
    if (release.status === "imported") {
      await transaction
        .updateTable("food_source_release")
        .set({ promoted_at: new Date(), status: "promoted" })
        .where("id", "=", release.id)
        .where("status", "=", "imported")
        .execute();
    }
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: release.id })
      .where("id", "=", source.id)
      .execute();

    const activation = await transaction
      .insertInto("food_source_release_activation")
      .values({
        food_source_id: source.id,
        import_batch_id: initialBatch.id,
        operation: "activate",
        performed_by: performedBy,
        previous_release_id: previousReleaseId,
        reason: options.reason ?? `Promote import batch ${initialBatch.id}`,
        release_id: release.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeActivationOutbox(
      transaction,
      source.id,
      activation.id,
      previousReleaseId,
      release.id,
    );

    await transaction
      .updateTable("food_import_batch")
      .set({
        completed_at: new Date(),
        materialized_count: materialized.length,
        status: "completed",
      })
      .where("id", "=", initialBatch.id)
      .execute();
    return {
      activatedReleaseId: release.id,
      materializedCount: materialized.length,
      previousReleaseId,
      wasAlreadyCompleted: false,
    };
  });
}

/** Repoint or deactivate one source; immutable versions and diary rows are never touched. */
export async function rollbackSourceRelease(
  database: Kysely<Database>,
  input: RollbackSourceReleaseInput,
): Promise<RollbackSourceReleaseResult> {
  requireText(input.sourceCode, "sourceCode");
  const performedBy = stablePrincipalId(input.performedBy, "performedBy");
  requireText(input.reason, "reason");
  return database.transaction().execute(async (transaction) => {
    const source = await transaction
      .selectFrom("food_source")
      .selectAll()
      .where("code", "=", input.sourceCode)
      .forUpdate()
      .executeTakeFirst();
    if (!source) throw new Error(`Unknown food source ${input.sourceCode}`);
    await lockSource(transaction, source.id);

    if (input.targetReleaseId) {
      assertSourceMayActivate(source);
      const target = await transaction
        .selectFrom("food_source_release")
        .select(["id", "status"])
        .where("id", "=", input.targetReleaseId)
        .where("food_source_id", "=", source.id)
        .executeTakeFirst();
      if (!target) {
        throw new Error(`Release ${input.targetReleaseId} does not belong to ${input.sourceCode}`);
      }
      if (target.status !== "promoted") {
        throw new Error(`Release ${input.targetReleaseId} has never been promoted`);
      }
    }

    const previousReleaseId = source.active_release_id;
    if (previousReleaseId === input.targetReleaseId) {
      return { activeReleaseId: input.targetReleaseId, changed: false, previousReleaseId };
    }
    await activateCataloguePointers(transaction, source.id, input.targetReleaseId);
    await restoreReleaseBarcodes(transaction, source.id, input.targetReleaseId);
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: input.targetReleaseId })
      .where("id", "=", source.id)
      .execute();

    const operation = input.targetReleaseId
      ? previousReleaseId
        ? "rollback"
        : "activate"
      : "deactivate";
    const activation = await transaction
      .insertInto("food_source_release_activation")
      .values({
        food_source_id: source.id,
        import_batch_id: null,
        operation,
        performed_by: performedBy,
        previous_release_id: previousReleaseId,
        reason: input.reason,
        release_id: input.targetReleaseId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeActivationOutbox(
      transaction,
      source.id,
      activation.id,
      previousReleaseId,
      input.targetReleaseId,
    );
    return {
      activeReleaseId: input.targetReleaseId,
      changed: true,
      previousReleaseId,
    };
  });
}

async function buildValidationSummary(
  database: DatabaseExecutor,
  batch: BatchRow,
  policy: BatchValidationPolicy,
): Promise<BatchValidationSummary> {
  const source = await database
    .selectFrom("food_source")
    .select("code")
    .where("id", "=", batch.food_source_id)
    .executeTakeFirstOrThrow();
  const nutrientRegistry = await loadNutrientMappings(database, batch.food_source_id);
  const pinnedMappingDigest = /\+mapping\.([0-9a-f]{64})$/.exec(batch.parser_version)?.[1];
  if (pinnedMappingDigest && pinnedMappingDigest !== nutrientRegistry.revisionDigest) {
    throw new Error(
      "Source nutrient mappings changed after this validation attempt was created; stage a new attempt",
    );
  }
  const forbiddenGtins = await loadForbiddenGtins(database, batch.food_source_id);
  const rows = await database
    .selectFrom("food_import_record")
    .selectAll()
    .where("batch_id", "=", batch.id)
    .orderBy("sequence_number")
    .execute();
  const initialResults = rows.map((record) =>
    validateRecordRow(record, batch, source.code, nutrientRegistry.mappings, forbiddenGtins),
  );
  const sourceFoodKeyCounts = new Map<string, number>();
  for (const result of initialResults) {
    const sourceFoodKey = result.food?.sourceFoodKey;
    if (sourceFoodKey) {
      sourceFoodKeyCounts.set(sourceFoodKey, (sourceFoodKeyCounts.get(sourceFoodKey) ?? 0) + 1);
    }
  }
  const duplicateSourceFoodKeys = new Set(
    [...sourceFoodKeyCounts].filter(([, count]) => count > 1).map(([key]) => key),
  );
  const validationResults =
    duplicateSourceFoodKeys.size === 0
      ? initialResults
      : rows.map((record) =>
          validateRecordRow(
            record,
            batch,
            source.code,
            nutrientRegistry.mappings,
            forbiddenGtins,
            duplicateSourceFoodKeys,
          ),
        );
  const records = rows.map((record, index) => {
    const result = validationResults[index];
    if (!result) throw new Error(`Missing validation result for ${record.source_record_key}`);
    return {
      canonicalPayloadSha256: record.canonical_payload_sha256,
      excludedNutrientCount: result.excludedNutrientCount,
      issues: result.issues,
      nutrientInputCount: result.nutrientInputCount,
      nutrientMaterializableCount: result.nutrientMaterializableCount,
      portionInputCount: result.portionInputCount,
      sourceRecordKey: record.source_record_key,
      status: result.recordIsValid ? ("valid" as const) : ("quarantined" as const),
    };
  });
  const parserReport = await database
    .selectFrom("food_import_parser_report")
    .selectAll()
    .where("batch_id", "=", batch.id)
    .executeTakeFirst();
  if (!parserReport) {
    throw new Error(`Batch ${batch.id} is missing immutable parser evidence`);
  }
  const parserEvidence = parserCountsFromRow(parserReport);
  const emittedNutrientCount = records.reduce(
    (total, record) => total + record.nutrientInputCount,
    0,
  );
  const emittedPortionCount = records.reduce(
    (total, record) => total + record.portionInputCount,
    0,
  );
  if (
    parserEvidence.emittedRecordCount !== records.length ||
    parserEvidence.emittedNutrientCount !== emittedNutrientCount ||
    parserEvidence.emittedPortionCount !== emittedPortionCount
  ) {
    throw new Error("Parser report emitted counts do not match staged canonical records");
  }
  const evaluation = evaluateBatchPolicy(records, policy, parserEvidence);
  const digestEvidence: JsonObject = {
    artifactSha256: batch.artifact_sha256,
    batchId: batch.id,
    nutrientMappingDigest: nutrientRegistry.revisionDigest,
    policy,
    parserEvidence: { ...parserEvidence },
    parserReportSha256: parserReport.report_sha256,
    records: records.map((record) => ({
      canonicalPayloadSha256: record.canonicalPayloadSha256,
      issues: record.issues,
      excludedNutrientCount: record.excludedNutrientCount,
      nutrientInputCount: record.nutrientInputCount,
      nutrientMaterializableCount: record.nutrientMaterializableCount,
      portionInputCount: record.portionInputCount,
      sourceRecordKey: record.sourceRecordKey,
      status: record.status,
    })),
    rightsManifestSha256: batch.rights_manifest_sha256,
  };
  return {
    ...evaluation,
    nutrientMappingDigest: nutrientRegistry.revisionDigest,
    parserExcludedNutrientCount: parserEvidence.excludedNutrientCount,
    parserExcludedPortionCount: parserEvidence.excludedPortionCount,
    parserExcludedRecordCount: parserEvidence.excludedRecordCount,
    parserReportSha256: parserReport.report_sha256,
    portionInputCount: parserEvidence.sourcePortionCount,
    records,
    stagedCount: records.length,
    validationDigest: sha256CanonicalJson(digestEvidence),
    validationPolicy: policy,
  };
}

function validateRecordRow(
  record: RecordRow,
  batch: BatchRow,
  sourceCode: string,
  nutrientMappings: ReadonlyMap<string, ReviewedCatalogueNutrientMapping>,
  forbiddenGtins: ReadonlySet<string>,
  duplicateSourceFoodKeys: ReadonlySet<string> = new Set(),
): CatalogueRecordValidationResult {
  return validateCatalogueRecord(
    record.canonical_payload,
    {
      canonicalPayloadSha256: record.canonical_payload_sha256,
      expectedReleaseKey: batch.release_key,
      expectedSourceCode: sourceCode,
      sourcePayloadSha256: record.source_payload_sha256,
      sourceRecordKey: record.source_record_key,
      sourceRecordType: record.source_record_type,
    },
    nutrientMappings,
    forbiddenGtins,
    duplicateSourceFoodKeys,
  );
}

async function createOrLoadRelease(
  transaction: Transaction<Database>,
  batch: BatchRow,
  summary: BatchValidationSummary,
): Promise<Selectable<Database["food_source_release"]>> {
  const recordCounts: JsonObject = {
    materializable: summary.validCount,
    nutrientInput: summary.nutrientInputCount,
    nutrientMaterializable: summary.nutrientMaterializableCount,
    nutrientExcluded: summary.excludedNutrientCount,
    parserExcludedRecords: summary.parserExcludedRecordCount,
    quarantined: summary.quarantinedCount,
    sourcePortions: summary.portionInputCount,
    sourceRecords: summary.stagedCount + summary.parserExcludedRecordCount,
    staged: summary.stagedCount,
  };
  const validationSummary: JsonObject = {
    recordErrors: summary.recordErrorCount,
    excludedNutrientFraction: summary.excludedNutrientFraction,
    nutrientMappingDigest: summary.nutrientMappingDigest,
    parserExcludedNutrients: summary.parserExcludedNutrientCount,
    parserExcludedPortions: summary.parserExcludedPortionCount,
    parserReportSha256: summary.parserReportSha256,
    unresolvedErrors: summary.unresolvedErrorCount,
    validationDigest: summary.validationDigest,
    warnings: summary.warningCount,
  };
  const inserted = await transaction
    .insertInto("food_source_release")
    .values({
      acquired_at: batch.acquired_at,
      artifact_bytes: batch.artifact_bytes,
      artifact_sha256: batch.artifact_sha256,
      artifact_uri: batch.artifact_uri,
      food_source_id: batch.food_source_id,
      media_type: batch.media_type,
      parser_version: batch.parser_version,
      published_on: batch.published_on,
      record_counts: recordCounts,
      release_key: batch.release_key,
      rights_manifest_uri: batch.rights_manifest_uri,
      rights_manifest_sha256: batch.rights_manifest_sha256,
      status: "imported",
      upstream_schema_version: batch.upstream_schema_version,
      validation_summary: validationSummary,
    })
    .onConflict((conflict) =>
      conflict.columns(["food_source_id", "release_key", "artifact_sha256"]).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  const release =
    inserted ??
    (await transaction
      .selectFrom("food_source_release")
      .selectAll()
      .where("food_source_id", "=", batch.food_source_id)
      .where("release_key", "=", batch.release_key)
      .where("artifact_sha256", "=", batch.artifact_sha256)
      .executeTakeFirstOrThrow());
  if (
    release.parser_version !== batch.parser_version ||
    release.rights_manifest_uri !== batch.rights_manifest_uri ||
    release.rights_manifest_sha256 !== batch.rights_manifest_sha256 ||
    canonicalJson(release.record_counts) !== canonicalJson(recordCounts) ||
    canonicalJson(release.validation_summary) !== canonicalJson(validationSummary)
  ) {
    throw new Error("Existing source release provenance differs from the approved batch");
  }
  if (release.status !== "imported" && release.status !== "promoted") {
    throw new Error(`Source release ${release.id} cannot be promoted while ${release.status}`);
  }
  return release;
}

async function materializeRecord(
  transaction: Transaction<Database>,
  batch: BatchRow,
  releaseId: string,
  record: RecordRow,
  validation: CatalogueRecordValidationResult,
): Promise<{
  foodId: string;
  foodVersionId: string;
  gtin: string | null;
  marketCode: string;
}> {
  const food = validation.food;
  if (!food) throw new Error("Cannot materialize an invalid record");
  await transaction
    .insertInto("food")
    .values({
      food_source_id: batch.food_source_id,
      kind: food.kind,
      owner_user_id: null,
      source_food_key: food.sourceFoodKey,
      visibility: "public",
    })
    .onConflict((conflict) =>
      conflict
        .columns(["food_source_id", "source_food_key"])
        .where("food_source_id", "is not", null)
        .doNothing(),
    )
    .execute();
  const foodRow = await transaction
    .selectFrom("food")
    .select(["id", "kind"])
    .where("food_source_id", "=", batch.food_source_id)
    .where("source_food_key", "=", food.sourceFoodKey)
    .executeTakeFirstOrThrow();
  if (foodRow.kind !== food.kind) {
    throw new Error(`Food ${food.sourceFoodKey} changed kind across source releases`);
  }

  const existingVersion = await transaction
    .selectFrom("food_version")
    .selectAll()
    .where("food_id", "=", foodRow.id)
    .where("source_release_id", "=", releaseId)
    .executeTakeFirst();
  if (
    existingVersion &&
    (existingVersion.attributes.canonicalPayloadSha256 !== record.canonical_payload_sha256 ||
      existingVersion.attributes.importBatchId !== batch.id)
  ) {
    throw new Error(
      `Source food ${food.sourceFoodKey} maps to conflicting payloads in release ${releaseId}`,
    );
  }
  let foodVersion = existingVersion;
  if (!foodVersion) {
    const versionResult = await sql<{ version_number: number }>`
      select (coalesce(max(version_number), 0) + 1)::integer as version_number
      from food_version where food_id = ${foodRow.id}
    `.execute(transaction);
    const versionNumber = versionResult.rows[0]?.version_number ?? 1;
    const attributes: JsonObject = {
      ...food.attributes,
      canonicalPayloadSha256: record.canonical_payload_sha256,
      importBatchId: batch.id,
    };
    foodVersion = await transaction
      .insertInto("food_version")
      .values({
        attributes,
        basis_quantity: food.basisQuantity,
        basis_unit: "g",
        brand_name: food.brandName,
        created_by_user_id: null,
        data_quality: "provisional",
        description: food.description,
        food_id: foodRow.id,
        ingredients_text: null,
        language_tag: food.languageTag,
        market_code: food.marketCode,
        name: food.name,
        normalized_name: food.normalizedName,
        source_modified_at: food.sourceModifiedAt,
        source_release_id: releaseId,
        version_number: versionNumber,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  for (const value of food.nutrients) {
    const nutrient = await transaction
      .selectFrom("nutrient")
      .select(["id", "canonical_unit"])
      .where("id", "=", value.nutrientId)
      .where("code", "=", value.nutrientCode)
      .executeTakeFirstOrThrow();
    if (nutrient.canonical_unit !== value.canonicalUnit) {
      throw new Error(`Nutrient ${value.nutrientCode} changed canonical unit during promotion`);
    }
    await transaction
      .insertInto("food_nutrient_value")
      .values({
        amount: value.amount,
        basis_quantity: food.basisQuantity,
        basis_unit: "g",
        confidence: null,
        derivation_code: value.derivationCode,
        food_version_id: foodVersion.id,
        metadata: value.metadata,
        nutrient_id: nutrient.id,
        source_amount: value.sourceAmount,
        source_basis_quantity: value.sourceBasisQuantity,
        source_basis_unit: value.sourceBasisUnit,
        source_unit: value.sourceUnit,
        unit: value.canonicalUnit,
        value_status: value.valueStatus,
      })
      .onConflict((conflict) => conflict.columns(["food_version_id", "nutrient_id"]).doNothing())
      .execute();
  }

  for (const serving of food.servings) {
    await transaction
      .insertInto("food_serving")
      .values({
        display_order: serving.displayOrder,
        food_version_id: foodVersion.id,
        gram_weight: serving.gramWeight,
        is_default: serving.isDefault,
        label: serving.label,
        metadata: serving.metadata,
        milliliter_volume: null,
        quantity: serving.quantity,
        source_serving_key: serving.sourceServingKey,
        unit: serving.unit,
        unit_kind: serving.unitKind,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["food_version_id", "source_serving_key"])
          .where("source_serving_key", "is not", null)
          .doNothing(),
      )
      .execute();
  }

  await transaction
    .updateTable("food_import_record")
    .set({
      food_version_id: foodVersion.id,
      materialized_at: new Date(),
      validation_status: "materialized",
    })
    .where("id", "=", record.id)
    .where("validation_status", "=", "valid")
    .execute();
  return {
    foodId: foodRow.id,
    foodVersionId: foodVersion.id,
    gtin: food.gtin,
    marketCode: food.marketCode,
  };
}

async function activateCataloguePointers(
  transaction: Transaction<Database>,
  sourceId: string,
  releaseId: string | null,
): Promise<void> {
  await sql`
    update food
    set current_version_id = null, archived_at = clock_timestamp()
    where food_source_id = ${sourceId}
  `.execute(transaction);
  if (!releaseId) return;
  await sql`
    update food as target
    set current_version_id = version.id, archived_at = null
    from food_version as version
    where target.food_source_id = ${sourceId}
      and version.food_id = target.id
      and version.source_release_id = ${releaseId}
  `.execute(transaction);
}

async function replaceActiveBarcodes(
  transaction: Transaction<Database>,
  sourceId: string,
  releaseId: string,
  materialized: readonly {
    foodId: string;
    foodVersionId: string;
    gtin: string | null;
    marketCode: string;
  }[],
): Promise<void> {
  await closeActiveBarcodes(transaction, sourceId);
  for (const item of materialized) {
    if (!item.gtin) continue;
    const inserted = await sql<{ id: string }>`
      insert into food_barcode (
        food_id,
        food_serving_id,
        food_version_id,
        gtin,
        market_code,
        metadata,
        source_release_id
      ) values (
        ${item.foodId},
        null,
        ${item.foodVersionId},
        ${item.gtin},
        ${item.marketCode},
        jsonb_build_object('activation', 'promotion'),
        ${releaseId}
      )
      on conflict ((lpad(gtin, 14, '0')), market_code)
        where valid_to is null
        do nothing
      returning id
    `.execute(transaction);
    if (!inserted.rows[0]) {
      throw new Error(`GTIN ${item.gtin} became unavailable after validation`);
    }
  }
}

async function restoreReleaseBarcodes(
  transaction: Transaction<Database>,
  sourceId: string,
  releaseId: string | null,
): Promise<void> {
  if (!releaseId) {
    await closeActiveBarcodes(transaction, sourceId);
    return;
  }
  const conflicts = await sql<{ gtin: string; market_code: string }>`
    select distinct desired.gtin, desired.market_code
    from food_barcode as desired
    join food as desired_food on desired_food.id = desired.food_id
    join food_barcode as active
      on lpad(active.gtin, 14, '0') = lpad(desired.gtin, 14, '0')
      and active.market_code = desired.market_code
      and active.valid_to is null
    join food as active_food on active_food.id = active.food_id
    where desired_food.food_source_id = ${sourceId}
      and desired.source_release_id = ${releaseId}
      and active_food.food_source_id is distinct from ${sourceId}
  `.execute(transaction);
  if (conflicts.rows.length > 0) {
    const conflict = conflicts.rows[0];
    throw new Error(
      `Cannot restore GTIN ${conflict?.gtin}/${conflict?.market_code}; another source owns it`,
    );
  }
  await closeActiveBarcodes(transaction, sourceId);
  await sql`
    insert into food_barcode (
      gtin, market_code, food_id, food_version_id, food_serving_id,
      source_release_id, valid_from, metadata
    )
    select distinct on (lpad(barcode.gtin, 14, '0'), barcode.market_code)
      lpad(barcode.gtin, 14, '0'),
      barcode.market_code,
      barcode.food_id,
      barcode.food_version_id,
      barcode.food_serving_id,
      barcode.source_release_id,
      clock_timestamp(),
      jsonb_build_object('activation', 'rollback', 'priorBarcodeId', barcode.id)
    from food_barcode as barcode
    join food as source_food on source_food.id = barcode.food_id
    where source_food.food_source_id = ${sourceId}
      and barcode.source_release_id = ${releaseId}
    order by
      lpad(barcode.gtin, 14, '0'),
      barcode.market_code,
      barcode.created_at desc,
      barcode.id desc
  `.execute(transaction);
}

async function closeActiveBarcodes(
  transaction: Transaction<Database>,
  sourceId: string,
): Promise<void> {
  await sql`
    update food_barcode as barcode
    set valid_to = clock_timestamp()
    from food as source_food
    where source_food.id = barcode.food_id
      and source_food.food_source_id = ${sourceId}
      and barcode.valid_to is null
  `.execute(transaction);
}

async function writeActivationOutbox(
  transaction: Transaction<Database>,
  sourceId: string,
  activationId: string,
  previousReleaseId: string | null,
  releaseId: string | null,
): Promise<void> {
  const payload: JsonObject = { activationId, previousReleaseId, releaseId, sourceId };
  await transaction
    .insertInto("outbox_event")
    .values({
      aggregate_id: sourceId,
      aggregate_type: "food_source",
      attempt_count: 0,
      available_at: new Date(),
      deduplication_key: `catalogue-activation:${activationId}`,
      event_version: 1,
      event_type: "catalogue.source_release_activated",
      headers: {},
      last_error: null,
      locked_at: null,
      locked_by: null,
      payload,
      published_at: null,
    })
    .execute();
}

async function loadNutrientMappings(
  database: DatabaseExecutor,
  sourceId: string,
): Promise<{
  readonly mappings: ReadonlyMap<string, ReviewedCatalogueNutrientMapping>;
  readonly revisionDigest: string;
}> {
  const mappings = await database
    .selectFrom("source_nutrient_map as mapping")
    .innerJoin(
      "source_nutrient_map_revision as revision",
      "revision.id",
      "mapping.current_revision_id",
    )
    .innerJoin("nutrient", "nutrient.id", "revision.nutrient_id")
    .select([
      "mapping.source_nutrient_key",
      "revision.id as revision_id",
      "revision.source_unit",
      "revision.conversion_multiplier",
      "nutrient.id as nutrient_id",
      "nutrient.code as nutrient_code",
      "nutrient.canonical_unit",
      "nutrient.dimension",
      "nutrient.name as nutrient_name",
    ])
    .where("mapping.food_source_id", "=", sourceId)
    .orderBy("mapping.source_nutrient_key")
    .execute();
  const registry = new Map(
    mappings.map((mapping) => [
      mapping.source_nutrient_key,
      {
        canonicalUnit: mapping.canonical_unit,
        conversionMultiplier: String(mapping.conversion_multiplier),
        mappingRevisionId: mapping.revision_id,
        nutrientCode: mapping.nutrient_code,
        nutrientId: mapping.nutrient_id,
        sourceNutrientId: mapping.source_nutrient_key,
        sourceUnit: mapping.source_unit,
      },
    ]),
  );
  const snapshot: JsonArray = mappings.map((mapping) => ({
    canonicalUnit: mapping.canonical_unit,
    conversionMultiplier: normalizeDatabaseDecimal(String(mapping.conversion_multiplier)),
    nutrientCode: mapping.nutrient_code,
    nutrientDimension: mapping.dimension,
    nutrientId: String(mapping.nutrient_id),
    nutrientName: mapping.nutrient_name,
    revisionId: mapping.revision_id,
    sourceNutrientKey: mapping.source_nutrient_key,
    sourceUnit: mapping.source_unit,
  }));
  return { mappings: registry, revisionDigest: sha256CanonicalJson(snapshot) };
}

/** Digest of the exact active mapping revisions used to identify a validation attempt. */
export async function getSourceNutrientMappingDigest(
  database: Kysely<Database>,
  sourceCode: string,
): Promise<string> {
  requireText(sourceCode, "sourceCode");
  const source = await database
    .selectFrom("food_source")
    .select("id")
    .where("code", "=", sourceCode)
    .executeTakeFirst();
  if (!source) throw new Error(`Unknown food source ${sourceCode}`);
  return (await loadNutrientMappings(database, source.id)).revisionDigest;
}

async function selectCurrentMapping(
  transaction: Transaction<Database>,
  sourceId: string,
  sourceNutrientKey: string,
) {
  return transaction
    .selectFrom("source_nutrient_map as mapping")
    .innerJoin(
      "source_nutrient_map_revision as revision",
      "revision.id",
      "mapping.current_revision_id",
    )
    .select([
      "revision.id",
      "revision.nutrient_id",
      "revision.source_name",
      "revision.source_unit",
      "revision.conversion_multiplier",
      "revision.mapping_notes",
      "revision.reviewed_at",
      "revision.reviewed_by",
    ])
    .where("mapping.food_source_id", "=", sourceId)
    .where("mapping.source_nutrient_key", "=", sourceNutrientKey)
    .executeTakeFirst();
}

async function ensureCanonicalNutrient(
  transaction: Transaction<Database>,
  mapping: ReviewedNutrientMappingInput,
  reviewedBy: string,
) {
  await transaction
    .insertInto("nutrient")
    .values({
      canonical_unit: mapping.canonicalNutrient.unit,
      code: mapping.canonicalNutrient.code,
      dimension: mapping.canonicalNutrient.dimension,
      metadata: { ontologyReviewPrincipal: reviewedBy },
      name: mapping.canonicalNutrient.name,
    })
    .onConflict((conflict) => conflict.column("code").doNothing())
    .execute();
  const nutrient = await transaction
    .selectFrom("nutrient")
    .select(["id", "name", "canonical_unit", "dimension"])
    .where("code", "=", mapping.canonicalNutrient.code)
    .executeTakeFirstOrThrow();
  if (
    nutrient.canonical_unit !== mapping.canonicalNutrient.unit ||
    nutrient.dimension !== mapping.canonicalNutrient.dimension ||
    nutrient.name !== mapping.canonicalNutrient.name
  ) {
    throw new Error(`Canonical nutrient ${mapping.canonicalNutrient.code} conflicts with ontology`);
  }
  return nutrient;
}

async function lockNutrientRegistry(transaction: Transaction<Database>): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${NUTRIENT_REGISTRY_LOCK_NAMESPACE}))`.execute(
    transaction,
  );
}

function validateMappingInput(mapping: ReviewedNutrientMappingInput): void {
  requireText(mapping.sourceNutrientKey, "sourceNutrientKey");
  requireText(mapping.sourceName, "sourceName");
  requireText(mapping.sourceUnit, "sourceUnit");
  requireText(mapping.canonicalNutrient.code, "canonicalNutrient.code");
  requireText(mapping.canonicalNutrient.name, "canonicalNutrient.name");
  requireText(mapping.canonicalNutrient.unit, "canonicalNutrient.unit");
  const multiplier = mapping.conversionMultiplier ?? "1";
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(multiplier) || Number(multiplier) <= 0) {
    throw new Error(`Invalid conversion multiplier for ${mapping.sourceNutrientKey}`);
  }
}

function parserCountsFromInput(input: RecordBatchParserReportInput): ParserCountEvidence {
  return {
    emittedNutrientCount: nonNegativeSafeInteger(
      input.emittedNutrientCount,
      "emittedNutrientCount",
    ),
    emittedPortionCount: nonNegativeSafeInteger(input.emittedPortionCount, "emittedPortionCount"),
    emittedRecordCount: nonNegativeSafeInteger(input.emittedRecordCount, "emittedRecordCount"),
    excludedNutrientCount: nonNegativeSafeInteger(
      input.excludedNutrientCount,
      "excludedNutrientCount",
    ),
    excludedPortionCount: nonNegativeSafeInteger(
      input.excludedPortionCount,
      "excludedPortionCount",
    ),
    excludedRecordCount: nonNegativeSafeInteger(input.excludedRecordCount, "excludedRecordCount"),
    sourceNutrientCount: nonNegativeSafeInteger(input.sourceNutrientCount, "sourceNutrientCount"),
    sourcePortionCount: nonNegativeSafeInteger(input.sourcePortionCount, "sourcePortionCount"),
    sourceRecordCount: nonNegativeSafeInteger(input.sourceRecordCount, "sourceRecordCount"),
  };
}

function parserCountsFromRow(row: Selectable<FoodImportParserReportTable>): ParserCountEvidence {
  return {
    emittedNutrientCount: nonNegativeSafeInteger(
      row.emitted_nutrient_count,
      "emitted_nutrient_count",
    ),
    emittedPortionCount: nonNegativeSafeInteger(row.emitted_portion_count, "emitted_portion_count"),
    emittedRecordCount: nonNegativeSafeInteger(row.emitted_record_count, "emitted_record_count"),
    excludedNutrientCount: nonNegativeSafeInteger(
      row.excluded_nutrient_count,
      "excluded_nutrient_count",
    ),
    excludedPortionCount: nonNegativeSafeInteger(
      row.excluded_portion_count,
      "excluded_portion_count",
    ),
    excludedRecordCount: nonNegativeSafeInteger(row.excluded_record_count, "excluded_record_count"),
    sourceNutrientCount: nonNegativeSafeInteger(row.source_nutrient_count, "source_nutrient_count"),
    sourcePortionCount: nonNegativeSafeInteger(row.source_portion_count, "source_portion_count"),
    sourceRecordCount: nonNegativeSafeInteger(row.source_record_count, "source_record_count"),
  };
}

function assertParserCountSums(counts: ParserCountEvidence): void {
  if (counts.sourceRecordCount !== counts.emittedRecordCount + counts.excludedRecordCount) {
    throw new Error("Parser source record count must equal emitted plus excluded records");
  }
  if (counts.sourceNutrientCount !== counts.emittedNutrientCount + counts.excludedNutrientCount) {
    throw new Error("Parser source nutrient count must equal emitted plus excluded nutrients");
  }
  if (counts.sourcePortionCount !== counts.emittedPortionCount + counts.excludedPortionCount) {
    throw new Error("Parser source portion count must equal emitted plus excluded portions");
  }
}

async function loadForbiddenGtins(
  database: DatabaseExecutor,
  sourceId: string,
): Promise<ReadonlySet<string>> {
  const rows = await sql<{ gtin14: string; market_code: string }>`
    select lpad(barcode.gtin, 14, '0') as gtin14, barcode.market_code
    from food_barcode as barcode
    join food on food.id = barcode.food_id
    where barcode.valid_to is null
      and food.food_source_id is not null
      and food.food_source_id <> ${sourceId}
  `.execute(database);
  return new Set(rows.rows.map((row) => `${row.gtin14}:${row.market_code}`));
}

async function selectBatch(database: DatabaseExecutor, batchId: string): Promise<BatchRow> {
  const batch = await database
    .selectFrom("food_import_batch")
    .selectAll()
    .where("id", "=", batchId)
    .executeTakeFirst();
  if (!batch) throw new Error(`Unknown food import batch ${batchId}`);
  return batch;
}

async function selectBatchForUpdate(
  transaction: Transaction<Database>,
  batchId: string,
): Promise<BatchRow> {
  const batch = await transaction
    .selectFrom("food_import_batch")
    .selectAll()
    .where("id", "=", batchId)
    .forUpdate()
    .executeTakeFirst();
  if (!batch) throw new Error(`Unknown food import batch ${batchId}`);
  return batch;
}

async function selectAndLockSource(
  transaction: Transaction<Database>,
  sourceId: string,
): Promise<Selectable<Database["food_source"]>> {
  return transaction
    .selectFrom("food_source")
    .selectAll()
    .where("id", "=", sourceId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

async function lockSource(transaction: Transaction<Database>, sourceId: string): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtext(${SOURCE_LOCK_NAMESPACE}), hashtext(${sourceId}))
  `.execute(transaction);
}

function assertSourceMayActivate(source: Selectable<Database["food_source"]>): void {
  if (!source.active) throw new Error(`Food source ${source.code} is disabled`);
  if (source.commercial_use_allowed !== true) {
    throw new Error(`Food source ${source.code} is not approved for commercial use`);
  }
  if (source.rights_review_status !== "approved" && source.rights_review_status !== "restricted") {
    throw new Error(`Food source ${source.code} does not have an approved rights review`);
  }
  if (!source.rights_reviewed_at || !source.rights_reviewed_by) {
    throw new Error(`Food source ${source.code} rights review evidence is incomplete`);
  }
}

function normalizePolicy(
  policy: Partial<BatchValidationPolicy> | JsonObject,
): BatchValidationPolicy {
  const excludedNutrientFraction = policy.maximumExcludedNutrientFraction ?? 0;
  const fraction = policy.maximumQuarantineFraction ?? 0.1;
  const count = policy.maximumQuarantinedRecords ?? 100_000;
  const requireDistinctApprovers = policy.requireDistinctApprovalPrincipals ?? true;
  const requireValid = policy.requireAtLeastOneValidRecord ?? true;
  const requireNutrient = policy.requireMaterializedNutrientPerValidRecord ?? true;
  if (
    typeof excludedNutrientFraction !== "number" ||
    !Number.isFinite(excludedNutrientFraction) ||
    excludedNutrientFraction < 0 ||
    excludedNutrientFraction > 1
  ) {
    throw new Error("maximumExcludedNutrientFraction must be between 0 and 1");
  }
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error("maximumQuarantineFraction must be between 0 and 1");
  }
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw new Error("maximumQuarantinedRecords must be a non-negative safe integer");
  }
  if (typeof requireValid !== "boolean") {
    throw new Error("requireAtLeastOneValidRecord must be boolean");
  }
  if (typeof requireNutrient !== "boolean") {
    throw new Error("requireMaterializedNutrientPerValidRecord must be boolean");
  }
  if (typeof requireDistinctApprovers !== "boolean") {
    throw new Error("requireDistinctApprovalPrincipals must be boolean");
  }
  return {
    maximumExcludedNutrientFraction: excludedNutrientFraction,
    maximumQuarantineFraction: fraction,
    maximumQuarantinedRecords: Number(count),
    requireDistinctApprovalPrincipals: requireDistinctApprovers,
    requireAtLeastOneValidRecord: requireValid,
    requireMaterializedNutrientPerValidRecord: requireNutrient,
  };
}

function assertBatchProvenance(batch: BatchRow, input: StageBatchInput): void {
  const same =
    batch.release_key === input.releaseKey &&
    batch.artifact_uri === input.artifactUri &&
    batch.artifact_sha256 === input.artifactSha256 &&
    String(batch.artifact_bytes) === String(input.artifactBytes) &&
    batch.media_type === input.mediaType &&
    batch.parser_version === input.parserVersion &&
    batch.upstream_schema_version === (input.upstreamSchemaVersion ?? null) &&
    batch.rights_manifest_uri === input.rightsManifestUri &&
    batch.rights_manifest_sha256 === input.rightsManifestSha256 &&
    dateOnly(batch.published_on) === (input.publishedOn ?? null) &&
    batch.acquired_at.toISOString() === new Date(input.acquiredAt).toISOString();
  if (!same) throw new Error("Existing import batch provenance differs from the requested batch");
}

function assertSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} is required`);
}

function requireBoundedText(value: string, field: string, maximumLength: number): void {
  requireText(value, field);
  if (Buffer.byteLength(value, "utf8") > maximumLength) {
    throw new Error(`${field} must contain at most ${maximumLength} UTF-8 bytes`);
  }
}

function stablePrincipalId(value: string, field: string): string {
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  if (
    value !== canonical ||
    !/^[a-z][-a-z0-9._:@/]{2,255}$/.test(canonical) ||
    [...canonical].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error(`${field} must be a canonical lowercase principal ID`);
  }
  return canonical;
}

function nonNegativeSafeInteger(value: bigint | number | string, field: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || !/^\d+$/.test(String(value))) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function normalizeDatabaseDecimal(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${whole.replace(/^0+(?=\d)/, "")}.${normalizedFraction}` : whole;
}

function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
