import { createHash } from "node:crypto";
import { expect } from "vitest";
import { submitCatalogueApproval } from "../../../packages/db/src/catalogue-capability-approval.js";
import {
  prepareCatalogueValidation,
  submitCatalogueValidation,
} from "../../../packages/db/src/catalogue-capability-validation.js";
import type {
  BatchValidationPolicy,
  RecordBatchParserReportInput,
  StageBatchInput,
  StagedCatalogueRecordInput,
} from "../../../packages/db/src/catalogue-ingestion.js";
import {
  appendCatalogueStageChunk,
  createOrResumeCatalogueStage,
  sealCatalogueStageParserReport,
} from "../../../packages/db/src/catalogue-stage.js";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "../../../packages/db/src/catalogue-validation.js";
import type { createDatabase } from "../../../packages/db/src/client.js";
import type { JsonObject } from "../../../packages/db/src/types.js";
import { sql } from "../../../packages/db/test/catalogue-paged-test-runtime.js";

// Synthetic evidence exists only in disposable, explicitly opted-in PostgreSQL
// fixtures. These helpers perform no acquisition or provider verification.
const HASH = "a".repeat(64);
const BUILD = "b".repeat(64);
type Client = ReturnType<typeof createDatabase>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const POLICY: BatchValidationPolicy = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0,
  maximumQuarantinedRecords: 0,
  requireAtLeastOneValidRecord: true,
  requireDistinctApprovalPrincipals: true,
  requireMaterializedNutrientPerValidRecord: true,
};
export const MAPPING = {
  canonicalNutrient: { code: "protein", dimension: "mass" as const, name: "Protein", unit: "g" },
  sourceName: "Protein",
  sourceNutrientKey: "1003",
  sourceUnit: "g",
  conversionMultiplier: "1",
};

export function stageIdentity(releaseKey: string, mappingSha: string): StageBatchInput {
  return {
    sourceCode: "USDA_FDC",
    releaseKey,
    acquiredAt: new Date(Date.now() - 60_000),
    artifactBytes: 1024,
    artifactSha256: HASH,
    artifactUri: `urn:test:paged:${releaseKey}`,
    rightsManifestSha256: HASH,
    rightsManifestUri: "urn:test:paged:rights",
    releaseClass: "live-reviewed",
    evidenceBundleSha256: HASH,
    evidenceBundleUri: `s3://nourishing-test-evidence/adr0104/sha256/${HASH}/${releaseKey}/bundle.json`,
    evidenceDecisionSha256: HASH,
    evidenceObjectVersionId: `synthetic-${releaseKey}`,
    evidenceValidUntil: new Date(Date.now() + 60 * 60_000),
    mediaType: "text/csv",
    parserVersion: `fixture@1.0.0+build.${BUILD}+mapping.${mappingSha}`,
    publishedOn: "2026-09-21",
    upstreamSchemaVersion: "synthetic-v1",
  };
}
export function syntheticRecord(
  releaseKey: string,
  sequence: number,
  padding: number,
): StagedCatalogueRecordInput {
  const key = `FDC:${releaseKey}:Foundation:${sequence + 1}`;
  const payload: JsonObject = {
    schemaVersion: 1,
    idempotencyKey: key,
    basis: { amount: "100", unit: "g" },
    identity: {
      brandOwner: null,
      description: `Synthetic food ${sequence}`,
      descriptionFr: null,
      gtin: null,
    },
    source: {
      sourceCode: "USDA_FDC",
      releaseKey,
      sourceDataType: "Foundation",
      sourceRecordId: String(sequence + 1),
      sourceModifiedAt: null,
      languageTag: "en",
      marketCode: "US",
    },
    sourcePayloadHash: HASH,
    unlistedNutrientPolicy: "unknown_not_reported",
    servings: [],
    nutrients: [
      {
        sourceNutrientId: "1003",
        sourceName: "Protein",
        canonicalNutrientId: "protein",
        canonicalUnit: "g",
        originalUnit: "g",
        value: { state: "known", amount: "12.5", quality: "measured" },
        provenance: { dataPoints: 12, derivationCode: null },
      },
    ],
    syntheticResourcePadding: "x".repeat(padding),
  };
  return {
    sequenceNumber: sequence,
    sourceRecordKey: key,
    sourceRecordType: "Foundation",
    sourcePayloadSha256: HASH,
    canonicalPayload: payload,
    canonicalPayloadSha256: sha256CanonicalJson(payload),
  };
}
export function parserReport(
  batchId: string,
  input: StageBatchInput,
  count: number,
  recordsSha256: string,
  admissionSha256?: string,
): RecordBatchParserReportInput {
  const mapping = required(/\+mapping\.([0-9a-f]{64})$/u.exec(input.parserVersion)?.[1]);
  const report: JsonObject = {
    schemaVersion: admissionSha256 ? 2 : 1,
    sourceCode: "USDA_FDC",
    releaseKey: input.releaseKey,
    artifactSha256: input.artifactSha256,
    nutrientMappingDigest: mapping,
    parserBuildSha256: BUILD,
    parserPackage: "@nutrition-tracker/ingestion",
    parserVersion: "fixture@1.0.0",
    reportKind: admissionSha256
      ? "usda-fdc-full-csv-capability-stage-v2"
      : "usda-fdc-full-csv-capability-stage-v1",
    ...(admissionSha256 ? { preparationAdmissionSha256: admissionSha256 } : {}),
    portionCountBasis: "source-csv-portions-plus-emitted-derived-label-servings-v1",
    recordsExport: { byteSize: count * 8192, sha256: HASH, recordCount: count, recordsSha256 },
    inspection: {
      semanticEvidence: { canonicalAcceptedRecords: { count, sha256: recordsSha256 } },
      conservation: {
        foods: { acceptedCount: count, quarantinedCount: 0, sourceCount: count },
        foodNutrients: {
          emittedCount: count,
          excludedCount: 0,
          quarantinedParentCount: 0,
          sourceCount: count,
        },
        foodPortions: {
          emittedCount: 0,
          excludedCount: 0,
          quarantinedParentCount: 0,
          sourceCount: 0,
        },
      },
      metrics: {
        acceptedFoodCount: count,
        quarantinedFoodCount: 0,
        stagedNutrientCount: count,
        excludedNutrientCount: 0,
        stagedPortionCount: 0,
        excludedPortionCount: 0,
        derivedLabelServingCount: 0,
      },
    },
  };
  return {
    batchId,
    report,
    sourceRecordCount: count,
    emittedRecordCount: count,
    excludedRecordCount: 0,
    sourceNutrientCount: count,
    emittedNutrientCount: count,
    excludedNutrientCount: 0,
    sourcePortionCount: 0,
    emittedPortionCount: 0,
    excludedPortionCount: 0,
  };
}
export async function createBaseline(input: {
  owner: Client;
  client: (key: string) => Client;
  actor: (key: string) => string;
  mappingSha: string;
  token: string;
}) {
  const stage = stageIdentity(`baseline-${input.token}`, input.mappingSha);
  const batch = await createOrResumeCatalogueStage(input.client("stage"), stage);
  const record = syntheticRecord(stage.releaseKey, 0, 0);
  await appendCatalogueStageChunk(input.client("stage"), {
    batchId: batch.batchId,
    expectedNextOffset: 0,
    records: [record],
  });
  const seal = await sealCatalogueStageParserReport(
    input.client("stage"),
    parserReport(batch.batchId, stage, 1, sha(`${canonicalJson(record.canonicalPayload)}\n`)),
  );
  const request = await prepareCatalogueValidation(input.client("validate"), {
    batchId: batch.batchId,
    expectedStagingSealSha256: seal.stagingSealSha256,
    expectedNutrientMappingDigest: input.mappingSha,
    policy: POLICY,
  });
  const result = await submitCatalogueValidation(input.client("validate"), request);
  expect(result.promotionEligible).toBe(true);
  for (const approvalRole of ["data", "quality", "rights"] as const)
    await submitCatalogueApproval(input.client(approvalRole), {
      batchId: batch.batchId,
      approvalRole,
      rightsManifestSha256: HASH,
      validationDigest: request.validationDigest,
      principalId: input.actor(approvalRole),
      approvalReference: `urn:test:paged:baseline:${approvalRole}`,
    });
  const promoted = await sql<{
    result: { activatedReleaseId: string };
  }>`select public.catalogue_promote_import_batch(
    ${batch.batchId}::uuid,${input.actor("promote")}::text,'Synthetic V1 baseline for paged preparation') as result`.execute(
    input.client("promote"),
  );
  return {
    batchId: batch.batchId,
    releaseId: required(promoted.rows[0]).result.activatedReleaseId,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture value");
  return value;
}
