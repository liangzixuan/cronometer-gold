import type { Selectable } from "kysely";
import type { PreparedCatalogueValidationRequest } from "./catalogue-capability-validation.js";
import type { BatchValidationSummary } from "./catalogue-ingestion.js";
import { canonicalJson } from "./catalogue-validation.js";
import type {
  FoodImportBatchTable,
  FoodImportParserReportTable,
  FoodImportRecordTable,
  JsonObject,
  JsonValue,
} from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/u;

/** Verify the retained historical request; current observation cannot recreate its token. */
export async function verifyCatalogueReconciliationValidationRequest(input: {
  readonly request: PreparedCatalogueValidationRequest;
  readonly batch: Selectable<FoodImportBatchTable>;
  readonly parser: Selectable<FoodImportParserReportTable>;
  readonly sourceCode: string;
  readonly summary: BatchValidationSummary;
  readonly records: readonly Selectable<FoodImportRecordTable>[];
}): Promise<BatchValidationSummary> {
  // The decoder depends on ingestion's pure validators. Load it at invocation
  // time to reuse the strict contract without introducing a static module cycle.
  const { parsePreparedCatalogueValidationRequest } = await import(
    "./catalogue-capability-validation.js"
  );
  const request = parsePreparedCatalogueValidationRequest(input.request);
  const { batch, parser, summary, records } = input;
  if (
    input.sourceCode !== "USDA_FDC" ||
    parser.report.reportKind !== "usda-fdc-full-csv-capability-stage-v1" ||
    batch.staged_database_capability_role !== "nutrition_catalogue_stage" ||
    batch.validated_database_capability_role !== "nutrition_catalogue_validate" ||
    !batch.staged_database_principal ||
    batch.staged_database_principal === batch.validated_database_principal ||
    batch.validated_database_principal !== request.validatorDatabasePrincipal ||
    batch.staging_sealed_at === null ||
    batch.staging_seal_sha256 !== request.expectedStagingSealSha256 ||
    batch.id !== request.batchId ||
    batch.validation_digest !== request.validationDigest ||
    batch.nutrient_mapping_digest !== request.nutrientMappingDigest ||
    summary.nutrientMappingDigest !== request.nutrientMappingDigest ||
    parser.report_sha256 !== request.parserReportSha256 ||
    summary.parserReportSha256 !== request.parserReportSha256 ||
    batch.validated_food_contract_version !== 1 ||
    batch.nutrition_semantic_contract_version !== 1 ||
    !SHA256.test(batch.nutrition_semantic_sha256 ?? "")
  ) {
    throw new Error(
      "Retained validation request does not match the capability candidate authority or evidence",
    );
  }
  const outer = JSON.parse(request.validationDocument) as {
    readonly digestDocument: string;
    readonly records: JsonValue;
  };
  const original = JSON.parse(outer.digestDocument) as JsonObject;
  if (
    typeof original.evidenceValidUntil !== "string" ||
    Date.parse(original.evidenceValidUntil) !== batch.evidence_valid_until?.getTime() ||
    canonicalJson(request.policy) !== canonicalJson(batch.validation_policy) ||
    canonicalJson(summary.validationPolicy) !== canonicalJson(batch.validation_policy) ||
    canonicalJson(summary.nutrientMappingRevisionIds as unknown as JsonValue) !==
      canonicalJson(batch.nutrient_mapping_revision_ids)
  ) {
    throw new Error(
      "Retained validation request expiry, policy or mapping revisions differ from frozen evidence",
    );
  }
  const expected: JsonObject = {
    artifactSha256: batch.artifact_sha256,
    batchId: batch.id,
    evidenceBundleSha256: batch.evidence_bundle_sha256,
    evidenceBundleUri: batch.evidence_bundle_uri,
    evidenceDecisionSha256: batch.evidence_decision_sha256,
    evidenceObjectVersionId: batch.evidence_object_version_id,
    // PostgreSQL's original timestamp spelling is part of the retained digest;
    // compare its instant above without rewriting the historical retained bytes.
    evidenceValidUntil: original.evidenceValidUntil,
    nutrientMappingDigest: summary.nutrientMappingDigest,
    nutrientMappingRevisionIds: summary.nutrientMappingRevisionIds as unknown as JsonValue,
    observationSha256: request.observationSha256,
    policy: summary.validationPolicy,
    parserEvidence: {
      emittedNutrientCount: Number(parser.emitted_nutrient_count),
      emittedPortionCount: Number(parser.emitted_portion_count),
      emittedRecordCount: Number(parser.emitted_record_count),
      excludedNutrientCount: Number(parser.excluded_nutrient_count),
      excludedPortionCount: Number(parser.excluded_portion_count),
      excludedRecordCount: Number(parser.excluded_record_count),
      sourceNutrientCount: Number(parser.source_nutrient_count),
      sourcePortionCount: Number(parser.source_portion_count),
      sourceRecordCount: Number(parser.source_record_count),
    },
    parserReportSha256: parser.report_sha256,
    records: summary.records as unknown as JsonValue,
    releaseClass: batch.release_class,
    rightsManifestSha256: batch.rights_manifest_sha256,
    validatedFoodContractVersion: 1,
  };
  if (canonicalJson(expected) !== outer.digestDocument) {
    throw new Error(
      "Retained validation digest document differs from current provenance, parser or record semantics",
    );
  }
  const frozenRecords = records.map((record, index) => {
    const current = summary.records[index];
    if (
      String(record.sequence_number) !== String(index) ||
      record.batch_id !== batch.id ||
      !current ||
      current.sourceRecordKey !== record.source_record_key ||
      current.status !== record.validation_status ||
      current.canonicalPayloadSha256 !== record.canonical_payload_sha256 ||
      current.validatedFoodContractVersion !== record.validated_food_contract_version ||
      current.validatedFoodSha256 !== record.validated_food_sha256 ||
      canonicalJson(current.issues) !== canonicalJson(record.validation_issues) ||
      record.nutrition_semantic_contract_version !== 1 ||
      !SHA256.test(record.nutrition_semantic_sha256 ?? "")
    ) {
      throw new Error("Retained validation request ordered records differ from frozen evidence");
    }
    return {
      sourceRecordKey: record.source_record_key,
      validatedFoodDocument: record.validated_food_document,
      validationIssuesDocument: canonicalJson(record.validation_issues),
    };
  });
  if (canonicalJson(frozenRecords) !== canonicalJson(outer.records)) {
    throw new Error(
      "Retained validation materialization or issue documents differ from frozen bytes",
    );
  }
  // The independently recomputed summary remains intact; only its legacy owner
  // digest is replaced by the now-verified original capability digest.
  return { ...summary, validationDigest: request.validationDigest };
}
