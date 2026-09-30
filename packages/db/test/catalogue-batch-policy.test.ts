import { describe, expect, it } from "vitest";
import {
  type BatchRecordValidation,
  type BatchValidationPolicy,
  evaluateBatchPolicy,
  normalizePolicy,
  type ParserCountEvidence,
} from "../src/catalogue-batch-policy.js";
import type { JsonValue } from "../src/types.js";

const DEFAULT_POLICY: BatchValidationPolicy = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0.1,
  maximumQuarantinedRecords: 100_000,
  requireDistinctApprovalPrincipals: true,
  requireAtLeastOneValidRecord: true,
  requireMaterializedNutrientPerValidRecord: true,
};

function record(overrides: Partial<BatchRecordValidation> = {}): BatchRecordValidation {
  return {
    canonicalPayloadSha256: "a".repeat(64),
    issues: [],
    nutrientInputCount: 2,
    nutrientMaterializableCount: 2,
    portionInputCount: 0,
    excludedNutrientCount: 0,
    sourceRecordKey: "fixture-record",
    status: "valid",
    validatedFoodContractVersion: 1,
    validatedFoodSha256: "b".repeat(64),
    ...overrides,
  };
}

describe("catalogue batch policy normalization", () => {
  it("supplies all defaults and treats null fields as absent", () => {
    expect(normalizePolicy({})).toEqual(DEFAULT_POLICY);
    expect(
      normalizePolicy({
        maximumExcludedNutrientFraction: null,
        maximumQuarantineFraction: null,
        maximumQuarantinedRecords: null,
        requireDistinctApprovalPrincipals: null,
        requireAtLeastOneValidRecord: null,
        requireMaterializedNutrientPerValidRecord: null,
      }),
    ).toEqual(DEFAULT_POLICY);
  });

  it.each([0, 1])("retains inclusive fraction boundary %s and explicit false flags", (fraction) => {
    const policy = {
      maximumExcludedNutrientFraction: fraction,
      maximumQuarantineFraction: fraction,
      maximumQuarantinedRecords: 0,
      requireDistinctApprovalPrincipals: false,
      requireAtLeastOneValidRecord: false,
      requireMaterializedNutrientPerValidRecord: false,
    };
    expect(normalizePolicy(policy)).toEqual(policy);
  });

  it("accepts the largest safe quarantine count and discards unrelated fields", () => {
    expect(
      normalizePolicy({ maximumQuarantinedRecords: Number.MAX_SAFE_INTEGER, unrelated: true }),
    ).toEqual({ ...DEFAULT_POLICY, maximumQuarantinedRecords: Number.MAX_SAFE_INTEGER });
  });

  describe.each(["maximumExcludedNutrientFraction", "maximumQuarantineFraction"])("%s", (key) => {
    it.each([
      -Number.EPSILON,
      1 + Number.EPSILON,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0",
      false,
    ])("rejects invalid fraction %s with the existing Error", (value) => {
      expect(() => normalizePolicy({ [key]: value })).toThrow(
        new Error(`${key} must be between 0 and 1`),
      );
    });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "0", false])(
    "rejects invalid quarantine count %s",
    (maximumQuarantinedRecords) => {
      expect(() => normalizePolicy({ maximumQuarantinedRecords })).toThrow(
        new Error("maximumQuarantinedRecords must be a non-negative safe integer"),
      );
    },
  );

  it.each([
    "requireAtLeastOneValidRecord",
    "requireMaterializedNutrientPerValidRecord",
    "requireDistinctApprovalPrincipals",
  ])("rejects a non-boolean %s", (key) => {
    expect(() => normalizePolicy({ [key]: "false" })).toThrow(new Error(`${key} must be boolean`));
  });

  it("reports the first invalid field in the existing validation order", () => {
    const policy: Record<string, JsonValue> = {
      maximumExcludedNutrientFraction: -1,
      maximumQuarantineFraction: -1,
      maximumQuarantinedRecords: -1,
      requireAtLeastOneValidRecord: "false",
      requireMaterializedNutrientPerValidRecord: "false",
      requireDistinctApprovalPrincipals: "false",
    };
    const errors = [
      ["maximumExcludedNutrientFraction", "must be between 0 and 1"],
      ["maximumQuarantineFraction", "must be between 0 and 1"],
      ["maximumQuarantinedRecords", "must be a non-negative safe integer"],
      ["requireAtLeastOneValidRecord", "must be boolean"],
      ["requireMaterializedNutrientPerValidRecord", "must be boolean"],
      ["requireDistinctApprovalPrincipals", "must be boolean"],
    ];
    for (const [key, message] of errors) {
      if (key === undefined) throw new Error("Missing policy field");
      expect(() => normalizePolicy(policy)).toThrow(new Error(`${key} ${message}`));
      delete policy[key];
    }
    expect(normalizePolicy(policy)).toEqual(DEFAULT_POLICY);
  });
});

describe("catalogue batch policy evaluation", () => {
  const records: readonly BatchRecordValidation[] = [
    record(),
    record(),
    record({
      nutrientMaterializableCount: 1,
      excludedNutrientCount: 1,
      issues: [
        {
          code: "fixture-warning",
          disposition: "exclude_nutrient",
          message: "Excluded nutrient",
          path: "nutrients[0]",
          severity: "warning",
        },
      ],
    }),
    record({
      status: "quarantined",
      nutrientMaterializableCount: 0,
      validatedFoodContractVersion: null,
      validatedFoodSha256: null,
      issues: [
        {
          code: "fixture-error",
          disposition: "exclude_record",
          message: "Quarantined record",
          path: "identity",
          severity: "error",
        },
      ],
    }),
  ];
  const parserEvidence: ParserCountEvidence = {
    emittedNutrientCount: 8,
    emittedPortionCount: 0,
    emittedRecordCount: 4,
    excludedNutrientCount: 2,
    excludedPortionCount: 0,
    excludedRecordCount: 1,
    sourceNutrientCount: 10,
    sourcePortionCount: 0,
    sourceRecordCount: 5,
  };
  const boundaryPolicy = {
    ...DEFAULT_POLICY,
    maximumExcludedNutrientFraction: 0.3,
    maximumQuarantineFraction: 0.4,
    maximumQuarantinedRecords: 2,
  };

  it("accepts exact thresholds using source counts and both parser and row exclusions", () => {
    expect(evaluateBatchPolicy(records, boundaryPolicy, parserEvidence)).toEqual({
      excludedNutrientCount: 3,
      excludedNutrientFraction: 0.3,
      nutrientInputCount: 10,
      nutrientMaterializableCount: 5,
      promotionEligible: true,
      quarantinedCount: 2,
      recordErrorCount: 1,
      unresolvedErrorCount: 0,
      validCount: 3,
      warningCount: 1,
    });
  });

  it.each([
    { maximumExcludedNutrientFraction: 0.3 - Number.EPSILON },
    { maximumQuarantineFraction: 0.4 - Number.EPSILON },
    { maximumQuarantinedRecords: 1 },
  ])("rejects when a threshold is below the observed value: %j", (override) => {
    expect(
      evaluateBatchPolicy(records, { ...boundaryPolicy, ...override }, parserEvidence),
    ).toMatchObject({ promotionEligible: false, unresolvedErrorCount: 1 });
  });

  it("uses staged counts when parser evidence is absent", () => {
    expect(evaluateBatchPolicy(records, boundaryPolicy)).toMatchObject({
      excludedNutrientCount: 1,
      excludedNutrientFraction: 0.125,
      nutrientInputCount: 8,
      quarantinedCount: 1,
      promotionEligible: true,
      unresolvedErrorCount: 0,
    });
  });

  it("uses fraction one for empty denominators and honors the valid-record requirement", () => {
    const policy = {
      ...DEFAULT_POLICY,
      maximumExcludedNutrientFraction: 1,
      maximumQuarantineFraction: 1,
    };
    expect(evaluateBatchPolicy([], policy)).toMatchObject({
      excludedNutrientFraction: 1,
      promotionEligible: false,
      unresolvedErrorCount: 1,
    });
    expect(
      evaluateBatchPolicy([], { ...policy, requireAtLeastOneValidRecord: false }),
    ).toMatchObject({ promotionEligible: true, unresolvedErrorCount: 0 });
    expect(
      evaluateBatchPolicy([], { ...DEFAULT_POLICY, requireAtLeastOneValidRecord: false }),
    ).toMatchObject({ promotionEligible: false, unresolvedErrorCount: 2 });
  });

  it("requires nutrients for each valid record even when other rows have nutrients", () => {
    const mixed = [record(), record({ nutrientMaterializableCount: 0 })];
    expect(evaluateBatchPolicy(mixed, DEFAULT_POLICY)).toMatchObject({
      nutrientMaterializableCount: 2,
      promotionEligible: false,
      unresolvedErrorCount: 1,
    });
    expect(
      evaluateBatchPolicy(mixed, {
        ...DEFAULT_POLICY,
        requireMaterializedNutrientPerValidRecord: false,
      }),
    ).toMatchObject({ promotionEligible: true, unresolvedErrorCount: 0 });
  });
});
