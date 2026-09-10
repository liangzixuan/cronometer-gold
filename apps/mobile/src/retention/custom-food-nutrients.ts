import type { CustomFoodNutrientDraft } from "@nutrition-tracker/contracts";

import type { TargetableNutrient } from "../recipes/recipes-goals";

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

export function parseCanonicalNutrientInput(value: string): readonly CustomFoodNutrientDraft[] {
  const rows = value
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length < 1 || rows.length > 256) {
    throw new RangeError("Enter between 1 and 256 canonical nutrient rows.");
  }
  const result = rows.map((row): CustomFoodNutrientDraft => {
    const separator = row.indexOf("=");
    const nutrientId = row.slice(0, separator);
    const amount = row.slice(separator + 1);
    if (separator < 1 || !/^[1-9][0-9]{0,19}$/u.test(nutrientId)) {
      throw new TypeError("Each nutrient row must start with its numeric nutrient ID.");
    }
    if (NON_NEGATIVE_DECIMAL.test(amount) && amount.length <= 200) {
      return { nutrientId, state: "quantified", amountPer100Grams: amount };
    }
    if (amount === "trace") return { nutrientId, state: "trace", amountPer100Grams: null };
    const unknown = /^unknown:(not_reported|not_analyzed|not_applicable|withheld)$/u.exec(amount);
    if (unknown?.[1]) {
      return {
        nutrientId,
        state: "unknown",
        amountPer100Grams: null,
        reason: unknown[1] as "not_reported" | "not_analyzed" | "not_applicable" | "withheld",
      };
    }
    throw new TypeError("Use an exact amount per 100 g, trace, or unknown:<reason>.");
  });
  if (new Set(result.map((row) => row.nutrientId)).size !== result.length) {
    throw new TypeError("Each nutrient may appear only once.");
  }
  return result;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function canonicalCandidateLine(candidate: CustomFoodNutrientDraft): string {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate.nutrientId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(candidate.nutrientId)
  )
    throw new TypeError("Choose an available nutrient before adding a row.");

  if (
    candidate.state === "quantified" &&
    exactKeys(candidate, ["nutrientId", "state", "amountPer100Grams"]) &&
    typeof candidate.amountPer100Grams === "string" &&
    NON_NEGATIVE_DECIMAL.test(candidate.amountPer100Grams) &&
    candidate.amountPer100Grams.length <= 200
  )
    return `${candidate.nutrientId}=${candidate.amountPer100Grams}`;

  if (
    candidate.state === "trace" &&
    exactKeys(candidate, ["nutrientId", "state", "amountPer100Grams"]) &&
    candidate.amountPer100Grams === null
  )
    return `${candidate.nutrientId}=trace`;

  if (
    candidate.state === "unknown" &&
    exactKeys(candidate, ["nutrientId", "state", "amountPer100Grams", "reason"]) &&
    candidate.amountPer100Grams === null &&
    ["not_reported", "not_analyzed", "not_applicable", "withheld"].includes(candidate.reason)
  )
    return `${candidate.nutrientId}=unknown:${candidate.reason}`;

  throw new TypeError(
    "Enter an exact amount per 100 g, choose trace, or choose an unknown reason.",
  );
}

/** Appends one named choice; existing canonical text remains byte-for-byte authoritative. */
export function appendCanonicalNutrientInput(
  value: string,
  candidate: CustomFoodNutrientDraft,
  available: readonly Pick<TargetableNutrient, "nutrientId">[],
): string {
  if (typeof value !== "string") throw new TypeError("Canonical nutrient text must be a string.");
  if (value.trim()) parseCanonicalNutrientInput(value);
  const line = canonicalCandidateLine(candidate);
  if (!available.some((nutrient) => nutrient.nutrientId === candidate.nutrientId)) {
    throw new TypeError(
      "Choose a nutrient from the available named list, or use canonical text for other IDs.",
    );
  }
  const separator =
    value === "" || value.endsWith("\n") ? "" : value.includes("\r\n") ? "\r\n" : "\n";
  const next = `${value}${separator}${line}`;
  if (next.length > 12_000) {
    throw new RangeError(
      "Adding this nutrient would exceed 12,000 canonical text characters. Edit the text before adding another row.",
    );
  }
  parseCanonicalNutrientInput(next);
  return next;
}
