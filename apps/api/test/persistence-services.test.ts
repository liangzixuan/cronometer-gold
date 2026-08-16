import type { DiaryNutrientAggregateRecord } from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";
import { normalizeProfilePatch } from "../src/modules/profile/profile-validation.js";
import { mapDiaryNutrientAggregate } from "../src/persistence-services.js";

function persistedAggregate(
  overrides: Partial<DiaryNutrientAggregateRecord> = {},
): DiaryNutrientAggregateRecord {
  return {
    code: "protein_g",
    completeness: "partial",
    contributorCount: 7,
    isExact: false,
    knownAmount: "12.250000000000",
    name: "Protein",
    nutrientId: "1003",
    quantifiedCount: 2,
    traceCount: 1,
    unit: "g",
    unknownCount: 4,
    unknownReasons: { not_reported: 3, withheld: 1 },
    ...overrides,
  };
}

describe("PostgreSQL API adapters", () => {
  it("preserves every unknown-reason count and fills absent closed reasons with zero", () => {
    expect(mapDiaryNutrientAggregate(persistedAggregate())).toMatchObject({
      contributorCount: 7,
      quantifiedCount: 2,
      traceCount: 1,
      unknownCount: 4,
      unknownReasonCounts: {
        not_reported: 3,
        not_analyzed: 0,
        not_applicable: 0,
        withheld: 1,
      },
    });
  });

  it("normalizes DB-aligned profile values and rejects future dates", () => {
    expect(
      normalizeProfilePatch(
        { baselineWeightKg: "65.500", birthDate: "1990-02-03", heightCm: "170.000" },
        new Date("2026-08-15T00:00:00.000Z"),
      ),
    ).toEqual({ baselineWeightKg: "65.5", birthDate: "1990-02-03", heightCm: "170" });
    expect(() =>
      normalizeProfilePatch({ birthDate: "2026-08-16" }, new Date("2026-08-15T00:00:00.000Z")),
    ).toThrow(RangeError);
    expect(() => normalizeProfilePatch({ birthDate: "0000-01-01" })).toThrow(RangeError);
  });

  it("fails closed on unrecognized or non-integral persisted reason values", () => {
    expect(() =>
      mapDiaryNutrientAggregate(
        persistedAggregate({ unknownReasons: { suppressed_for_private_reason: 4 } }),
      ),
    ).toThrow("Unknown nutrient reason");
    expect(() =>
      mapDiaryNutrientAggregate(persistedAggregate({ unknownReasons: { not_reported: 1.5 } })),
    ).toThrow("Invalid nutrient unknown reason count");
  });
});
