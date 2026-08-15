import { describe, expect, it } from "vitest";

import {
  type BatchRecordValidation,
  type BatchValidationPolicy,
  evaluateBatchPolicy,
  type JsonObject,
  type ReviewedCatalogueNutrientMapping,
  sha256CanonicalJson,
  validateCatalogueRecord,
} from "../src/index.js";

const SOURCE_HASH = "a".repeat(64);
const RECORD_KEY = "FDC:2026-04-30:Foundation:123";
const POLICY: BatchValidationPolicy = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0.1,
  maximumQuarantinedRecords: 100,
  requireAtLeastOneValidRecord: true,
  requireDistinctApprovalPrincipals: true,
  requireMaterializedNutrientPerValidRecord: true,
};

const PROTEIN_MAPPING: ReviewedCatalogueNutrientMapping = {
  canonicalUnit: "g",
  conversionMultiplier: "1.000000000000",
  mappingRevisionId: "revision:protein:1",
  nutrientCode: "protein",
  nutrientId: "1",
  sourceNutrientId: "1003",
  sourceUnit: "g",
};

function foodPayload(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    basis: { amount: "100", unit: "g" },
    idempotencyKey: RECORD_KEY,
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
      sourceCode: "FDC",
      sourceDataType: "Foundation",
      sourceModifiedAt: "2026-04-30T00:00:00.000Z",
      sourceRecordId: "123",
    },
    sourcePayloadHash: SOURCE_HASH,
    unlistedNutrientPolicy: "unknown_not_reported",
    ...overrides,
  };
}

function validate(payload: JsonObject | null, mappings = [PROTEIN_MAPPING]) {
  return validateCatalogueRecord(
    payload,
    {
      canonicalPayloadSha256: sha256CanonicalJson(payload),
      expectedReleaseKey: "2026-04-30",
      expectedSourceCode: "FDC",
      sourcePayloadSha256: SOURCE_HASH,
      sourceRecordKey: RECORD_KEY,
      sourceRecordType: "Foundation",
    },
    new Map(mappings.map((mapping) => [mapping.sourceNutrientId, mapping])),
  );
}

describe("catalogue record validation", () => {
  it("accepts a nutrient-bearing food with no source portions", () => {
    const result = validate(foodPayload());

    expect(result.recordIsValid).toBe(true);
    expect(result.food?.servings).toEqual([]);
    expect(result.food?.nutrients).toHaveLength(1);
    expect(result.nutrientMaterializableCount).toBe(1);
  });

  it("quarantines a non-object top-level record without losing its checksum identity", () => {
    const result = validate(null);

    expect(result.recordIsValid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("RECORD_NOT_OBJECT");
  });

  it("excludes null and negative nutrient amounts granularly instead of rejecting the food", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: "protein",
          canonicalUnit: "g",
          originalUnit: "g",
          provenance: { dataPoints: null, derivationCode: null },
          sourceName: "Protein null",
          sourceNutrientId: "1003-null",
          value: { amount: null, quality: "measured", state: "known" },
        },
        {
          canonicalNutrientId: "carbohydrate",
          canonicalUnit: "g",
          originalUnit: "g",
          provenance: { dataPoints: null, derivationCode: null },
          sourceName: "Carbohydrate",
          sourceNutrientId: "1005",
          value: { amount: "-0.1", quality: "measured", state: "known" },
        },
        ...(foodPayload().nutrients as readonly JsonObject[]),
      ],
    });
    const nullMapping = { ...PROTEIN_MAPPING, sourceNutrientId: "1003-null" };
    const carbohydrateMapping = {
      ...PROTEIN_MAPPING,
      nutrientCode: "carbohydrate",
      nutrientId: "2",
      sourceNutrientId: "1005",
    };
    const result = validate(payload, [nullMapping, carbohydrateMapping, PROTEIN_MAPPING]);

    expect(result.recordIsValid).toBe(true);
    expect(result.food?.nutrients).toHaveLength(1);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NUTRIENT_NULL_AMOUNT", "NUTRIENT_NEGATIVE_AMOUNT"]),
    );
    expect(result.excludedNutrientCount).toBe(2);
  });

  it("ignores a staged mapping proposal and resolves solely through the reviewed registry", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: null,
          canonicalUnit: null,
          originalUnit: "g",
          provenance: { dataPoints: 1, derivationCode: null },
          sourceName: "Protein",
          sourceNutrientId: "1003",
          value: { amount: "12.5", quality: "measured", state: "known" },
        },
      ],
    });
    const result = validate(payload);

    expect(result.recordIsValid).toBe(true);
    expect(result.food?.nutrients[0]).toMatchObject({
      canonicalUnit: "g",
      nutrientCode: "protein",
    });
    expect(result.issues).toEqual([]);
  });

  it("rejects non-positive FDC IDs and duplicate canonical source-food identities", () => {
    const nonPositive = foodPayload({
      idempotencyKey: "FDC:2026-04-30:Foundation:0",
      source: {
        ...(foodPayload().source as JsonObject),
        sourceRecordId: "0",
      },
    });
    const nonPositiveResult = validateCatalogueRecord(
      nonPositive,
      {
        canonicalPayloadSha256: sha256CanonicalJson(nonPositive),
        expectedReleaseKey: "2026-04-30",
        expectedSourceCode: "FDC",
        sourcePayloadSha256: SOURCE_HASH,
        sourceRecordKey: "FDC:2026-04-30:Foundation:0",
        sourceRecordType: "Foundation",
      },
      new Map([[PROTEIN_MAPPING.sourceNutrientId, PROTEIN_MAPPING]]),
    );
    const duplicateResult = validateCatalogueRecord(
      foodPayload(),
      {
        canonicalPayloadSha256: sha256CanonicalJson(foodPayload()),
        expectedReleaseKey: "2026-04-30",
        expectedSourceCode: "FDC",
        sourcePayloadSha256: SOURCE_HASH,
        sourceRecordKey: RECORD_KEY,
        sourceRecordType: "Foundation",
      },
      new Map([[PROTEIN_MAPPING.sourceNutrientId, PROTEIN_MAPPING]]),
      new Set(),
      new Set(["123"]),
    );

    expect(nonPositiveResult.issues.map((issue) => issue.code)).toContain(
      "FDC_ID_NOT_POSITIVE_INTEGER",
    );
    expect(duplicateResult.issues.map((issue) => issue.code)).toContain(
      "DUPLICATE_SOURCE_FOOD_KEY",
    );
    expect(duplicateResult.recordIsValid).toBe(false);
  });

  it("excludes nutrients with malformed derivation provenance", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: null,
          canonicalUnit: null,
          originalUnit: "g",
          provenance: { dataPoints: -1, derivationCode: "analytical" },
          sourceName: "Protein",
          sourceNutrientId: "1003",
          value: { amount: "12.5", quality: "measured", state: "known" },
        },
      ],
    });

    const result = validate(payload);
    expect(result.recordIsValid).toBe(true);
    expect(result.food?.nutrients).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain("NUTRIENT_PROVENANCE_INVALID");
  });

  it("fails promotion policy when every nutrient is unmapped or excluded", () => {
    const result = validate(foodPayload(), []);
    const record: BatchRecordValidation = {
      canonicalPayloadSha256: "b".repeat(64),
      excludedNutrientCount: result.excludedNutrientCount,
      issues: result.issues,
      nutrientInputCount: result.nutrientInputCount,
      nutrientMaterializableCount: result.nutrientMaterializableCount,
      portionInputCount: result.portionInputCount,
      sourceRecordKey: RECORD_KEY,
      status: "valid",
    };

    expect(evaluateBatchPolicy([record], POLICY)).toMatchObject({
      nutrientMaterializableCount: 0,
      promotionEligible: false,
    });
  });

  it("preserves trace source name and unit in canonical metadata", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: "protein",
          canonicalUnit: "g",
          originalUnit: "g",
          provenance: { dataPoints: null, derivationCode: "analytical" },
          sourceName: "Protein, trace",
          sourceNutrientId: "1003",
          value: { detectionLimit: "0.01", state: "trace" },
        },
      ],
    });

    expect(validate(payload).food?.nutrients[0]).toMatchObject({
      metadata: { sourceName: "Protein, trace", sourceUnit: "g" },
      valueStatus: "trace",
    });
  });

  it("counts parser-rejected source records outside the staged-row denominator", () => {
    const result = validate(foodPayload());
    const emittedRecord: BatchRecordValidation = {
      canonicalPayloadSha256: "c".repeat(64),
      excludedNutrientCount: 0,
      issues: result.issues,
      nutrientInputCount: 1,
      nutrientMaterializableCount: 1,
      portionInputCount: 0,
      sourceRecordKey: RECORD_KEY,
      status: "valid",
    };
    const records = Array.from({ length: 363 }, (_, index) => ({
      ...emittedRecord,
      sourceRecordKey: `${RECORD_KEY}:${index}`,
    }));

    expect(
      evaluateBatchPolicy(records, POLICY, {
        emittedNutrientCount: 363,
        emittedPortionCount: 0,
        emittedRecordCount: 363,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 32,
        sourceNutrientCount: 363,
        sourcePortionCount: 0,
        sourceRecordCount: 395,
      }),
    ).toMatchObject({
      promotionEligible: true,
      quarantinedCount: 32,
      validCount: 363,
    });
  });
});
