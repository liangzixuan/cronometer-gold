import { Ajv, type AnySchema, type ErrorObject } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  createRecipeDiaryEntryRequestSchema,
  diaryEntrySchema,
  goalProgressRowSchema,
  nutritionGoalDraftRequestSchema,
  nutritionGoalRevisionRequestSchema,
  nutritionGoalSchema,
  recipeDraftRequestSchema,
  recipeSchema,
} from "./index.js";

const addFormats = addFormatsModule.default as unknown as (ajv: Ajv) => Ajv;

function validator(schema: AnySchema) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const source = {
  code: "USDA",
  displayName: "USDA",
  licenseExpression: "CC0-1.0",
  attributionRequired: false,
  attributionText: "USDA FoodData Central",
  releaseId: "10000000-0000-4000-8000-000000000001",
} as const;

const aggregate = {
  nutrientId: "1",
  code: "energy",
  name: "Energy",
  unit: "kcal",
  knownAmount: "100",
  completeness: "complete",
  isExact: true,
  contributorCount: 1,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 0,
  unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
} as const;

const warning = {
  code: "RETENTION_FACTORS_DEFAULTED",
  message: "No cooking-retention dataset was applied.",
  nutrientIds: ["1"],
} as const;

const recipeDraft = {
  name: "Porridge",
  description: null,
  instructions: null,
  ingredients: [
    {
      kind: "food",
      foodVersionId: "1",
      portion: { kind: "grams", grams: "80" },
    },
  ],
  finalYield: { grams: "400", source: "measured" },
  servingCount: "2",
  servingLabel: "bowl",
} as const;

const recipe = {
  id: "20000000-0000-4000-8000-000000000001",
  status: "active",
  revision: "1",
  currentVersion: {
    id: "20000000-0000-4000-8000-000000000002",
    versionNumber: 1,
    name: "Porridge",
    description: null,
    instructions: null,
    ingredients: [
      {
        kind: "food",
        position: 0,
        foodVersionId: "1",
        name: "Oats",
        brandName: null,
        portion: { kind: "grams", grams: "80" },
        resolvedGrams: "80",
        note: null,
        source,
        foodProvenance: { kind: "public", source },
      },
    ],
    finalYield: { grams: "400", source: "measured", ratioToInputMass: "5" },
    inputMassGrams: "80",
    servingCount: "2",
    servingLabel: "bowl",
    nutrition: { totals: [aggregate], per100Grams: [aggregate], perServing: [aggregate] },
    sources: [source],
    retentionPolicy: {
      code: "identity-retention-default",
      version: "1",
      assumption: "No cooking-retention dataset was applied.",
    },
    calculationVersion: "nutrition-engine-v1",
    warnings: [warning],
    createdAt: "2026-08-16T00:00:00.000Z",
  },
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
} as const;

describe("recipe transport schemas", () => {
  it("accepts a closed serving pair and rejects either half or an extra property", () => {
    const validate = validator(recipeDraftRequestSchema);
    expect(
      validate(recipeDraft),
      validate.errors?.map((error: ErrorObject) => error.message).join(", "),
    ).toBe(true);
    expect(validate({ ...recipeDraft, servingLabel: null })).toBe(false);
    expect(validate({ ...recipeDraft, servingCount: null })).toBe(false);
    expect(validate({ ...recipeDraft, unexpected: true })).toBe(false);
    expect(validate({ ...recipeDraft, servingCount: null, servingLabel: null })).toBe(true);
    expect(
      validate({
        ...recipeDraft,
        finalYield: { ...recipeDraft.finalYield, grams: "1000000000000" },
      }),
    ).toBe(false);
    expect(
      validate({ ...recipeDraft, finalYield: { ...recipeDraft.finalYield, grams: "1.1234567" } }),
    ).toBe(false);
  });

  it("enforces 50 ingredients and validates the complete explainable response", () => {
    const validateDraft = validator(recipeDraftRequestSchema);
    expect(
      validateDraft({
        ...recipeDraft,
        ingredients: Array.from({ length: 51 }, () => recipeDraft.ingredients[0]),
      }),
    ).toBe(false);
    const validateRecipe = validator(recipeSchema);
    expect(validateRecipe(recipe), JSON.stringify(validateRecipe.errors)).toBe(true);
    expect(
      validateRecipe({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          nutrition: { ...recipe.currentVersion.nutrition, totals: [] },
        },
      }),
    ).toBe(false);
    expect(
      validateRecipe({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          nutrition: { ...recipe.currentVersion.nutrition, perServing: [] },
        },
      }),
    ).toBe(false);
    const privateIngredient = {
      ...recipe.currentVersion.ingredients[0],
      source: null,
      foodProvenance: {
        kind: "private_custom",
        customFoodId: "25000000-0000-4000-8000-000000000001",
        customFoodVersionNumber: 2,
      },
    } as const;
    expect(
      validateRecipe({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          ingredients: [privateIngredient],
          sources: [],
        },
      }),
      JSON.stringify(validateRecipe.errors),
    ).toBe(true);
    expect(
      validateRecipe({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          ingredients: [{ ...privateIngredient, source }],
          sources: [],
        },
      }),
    ).toBe(false);
    const scaledAmount = `${"9".repeat(168)}`;
    expect(
      validateRecipe({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          nutrition: {
            totals: [aggregate],
            per100Grams: [{ ...aggregate, knownAmount: scaledAmount }],
            perServing: [{ ...aggregate, knownAmount: scaledAmount }],
          },
        },
      }),
      JSON.stringify(validateRecipe.errors),
    ).toBe(true);
    expect(
      validateRecipe({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          nutrition: {
            totals: [aggregate],
            per100Grams: [{ ...aggregate, knownAmount: "9".repeat(201) }],
            perServing: [{ ...aggregate, knownAmount: "9".repeat(201) }],
          },
        },
      }),
    ).toBe(false);
  });
});

describe("goal transport schemas", () => {
  it("permits an energy-only fixed goal and enforces the 256 target cap", () => {
    const validate = validator(nutritionGoalDraftRequestSchema);
    const request = {
      effectiveFrom: "2026-08-16",
      energy: { mode: "fixed", targetKcal: "2000", rationale: "User-entered target." },
      nutrientTargets: [],
    };
    expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...request, extra: true })).toBe(false);
    const validateRevision = validator(nutritionGoalRevisionRequestSchema);
    expect(validateRevision({ energy: request.energy, nutrientTargets: [] })).toBe(true);
    expect(validateRevision(request)).toBe(false);
    expect(
      validate({ ...request, energy: { ...request.energy, targetKcal: "1000000000000" } }),
    ).toBe(false);
    const target = {
      nutrientId: "1",
      minimumAmount: null,
      targetAmount: "100",
      maximumAmount: null,
      source: { label: "User supplied", version: null },
      rationale: null,
    };
    expect(
      validate({
        ...request,
        nutrientTargets: [{ ...target, targetAmount: "1000000000000000000" }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...request,
        nutrientTargets: [{ ...target, targetAmount: "999999999999999999.123456789012" }],
      }),
    ).toBe(true);
    expect(
      validate({
        ...request,
        nutrientTargets: [{ ...target, targetAmount: "1.1234567890123" }],
      }),
    ).toBe(false);
    expect(
      validate({ ...request, nutrientTargets: Array.from({ length: 257 }, () => target) }),
    ).toBe(false);
  });

  it("requires a fully sourced derived snapshot in the reviewed profile range", () => {
    const validate = validator(nutritionGoalSchema);
    const goal = {
      id: "30000000-0000-4000-8000-000000000001",
      status: "active",
      effectiveFrom: "2026-08-16",
      effectiveTo: null,
      revision: "1",
      currentVersion: {
        id: "30000000-0000-4000-8000-000000000002",
        versionNumber: 1,
        energy: {
          mode: "derived",
          targetKcal: "2700",
          bmrKcal: "1800",
          ageYears: 40,
          heightCm: "180",
          weightKg: "80",
          sexAtBirth: "male",
          profileRevision: "7",
          activityLevelCode: "sedentary_or_light",
          activityFactor: "1.5",
          adjustmentKcal: "0",
          source: {
            equation: {
              code: "mifflin-st-jeor-ree",
              version: "1990-original",
              url: "https://doi.org/10.1093/ajcn/51.2.241",
            },
            activityPolicy: {
              code: "fao-who-unu-pal-policy",
              version: "2004-reviewed-v1",
              sourceUrl: "https://www.fao.org/4/y5686e/y5686e07.htm",
            },
          },
          rationale: "Equation-based estimate selected by the user.",
        },
        nutrientTargets: [],
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      notice: "General wellness estimate; not medical advice.",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    };
    expect(validate(goal), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...goal,
        currentVersion: {
          ...goal.currentVersion,
          energy: { ...goal.currentVersion.energy, ageYears: 79 },
        },
      }),
    ).toBe(false);
    const { source: _source, ...unsourced } = goal.currentVersion.energy;
    expect(
      validate({ ...goal, currentVersion: { ...goal.currentVersion, energy: unsourced } }),
    ).toBe(false);
  });

  it("serializes uncertain progress as a lower bound rather than an exact percent", () => {
    const validate = validator(goalProgressRowSchema);
    const partial = {
      nutrientId: "2",
      code: "fiber",
      name: "Fiber",
      unit: "g",
      knownAmount: "20",
      amountInterpretation: "lower_bound",
      completeness: "partial",
      minimum: { amount: "15", state: "met" },
      target: { amount: "25", lowerBoundPercent: "80", percentIsExact: false },
      maximum: { amount: "40", state: "indeterminate" },
    };
    expect(validate(partial), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...partial,
        target: { ...partial.target, lowerBoundPercent: "9".repeat(174) },
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(
      validate({
        ...partial,
        target: { ...partial.target, lowerBoundPercent: "9".repeat(201) },
      }),
    ).toBe(false);
    expect(validate({ ...partial, amountInterpretation: "exact", extra: true })).toBe(false);
  });
});

describe("food and recipe diary entry union", () => {
  const common = {
    id: "40000000-0000-4000-8000-000000000001",
    revision: "1",
    mealSlot: "breakfast",
    resolvedGrams: "100",
    occurredAt: "2026-08-16T12:00:00.000Z",
    localDate: "2026-08-16",
    localTime: "07:00:00",
    timeZone: "America/Chicago",
    position: 0,
    nutrients: [aggregate],
  } as const;

  it("accepts both exact variants and the pinned recipe log request", () => {
    const validateEntry = validator(diaryEntrySchema);
    const food = {
      ...common,
      entryKind: "food",
      foodVersionId: "1",
      recipeVersionId: null,
      portion: { kind: "grams", grams: "100" },
      food: { name: "Oats", brandName: null },
      recipe: null,
      source,
      foodProvenance: { kind: "public", source },
    };
    expect(validateEntry(food), JSON.stringify(validateEntry.errors)).toBe(true);
    const recipeEntry = {
      ...common,
      entryKind: "recipe",
      foodVersionId: null,
      recipeVersionId: recipe.currentVersion.id,
      portion: { kind: "serving", amount: "1", servingLabel: "bowl" },
      food: null,
      recipe: {
        id: recipe.id,
        name: recipe.currentVersion.name,
        versionNumber: 1,
        yieldGrams: "400",
        yieldSource: "measured",
        servingCount: "2",
        servingLabel: "bowl",
        calculationVersion: "nutrition-engine-v1",
        retentionPolicy: recipe.currentVersion.retentionPolicy,
        warnings: [warning],
      },
      sources: [source],
      source: null,
    };
    expect(validateEntry(recipeEntry), JSON.stringify(validateEntry.errors)).toBe(true);
    expect(
      validateEntry({ ...recipeEntry, resolvedGrams: `33.${"3".repeat(150)}` }),
      JSON.stringify(validateEntry.errors),
    ).toBe(true);
    expect(validateEntry({ ...recipeEntry, resolvedGrams: "1000000000000000000" })).toBe(false);
    expect(validateEntry({ ...recipeEntry, source })).toBe(false);

    const validateLog = validator(createRecipeDiaryEntryRequestSchema);
    expect(
      validateLog({
        recipeVersionId: recipe.currentVersion.id,
        portion: { kind: "serving", amount: "1" },
        mealSlot: "breakfast",
        occurredAt: "2026-08-16T12:00:00.000Z",
      }),
      JSON.stringify(validateLog.errors),
    ).toBe(true);
    expect(
      validateLog({
        portion: { kind: "serving", amount: "1" },
        mealSlot: "breakfast",
        occurredAt: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe(false);
  });
});
