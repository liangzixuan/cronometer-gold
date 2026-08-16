import { describe, expect, it } from "vitest";

import type { FoodSearchHit } from "../../lib/food-search";
import type { RecipeView } from "../../lib/recipes-goals";
import { draftFromRecipe, foodDraftIngredient } from "./RecipesClient";

const food = {
  foodId: "101",
  foodVersionId: "202",
  kind: "generic",
  name: "Rolled oats",
  brandName: null,
  marketCode: "US",
  languageTag: "en-US",
  source: {
    code: "USDA_FDC",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
  },
  defaultServing: null,
} satisfies FoodSearchHit;

describe("web recipe builder state", () => {
  it("preserves instructions when preparing an immutable revision", () => {
    const recipe = {
      id: "ce126b7f-dfe5-4ee4-a75c-6b0f50c1963e",
      status: "active",
      revision: "4",
      versionId: "db2ed69e-29d1-4330-a210-0a804f9ff2b3",
      versionNumber: 4,
      name: "Porridge",
      description: null,
      instructions: "Simmer for five minutes.",
      finalYieldGrams: "440",
      yieldSource: "measured",
      servingCount: "2",
      servingLabel: "bowl",
      inputMassGrams: "440",
      ingredients: [
        {
          position: 0,
          kind: "food",
          foodVersionId: "202",
          recipeId: null,
          recipeVersionId: null,
          name: "Rolled oats",
          brandName: null,
          portion: { kind: "serving", servingId: "303", amount: "2", servingLabel: "scoop" },
          quantityText: "2",
          resolvedGrams: "80",
          source: {
            displayName: "USDA FoodData Central",
            licenseExpression: "CC0-1.0",
            attributionText: "Data source: USDA FoodData Central",
          },
          note: "Toast first",
          coverage: "complete",
        },
      ],
      sources: [],
      nutrientsPer100Grams: [],
      nutrientsPerServing: [],
      warnings: [],
      retentionPolicy: {
        code: "identity-retention-default",
        version: "1",
        assumption: "No named retention factor set is applied.",
      },
      createdAt: "2026-08-16T12:00:00.000Z",
      updatedAt: "2026-08-16T12:00:00.000Z",
    } satisfies RecipeView;
    expect(draftFromRecipe(recipe).instructions).toBe("Simmer for five minutes.");
    expect(draftFromRecipe(recipe).ingredients[0]).toEqual(
      expect.objectContaining({
        note: "Toast first",
        portion: { kind: "serving", servingId: "303", amount: "2", servingLabel: "scoop" },
      }),
    );
    expect(draftFromRecipe(recipe).ingredients[0]).not.toHaveProperty("resolvedGramsPerServing");
  });

  it("offers exact grams when a food has no default serving", () => {
    expect(foodDraftIngredient(food, "grams")).toMatchObject({
      kind: "food",
      foodVersionId: "202",
      portion: { kind: "grams", grams: "100" },
    });
    expect(() => foodDraftIngredient(food, "serving")).toThrow("reviewed gram-resolved");
  });
});
