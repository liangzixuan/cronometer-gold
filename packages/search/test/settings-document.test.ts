import { describe, expect, it } from "vitest";
import {
  assertFoodSearchDocument,
  CURATED_FOOD_SYNONYMS,
  FOOD_SEARCH_INDEX_SETTINGS,
  FoodSearchError,
  isFoodSearchDocument,
  toFoodSearchHit,
} from "../src/index.js";
import { foodDocument } from "./fixtures.js";

describe("shared food index safety", () => {
  it("uses curated reciprocal synonyms and exact numeric/barcode typo settings", () => {
    expect(CURATED_FOOD_SYNONYMS.chickpea).toContain("garbanzo bean");
    expect(CURATED_FOOD_SYNONYMS["garbanzo bean"]).toContain("chickpea");
    expect(FOOD_SEARCH_INDEX_SETTINGS.typoTolerance.disableOnNumbers).toBe(true);
    expect(FOOD_SEARCH_INDEX_SETTINGS.typoTolerance.disableOnAttributes).toContain("barcodes");
    expect(FOOD_SEARCH_INDEX_SETTINGS.rankingRules.at(-1)).toBe("exactness");
  });

  it("accepts only the exact public projection shape and preserves decimal strings", () => {
    const document = foodDocument({
      defaultServing: {
        servingId: "7001",
        label: "1.25 cup",
        quantity: "1.250000",
        unit: "cup",
        gramWeight: "205.125000",
        milliliterVolume: "295.735296875",
      },
    });
    expect(isFoodSearchDocument(document)).toBe(true);
    expect(toFoodSearchHit(document).defaultServing?.milliliterVolume).toBe("295.735296875");
    expect(typeof toFoodSearchHit(document).defaultServing?.quantity).toBe("string");
  });

  it("rejects private/custom fields, quarantined quality, malformed IDs, numeric decimals, and casing drift", () => {
    expect(isFoodSearchDocument({ ...foodDocument(), ownerUserId: "private-user" })).toBe(false);
    expect(isFoodSearchDocument({ ...foodDocument(), kind: "custom" })).toBe(false);
    expect(isFoodSearchDocument({ ...foodDocument(), dataQuality: "quarantined" })).toBe(false);
    expect(isFoodSearchDocument({ ...foodDocument(), id: "fdc:100" })).toBe(false);
    expect(isFoodSearchDocument({ ...foodDocument(), languageTag: "en-us" })).toBe(false);
    expect(
      isFoodSearchDocument({
        ...foodDocument(),
        defaultServing: { ...foodDocument().defaultServing, quantity: 1.25 },
      }),
    ).toBe(false);
    expect(() =>
      assertFoodSearchDocument({ ...foodDocument(), diaryEntryId: "health-data" }),
    ).toThrow(FoodSearchError);
  });
});
