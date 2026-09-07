import { Ajv } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  createDiaryEntryHeadersSchema,
  createDiaryEntryQuerySchema,
  createDiaryEntryRequestSchema,
  defaultDiaryGroups,
  diaryDayResponseSchema,
  diaryEntrySchema,
  diaryFoodEntrySchema,
  diaryGroupsSchema,
  diaryMealSlots,
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
  updateUserProfileRequestSchema,
  userProfileSchema,
} from "./index.js";

const addFormats = addFormatsModule.default as unknown as (ajv: Ajv) => Ajv;

describe("public contracts", () => {
  it("keeps the liveness response intentionally small", () => {
    expect(probeResponseSchema.required).toEqual(["status"]);
    expect(probeResponseSchema.properties.status.const).toBe("ok");
  });

  it("keeps the problem schema and code taxonomy synchronized", () => {
    expect(problemDetailsSchema.properties.code.enum).toEqual(problemCodes);
    expect(problemCodes).toContain("INTERNAL_ERROR");
    expect(problemCodes).toContain("PROFILE_OWNER_CHANGED");
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
    expect(userProfileSchema.required).toContain("diaryGroups");
    expect(updateUserProfileRequestSchema.dependencies).toEqual({
      diaryGroups: ["expectedOwnerUserId"],
      expectedOwnerUserId: { minProperties: 2 },
    });
    const profileUpdateAjv = new Ajv({ allErrors: true, strict: true });
    addFormats(profileUpdateAjv);
    const validateProfileUpdate = profileUpdateAjv.compile(updateUserProfileRequestSchema);
    expect(validateProfileUpdate({ displayName: "Legacy edit" })).toBe(true);
    expect(
      validateProfileUpdate({
        expectedOwnerUserId: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
        diaryGroups: defaultDiaryGroups,
      }),
    ).toBe(true);
    expect(validateProfileUpdate({ diaryGroups: defaultDiaryGroups })).toBe(false);
    expect(
      validateProfileUpdate({
        expectedOwnerUserId: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
      }),
    ).toBe(false);
    expect(diaryGroupsSchema).toMatchObject({
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
    });
    expect(diaryGroupsSchema.items).toMatchObject({
      additionalProperties: false,
      required: ["mealSlot", "label"],
      properties: {
        mealSlot: { enum: diaryMealSlots },
        label: { minLength: 1, maxLength: 40 },
      },
    });
    expect(
      diaryGroupsSchema.allOf.map((constraint) => constraint.contains.properties.mealSlot.const),
    ).toEqual(diaryMealSlots);
    const validateDiaryGroups = new Ajv({ allErrors: true, strict: true }).compile(
      diaryGroupsSchema,
    );
    expect(validateDiaryGroups(defaultDiaryGroups)).toBe(true);
    expect(
      validateDiaryGroups([
        { mealSlot: "breakfast", label: "Morning" },
        { mealSlot: "breakfast", label: "Second breakfast" },
        { mealSlot: "dinner", label: "Dinner" },
        { mealSlot: "snacks", label: "Snacks" },
      ]),
    ).toBe(false);
    expect(createDiaryEntryRequestSchema.required).not.toContain("localDate");
    expect(createDiaryEntryHeadersSchema).toMatchObject({
      additionalProperties: true,
      properties: {
        "x-expected-profile-time-zone": { type: "string", minLength: 1, maxLength: 63 },
      },
    });
    expect(createDiaryEntryQuerySchema).toEqual({
      $id: "CreateDiaryEntryQuery",
      type: "object",
      additionalProperties: false,
      properties: {
        profileTimeZonePrecondition: { type: "string", const: "v1" },
      },
    });
    expect(problemCodes).toContain("DIARY_TIME_ZONE_CHANGED");
    expect(updateDiaryEntryRequestSchema.properties).not.toHaveProperty("localDate");
    expect(updateDiaryEntryRequestSchema.properties.note.anyOf[0]).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      pattern: expect.any(String),
    });
    expect(diaryFoodEntrySchema.properties.note.anyOf[0]).toEqual({
      type: "string",
      maxLength: 10_000,
      pattern: expect.any(String),
    });
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
    expect(diaryFoodEntrySchema.properties.foodProvenance.oneOf).toHaveLength(2);
    expect(diaryFoodEntrySchema.properties.nutrients.maxItems).toBe(256);
    expect(diaryFoodEntrySchema.required).toContain("source");
    expect(diaryFoodEntrySchema.required).toContain("foodProvenance");
    expect(diaryFoodEntrySchema.required).toContain("note");
    expect(diaryRecipeEntrySchema.required).toContain("note");
    expect(diaryFoodEntrySchema.required).toContain("timeZone");
    const servingEntryPortion = diaryFoodEntrySchema.properties.portion.oneOf[0];
    expect(servingEntryPortion.required).toContain("servingLabel");
    expect(servingEntryPortion.additionalProperties).toBe(false);
    expect(
      diaryFoodEntrySchema.properties.foodProvenance.oneOf[0].properties.source.required,
    ).toEqual([
      "code",
      "displayName",
      "licenseExpression",
      "attributionRequired",
      "attributionText",
      "releaseId",
    ]);
    expect(diaryFoodEntrySchema.properties.source.anyOf[1].type).toBe("null");
    expect(diaryMutationResponseSchema.properties.data.properties.affectedDays.maxItems).toBe(2);
  });
});
