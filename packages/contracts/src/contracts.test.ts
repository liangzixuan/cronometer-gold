import { describe, expect, it } from "vitest";

import {
  createDiaryEntryRequestSchema,
  diaryDayResponseSchema,
  diaryEntrySchema,
  diaryFoodEntrySchema,
  diaryMutationResponseSchema,
  diaryNutrientAggregateSchema,
  diaryRecipeEntrySchema,
  foodAutocompleteResponseSchema,
  foodBarcodeNotFoundSchema,
  foodBarcodeResponseSchema,
  foodSearchHitSchema,
  foodSearchPageSchema,
  probeResponseSchema,
  problemCodes,
  problemDetailsSchema,
  publicFoodKinds,
  registerAccountRequestSchema,
  updateDiaryEntryRequestSchema,
  userProfileSchema,
} from "./index.js";

describe("public contracts", () => {
  it("keeps the liveness response intentionally small", () => {
    expect(probeResponseSchema.required).toEqual(["status"]);
    expect(probeResponseSchema.properties.status.const).toBe("ok");
  });

  it("keeps the problem schema and code taxonomy synchronized", () => {
    expect(problemDetailsSchema.properties.code.enum).toEqual(problemCodes);
    expect(problemCodes).toContain("INTERNAL_ERROR");
    expect(new Set(problemCodes).size).toBe(problemCodes.length);
  });

  it("publishes closed food-search result contracts", () => {
    expect(foodSearchHitSchema.additionalProperties).toBe(false);
    expect(foodSearchHitSchema.properties.kind.enum).toEqual(publicFoodKinds);
    expect(foodSearchPageSchema.properties.data.maxItems).toBe(50);
    expect(foodSearchPageSchema.properties.page.additionalProperties).toBe(false);
    expect(foodSearchHitSchema.properties.source.required).toEqual([
      "code",
      "displayName",
      "licenseExpression",
      "attributionRequired",
      "attributionText",
    ]);
    expect(foodAutocompleteResponseSchema.properties.data.maxItems).toBe(10);
    expect(foodAutocompleteResponseSchema.properties.data.items.required).toContain("source");
    expect(foodBarcodeResponseSchema.properties.data).toBe(foodSearchHitSchema);
  });

  it("makes barcode misses deterministic RFC problem responses", () => {
    expect(foodBarcodeNotFoundSchema.properties.status.const).toBe(404);
    expect(foodBarcodeNotFoundSchema.properties.code.const).toBe("NOT_FOUND");
    expect(foodBarcodeNotFoundSchema.properties.detail.const).toBe(
      "No current public food matches this barcode.",
    );
  });

  it("publishes closed account and diary contracts", () => {
    expect(registerAccountRequestSchema.additionalProperties).toBe(false);
    expect(registerAccountRequestSchema.required).toContain("timeZone");
    expect(userProfileSchema.required).toContain("revision");
    expect(createDiaryEntryRequestSchema.required).not.toContain("localDate");
    expect(updateDiaryEntryRequestSchema.properties).not.toHaveProperty("localDate");
    expect(diaryNutrientAggregateSchema.additionalProperties).toBe(false);
    expect(diaryNutrientAggregateSchema.properties).toHaveProperty("knownAmount");
    expect(diaryNutrientAggregateSchema.properties.knownAmount.maxLength).toBe(200);
    expect(diaryNutrientAggregateSchema.properties.unknownReasonCounts.required).toEqual([
      "not_reported",
      "not_analyzed",
      "not_applicable",
      "withheld",
    ]);
    expect(diaryDayResponseSchema.properties.data.additionalProperties).toBe(false);
    expect(diaryDayResponseSchema.properties.data.properties.entries.maxItems).toBe(50);
    expect(diaryDayResponseSchema.properties.data.properties.totals.maxItems).toBe(256);
    expect(diaryEntrySchema.oneOf).toEqual([diaryFoodEntrySchema, diaryRecipeEntrySchema]);
    expect(diaryFoodEntrySchema.properties.nutrients.maxItems).toBe(256);
    expect(diaryFoodEntrySchema.required).toContain("source");
    expect(diaryFoodEntrySchema.required).toContain("timeZone");
    const servingEntryPortion = diaryFoodEntrySchema.properties.portion.oneOf[0];
    expect(servingEntryPortion.required).toContain("servingLabel");
    expect(servingEntryPortion.additionalProperties).toBe(false);
    expect(diaryFoodEntrySchema.properties.source.required).toEqual([
      "code",
      "displayName",
      "licenseExpression",
      "attributionRequired",
      "attributionText",
      "releaseId",
    ]);
    expect(diaryMutationResponseSchema.properties.data.properties.affectedDays.maxItems).toBe(2);
  });
});
