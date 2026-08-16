import type {
  DiaryNutrientAggregateRecord,
  DiaryRecipeEntryRecord,
  NutritionGoalProgressRecord,
  NutritionGoalRecord,
  RecipeRecord,
} from "@nutrition-tracker/db";
import { RecipeCursorError } from "@nutrition-tracker/db";
import { canonicalNonNegativeDecimal, decimal } from "@nutrition-tracker/domain";
import { describe, expect, it } from "vitest";
import { normalizeProfilePatch } from "../src/modules/profile/profile-validation.js";
import { RecipeCursorServiceError } from "../src/modules/recipes/recipe.routes.js";
import {
  mapDiaryEntryRecord,
  mapDiaryNutrientAggregate,
  mapNutritionGoalProgressRecord,
  mapNutritionGoalRecord,
  mapRecipePersistenceError,
  mapRecipeRecord,
} from "../src/persistence-services.js";

function persistedAggregate(
  overrides: Partial<DiaryNutrientAggregateRecord> = {},
): DiaryNutrientAggregateRecord {
  return {
    code: "protein_g",
    completeness: "partial",
    contributorCount: 7,
    isExact: false,
    knownAmount: "12.250000000000",
    name: "Protein",
    nutrientId: "1003",
    quantifiedCount: 2,
    traceCount: 1,
    unit: "g",
    unknownCount: 4,
    unknownReasons: { not_reported: 3, withheld: 1 },
    ...overrides,
  };
}

const recipeSource = {
  foodSourceId: "1",
  releaseId: "10000000-0000-4000-8000-000000000001",
  code: "USDA",
  displayName: "USDA",
  licenseExpression: "CC0-1.0",
  attributionRequired: false,
  attributionText: "USDA FoodData Central",
} as const;

const retentionAssumptions = {
  retentionPolicy: {
    code: "identity-retention-default",
    version: "1",
    assumption: "No cooking-retention dataset was applied; omitted factors remain exactly one.",
  },
} as const;

function persistedRecipe(overrides: Partial<RecipeRecord["currentVersion"]> = {}): RecipeRecord {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    status: "active",
    currentRevision: "1",
    currentVersion: {
      id: "20000000-0000-4000-8000-000000000002",
      versionNumber: "1",
      name: "Porridge",
      description: null,
      instructions: null,
      inputMassGrams: "100",
      yield: { grams: "80", source: "measured", ratioToInputMass: "0.8" },
      servingCount: "2",
      servingLabel: "bowl",
      calculationVersion: "nutrition-engine-v1",
      retentionPolicy: { code: "identity-retention-default", version: "1" },
      calculationAssumptions: retentionAssumptions,
      warnings: [
        {
          code: "RETENTION_FACTORS_DEFAULTED",
          message: retentionAssumptions.retentionPolicy.assumption,
          nutrientIds: ["1003"],
        },
      ],
      ingredients: [
        {
          kind: "food",
          position: 0,
          note: null,
          food: { foodVersionId: "101", name: "Oats", brandName: null },
          portion: {
            amount: "100",
            inputUnit: "g",
            servingId: null,
            servingLabel: null,
            resolvedGrams: "100",
          },
          source: recipeSource,
        },
      ],
      nutrients: [
        persistedAggregate({
          completeness: "complete",
          isExact: true,
          unknownCount: 0,
          unknownReasons: {},
          contributorCount: 1,
          quantifiedCount: 1,
          traceCount: 0,
        }),
      ],
      sources: [recipeSource],
      createdAt: "2026-08-16T00:00:00.000Z",
      ...overrides,
    },
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

function persistedGoal(
  energy: NutritionGoalRecord["currentVersion"]["energy"] = {
    mode: "derived",
    targetKcal: "2595",
    bmrKcal: "1730",
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
    rationale: "User selected an adult estimate.",
  },
): NutritionGoalRecord {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    status: "active",
    currentRevision: "1",
    effectiveFrom: "2026-08-16",
    effectiveTo: null,
    currentVersion: {
      id: "30000000-0000-4000-8000-000000000002",
      versionNumber: "1",
      status: "active",
      effectiveFrom: "2026-08-16",
      effectiveTo: null,
      energy,
      targets: [
        {
          nutrient: {
            id: "1079",
            code: "fiber",
            name: "Fiber",
            unit: "g",
            category: "other",
          },
          minimumAmount: "15",
          targetAmount: "25",
          maximumAmount: "40",
          source: { label: "User supplied", version: null },
          rationale: null,
        },
      ],
      calculationVersion: "nutrition-engine-v1",
      createdAt: "2026-08-16T00:00:00.000Z",
    },
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

describe("PostgreSQL API adapters", () => {
  it("preserves every unknown-reason count and fills absent closed reasons with zero", () => {
    expect(mapDiaryNutrientAggregate(persistedAggregate())).toMatchObject({
      contributorCount: 7,
      quantifiedCount: 2,
      traceCount: 1,
      unknownCount: 4,
      unknownReasonCounts: {
        not_reported: 3,
        not_analyzed: 0,
        not_applicable: 0,
        withheld: 1,
      },
    });
  });

  it("normalizes DB-aligned profile values and rejects future dates", () => {
    expect(
      normalizeProfilePatch(
        { baselineWeightKg: "65.500", birthDate: "1990-02-03", heightCm: "170.000" },
        new Date("2026-08-15T00:00:00.000Z"),
      ),
    ).toEqual({ baselineWeightKg: "65.5", birthDate: "1990-02-03", heightCm: "170" });
    expect(() =>
      normalizeProfilePatch({ birthDate: "2026-08-16" }, new Date("2026-08-15T00:00:00.000Z")),
    ).toThrow(RangeError);
    expect(() => normalizeProfilePatch({ birthDate: "0000-01-01" })).toThrow(RangeError);
  });

  it("fails closed on unrecognized or non-integral persisted reason values", () => {
    expect(() =>
      mapDiaryNutrientAggregate(
        persistedAggregate({ unknownReasons: { suppressed_for_private_reason: 4 } }),
      ),
    ).toThrow("Unknown nutrient reason");
    expect(() =>
      mapDiaryNutrientAggregate(persistedAggregate({ unknownReasons: { not_reported: 1.5 } })),
    ).toThrow("Invalid nutrient unknown reason count");
  });

  it("preserves persisted recipe mass/yield evidence and rejects drift from ingredient snapshots", () => {
    expect(mapRecipeRecord(persistedRecipe()).currentVersion).toMatchObject({
      inputMassGrams: "100",
      finalYield: { grams: "80", ratioToInputMass: "0.8" },
    });
    expect(() => mapRecipeRecord(persistedRecipe({ inputMassGrams: "99" }))).toThrow(
      "input mass does not match",
    );
    expect(() =>
      mapRecipeRecord(
        persistedRecipe({ yield: { grams: "80", source: "measured", ratioToInputMass: "0.81" } }),
      ),
    ).toThrow("yield ratio does not match");
  });

  it("preserves exact derived recipe amounts beyond the persisted 160-character bound", () => {
    const knownAmount = "9".repeat(160);
    const mapped = mapRecipeRecord(
      persistedRecipe({
        yield: {
          grams: "0.000001",
          source: "measured",
          ratioToInputMass: "0.00000001",
        },
        servingCount: "0.000001",
        nutrients: [
          persistedAggregate({
            knownAmount,
            completeness: "complete",
            isExact: true,
            unknownCount: 0,
            unknownReasons: {},
            contributorCount: 1,
            quantifiedCount: 1,
            traceCount: 0,
          }),
        ],
      }),
    );
    const per100Amount = mapped.currentVersion.nutrition.per100Grams[0]?.knownAmount;
    const perServingAmount = mapped.currentVersion.nutrition.perServing?.[0]?.knownAmount;
    expect(per100Amount?.length).toBeGreaterThan(160);
    expect(per100Amount?.length).toBeLessThanOrEqual(200);
    expect(perServingAmount?.length).toBeGreaterThan(160);
    expect(perServingAmount?.length).toBeLessThanOrEqual(200);
  });

  it("maps a recipe diary snapshot without inventing singular food provenance", () => {
    const record: DiaryRecipeEntryRecord = {
      id: "40000000-0000-4000-8000-000000000001",
      currentRevision: "1",
      operation: "create",
      kind: "recipe",
      occurredAt: "2026-08-16T12:00:00.000Z",
      localDate: "2026-08-16",
      localTime: "07:00:00",
      timeZone: "America/Chicago",
      mealSlot: "breakfast",
      position: 0,
      note: null,
      recipe: {
        recipeId: "20000000-0000-4000-8000-000000000001",
        recipeVersionId: "20000000-0000-4000-8000-000000000002",
        versionNumber: 1,
        name: "Porridge",
        yieldGrams: "80",
        yieldSource: "measured",
        servingCount: "2",
        servingLabel: "bowl",
        calculationVersion: "nutrition-engine-v1",
        retentionPolicy: { code: "identity-retention-default", version: "1" },
        calculationAssumptions: retentionAssumptions,
        warnings: [
          {
            code: "RETENTION_FACTORS_DEFAULTED",
            message: retentionAssumptions.retentionPolicy.assumption,
            nutrientIds: ["1003"],
          },
        ],
        sources: [recipeSource],
      },
      portion: { amount: "1", inputUnit: "serving", resolvedGrams: "40" },
      snapshotStatus: "complete",
      snapshotEngineVersion: "nutrition-engine-v1",
      nutrients: [persistedAggregate()],
      createdAt: "2026-08-16T12:00:00.000Z",
    };
    expect(mapDiaryEntryRecord(record)).toMatchObject({
      entryKind: "recipe",
      food: null,
      foodVersionId: null,
      recipeVersionId: record.recipe.recipeVersionId,
      source: null,
      sources: [{ code: "USDA", releaseId: recipeSource.releaseId }],
      recipe: {
        id: record.recipe.recipeId,
        versionNumber: 1,
        retentionPolicy: retentionAssumptions.retentionPolicy,
      },
    });
  });

  it("verifies and exposes a fully sourced derived goal snapshot", () => {
    expect(mapNutritionGoalRecord(persistedGoal())).toMatchObject({
      revision: "1",
      notice: "General wellness estimate; not medical advice.",
      currentVersion: {
        energy: {
          mode: "derived",
          bmrKcal: "1730",
          targetKcal: "2595",
          profileRevision: "7",
          source: {
            equation: { code: "mifflin-st-jeor-ree", version: "1990-original" },
            activityPolicy: {
              code: "fao-who-unu-pal-policy",
              version: "2004-reviewed-v1",
            },
          },
        },
      },
    });
    const invalid = persistedGoal();
    const invalidEnergy = invalid.currentVersion.energy;
    if (invalidEnergy.mode !== "derived") throw new Error("Expected the derived goal fixture");
    expect(() =>
      mapNutritionGoalRecord({
        ...invalid,
        currentVersion: {
          ...invalid.currentVersion,
          energy: { ...invalidEnergy, bmrKcal: "1729" },
        },
      }),
    ).toThrow("calculation snapshot is inconsistent");
  });

  it("maps pinned goal progress and verifies exact lower-bound percentages", () => {
    const goal = persistedGoal({
      mode: "fixed",
      targetKcal: "100",
      source: { code: "user-fixed", version: "1" },
      rationale: "User entered a fixed target.",
    });
    const record: NutritionGoalProgressRecord = {
      localDate: "2026-08-16",
      timeZone: "America/Chicago",
      goal,
      goalVersionId: goal.currentVersion.id,
      diaryDayId: null,
      diaryRevision: "0",
      energy: {
        nutrientId: "1008",
        code: "energy",
        name: "Energy",
        unit: "kcal",
        targetKcal: "100",
        knownAmount: "50",
        amountInterpretation: "exact",
        completeness: "complete",
        lowerBoundPercent: "50",
        percentIsExact: true,
      },
      targets: [
        {
          nutrientId: "1079",
          code: "fiber",
          name: "Fiber",
          unit: "g",
          knownAmount: "20",
          amountInterpretation: "lower_bound",
          completeness: "partial",
          minimum: { amount: "15", state: "met" },
          target: { amount: "25", lowerBoundPercent: "80", percentIsExact: false },
          maximum: { amount: "40", state: "indeterminate" },
        },
      ],
    };
    expect(mapNutritionGoalProgressRecord(record).data).toMatchObject({
      diaryRevision: "0",
      energy: { target: { amount: "100", lowerBoundPercent: "50" } },
      nutrients: [{ amountInterpretation: "lower_bound", target: { percentIsExact: false } }],
    });
    expect(() =>
      mapNutritionGoalProgressRecord({
        ...record,
        energy: { ...record.energy, lowerBoundPercent: "49.99" },
      }),
    ).toThrow("Goal progress percentage is inconsistent");

    const extremeKnownAmount = "9".repeat(160);
    const extremeTarget = "0.000001";
    const extremePercentage = canonicalNonNegativeDecimal(
      decimal(extremeKnownAmount).mul(100).div(extremeTarget),
    );
    const extremeGoal = persistedGoal({
      mode: "fixed",
      targetKcal: extremeTarget,
      source: { code: "user-fixed", version: "1" },
      rationale: "User entered a fixed target.",
    });
    const mappedExtreme = mapNutritionGoalProgressRecord({
      ...record,
      goal: extremeGoal,
      goalVersionId: extremeGoal.currentVersion.id,
      energy: {
        ...record.energy,
        targetKcal: extremeTarget,
        knownAmount: extremeKnownAmount,
        lowerBoundPercent: extremePercentage,
      },
    });
    expect(mappedExtreme.data.energy?.target?.lowerBoundPercent?.length).toBeGreaterThan(160);
    expect(mappedExtreme.data.energy?.target?.lowerBoundPercent?.length).toBeLessThanOrEqual(200);
  });

  it("translates the production DB cursor subtype before generic recipe validation", () => {
    expect(() => mapRecipePersistenceError(new RecipeCursorError())).toThrow(
      RecipeCursorServiceError,
    );
  });
});
