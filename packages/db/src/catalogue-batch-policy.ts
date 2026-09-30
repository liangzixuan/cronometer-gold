import type { CatalogueValidationIssue } from "./catalogue-validation.js";
import type { JsonObject } from "./types.js";

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
  readonly validatedFoodContractVersion: 1 | null;
  readonly validatedFoodSha256: string | null;
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

export function normalizePolicy(
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
