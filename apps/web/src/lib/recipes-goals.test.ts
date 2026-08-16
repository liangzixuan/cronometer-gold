import { describe, expect, it } from "vitest";

import {
  goalWriteBody,
  isGoalDecimal,
  isRecipePositiveDecimal,
  isSignedGoalDecimal,
  mergeRecipePage,
  nutrientProgressPresentation,
  parseGoalProgress,
  prepareRecipeLogOperation,
  prepareStableMutation,
  recipeIngredientAccessibilityLabel,
  recipeLogInstant,
  recipeLogKindFor,
  recipeSourceLines,
  type StableMutation,
} from "./recipes-goals";

describe("recipe mutation safety", () => {
  it("preserves the exact id and body after an ambiguous response", () => {
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
      () => ({ name: "Changed by time" }),
      () => "00000000-0000-4000-8000-000000000002",
    );
    expect(retry).toBe(first);
    expect(retry.body).toEqual({ name: "Porridge" });
  });

  it("aligns request decimal caps with the API contract", () => {
    expect(isRecipePositiveDecimal("999999999999.999999")).toBe(true);
    expect(isRecipePositiveDecimal("1000000000000")).toBe(false);
    expect(isRecipePositiveDecimal("1.0000001")).toBe(false);
    expect(isGoalDecimal(`${"9".repeat(18)}.${"8".repeat(12)}`)).toBe(true);
    expect(isGoalDecimal(`${"9".repeat(19)}.${"8".repeat(12)}`)).toBe(false);
    expect(isSignedGoalDecimal("-999999999999.999999")).toBe(true);
    expect(isSignedGoalDecimal("-1000000000000")).toBe(false);
  });

  it("appends cursor pages without duplicates and resets on a fresh first page", () => {
    const first = { id: "first", name: "First" } as never;
    const updated = { id: "first", name: "Updated" } as never;
    const second = { id: "second", name: "Second" } as never;
    expect(mergeRecipePage([first], [updated, second], true)).toEqual([updated, second]);
    expect(mergeRecipePage([first, second], [updated], false)).toEqual([updated]);
  });

  it("sends effectiveFrom only when creating a goal", () => {
    const energy = { mode: "fixed", targetKcal: "2000", rationale: "User selected" } as const;
    expect(goalWriteBody(null, "2026-08-16", energy, [])).toHaveProperty(
      "effectiveFrom",
      "2026-08-16",
    );
    expect(goalWriteBody("existing", "2026-08-16", energy, [])).not.toHaveProperty("effectiveFrom");
  });

  it("forces gram logging whenever a saved recipe has no serving definition", () => {
    expect(recipeLogKindFor({ servingCount: null })).toBe("grams");
    expect(recipeLogKindFor({ servingCount: "4" })).toBe("serving");
  });

  it("uses the real instant during the repeated DST hour", () => {
    const now = new Date("2026-11-01T07:30:00.000Z");
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
      now,
      () => "00000000-0000-4000-8000-000000000001",
    );
    expect(operation.body.occurredAt).toBe("2026-11-01T07:30:00.000Z");
    expect(operation.body.recipeVersionId).toBe("db2ed69e-29d1-4330-a210-0a804f9ff2b3");
    expect(() => recipeLogInstant("2026-03-08", "02:30", "America/Chicago")).toThrow(
      "does not exist",
    );
  });
});

describe("goal and recipe accessibility semantics", () => {
  it("labels partial amounts as lower bounds", () => {
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
      coverageText: "Partial coverage — shown amount is a quantified lower bound",
      progressPercent: 52.5,
    });
  });

  it("never presents an all-unknown zero as measured zero", () => {
    const presentation = nutrientProgressPresentation({
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
    expect(presentation.valueText).toBe("at least 0 ug");
    expect(presentation.accessibilityLabel).toContain("zero is not a measured zero");
  });

  it("does not call trace-only source coverage quantified", () => {
    const presentation = nutrientProgressPresentation({
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
    expect(presentation.coverageText).toBe(
      "Complete source coverage — trace or unquantified contributions make this a lower bound",
    );
    expect(presentation.coverageText).not.toContain("quantified coverage");
  });

  it("preserves aggregate precision beyond database request-decimal limits", () => {
    const knownAmount = `${"9".repeat(80)}.${"7".repeat(40)}`;
    const presentation = nutrientProgressPresentation({
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
    expect(presentation.valueText).toBe(`${knownAmount} kcal`);
    expect(presentation.progressPercent).toBe(100);
  });

  it("accepts a server-computed percentage beyond the 160-character amount budget", () => {
    const lowerBoundPercent = "9".repeat(174);
    const presentation = nutrientProgressPresentation({
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
    expect(presentation.progressPercent).toBe(100);
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

  it("rejects contradictory server coverage flags", () => {
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

  it("includes amount, provenance, and coverage in ingredient labels", () => {
    expect(
      recipeIngredientAccessibilityLabel({
        name: "Rolled oats",
        amountText: "40 grams",
        sourceText: "USDA FoodData Central, CC0-1.0",
        coverage: "partial",
      }),
    ).toBe("Rolled oats. 40 grams. Source: USDA FoodData Central, CC0-1.0. partial coverage.");
  });

  it("renders flattened nested provenance once per immutable release", () => {
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
