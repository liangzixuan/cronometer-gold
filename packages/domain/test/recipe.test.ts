import { describe, expect, it } from "vitest";

import {
  calculateRecipeNutrition,
  createResolvedNutrientProfile,
  type DomainError,
  recipePer100GramProfile,
  validateRecipeDependencies,
} from "../src/index.js";
import { PORRIDGE_GOLDEN_VECTOR } from "./golden-vectors.js";

function amounts(
  rows: readonly { readonly nutrientId: string; readonly knownAmount: string }[],
): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.nutrientId, row.knownAmount]));
}

describe("recipe nutrition", () => {
  it("matches the reviewed porridge golden vector", () => {
    const result = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);

    expect(result.inputMassGrams).toBe("440");
    expect(amounts(result.totals)).toEqual(PORRIDGE_GOLDEN_VECTOR.expected.total);
    expect(amounts(result.per100Grams)).toEqual(PORRIDGE_GOLDEN_VECTOR.expected.per100Grams);
    expect(amounts(result.perServing ?? [])).toEqual(PORRIDGE_GOLDEN_VECTOR.expected.perServing);

    const iron = result.totals.find((row) => row.nutrientId === "iron");
    expect(iron).toMatchObject({
      knownAmount: "4.088",
      completeness: "partial",
      contributorCount: 3,
      quantifiedCount: 2,
      unknownCount: 1,
      unknownReasons: { not_analyzed: 1 },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "RETENTION_FACTORS_DEFAULTED",
      "PARTIAL_NUTRIENT_DATA",
    ]);
    expect(result.retentionPolicy).toMatchObject({
      code: "identity-retention-default",
      version: "1",
    });
  });

  it("is invariant to ingredient ordering", () => {
    const forward = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);
    const reverse = calculateRecipeNutrition({
      ...PORRIDGE_GOLDEN_VECTOR,
      ingredients: [...PORRIDGE_GOLDEN_VECTOR.ingredients].reverse(),
    });
    expect(reverse.totals).toEqual(forward.totals);
    expect(reverse.per100Grams).toEqual(forward.per100Grams);
  });

  it("preserves partial coverage in a nested recipe profile", () => {
    const first = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);
    const nestedProfile = recipePer100GramProfile(first);
    const nested = calculateRecipeNutrition({
      ingredients: [
        {
          id: "porridge-half",
          name: "Prepared porridge",
          grams: "200",
          nutrientProfile: nestedProfile,
        },
      ],
      nutrients: PORRIDGE_GOLDEN_VECTOR.nutrients,
      finalYield: { grams: "200", source: "measured" },
      servingCount: "1",
    });

    expect(nested.totals.find((row) => row.nutrientId === "iron")).toMatchObject({
      knownAmount: "2.044",
      completeness: "partial",
      contributorCount: 3,
      unknownCount: 1,
    });
  });

  it("rejects repeated nested coverage before PostgreSQL integer overflow", () => {
    const [nutrient] = PORRIDGE_GOLDEN_VECTOR.nutrients;
    if (!nutrient) throw new Error("nutrient fixture is missing");
    const contributorCount = 1_500_000_000;
    const profile = createResolvedNutrientProfile("100", [
      {
        nutrientId: nutrient.id,
        unit: nutrient.canonicalUnit,
        knownAmount: "1",
        completeness: "complete",
        isExact: true,
        contributorCount,
        quantifiedCount: contributorCount,
        traceCount: 0,
        unknownCount: 0,
        unknownReasons: {},
      },
    ]);
    expect(() =>
      calculateRecipeNutrition({
        ingredients: [
          { id: "nested-a", name: "Nested A", grams: "100", nutrientProfile: profile },
          { id: "nested-b", name: "Nested B", grams: "100", nutrientProfile: profile },
        ],
        nutrients: [nutrient],
        finalYield: { grams: "200", source: "measured" },
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_RECIPE" }));
  });

  it("applies an explicit nutrient retention factor before yield concentration", () => {
    const [oats] = PORRIDGE_GOLDEN_VECTOR.ingredients;
    const [energy] = PORRIDGE_GOLDEN_VECTOR.nutrients;
    if (!oats) throw new Error("oats fixture is missing");
    if (!energy) throw new Error("energy fixture is missing");
    const result = calculateRecipeNutrition({
      ingredients: [{ ...oats, retentionFactors: { energy: "0.5" } }],
      nutrients: [energy],
      finalYield: { grams: "80", source: "measured" },
      servingCount: "1",
    });

    expect(result.totals[0]).toMatchObject({
      nutrientId: "energy",
      knownAmount: "155.6",
      completeness: "complete",
    });
    expect(result.per100Grams[0]?.knownAmount).toBe("194.5");
    expect(() =>
      calculateRecipeNutrition({
        ingredients: [{ ...oats, retentionFactors: { energy: "1.0001" } }],
        nutrients: [energy],
        finalYield: { grams: "80", source: "measured" },
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_RECIPE" }));
  });

  it("rejects zero yield and an unknown retention-factor key", () => {
    const [firstIngredient] = PORRIDGE_GOLDEN_VECTOR.ingredients;
    if (!firstIngredient) throw new Error("ingredient fixture is missing");
    expect(() =>
      calculateRecipeNutrition({
        ...PORRIDGE_GOLDEN_VECTOR,
        finalYield: { grams: "0", source: "measured" },
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DECIMAL" }));

    expect(() =>
      calculateRecipeNutrition({
        ...PORRIDGE_GOLDEN_VECTOR,
        ingredients: [
          {
            ...firstIngredient,
            retentionFactors: { typo_nutrient: "0.9" },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_RECIPE" }));
  });

  it("rejects ingredient/nutrient overflow and unsafe nested dependencies", () => {
    const [ingredient] = PORRIDGE_GOLDEN_VECTOR.ingredients;
    const [nutrient] = PORRIDGE_GOLDEN_VECTOR.nutrients;
    if (!ingredient || !nutrient) throw new Error("fixture is missing");
    expect(() =>
      calculateRecipeNutrition({
        ...PORRIDGE_GOLDEN_VECTOR,
        ingredients: Array.from({ length: 51 }, (_, index) => ({
          ...ingredient,
          id: `ingredient-${index}`,
        })),
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_RECIPE" }));
    expect(() =>
      calculateRecipeNutrition({
        ...PORRIDGE_GOLDEN_VECTOR,
        nutrients: Array.from({ length: 257 }, (_, index) => ({
          ...nutrient,
          id: `nutrient-${index}`,
        })),
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_RECIPE" }));

    expect(() =>
      validateRecipeDependencies("a", [
        { recipeVersionId: "a", nestedRecipeVersionIds: ["b"] },
        { recipeVersionId: "b", nestedRecipeVersionIds: ["a"] },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "RECIPE_DEPENDENCY_CYCLE" }),
    );
    expect(() =>
      validateRecipeDependencies(
        "a",
        [
          { recipeVersionId: "a", nestedRecipeVersionIds: ["b"] },
          { recipeVersionId: "b", nestedRecipeVersionIds: ["c"] },
          { recipeVersionId: "c", nestedRecipeVersionIds: [] },
        ],
        2,
      ),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "RECIPE_NESTING_LIMIT" }));

    const elevenNodes = Array.from({ length: 11 }, (_, index) => ({
      recipeVersionId: `v${index + 1}`,
      nestedRecipeVersionIds: index === 10 ? [] : [`v${index + 2}`],
    }));
    expect(() => validateRecipeDependencies("v1", elevenNodes)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "RECIPE_NESTING_LIMIT" }),
    );
    expect(() => validateRecipeDependencies("v2", elevenNodes.slice(1))).not.toThrow();
    expect(() =>
      validateRecipeDependencies("root", [
        { recipeVersionId: "root", nestedRecipeVersionIds: ["missing"] },
      ]),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_RECIPE" }));

    const sharedDag = [
      { recipeVersionId: "root", nestedRecipeVersionIds: ["shared", "a"] },
      { recipeVersionId: "a", nestedRecipeVersionIds: ["b"] },
      { recipeVersionId: "b", nestedRecipeVersionIds: ["c"] },
      { recipeVersionId: "c", nestedRecipeVersionIds: ["shared"] },
      { recipeVersionId: "shared", nestedRecipeVersionIds: ["leaf"] },
      { recipeVersionId: "leaf", nestedRecipeVersionIds: [] },
    ];
    expect(() => validateRecipeDependencies("root", sharedDag, 5)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "RECIPE_NESTING_LIMIT" }),
    );
    expect(() =>
      validateRecipeDependencies(
        "v0",
        Array.from({ length: 501 }, (_, index) => ({
          recipeVersionId: `v${index}`,
          nestedRecipeVersionIds: [],
        })),
      ),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_RECIPE" }));
  });
});
