import { describe, expect, it } from "vitest";

import {
  foodAutocompleteResponseSchema,
  foodBarcodeNotFoundSchema,
  foodBarcodeResponseSchema,
  foodSearchHitSchema,
  foodSearchPageSchema,
  probeResponseSchema,
  problemCodes,
  problemDetailsSchema,
  publicFoodKinds,
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
});
