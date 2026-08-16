import { describe, expect, it } from "vitest";

import {
  calculateNutrientTargetProgress,
  createEnergyTargetSnapshot,
  type DomainError,
  MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH,
} from "../src/index.js";

describe("energy goal snapshots", () => {
  it("matches the original adult Mifflin–St Jeor equations and snapshots policy inputs", () => {
    const male = createEnergyTargetSnapshot({
      mode: "derived",
      effectiveDate: "2026-08-16",
      birthDate: "1990-08-17",
      sexAtBirth: "male",
      profileRevision: "3",
      heightCm: "180",
      weightKg: "80",
      activityLevelCode: "sedentary_or_light",
      activityFactor: "1.55",
      adjustmentKcal: "-100",
      rationale: "User selected a maintenance estimate with a 100 kcal adjustment.",
    });
    expect(male).toMatchObject({
      ageYears: 35,
      bmrKcal: "1755",
      activityFactor: "1.55",
      targetKcal: "2620.25",
      source: {
        equation: { code: "mifflin-st-jeor-ree", version: "1990-original" },
        activityPolicy: { code: "fao-who-unu-pal-policy", version: "2004-reviewed-v1" },
      },
    });

    const female = createEnergyTargetSnapshot({
      mode: "derived",
      effectiveDate: "2026-08-17",
      birthDate: "1990-08-17",
      sexAtBirth: "female",
      profileRevision: "4",
      heightCm: "180",
      weightKg: "80",
      activityLevelCode: "sedentary_or_light",
      activityFactor: "1.55",
      rationale: "User requested an equation-based estimate.",
    });
    expect(female).toMatchObject({ ageYears: 36, bmrKcal: "1584", targetKcal: "2455.2" });
  });

  it("supports explicit fixed energy for profiles the equation does not support", () => {
    expect(
      createEnergyTargetSnapshot({
        mode: "fixed",
        targetKcal: "2100.00",
        rationale: "User entered a fixed wellness target.",
      }),
    ).toEqual({
      mode: "fixed",
      targetKcal: "2100",
      source: { code: "user-fixed", version: "1" },
      rationale: "User entered a fixed wellness target.",
    });
  });

  it("rejects children, invalid dates, and unreviewed activity codes", () => {
    const baseline = {
      mode: "derived" as const,
      effectiveDate: "2026-08-16",
      birthDate: "2010-08-16",
      sexAtBirth: "female" as const,
      profileRevision: "1",
      heightCm: "160",
      weightKg: "55",
      activityLevelCode: "sedentary_or_light" as const,
      activityFactor: "1.55",
      rationale: "Equation estimate.",
    };
    expect(() => createEnergyTargetSnapshot(baseline)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_GOAL" }),
    );
    expect(() => createEnergyTargetSnapshot({ ...baseline, birthDate: "2000-02-30" })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_GOAL" }),
    );
    expect(() =>
      createEnergyTargetSnapshot({
        ...baseline,
        birthDate: "2000-01-01",
        activityLevelCode: "athlete" as never,
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_GOAL" }));
    expect(() =>
      createEnergyTargetSnapshot({
        ...baseline,
        birthDate: "2000-01-01",
        sexAtBirth: "intersex" as never,
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_GOAL" }));
  });

  it("enforces the original study age and reviewed PAL boundaries", () => {
    const input = {
      mode: "derived" as const,
      effectiveDate: "2026-08-16",
      sexAtBirth: "male" as const,
      profileRevision: "2",
      heightCm: "180",
      weightKg: "80",
      activityLevelCode: "vigorous" as const,
      activityFactor: "2.4",
      rationale: "Explicit adult estimate.",
    };
    expect(createEnergyTargetSnapshot({ ...input, birthDate: "2007-08-16" })).toMatchObject({
      ageYears: 19,
      activityFactor: "2.4",
    });
    expect(createEnergyTargetSnapshot({ ...input, birthDate: "1948-08-16" })).toMatchObject({
      ageYears: 78,
    });
    for (const birthDate of ["2008-08-16", "1947-08-16"]) {
      expect(() => createEnergyTargetSnapshot({ ...input, birthDate })).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_GOAL" }),
      );
    }
    expect(() =>
      createEnergyTargetSnapshot({ ...input, activityFactor: "2.4001", birthDate: "2000-01-01" }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_GOAL" }));
    expect(() =>
      createEnergyTargetSnapshot({
        ...input,
        birthDate: "2000-01-01",
        activityLevelCode: "sedentary_or_light",
        activityFactor: "1.3999",
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_GOAL" }));
  });
});

describe("nutrient target progress", () => {
  const target = {
    nutrientId: "fiber",
    unit: "g",
    minimumAmount: "20",
    targetAmount: "30",
    maximumAmount: "40",
  } as const;

  it("reports exact threshold and percentage states only for exact totals", () => {
    const result = calculateNutrientTargetProgress(
      {
        nutrientId: "fiber",
        unit: "g",
        knownAmount: "24",
        completeness: "complete",
        isExact: true,
        contributorCount: 2,
        quantifiedCount: 2,
        traceCount: 0,
        unknownCount: 0,
        unknownReasons: {},
      },
      target,
    );
    expect(result).toMatchObject({
      amountInterpretation: "exact",
      minimum: { state: "met" },
      target: { lowerBoundPercent: "80", percentIsExact: true },
      maximum: { state: "within" },
    });
  });

  it("treats partial totals as lower bounds with one-way threshold conclusions", () => {
    const result = calculateNutrientTargetProgress(
      {
        nutrientId: "fiber",
        unit: "g",
        knownAmount: "24",
        completeness: "partial",
        isExact: false,
        contributorCount: 2,
        quantifiedCount: 1,
        traceCount: 0,
        unknownCount: 1,
        unknownReasons: { not_reported: 1 },
      },
      target,
    );
    expect(result).toMatchObject({
      amountInterpretation: "lower_bound",
      minimum: { state: "met" },
      target: { lowerBoundPercent: "80", percentIsExact: false },
      maximum: { state: "indeterminate" },
    });
  });

  it("does not divide by a zero target", () => {
    const result = calculateNutrientTargetProgress(
      {
        nutrientId: "sodium",
        unit: "mg",
        knownAmount: "0",
        completeness: "complete",
        isExact: true,
        contributorCount: 1,
        quantifiedCount: 1,
        traceCount: 0,
        unknownCount: 0,
        unknownReasons: {},
      },
      {
        nutrientId: "sodium",
        unit: "mg",
        minimumAmount: null,
        targetAmount: "0",
        maximumAmount: null,
      },
    );
    expect(result.target).toEqual({ amount: "0", lowerBoundPercent: null, percentIsExact: true });
  });

  it("preserves exact large percentages produced by valid boundary-sized amounts", () => {
    const result = calculateNutrientTargetProgress(
      {
        nutrientId: "fiber",
        unit: "g",
        knownAmount: "9".repeat(160),
        completeness: "complete",
        isExact: true,
        contributorCount: 1,
        quantifiedCount: 1,
        traceCount: 0,
        unknownCount: 0,
        unknownReasons: {},
      },
      {
        nutrientId: "fiber",
        unit: "g",
        minimumAmount: null,
        targetAmount: "0.000000000001",
        maximumAmount: null,
      },
    );
    const percentage = result.target?.lowerBoundPercent;
    expect(percentage).not.toBeNull();
    if (percentage === null || percentage === undefined) throw new Error("Expected a percentage");
    expect(percentage.length).toBeGreaterThan(160);
    expect(percentage.length).toBeLessThanOrEqual(MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH);
  });
});
