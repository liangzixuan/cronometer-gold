import {
  NUTRITION_REPORT_NOTICE,
  type NutritionReportResponse,
} from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import {
  nutritionReportAdjacentRange,
  nutritionReportBoundarySummary,
  nutritionReportCoverageSummary,
  nutritionReportLocalDates,
  nutritionReportPath,
  nutritionReportPointDisplay,
  nutritionReportRangeEndingAt,
  nutritionReportRequestIdentityMatches,
  nutritionReportTargetMarkerPosition,
  parseNutritionReport,
} from "./reports";

const ownerUserId = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
const sourceDiaryId = "b71ae11b-750e-4124-940f-a4a7ef42f246";
const goalId = "820e5ef5-2af4-48f8-ae6f-c0d5f53b1507";
const goalVersionId = "5343e5c9-3a61-4a3e-a6aa-2302f29829f4";
const expectation = {
  from: "2026-09-01",
  ownerUserId,
  profileRevision: "4",
  timeZone: "America/Chicago",
  to: "2026-09-02",
} as const;

const definitions = [
  ["energy", "Energy", "kcal", "energy"],
  ["protein", "Protein", "g", "macronutrient"],
  ["carbohydrate", "Carbohydrate", "g", "macronutrient"],
  ["fat", "Fat", "g", "macronutrient"],
  ["fiber", "Fiber", "g", "macronutrient"],
  ["sugars", "Sugars", "g", "macronutrient"],
  ["sodium", "Sodium", "mg", "mineral"],
  ["potassium", "Potassium", "mg", "mineral"],
  ["calcium", "Calcium", "mg", "mineral"],
  ["iron", "Iron", "mg", "mineral"],
  ["vitamin-c", "Vitamin C", "mg", "vitamin"],
  ["vitamin-d", "Vitamin D", "ug", "vitamin"],
  ["vitamin-b12", "Vitamin B12", "ug", "vitamin"],
  ["folate-dfe", "Folate DFE", "ug_DFE", "vitamin"],
  ["vitamin-a-rae", "Vitamin A RAE", "ug_RAE", "vitamin"],
] as const;

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function required<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (!item) throw new Error(`Expected fixture item ${index}.`);
  return item;
}

function fixture(): Mutable<NutritionReportResponse> {
  const series = definitions.map((definition, index) => {
    const nutrient = {
      category: definition[3],
      code: definition[0],
      id: String(index + 1),
      name: definition[1],
      unit: definition[2],
    };
    return {
      nutrient,
      scalePolicy: "max-intake-or-saved-threshold-v1",
      scaleMaximum: "100",
      summary: {
        completeDays: 1,
        diaryDays: 1,
        exactDays: 1,
        missingDays: 1,
        partialDays: 0,
        traceDays: 0,
        unknownDays: 0,
      },
      points: [
        {
          aggregate: {
            nutrientId: nutrient.id,
            code: nutrient.code,
            name: nutrient.name,
            unit: nutrient.unit,
            knownAmount: "10",
            completeness: "complete",
            isExact: true,
            contributorCount: 1,
            quantifiedCount: 1,
            traceCount: 0,
            unknownCount: 0,
            unknownReasonCounts: {
              not_reported: 0,
              not_analyzed: 0,
              not_applicable: 0,
              withheld: 0,
            },
          },
          comparison: null,
          goalVersionId: null,
          knownPercentOfScale: "10",
          localDate: "2026-09-01",
          maximumPercentOfScale: null,
          minimumPercentOfScale: null,
          targetPercentOfScale: null,
        },
        {
          aggregate: null,
          comparison: null,
          goalVersionId: null,
          knownPercentOfScale: null,
          localDate: "2026-09-02",
          maximumPercentOfScale: null,
          minimumPercentOfScale: null,
          targetPercentOfScale: null,
        },
      ],
    };
  });
  return {
    data: {
      dateBasis: "active-profile-time-zone-v1",
      days: [
        {
          endsAt: "2026-09-02T05:00:00.000Z",
          entryCount: 1,
          localDate: "2026-09-01",
          sourceDiaries: [{ id: sourceDiaryId, localDate: "2026-09-01", revision: "3" }],
          sourceTimeZones: ["America/Chicago"],
          startsAt: "2026-09-01T05:00:00.000Z",
        },
        {
          endsAt: "2026-09-03T05:00:00.000Z",
          entryCount: 0,
          localDate: "2026-09-02",
          sourceDiaries: [],
          sourceTimeZones: [],
          startsAt: "2026-09-02T05:00:00.000Z",
        },
      ],
      from: expectation.from,
      goalVersionBasis: "current-version-at-report-snapshot-v1",
      goalVersions: [],
      notice: NUTRITION_REPORT_NOTICE,
      ownerUserId,
      profileRevision: expectation.profileRevision,
      series,
      snapshotAt: "2026-09-03T12:00:00.000Z",
      targetSegments: [{ from: expectation.from, to: expectation.to, goalVersionId: null }],
      timeZone: expectation.timeZone,
      to: expectation.to,
      watermarkRevision: "9",
    },
  } as Mutable<NutritionReportResponse>;
}

function fixtureWithGoal(): Mutable<NutritionReportResponse> {
  const value = fixture();
  const energy = required(value.data.series, 0);
  value.data.goalVersions = [
    {
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      goalId,
      reference: null,
      revision: "3",
      targets: [
        {
          nutrientId: "1",
          snapshot: {
            maximumAmount: null,
            minimumAmount: null,
            rationale: "My saved daily energy target.",
            source: { label: "user_fixed", version: "1" },
            targetAmount: "20",
          },
        },
      ],
      versionId: goalVersionId,
    },
  ];
  value.data.targetSegments = [{ from: expectation.from, to: expectation.to, goalVersionId }];
  for (const series of value.data.series) {
    for (const point of series.points) point.goalVersionId = goalVersionId;
  }
  const firstEnergyPoint = required(energy.points, 0);
  const secondEnergyPoint = required(energy.points, 1);
  firstEnergyPoint.targetPercentOfScale = "20";
  firstEnergyPoint.comparison = {
    maximumState: null,
    minimumState: null,
    targetLowerBoundPercent: "50",
    targetPercentIsExact: true,
  };
  secondEnergyPoint.targetPercentOfScale = "20";
  return value;
}

describe("mobile nutrition reports", () => {
  it("parses all 15 series and keeps an empty day distinct from a measured zero", () => {
    const report = parseNutritionReport(fixture(), expectation);
    expect(report.series).toHaveLength(15);
    expect(report.days).toHaveLength(2);
    const energy = required(report.series, 0);
    expect(nutritionReportPointDisplay(required(energy.points, 0), energy.nutrient.unit)).toEqual({
      amount: "10 kcal",
      comparison: "No saved target applied.",
      coverage: "Complete coverage · quantified amount",
    });
    expect(nutritionReportPointDisplay(required(energy.points, 1), energy.nutrient.unit)).toEqual({
      amount: "No diary entries",
      comparison: "No saved target applied.",
      coverage: "Missing day; this is not a measured zero.",
    });
    expect(nutritionReportCoverageSummary(energy)).toContain("1 exact");
  });

  it("accepts a pinned goal version and reports its saved-target comparison", () => {
    const report = parseNutritionReport(fixtureWithGoal(), expectation);
    const energy = required(report.series, 0);
    expect(
      nutritionReportPointDisplay(required(energy.points, 0), energy.nutrient.unit).comparison,
    ).toBe("Saved comparison: 50% of saved target.");
    expect(nutritionReportBoundarySummary(report.targetSegments)).toBe(
      "One saved goal version applied across this whole range.",
    );
  });

  it("accepts an exact zero saved target without inventing a division-by-zero percentage", () => {
    const value = fixtureWithGoal();
    const energyGoal = required(value.data.goalVersions, 0).targets[0];
    if (!energyGoal) throw new Error("Expected the energy goal fixture.");
    energyGoal.snapshot.targetAmount = "0";
    const energy = required(value.data.series, 0);
    const firstPoint = required(energy.points, 0);
    const secondPoint = required(energy.points, 1);
    firstPoint.targetPercentOfScale = "0";
    firstPoint.comparison = {
      maximumState: null,
      minimumState: null,
      targetLowerBoundPercent: null,
      targetPercentIsExact: true,
    };
    secondPoint.targetPercentOfScale = "0";

    const report = parseNutritionReport(value, expectation);
    const parsedEnergy = required(report.series, 0);
    const parsedPoint = required(parsedEnergy.points, 0);
    expect(parsedPoint.comparison).toEqual({
      maximumState: null,
      minimumState: null,
      targetLowerBoundPercent: null,
      targetPercentIsExact: true,
    });
    expect(nutritionReportPointDisplay(parsedPoint, parsedEnergy.nutrient.unit).comparison).toBe(
      "Saved comparison: target percentage unavailable because the saved target is zero.",
    );
  });

  it("rejects target-percentage exactness that contradicts the diary aggregate", () => {
    const value = fixtureWithGoal();
    const energyPoint = required(required(value.data.series, 0).points, 0);
    if (!energyPoint.comparison) throw new Error("Expected a target comparison fixture.");
    energyPoint.comparison.targetPercentIsExact = false;
    expect(() => parseNutritionReport(value, expectation)).toThrow("exactness");

    const zeroTarget = fixtureWithGoal();
    const target = required(required(zeroTarget.data.goalVersions, 0).targets, 0);
    target.snapshot.targetAmount = "0";
    const zeroPoint = required(required(zeroTarget.data.series, 0).points, 0);
    zeroPoint.targetPercentOfScale = "0";
    zeroPoint.comparison = {
      maximumState: null,
      minimumState: null,
      targetLowerBoundPercent: null,
      targetPercentIsExact: false,
    };
    required(required(zeroTarget.data.series, 0).points, 1).targetPercentOfScale = "0";
    expect(() => parseNutritionReport(zeroTarget, expectation)).toThrow("exactness");
  });

  it("rejects a delayed start that does not prove the exact profile-local midnight", () => {
    const value = fixture();
    required(value.data.days, 0).startsAt = "2026-09-01T06:00:00.000Z";
    expect(() => parseNutritionReport(value, expectation)).toThrow("day was invalid");
  });

  it("anchors a 100% target marker inside the chart boundary", () => {
    expect(nutritionReportTargetMarkerPosition("0")).toEqual({ left: "0%" });
    expect(nutritionReportTargetMarkerPosition("42.5")).toEqual({ left: "42.5%" });
    expect(nutritionReportTargetMarkerPosition("100")).toEqual({ right: 0 });
    expect(nutritionReportTargetMarkerPosition("100.000")).toEqual({ right: 0 });
    expect(() => nutritionReportTargetMarkerPosition("100.001")).toThrow("between 0 and 100");
  });

  it("rejects a unique but non-core nutrient vector", () => {
    const value = fixture();
    const firstSeries = required(value.data.series, 0);
    firstSeries.nutrient.code = "not-energy";
    const firstAggregate = required(firstSeries.points, 0).aggregate;
    if (!firstAggregate) throw new Error("Expected a fixture aggregate.");
    firstAggregate.code = "not-energy";

    expect(() => parseNutritionReport(value, expectation)).toThrow("core nutrient series");
  });

  it("rejects owner, profile, time-zone, range, and summary drift", () => {
    expect(() => parseNutritionReport(fixture(), { ...expectation, ownerUserId: goalId })).toThrow(
      "identity",
    );
    expect(() => parseNutritionReport(fixture(), { ...expectation, profileRevision: "5" })).toThrow(
      "identity",
    );
    expect(() => parseNutritionReport(fixture(), { ...expectation, timeZone: "UTC" })).toThrow(
      "identity",
    );
    expect(() => parseNutritionReport(fixture(), { ...expectation, to: "2026-09-03" })).toThrow();
    const wrongSummary = fixture();
    required(wrongSummary.data.series, 0).summary.exactDays = 0;
    expect(() => parseNutritionReport(wrongSummary, expectation)).toThrow("summary");
  });

  it("rejects reordered points, duplicate nutrients, and inconsistent missingness", () => {
    const reordered = fixture();
    required(reordered.data.series, 0).points.reverse();
    expect(() => parseNutritionReport(reordered, expectation)).toThrow("series point");

    const duplicate = fixture();
    const firstSeries = required(duplicate.data.series, 0);
    const duplicateSeries = required(duplicate.data.series, 1);
    duplicateSeries.nutrient = { ...firstSeries.nutrient };
    const firstAggregate = required(firstSeries.points, 0).aggregate;
    if (!firstAggregate) throw new Error("Expected a fixture aggregate.");
    required(duplicateSeries.points, 0).aggregate = { ...firstAggregate };
    expect(() => parseNutritionReport(duplicate, expectation)).toThrow("duplicated");

    const inventedZero = fixture();
    const inventedSeries = required(inventedZero.data.series, 0);
    const inventedAggregate = required(inventedSeries.points, 0).aggregate;
    if (!inventedAggregate) throw new Error("Expected a fixture aggregate.");
    required(inventedSeries.points, 1).aggregate = { ...inventedAggregate };
    required(inventedSeries.points, 1).knownPercentOfScale = "10";
    expect(() => parseNutritionReport(inventedZero, expectation)).toThrow("coverage");
  });

  it("builds bounded profile-local ranges and an encoded direct API path", () => {
    expect(nutritionReportRangeEndingAt("2026-09-07", 14)).toEqual({
      from: "2026-08-25",
      to: "2026-09-07",
    });
    expect(nutritionReportLocalDates("2026-02-27", "2026-03-01")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    expect(nutritionReportPath("2026-09-01", "2026-09-02")).toBe(
      "/v1/reports/nutrition?from=2026-09-01&to=2026-09-02",
    );
    expect(() => nutritionReportLocalDates("2026-08-01", "2026-09-01")).toThrow("1 to 31");
    expect(() => nutritionReportLocalDates("2026-09-02", "2026-09-01")).toThrow("1 to 31");
  });

  it("fences every response to the owner, session, profile, time zone, query, and generation", () => {
    const fence = { ...expectation, generation: 3, sessionEpoch: 8 };
    expect(nutritionReportRequestIdentityMatches(fence, fence)).toBe(true);
    for (const changed of [
      { ...fence, ownerUserId: goalId },
      { ...fence, sessionEpoch: 9 },
      { ...fence, profileRevision: "5" },
      { ...fence, timeZone: "UTC" },
      { ...fence, from: "2026-08-31" },
      { ...fence, to: "2026-09-03" },
      { ...fence, generation: 4 },
    ]) {
      expect(nutritionReportRequestIdentityMatches(changed, fence)).toBe(false);
    }
  });
});

describe("mobile adjacent report calendar periods", () => {
  it.each([
    ["2026-09-01", "2026-09-07", "previous", "2026-08-25", "2026-08-31"],
    ["2026-09-01", "2026-09-07", "next", "2026-09-08", "2026-09-14"],
    ["2024-02-28", "2024-02-29", "next", "2024-03-01", "2024-03-02"],
    ["2024-03-01", "2024-03-02", "previous", "2024-02-28", "2024-02-29"],
    ["2026-12-29", "2026-12-31", "next", "2027-01-01", "2027-01-03"],
    ["2026-03-07", "2026-03-09", "next", "2026-03-10", "2026-03-12"],
    ["2026-10-31", "2026-11-02", "previous", "2026-10-28", "2026-10-30"],
    ["0002-01-01", "0002-01-01", "next", "0002-01-02", "0002-01-02"],
    ["0099-12-31", "0099-12-31", "next", "0100-01-01", "0100-01-01"],
    ["0099-12-30", "0099-12-31", "next", "0100-01-01", "0100-01-02"],
  ] as const)(
    "shifts %s through %s %s without local-hour or early-year remapping",
    (from, to, direction, nextFrom, nextTo) => {
      expect(nutritionReportAdjacentRange(from, to, direction)).toEqual({
        from: nextFrom,
        to: nextTo,
      });
    },
  );
  it.each([1, 7, 14, 30, 31])(
    "preserves an inclusive %i-day period and reverses exactly",
    (days) => {
      const from = "2026-03-01";
      const to = `2026-03-${String(days).padStart(2, "0")}`;
      const next = nutritionReportAdjacentRange(from, to, "next");
      if (!next) throw new Error("Expected a supported next period.");
      expect(nutritionReportLocalDates(next.from, next.to)).toHaveLength(days);
      expect(nutritionReportAdjacentRange(next.from, next.to, "previous")).toEqual({ from, to });
    },
  );
  it("disables only a direction that would cross service bounds", () => {
    expect(nutritionReportAdjacentRange("0002-01-01", "0002-01-07", "previous")).toBeNull();
    expect(nutritionReportAdjacentRange("0002-01-01", "0002-01-07", "next")).toEqual({
      from: "0002-01-08",
      to: "0002-01-14",
    });
    expect(nutritionReportAdjacentRange("9998-12-25", "9998-12-31", "next")).toBeNull();
    expect(nutritionReportAdjacentRange("9998-12-25", "9998-12-31", "previous")).toEqual({
      from: "9998-12-18",
      to: "9998-12-24",
    });
    expect(nutritionReportRangeEndingAt("0002-01-14", 14)).toEqual({
      from: "0002-01-01",
      to: "0002-01-14",
    });
    expect(nutritionReportLocalDates("0099-12-31", "0100-01-01")).toEqual([
      "0099-12-31",
      "0100-01-01",
    ]);
  });
  it.each([
    ["2026-02-30", "2026-03-01"],
    ["2026-03-02", "2026-03-01"],
    ["2026-03-01", "2026-04-01"],
    ["0001-12-31", "0002-01-01"],
    ["9998-12-31", "9999-01-01"],
  ])("rejects unsupported input %s through %s", (from, to) => {
    expect(() => nutritionReportAdjacentRange(from, to, "next")).toThrow(RangeError);
  });
});
