import {
  appendCatalogueStageChunk,
  createOrResumeCatalogueStage,
  type JsonObject,
  type JsonValue,
  type RecordBatchParserReportInput,
  type StageBatchInput,
  sealCatalogueStageParserReport,
  sha256CanonicalJson,
} from "@nutrition-tracker/db";

import type { VerifiedFdcRecordExport } from "./fdc-record-reader.js";

export interface FdcCsvStageInput {
  readonly batch: StageBatchInput;
  readonly records: VerifiedFdcRecordExport;
  readonly parserReport: Omit<RecordBatchParserReportInput, "batchId">;
  readonly signal?: AbortSignal;
}

/** Append through the stage-only capability, then seal. Validation is a separate authority. */
export async function stageVerifiedFdcCsvExport(
  database: Parameters<typeof createOrResumeCatalogueStage>[0],
  input: FdcCsvStageInput,
) {
  input.signal?.throwIfAborted();
  const staged = await createOrResumeCatalogueStage(database, input.batch);
  const total = input.records.evidence.recordCount;
  if (
    staged.status !== "staging" ||
    !Number.isSafeInteger(staged.nextOffset) ||
    staged.nextOffset < 0 ||
    staged.nextOffset > total ||
    staged.stagedCount !== staged.nextOffset
  ) {
    throw new Error("FDC CSV staging receipt does not identify the exact resumable staging prefix");
  }
  let nextOffset = staged.nextOffset;
  let inserted = 0;
  let replayed = 0;
  // A complete prefix may already be sealed. The seal function checks immutable
  // evidence on replay; chunk writes are forbidden once that seal exists.
  if (nextOffset < total) {
    for await (const page of input.records.pages({
      nextOffset,
      replayPreviousPage: nextOffset > 0,
    })) {
      input.signal?.throwIfAborted();
      const count = page.records.length;
      if (
        count < 1 ||
        count > 250 ||
        page.nextOffset !== page.expectedNextOffset + count ||
        page.nextOffset > total ||
        (page.expectedNextOffset !== nextOffset && page.nextOffset !== nextOffset)
      ) {
        throw new Error("FDC CSV reader page differs from the durable staging boundary");
      }
      const result = await appendCatalogueStageChunk(database, {
        batchId: staged.batchId,
        expectedNextOffset: page.expectedNextOffset,
        records: page.records,
      });
      if (
        result.nextOffset !== page.nextOffset ||
        result.stagedCount !== page.nextOffset ||
        result.inserted + result.replayed !== count ||
        (result.wasAlreadyStaged
          ? result.inserted !== 0 || result.replayed !== count
          : result.inserted !== count || result.replayed !== 0) ||
        (page.nextOffset === nextOffset && !result.wasAlreadyStaged)
      ) {
        throw new Error("FDC CSV database chunk receipt differs from the submitted page");
      }
      inserted += result.inserted;
      replayed += result.replayed;
      nextOffset = page.nextOffset;
      input.signal?.throwIfAborted();
    }
  }
  if (nextOffset !== total) {
    throw new Error("FDC CSV staging stopped before the complete verified record set");
  }
  input.signal?.throwIfAborted();
  const sealed = await sealCatalogueStageParserReport(database, {
    ...input.parserReport,
    batchId: staged.batchId,
  });
  if (sealed.parserReportSha256 !== sha256CanonicalJson(input.parserReport.report)) {
    throw new Error("FDC CSV parser seal receipt differs from the submitted report");
  }
  input.signal?.throwIfAborted();
  return {
    batchId: staged.batchId,
    inserted,
    replayed,
    resumed: staged.resumed,
    staged: total,
    status: "staging" as const,
    validationPending: true as const,
    ...sealed,
  };
}

export function buildFdcCsvStageParserReport(input: {
  readonly records: VerifiedFdcRecordExport;
  readonly artifactSha256: string;
  readonly nutrientMappingDigest: string;
  readonly parserBuildSha256: string;
  readonly parserPackage: string;
  readonly parserVersion: string;
  readonly releaseKey: string;
  readonly sourceCode: string;
}): Omit<RecordBatchParserReportInput, "batchId"> {
  const inspection = input.records.inspection;
  const metrics = object(inspection.metrics, "metrics");
  const conservation = object(inspection.conservation, "conservation");
  const foods = object(conservation.foods, "conservation.foods");
  const nutrients = object(conservation.foodNutrients, "conservation.foodNutrients");
  const portions = object(conservation.foodPortions, "conservation.foodPortions");
  const emittedRecordCount = integer(foods.acceptedCount, "foods.acceptedCount");
  const excludedRecordCount = integer(foods.quarantinedCount, "foods.quarantinedCount");
  const sourceRecordCount = integer(foods.sourceCount, "foods.sourceCount");
  const emittedNutrientCount = integer(nutrients.emittedCount, "foodNutrients.emittedCount");
  const excludedNutrientCount = sum(
    integer(nutrients.excludedCount, "foodNutrients.excludedCount"),
    integer(nutrients.quarantinedParentCount, "foodNutrients.quarantinedParentCount"),
  );
  const sourceNutrientCount = integer(nutrients.sourceCount, "foodNutrients.sourceCount");
  const derivedLabelServingCount = integer(
    metrics.derivedLabelServingCount,
    "derivedLabelServingCount",
  );
  const sourceEmittedPortionCount = integer(portions.emittedCount, "foodPortions.emittedCount");
  const emittedPortionCount = sum(sourceEmittedPortionCount, derivedLabelServingCount);
  const excludedPortionCount = sum(
    integer(portions.excludedCount, "foodPortions.excludedCount"),
    integer(portions.quarantinedParentCount, "foodPortions.quarantinedParentCount"),
  );
  // The generic staging count includes servings synthesized from branded labels.
  // Preserve raw CSV conservation separately, so these never masquerade as CSV rows.
  const sourcePortionCount = sum(
    integer(portions.sourceCount, "foodPortions.sourceCount"),
    derivedLabelServingCount,
  );
  if (
    emittedRecordCount !== input.records.evidence.recordCount ||
    emittedNutrientCount !== input.records.evidence.nutrientCount ||
    emittedPortionCount !== input.records.evidence.servingCount ||
    emittedRecordCount !== integer(metrics.acceptedFoodCount, "acceptedFoodCount") ||
    excludedRecordCount !== integer(metrics.quarantinedFoodCount, "quarantinedFoodCount") ||
    emittedNutrientCount !== integer(metrics.stagedNutrientCount, "stagedNutrientCount") ||
    sourceEmittedPortionCount !== integer(metrics.stagedPortionCount, "stagedPortionCount") ||
    integer(nutrients.excludedCount, "foodNutrients.excludedCount") !==
      integer(metrics.excludedNutrientCount, "excludedNutrientCount") ||
    integer(portions.excludedCount, "foodPortions.excludedCount") !==
      integer(metrics.excludedPortionCount, "excludedPortionCount") ||
    sourceRecordCount !== sum(emittedRecordCount, excludedRecordCount) ||
    sourceNutrientCount !== sum(emittedNutrientCount, excludedNutrientCount) ||
    sourcePortionCount !== sum(emittedPortionCount, excludedPortionCount)
  ) {
    throw new Error(
      "FDC CSV parser report does not conserve the verified record, nutrient and serving counts",
    );
  }
  const { byteSize, sha256, recordCount, recordsSha256 } = input.records.evidence;
  const report: JsonObject = {
    artifactSha256: input.artifactSha256,
    inspection,
    nutrientMappingDigest: input.nutrientMappingDigest,
    parserBuildSha256: input.parserBuildSha256,
    parserPackage: input.parserPackage,
    parserVersion: input.parserVersion,
    portionCountBasis: "source-csv-portions-plus-emitted-derived-label-servings-v1",
    recordsExport: { byteSize, sha256, recordCount, recordsSha256 },
    releaseKey: input.releaseKey,
    reportKind: "usda-fdc-full-csv-capability-stage-v1",
    schemaVersion: 1,
    sourceCode: input.sourceCode,
  };
  return {
    report,
    emittedRecordCount,
    excludedRecordCount,
    sourceRecordCount,
    emittedNutrientCount,
    excludedNutrientCount,
    sourceNutrientCount,
    emittedPortionCount,
    excludedPortionCount,
    sourcePortionCount,
  };
}

function object(value: JsonValue | undefined, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`FDC CSV inspection ${field} must be an object`);
  }
  return value as JsonObject;
}

function integer(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FDC CSV inspection ${field} must be a non-negative safe integer`);
  }
  return value;
}

function sum(left: number, right: number): number {
  return integer(left + right, "count sum");
}
