import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculateRecipeNutrition,
  createNutrientProfile,
  createResolvedNutrientProfile,
  type DomainError,
  knownNutrient,
  type NutrientDefinition,
  nutrientDatum,
  type RecipeCalculationInput,
  recipePer100GramProfile,
  traceNutrient,
  unknownNutrient,
  validateRecipeDependencies,
} from "../src/index.js";
import * as nutrientCalculations from "../src/nutrients.js";
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

describe("recipe repeated portion work", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calculates one shared portion for fifty separate repeated ingredient contributions", () => {
    const oats = PORRIDGE_GOLDEN_VECTOR.ingredients[0];
    if (!oats) throw new Error("Missing oats fixture");
    const portion = vi.spyOn(nutrientCalculations, "calculatePortionNutrition");
    const result = calculateRecipeNutrition({
      ingredients: Array.from({ length: 50 }, (_, index) => ({
        ...oats,
        id: String(index),
        grams: "1",
      })),
      nutrients: PORRIDGE_GOLDEN_VECTOR.nutrients,
      finalYield: { grams: "50", source: "estimated" },
      servingCount: null,
    });
    expect(result.inputMassGrams).toBe("50");
    expect(result.totals[0]).toMatchObject({
      nutrientId: "energy",
      knownAmount: "194.5",
      contributorCount: 50,
      quantifiedCount: 50,
    });
    expect(portion).toHaveBeenCalledTimes(1);
    expect(portion).toHaveBeenCalledWith(
      oats.nutrientProfile,
      "1",
      PORRIDGE_GOLDEN_VECTOR.nutrients,
    );
  });

  it("reuses canonical grams but keeps different grams and distinct profile identities separate", () => {
    const oats = PORRIDGE_GOLDEN_VECTOR.ingredients[0];
    if (!oats) throw new Error("Missing oats fixture");
    const distinct = createResolvedNutrientProfile(
      oats.nutrientProfile.basisGrams,
      oats.nutrientProfile.nutrients,
    );
    const portion = vi.spyOn(nutrientCalculations, "calculatePortionNutrition");
    const result = calculateRecipeNutrition({
      ingredients: [
        { ...oats, id: "first", grams: "1" },
        { ...oats, id: "same", grams: "1.000" },
        { ...oats, id: "different-grams", grams: "2" },
        { ...oats, id: "different-profile", grams: "1", nutrientProfile: distinct },
      ],
      nutrients: PORRIDGE_GOLDEN_VECTOR.nutrients,
      finalYield: { grams: "5", source: "measured" },
      servingCount: null,
    });
    expect(result.totals[0]).toMatchObject({ knownAmount: "19.45", contributorCount: 4 });
    expect(portion).toHaveBeenCalledTimes(3);
    expect(
      portion.mock.calls.map(([profile, grams]) => [profile === oats.nutrientProfile, grams]),
    ).toEqual([
      [true, "1"],
      [true, "2"],
      [false, "1"],
    ]);
  });
});

function repeatedCoverageFixture(): RecipeCalculationInput {
  const definitions: readonly NutrientDefinition[] = [
    { id: "unknown", name: "Unknown", canonicalUnit: "mg", category: "other" },
    { id: "energy", name: "Energy", canonicalUnit: "kcal", category: "energy" },
    { id: "trace", name: "Trace", canonicalUnit: "mg", category: "other" },
    { id: "zero", name: "Zero", canonicalUnit: "g", category: "other" },
    { id: "absent", name: "Absent", canonicalUnit: "mg", category: "other" },
  ];
  const profile = createNutrientProfile(
    "100",
    definitions
      .filter((definition) => definition.id !== "absent")
      .map((definition) =>
        nutrientDatum(
          definition,
          definition.id === "energy"
            ? knownNutrient("1.234567890123456789")
            : definition.id === "zero"
              ? knownNutrient("0")
              : definition.id === "trace"
                ? traceNutrient("0.000001")
                : unknownNutrient("withheld"),
        ),
      ),
  );
  const factors = (value: string) =>
    Object.fromEntries(definitions.map((definition) => [definition.id, value]));
  return {
    ingredients: [
      { id: "omitted", name: "Omitted", grams: "1", nutrientProfile: profile },
      {
        id: "identity",
        name: "Identity",
        grams: "1.000",
        nutrientProfile: profile,
        retentionFactors: factors("1.00"),
      },
      {
        id: "zero",
        name: "Zero",
        grams: "2",
        nutrientProfile: profile,
        retentionFactors: factors("0"),
      },
      {
        id: "half",
        name: "Half",
        grams: "1",
        nutrientProfile: profile,
        retentionFactors: { energy: "0.5" },
      },
    ],
    nutrients: definitions,
    finalYield: { grams: "7.5", source: "estimated" },
    servingCount: "3",
  };
}
function expectDeeplyFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

describe("recipe portion reuse semantics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves whole output, ordered mixed coverage, per-occurrence retention, and unchanged inputs", () => {
    const shared = repeatedCoverageFixture();
    const separate = {
      ...shared,
      ingredients: shared.ingredients.map((ingredient) => ({
        ...ingredient,
        nutrientProfile: createResolvedNutrientProfile(
          ingredient.nutrientProfile.basisGrams,
          ingredient.nutrientProfile.nutrients,
        ),
      })),
    };
    const beforeShared = JSON.stringify(shared),
      beforeSeparate = JSON.stringify(separate);
    const result = calculateRecipeNutrition(shared);
    expect(result).toEqual(calculateRecipeNutrition(separate));
    expect(JSON.stringify(shared)).toBe(beforeShared);
    expect(JSON.stringify(separate)).toBe(beforeSeparate);
    expect(Object.isFrozen(shared.ingredients)).toBe(false);
    expectDeeplyFrozen(result);
    for (const ingredient of shared.ingredients) expectDeeplyFrozen(ingredient.nutrientProfile);
    expect(result.inputMassGrams).toBe("5");
    expect(result.finalYield).toEqual({
      grams: "7.5",
      source: "estimated",
      ratioToInputMass: "1.5",
    });
    expect(result.servingCount).toBe("3");
    expect(result.totals.map((row) => row.nutrientId)).toEqual(
      shared.nutrients.map((definition) => definition.id),
    );
    expect(result.per100Grams.map((row) => row.nutrientId)).toEqual(
      shared.nutrients.map((definition) => definition.id),
    );
    expect(result.perServing?.map((row) => row.nutrientId)).toEqual(
      shared.nutrients.map((definition) => definition.id),
    );
    expect(result.totals).toMatchObject([
      {
        nutrientId: "unknown",
        knownAmount: "0",
        completeness: "unknown",
        contributorCount: 4,
        unknownCount: 4,
        unknownReasons: { withheld: 4 },
      },
      {
        nutrientId: "energy",
        knownAmount: "0.030864197253086419725",
        isExact: true,
        contributorCount: 4,
        quantifiedCount: 4,
      },
      {
        nutrientId: "trace",
        knownAmount: "0",
        completeness: "complete",
        isExact: false,
        contributorCount: 4,
        traceCount: 4,
      },
      {
        nutrientId: "zero",
        knownAmount: "0",
        completeness: "complete",
        isExact: true,
        contributorCount: 4,
        quantifiedCount: 4,
      },
      {
        nutrientId: "absent",
        knownAmount: "0",
        completeness: "unknown",
        contributorCount: 4,
        unknownCount: 4,
        unknownReasons: { not_reported: 4 },
      },
    ]);
    expect(result.warnings.map((warning) => [warning.code, warning.nutrientIds])).toEqual([
      ["RETENTION_FACTORS_DEFAULTED", ["unknown", "energy", "trace", "zero", "absent"]],
      ["ESTIMATED_YIELD", []],
      ["YIELD_ABOVE_INPUT_MASS", []],
      ["PARTIAL_NUTRIENT_DATA", ["unknown", "trace", "absent"]],
    ]);
  });

  it("keeps explicit identity factors distinct from omissions only in default-factor warning provenance", () => {
    const fixture = repeatedCoverageFixture();
    const omitted = {
      ...fixture,
      ingredients: fixture.ingredients.map(
        ({ retentionFactors: _factors, ...ingredient }) => ingredient,
      ),
    };
    const identity = {
      ...omitted,
      ingredients: omitted.ingredients.map((ingredient) => ({
        ...ingredient,
        retentionFactors: Object.fromEntries(
          fixture.nutrients.map((definition) => [definition.id, "1.000"]),
        ),
      })),
    };
    const defaulted = calculateRecipeNutrition(omitted),
      explicit = calculateRecipeNutrition(identity);
    expect(explicit).toEqual({
      ...defaulted,
      warnings: defaulted.warnings.filter(
        (warning) => warning.code !== "RETENTION_FACTORS_DEFAULTED",
      ),
    });
    expect(
      defaulted.warnings.some((warning) => warning.code === "RETENTION_FACTORS_DEFAULTED"),
    ).toBe(true);
  });

  it.each([
    {
      label: "unknown retention key",
      patch: { retentionFactors: { typo: "1" } },
      code: "INVALID_RECIPE",
    },
    {
      label: "retention above one",
      patch: { retentionFactors: { energy: "1.0001" } },
      code: "INVALID_RECIPE",
    },
    {
      label: "negative retention",
      patch: { retentionFactors: { energy: "-0.1" } },
      code: "INVALID_DECIMAL",
    },
    {
      label: "nonfinite retention",
      patch: { retentionFactors: { energy: "NaN" } },
      code: "INVALID_DECIMAL",
    },
    { label: "duplicate ID", patch: { id: "first" }, code: "INVALID_RECIPE" },
    { label: "blank ID", patch: { id: " " }, code: "INVALID_RECIPE" },
    { label: "blank name", patch: { name: " " }, code: "INVALID_RECIPE" },
    { label: "zero grams", patch: { grams: "0" }, code: "INVALID_DECIMAL" },
    { label: "invalid grams", patch: { grams: "invalid" }, code: "INVALID_DECIMAL" },
  ] as const)("rejects $label on a later occurrence of the same profile", ({ patch, code }) => {
    const oats = PORRIDGE_GOLDEN_VECTOR.ingredients[0];
    if (!oats) throw new Error("Missing oats fixture");
    const input = {
      ingredients: [
        { ...oats, id: "first", grams: "1" },
        { ...oats, id: "second", grams: "1.0", ...patch },
      ],
      nutrients: PORRIDGE_GOLDEN_VECTOR.nutrients,
      finalYield: { grams: "2", source: "measured" as const },
    };
    const before = JSON.stringify(input);
    expect(() => calculateRecipeNutrition(input)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code }),
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it("preserves the existing 40-digit addition order across repeated identity-scaled contributions", () => {
    const energy = PORRIDGE_GOLDEN_VECTOR.nutrients[0];
    if (!energy) throw new Error("Missing energy fixture");
    const largeAmount = `1${"0".repeat(39)}`;
    const small = createNutrientProfile("1", [nutrientDatum(energy, knownNutrient("0.4"))]);
    const large = createNutrientProfile("1", [nutrientDatum(energy, knownNutrient(largeAmount))]);
    const result = calculateRecipeNutrition({
      ingredients: [
        { id: "small-first", name: "Small first", grams: "1", nutrientProfile: small },
        {
          id: "large",
          name: "Large",
          grams: "1",
          nutrientProfile: large,
          retentionFactors: { energy: "1" },
        },
        { id: "small-last", name: "Small last", grams: "1.00", nutrientProfile: small },
      ],
      nutrients: [energy],
      finalYield: { grams: "3", source: "measured" },
    });
    // Regrouping the two 0.4 contributions would round the final unit upward.
    expect(result.totals[0]).toMatchObject({
      knownAmount: largeAmount,
      contributorCount: 3,
      quantifiedCount: 3,
    });
    expectDeeplyFrozen(result);
  });

  it("ends reuse with each call and observes changed profile data and expected nutrient order", () => {
    const oats = PORRIDGE_GOLDEN_VECTOR.ingredients[0];
    if (!oats) throw new Error("Missing oats fixture");
    const profile = {
      basisGrams: oats.nutrientProfile.basisGrams,
      nutrients: oats.nutrientProfile.nutrients.map((row) => ({ ...row })),
    };
    const input = {
      ingredients: [
        { ...oats, id: "first", grams: "1", nutrientProfile: profile },
        { ...oats, id: "second", grams: "1.0", nutrientProfile: profile },
      ],
      nutrients: PORRIDGE_GOLDEN_VECTOR.nutrients,
      finalYield: { grams: "2", source: "measured" as const },
    };
    const portion = vi.spyOn(nutrientCalculations, "calculatePortionNutrition");
    const first = calculateRecipeNutrition(input);
    expect(first.totals[0]?.knownAmount).toBe("7.78");
    expect(portion).toHaveBeenCalledTimes(1);
    const energy = profile.nutrients.find((row) => row.nutrientId === "energy");
    if (!energy) throw new Error("Missing energy fixture");
    energy.knownAmount = "500";
    const second = calculateRecipeNutrition(input);
    expect(second.totals[0]?.knownAmount).toBe("10");
    expect(first.totals[0]?.knownAmount).toBe("7.78");
    expect(portion).toHaveBeenCalledTimes(2);
    const reversed = calculateRecipeNutrition({
      ...input,
      nutrients: [...input.nutrients].reverse(),
    });
    expect(reversed.totals).toEqual([...second.totals].reverse());
    expect(portion).toHaveBeenCalledTimes(3);
  });
});
