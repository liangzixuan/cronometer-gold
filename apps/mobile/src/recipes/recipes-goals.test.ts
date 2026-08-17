import { describe, expect, it } from "vitest";

import type { GoalView } from "./recipes-goals";
import {
  authoritativeRecipeDate,
  goalSelectionIsHistorical,
  goalWriteBody,
  isGoalDecimal,
  isRecipePositiveDecimal,
  isSignedGoalDecimal,
  mergeRecipePage,
  nutrientProgressPresentation,
  parseGoalProgress,
  prepareRecipeLogOperation,
  prepareStableMutation,
  recipeDraftIngredients,
  recipeIngredientAccessibilityLabel,
  recipeLogInstant,
  recipeLogKindFor,
  recipeSourceLines,
  type StableMutation,
} from "./recipes-goals";

describe("mobile recipe mutation safety", () => {
  it("preserves exact request identity and bytes across retries", () => {
    const pending = new Map<string, StableMutation<{ readonly name: string }>>();
    const first = prepareStableMutation(
      pending,
      "create:porridge",
      () => ({ name: "Porridge" }),
      () => "00000000-0000-4000-8000-000000000001",
    );
    pending.set(first.intentKey, first);
    const retry = prepareStableMutation(
      pending,
      "create:porridge",
      () => ({ name: "Changed" }),
      () => "00000000-0000-4000-8000-000000000002",
    );
    expect(retry).toBe(first);
    expect(retry.body).toEqual({ name: "Porridge" });
  });

  it("aligns request decimal caps with the API contract", () => {
    expect(isRecipePositiveDecimal("999999999999.999999")).toBe(true);
    expect(isRecipePositiveDecimal("1000000000000")).toBe(false);
    expect(isGoalDecimal(`${"9".repeat(18)}.${"8".repeat(12)}`)).toBe(true);
    expect(isGoalDecimal(`${"9".repeat(19)}.${"8".repeat(12)}`)).toBe(false);
    expect(isSignedGoalDecimal("-999999999999.999999")).toBe(true);
    expect(isSignedGoalDecimal("-1000000000000")).toBe(false);
  });

  it("appends cursor pages without duplicates and resets stale results", () => {
    const first = { id: "first", name: "First" } as never;
    const updated = { id: "first", name: "Updated" } as never;
    const second = { id: "second", name: "Second" } as never;
    expect(mergeRecipePage([first], [updated, second], true)).toEqual([updated, second]);
    expect(mergeRecipePage([first, second], [updated], false)).toEqual([updated]);
  });

  it("omits the immutable effective interval from goal revisions", () => {
    const energy = { mode: "fixed", targetKcal: "2000", rationale: "User selected" } as const;
    expect(goalWriteBody(null, "2026-08-16", energy, [])).toHaveProperty(
      "effectiveFrom",
      "2026-08-16",
    );
    expect(goalWriteBody("existing", "2026-08-16", energy, [])).not.toHaveProperty("effectiveFrom");
  });

  it("forces gram logging after a no-serving recipe mutation", () => {
    expect(recipeLogKindFor({ servingCount: null })).toBe("grams");
    expect(recipeLogKindFor({ servingCount: "4" })).toBe("serving");
  });

  it("round-trips a multi-serving ingredient note without inventing per-serving grams", () => {
    const source = {
      code: "USDA_FDC",
      releaseId: "eb8a4152-001f-4722-8bf1-8728ef8c14f8",
      displayName: "USDA",
      licenseExpression: "CC0-1.0",
      attributionRequired: true,
      attributionText: "USDA data",
    };
    const ingredients = recipeDraftIngredients({
      ingredients: [
        {
          position: 0,
          kind: "food",
          foodVersionId: "12",
          recipeId: null,
          recipeVersionId: null,
          name: "Oats",
          brandName: null,
          portion: { kind: "serving", servingId: "9", amount: "2", servingLabel: "scoop" },
          quantityText: "2",
          resolvedGrams: "80",
          source,
          foodProvenance: { kind: "public", source },
          note: "toasted",
          coverage: "complete",
        },
      ],
    });
    expect(ingredients[0]).toEqual(
      expect.objectContaining({
        note: "toasted",
        portion: { kind: "serving", servingId: "9", amount: "2", servingLabel: "scoop" },
      }),
    );
    expect(ingredients[0]).not.toHaveProperty("resolvedGramsPerServing");
  });

  it("retains the exact second-fold instant and rejects a spring DST gap", () => {
    const operation = prepareRecipeLogOperation(
      new Map(),
      {
        recipeId: "ce126b7f-dfe5-4ee4-a75c-6b0f50c1963e",
        recipeVersionId: "db2ed69e-29d1-4330-a210-0a804f9ff2b3",
        portion: { kind: "serving", amount: "1" },
        mealSlot: "breakfast",
        localDate: "2026-11-01",
        timeZone: "America/Chicago",
      },
      new Date("2026-11-01T07:30:00.000Z"),
      () => "00000000-0000-4000-8000-000000000001",
    );
    expect(operation.body.occurredAt).toBe("2026-11-01T07:30:00.000Z");
    expect(operation.body.recipeVersionId).toBe("db2ed69e-29d1-4330-a210-0a804f9ff2b3");
    expect(() => recipeLogInstant("2026-03-08", "02:30", "America/Chicago")).toThrow(
      "does not exist",
    );
  });

  it("replaces a stale bootstrap zone with the freshly authoritative profile zone", () => {
    const now = new Date("2026-08-16T04:30:00.000Z");
    expect(authoritativeRecipeDate(now, "America/Chicago")).toBe("2026-08-15");
    expect(authoritativeRecipeDate(now, "America/New_York")).toBe("2026-08-16");
  });
});

describe("mobile recipe and goal semantics", () => {
  it("keeps closed goal history read-only while a new root draft is editable", () => {
    const closedGoal = {
      id: "b71ae11b-750e-4124-940f-a4a7ef42f246",
      status: "active",
      revision: "2",
      versionId: "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507",
      versionNumber: 2,
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-09-01",
      energy: { mode: "fixed", targetKcal: "2000", rationale: "User selected." },
      targets: [],
      notice: "General wellness estimate; not medical advice.",
    } satisfies GoalView;
    expect(goalSelectionIsHistorical(closedGoal, closedGoal.id)).toBe(true);
    expect(goalSelectionIsHistorical(closedGoal, null)).toBe(false);
  });

  it("labels incomplete totals as lower bounds", () => {
    expect(
      nutrientProgressPresentation({
        name: "Iron",
        unit: "mg",
        knownAmount: "4.2",
        completeness: "partial",
        amountInterpretation: "lower_bound",
        minimumAmount: null,
        targetAmount: "8",
        maximumAmount: "45",
        lowerBoundPercent: "52.5",
        percentIsExact: false,
      }),
    ).toMatchObject({
      valueText: "at least 4.2 mg",
      progressPercent: 52.5,
    });
  });

  it("does not label an all-unknown zero as measured zero", () => {
    const progress = nutrientProgressPresentation({
      name: "Vitamin D",
      unit: "ug",
      knownAmount: "0",
      completeness: "unknown",
      amountInterpretation: "lower_bound",
      minimumAmount: null,
      targetAmount: "15",
      maximumAmount: null,
      lowerBoundPercent: "0",
      percentIsExact: false,
    });
    expect(progress.valueText).toBe("at least 0 ug");
    expect(progress.accessibilityLabel).toContain("zero is not a measured zero");
  });

  it("does not call trace-only source coverage quantified", () => {
    const progress = nutrientProgressPresentation({
      name: "Vitamin B12",
      unit: "ug",
      knownAmount: "0",
      completeness: "complete",
      amountInterpretation: "lower_bound",
      minimumAmount: null,
      targetAmount: "2.4",
      maximumAmount: null,
      lowerBoundPercent: "0",
      percentIsExact: false,
    });
    expect(progress.coverageText).toBe(
      "Complete source coverage — trace or unquantified contributions make this a lower bound",
    );
    expect(progress.coverageText).not.toContain("quantified coverage");
  });

  it("accepts 160-character aggregate precision and clamps only its display percentage", () => {
    const knownAmount = `${"9".repeat(80)}.${"7".repeat(40)}`;
    const progress = nutrientProgressPresentation({
      name: "Energy",
      unit: "kcal",
      knownAmount,
      completeness: "complete",
      amountInterpretation: "exact",
      minimumAmount: null,
      targetAmount: "2000",
      maximumAmount: null,
      lowerBoundPercent: "999999999999999999999999",
      percentIsExact: true,
    });
    expect(progress.valueText).toBe(`${knownAmount} kcal`);
    expect(progress.progressPercent).toBe(100);
  });

  it("accepts a server-computed percentage beyond the 160-character amount budget", () => {
    const lowerBoundPercent = "9".repeat(174);
    const progress = nutrientProgressPresentation({
      name: "Iron",
      unit: "mg",
      knownAmount: "1",
      completeness: "partial",
      amountInterpretation: "lower_bound",
      minimumAmount: null,
      targetAmount: "0.000000000001",
      maximumAmount: null,
      lowerBoundPercent,
      percentIsExact: false,
    });
    expect(progress.progressPercent).toBe(100);
    expect(
      parseGoalProgress({
        data: {
          localDate: "2026-08-16",
          timeZone: "America/Chicago",
          diaryRevision: "1",
          goal: null,
          energy: null,
          nutrients: [
            {
              nutrientId: "1",
              code: "iron",
              name: "Iron",
              unit: "mg",
              knownAmount: "1",
              amountInterpretation: "lower_bound",
              completeness: "partial",
              minimum: null,
              target: { amount: "0.000000000001", lowerBoundPercent, percentIsExact: false },
              maximum: null,
            },
          ],
          notice: "General wellness estimate; not medical advice.",
        },
      }).nutrients[0]?.target?.lowerBoundPercent,
    ).toBe(lowerBoundPercent);
  });

  it("fails closed on contradictory server coverage", () => {
    expect(() =>
      nutrientProgressPresentation({
        name: "Iron",
        unit: "mg",
        knownAmount: "0",
        completeness: "unknown",
        amountInterpretation: "exact",
        minimumAmount: null,
        targetAmount: "8",
        maximumAmount: null,
        lowerBoundPercent: "0",
        percentIsExact: true,
      }),
    ).toThrow("contradictory");
  });

  it("announces ingredient provenance and coverage", () => {
    expect(
      recipeIngredientAccessibilityLabel({
        name: "Rolled oats",
        amountText: "40 grams",
        sourceText: "USDA FoodData Central, CC0-1.0",
        coverage: "partial",
      }),
    ).toContain("Source: USDA FoodData Central, CC0-1.0. partial coverage");
  });

  it("renders flattened nested provenance once per source release", () => {
    const source = {
      code: "USDA_FDC",
      releaseId: "6ca1dfb1-1d4c-4e54-8f8b-ab132446943e",
      displayName: "USDA FoodData Central",
      licenseExpression: "CC0-1.0",
      attributionRequired: true,
      attributionText: "Data source: USDA FoodData Central",
    } as const;
    expect(recipeSourceLines({ sources: [source, source] })).toEqual([
      "Data source: USDA FoodData Central · CC0-1.0",
    ]);
  });
});
