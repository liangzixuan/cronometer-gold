import { describe, expect, it } from "vitest";

import { type FoodSearchHit, parseSearchPage } from "../search/food-search";
import {
  collectReviewedIngredients,
  hasReviewedGramServing,
  reviewedFoodIngredient,
} from "./recipe-ingredient-review";

// Same exact-decimal public source/serving contract exercised by food-search.test.ts.
const food: FoodSearchHit = parseSearchPage({
  data: [
    {
      foodId: "101",
      foodVersionId: "202",
      kind: "branded",
      name: "Apple Pie",
      brandName: "Orchard Kitchen",
      marketCode: "US",
      languageTag: "en-US",
      source: {
        code: "USDA_FDC",
        displayName: "USDA FoodData Central",
        licenseExpression: "CC0-1.0",
        attributionRequired: true,
        attributionText: "Data source: USDA FoodData Central",
      },
      defaultServing: {
        servingId: "303",
        label: "1 slice",
        quantity: "1",
        unit: "slice",
        gramWeight: "125.5",
        milliliterVolume: null,
      },
    },
  ],
  page: { nextCursor: null },
}).data[0] as FoodSearchHit;

const defaultServing = food.defaultServing;
if (defaultServing === null) throw new TypeError("The food-search fixture needs a serving.");

function resolvedLine(lineNumber: number, originalText = "a pasted quantity, never a note") {
  return {
    lineNumber,
    originalText,
    ingredient: reviewedFoodIngredient(food, "grams", "0.000001", `line-${lineNumber}`),
  };
}

describe("explicit food ingredient confirmation", () => {
  it("preserves exact grams, pinned identity, name, brand, and all source fields", () => {
    const ingredient = reviewedFoodIngredient(food, "grams", "999999999999.000001", "line-1");
    expect(ingredient).toEqual({
      kind: "food",
      clientKey: "line-1",
      foodVersionId: "202",
      name: "Apple Pie",
      brandName: "Orchard Kitchen",
      portion: { kind: "grams", grams: "999999999999.000001" },
      source: food.source,
      foodProvenance: { kind: "public", source: food.source },
      note: null,
    });
    expect(Object.isFrozen(ingredient)).toBe(true);
    expect(Object.isFrozen(ingredient.portion)).toBe(true);
    expect(Object.isFrozen(ingredient.source)).toBe(true);
  });

  it("uses an explicit exact serving amount without turning it into guessed grams", () => {
    const ingredient = reviewedFoodIngredient(food, "serving", "0.000001", "line-2");
    expect(ingredient.portion).toEqual({
      kind: "serving",
      servingId: "303",
      servingLabel: "1 slice",
      amount: "0.000001",
    });
    expect(hasReviewedGramServing(food)).toBe(true);
  });

  it.each([
    "",
    "0",
    "0.000000",
    "-1",
    "+1",
    "1e2",
    "1/2",
    ".5",
    "1.",
    "01",
    "1,5",
    " 1",
    "1 ",
    "0.0000001",
    "1000000000000",
    "Infinity",
    "NaN",
  ])("rejects unconfirmed or inexact quantity %j", (quantity) => {
    expect(() => reviewedFoodIngredient(food, "grams", quantity, "line-1")).toThrow(RangeError);
    expect(() => reviewedFoodIngredient(food, "serving", quantity, "line-1")).toThrow(RangeError);
  });

  it.each([null, "0", "0.000000"])(
    "rejects nonpositive or unresolved serving grams %j",
    (gramWeight) => {
      const unresolved = { ...food, defaultServing: { ...defaultServing, gramWeight } };
      expect(hasReviewedGramServing(unresolved)).toBe(false);
      expect(() => reviewedFoodIngredient(unresolved, "serving", "1", "line-1")).toThrow(
        "no positive gram-resolved",
      );
      expect(reviewedFoodIngredient(unresolved, "grams", "2.5", "line-1").portion).toEqual({
        kind: "grams",
        grams: "2.5",
      });
    },
  );

  it("rejects volume-only servings without introducing a density assumption", () => {
    const volumeOnly = {
      ...food,
      defaultServing: { ...defaultServing, gramWeight: null, milliliterVolume: "240" },
    };
    expect(() => reviewedFoodIngredient(volumeOnly, "serving", "1", "line-1")).toThrow(RangeError);
    expect(() =>
      reviewedFoodIngredient({ ...food, defaultServing: null }, "serving", "1", "line-1"),
    ).toThrow(RangeError);
  });

  it("checks source and identity contracts without accepting malformed results", () => {
    expect(() =>
      reviewedFoodIngredient({ ...food, foodVersionId: "0" }, "grams", "1", "line-1"),
    ).toThrow(TypeError);
    expect(() =>
      reviewedFoodIngredient(
        { ...food, source: { ...food.source, attributionText: "" } },
        "grams",
        "1",
        "line-1",
      ),
    ).toThrow(TypeError);
    expect(() => reviewedFoodIngredient(food, "grams", "1", "")).toThrow(TypeError);
  });
});

describe("reviewed ingredient transfer", () => {
  it("keeps duplicate foods as separate ordered lines without copying pasted text", () => {
    const lines = [
      resolvedLine(3, "RAW_PRIVATE_LINE_ONE"),
      resolvedLine(1, "RAW_PRIVATE_LINE_TWO"),
    ];
    const result = collectReviewedIngredients(lines, 2);
    expect(result.map((ingredient) => ingredient.clientKey)).toEqual(["line-3", "line-1"]);
    expect(result.map((ingredient) => ingredient.foodVersionId)).toEqual(["202", "202"]);
    expect(JSON.stringify(result)).not.toContain("RAW_PRIVATE_LINE");
    expect(result.every((ingredient) => ingredient.note === null)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("requires explicit confirmation of every line", () => {
    expect(() =>
      collectReviewedIngredients(
        [resolvedLine(1), { lineNumber: 2, originalText: "salt", ingredient: null }],
        50,
      ),
    ).toThrow("confirm line 2");
  });

  it("never silently drops lines to fit remaining capacity", () => {
    expect(() => collectReviewedIngredients([resolvedLine(1), resolvedLine(2)], 1)).toThrow(
      "room for 1",
    );
    expect(collectReviewedIngredients([resolvedLine(1), resolvedLine(2)], 2)).toHaveLength(2);
  });

  it.each([-1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid remaining capacity %j",
    (capacity) => {
      expect(() => collectReviewedIngredients([resolvedLine(1)], capacity)).toThrow(RangeError);
    },
  );

  it("rejects empty, oversized, or duplicated transfer identities", () => {
    expect(() => collectReviewedIngredients([], 50)).toThrow(RangeError);
    expect(() =>
      collectReviewedIngredients(
        Array.from({ length: 51 }, (_, index) => resolvedLine(index + 1)),
        50,
      ),
    ).toThrow(RangeError);
    expect(() => collectReviewedIngredients([resolvedLine(1), resolvedLine(1)], 50)).toThrow(
      "own ingredient identity",
    );
  });
});
