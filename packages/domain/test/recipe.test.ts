import { describe, expect, it } from "vitest";

import {
  calculateRecipeNutrition,
  type DomainError,
  recipePer100GramProfile,
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
    expect(result.warnings.map((warning) => warning.code)).toEqual(["PARTIAL_NUTRIENT_DATA"]);
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
});
