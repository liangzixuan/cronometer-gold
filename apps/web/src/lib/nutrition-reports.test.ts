import { describe, expect, it } from "vitest";

import {
  emptyNutritionReportFixture,
  zeroTargetNutritionReportFixture,
} from "../test/nutrition-report-fixture";
import {
  nutritionReportDates,
  nutritionReportRange,
  parseNutritionReport,
  reportAmountText,
  reportComparisonText,
  reportPointAccessibilityLabel,
  reportPointCoverageText,
  resolveInitialNutritionReportRange,
} from "./nutrition-reports";

describe("web nutrition-report range helpers", () => {
  it("builds inclusive profile-local ranges across calendar boundaries", () => {
    expect(nutritionReportRange("2026-03-02", 7)).toEqual({
      from: "2026-02-24",
      to: "2026-03-02",
    });
    expect(nutritionReportDates("2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("rejects reversed, impossible, and wider-than-31-day ranges", () => {
    for (const range of [
      ["2026-09-02", "2026-09-01"],
      ["2026-02-30", "2026-03-01"],
      ["2026-08-01", "2026-09-01"],
    ] as const) {
      expect(() => nutritionReportDates(range[0], range[1])).toThrow();
    }
  });

  it("uses an explicit valid range and otherwise defaults to 14 profile-local days", () => {
    expect(
      resolveInitialNutritionReportRange({
        initialFrom: "2026-08-01",
        initialTo: "2026-08-30",
        profileTimeZone: "Pacific/Kiritimati",
      }),
    ).toEqual({ from: "2026-08-01", to: "2026-08-30" });
    expect(
      resolveInitialNutritionReportRange({
        initialFrom: "2026-01-01",
        initialTo: "not-a-date",
        profileTimeZone: "Pacific/Kiritimati",
        now: new Date("2026-09-01T10:30:00.000Z"),
      }),
    ).toEqual({ from: "2026-08-20", to: "2026-09-02" });
  });
});

describe("web nutrition-report response parsing", () => {
  it("accepts an exact bounded 15-series report tied to the requested owner and range", () => {
    const parsed = parseNutritionReport(emptyNutritionReportFixture(), {
      from: "2026-09-01",
      ownerUserId: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
      to: "2026-09-01",
    });
    expect(parsed.series).toHaveLength(15);
    expect(parsed.days).toHaveLength(1);
    expect(parsed.series[0]?.summary.missingDays).toBe(1);
  });

  it.each([
    {
      localDate: "2026-03-08",
      startsAt: "2026-03-08T06:00:00.000Z",
      endsAt: "2026-03-09T05:00:00.000Z",
      durationHours: 23,
    },
    {
      localDate: "2026-11-01",
      startsAt: "2026-11-01T05:00:00.000Z",
      endsAt: "2026-11-02T06:00:00.000Z",
      durationHours: 25,
    },
  ])(
    "accepts the $durationHours-hour America/Chicago day on $localDate",
    ({ localDate, startsAt, endsAt }) => {
      const fixture = emptyNutritionReportFixture(localDate);
      const day = fixture.data.days[0];
      if (!day) throw new Error("Expected one fixture day.");
      fixture.data.days[0] = {
        ...day,
        startsAt,
        endsAt,
      };
      expect(parseNutritionReport(fixture).days[0]).toMatchObject({
        localDate,
        startsAt,
        endsAt,
      });
    },
  );

  it.each([
    {
      localDate: "2026-03-08",
      startsAt: "2026-03-08T06:00:00.000Z",
      invalidEndsAt: "2026-03-09T06:00:00.000Z",
    },
    {
      localDate: "2026-11-01",
      startsAt: "2026-11-01T05:00:00.000Z",
      invalidEndsAt: "2026-11-02T05:00:00.000Z",
    },
  ])(
    "rejects a fixed-24-hour boundary for $localDate",
    ({ localDate, startsAt, invalidEndsAt }) => {
      const fixture = emptyNutritionReportFixture(localDate);
      const day = fixture.data.days[0];
      if (!day) throw new Error("Expected one fixture day.");
      fixture.data.days[0] = {
        ...day,
        startsAt,
        endsAt: invalidEndsAt,
      };
      expect(() => parseNutritionReport(fixture)).toThrow("day was invalid");
    },
  );

  it("rejects a day whose start belongs to the preceding profile-local date", () => {
    const fixture = emptyNutritionReportFixture();
    const day = fixture.data.days[0];
    if (!day) throw new Error("Expected one fixture day.");
    fixture.data.days[0] = {
      ...day,
      startsAt: "2026-09-01T04:59:59.999Z",
    };
    expect(() => parseNutritionReport(fixture)).toThrow("day was invalid");
  });

  it("rejects a delayed start that does not represent the exact start of the local day", () => {
    const fixture = emptyNutritionReportFixture();
    const day = fixture.data.days[0];
    if (!day) throw new Error("Expected one fixture day.");
    fixture.data.days[0] = {
      ...day,
      startsAt: "2026-09-01T17:00:00.000Z",
    };
    expect(() => parseNutritionReport(fixture)).toThrow("day was invalid");
  });

  it("accepts one recipe entry with multiple nutrient contributors", () => {
    const fixture = emptyNutritionReportFixture();
    const series = fixture.data.series.map((candidate) => ({
      ...candidate,
      summary: {
        diaryDays: 1,
        completeDays: 1,
        exactDays: 1,
        partialDays: 0,
        unknownDays: 0,
        traceDays: 0,
        missingDays: 0,
      },
      points: candidate.points.map((point) => ({
        ...point,
        aggregate: {
          nutrientId: candidate.nutrient.id,
          code: candidate.nutrient.code,
          name: candidate.nutrient.name,
          unit: candidate.nutrient.unit,
          knownAmount: "1",
          completeness: "complete",
          isExact: true,
          contributorCount: 2,
          quantifiedCount: 2,
          traceCount: 0,
          unknownCount: 0,
          unknownReasonCounts: {
            not_reported: 0,
            not_analyzed: 0,
            not_applicable: 0,
            withheld: 0,
          },
        },
        knownPercentOfScale: "100",
      })),
    }));
    const parsed = parseNutritionReport({
      data: {
        ...fixture.data,
        days: [
          {
            ...fixture.data.days[0],
            entryCount: 1,
            sourceDiaries: [
              {
                id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
                localDate: "2026-09-01",
                revision: "2",
              },
            ],
            sourceTimeZones: ["America/Chicago"],
          },
        ],
        series,
      },
    });
    expect(parsed.days[0]?.entryCount).toBe(1);
    expect(parsed.series[0]?.points[0]?.aggregate?.contributorCount).toBe(2);
    expect(() =>
      parseNutritionReport({
        data: {
          ...fixture.data,
          days: [
            {
              ...fixture.data.days[0],
              entryCount: 1,
              sourceDiaries: [
                {
                  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
                  localDate: "2026-09-01",
                  revision: "2",
                },
              ],
              sourceTimeZones: ["America/Chicago"],
            },
          ],
          series: series.map((candidate, index) =>
            index === 0
              ? {
                  ...candidate,
                  points: candidate.points.map((point) => ({
                    ...point,
                    aggregate: { ...point.aggregate, score: 99 },
                  })),
                }
              : candidate,
          ),
        },
      }),
    ).toThrow("aggregate");
    expect(() =>
      parseNutritionReport({
        data: {
          ...fixture.data,
          days: [
            {
              ...fixture.data.days[0],
              entryCount: 1,
              sourceDiaries: [
                {
                  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
                  localDate: "2026-09-01",
                  revision: "2",
                },
              ],
              sourceTimeZones: [],
            },
          ],
          series,
        },
      }),
    ).toThrow("provenance");
  });

  it("fails closed on extra fields, request-range drift, and duplicated nutrient identity", () => {
    const fixture = emptyNutritionReportFixture();
    expect(() => parseNutritionReport({ data: { ...fixture.data, score: 92 } })).toThrow("invalid");
    expect(() => parseNutritionReport(fixture, { to: "2026-09-02" })).toThrow("match");
    expect(() =>
      parseNutritionReport({
        data: {
          ...fixture.data,
          series: fixture.data.series.map((series, index) =>
            index === 1 ? { ...series, nutrient: { ...series.nutrient, id: "1" } } : series,
          ),
        },
      }),
    ).toThrow("incomplete");
  });

  it("rejects missing-day data presented as a measured zero", () => {
    const fixture = emptyNutritionReportFixture();
    const first = fixture.data.series[0];
    if (!first) throw new Error("Expected an energy series.");
    expect(() =>
      parseNutritionReport({
        data: {
          ...fixture.data,
          series: [
            {
              ...first,
              summary: {
                ...first.summary,
                diaryDays: 1,
                completeDays: 1,
                exactDays: 1,
                missingDays: 0,
              },
              points: [
                {
                  ...first.points[0],
                  aggregate: {
                    nutrientId: "1",
                    code: "energy",
                    name: "energy",
                    unit: "kcal",
                    knownAmount: "0",
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
                  knownPercentOfScale: "0",
                },
              ],
            },
            ...fixture.data.series.slice(1),
          ],
        },
      }),
    ).toThrow("coverage");
  });
  it("rejects non-forward goal effective intervals", () => {
    const fixture = zeroTargetNutritionReportFixture();
    const goal = fixture.data.goalVersions[0];
    if (!goal) throw new Error("Expected one goal version.");
    expect(() =>
      parseNutritionReport({
        data: {
          ...fixture.data,
          goalVersions: [{ ...goal, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-01" }],
        },
      }),
    ).toThrow("goal version");
  });

  it("rejects segments outside goal-effective and reference-eligibility intervals", () => {
    const fixture = zeroTargetNutritionReportFixture();
    const goal = fixture.data.goalVersions[0];
    if (!goal) throw new Error("Expected one goal version.");
    for (const invalidGoal of [
      { ...goal, effectiveFrom: "2026-09-02" },
      { ...goal, effectiveTo: "2026-09-01" },
      {
        ...goal,
        reference: {
          templateCode: "adult",
          templateVersion: "1",
          groupCode: "adult",
          policyDigest: "a".repeat(64),
          eligibleThroughExclusive: "2026-09-01",
        },
      },
    ]) {
      expect(() =>
        parseNutritionReport({
          data: { ...fixture.data, goalVersions: [invalidGoal] },
        }),
      ).toThrow("segment exceeded");
    }
  });

  it("rejects comparison fields that contradict the selected target or aggregate exactness", () => {
    const fixture = zeroTargetNutritionReportFixture();
    const energy = fixture.data.series[0];
    const point = energy?.points[0];
    const comparison = point?.comparison;
    if (!energy || !point || !comparison) throw new Error("Expected a compared energy point.");
    for (const invalidComparison of [
      { ...comparison, minimumState: "met" },
      { ...comparison, targetLowerBoundPercent: "0" },
      { ...comparison, targetPercentIsExact: false },
    ]) {
      expect(() =>
        parseNutritionReport({
          data: {
            ...fixture.data,
            series: [
              { ...energy, points: [{ ...point, comparison: invalidComparison }] },
              ...fixture.data.series.slice(1),
            ],
          },
        }),
      ).toThrow("saved-target evidence");
    }
  });

  it("rejects chart-scale percentages above 100", () => {
    const fixture = zeroTargetNutritionReportFixture();
    const energy = fixture.data.series[0];
    const point = energy?.points[0];
    if (!energy || !point) throw new Error("Expected an energy point.");
    expect(() =>
      parseNutritionReport({
        data: {
          ...fixture.data,
          series: [
            { ...energy, points: [{ ...point, knownPercentOfScale: "100.001" }] },
            ...fixture.data.series.slice(1),
          ],
        },
      }),
    ).toThrow("series point");
  });
});

describe("web nutrition-report presentation", () => {
  const missing = emptyNutritionReportFixture().data.series[0]?.points[0];
  if (!missing) throw new Error("Expected a report point.");

  it("labels an empty diary day as missing rather than zero", () => {
    expect(reportAmountText(missing, "kcal")).toBe("Missing");
    expect(reportPointCoverageText(missing)).toContain("missing, not zero");
    expect(reportPointAccessibilityLabel(missing, "Energy", "kcal")).toContain("no chart bar");
  });

  it("uses lower-bound language for partial coverage", () => {
    const partial = {
      ...missing,
      aggregate: {
        nutrientId: "1",
        code: "energy",
        name: "Energy",
        unit: "kcal",
        knownAmount: "1400",
        completeness: "partial" as const,
        isExact: false,
        contributorCount: 3,
        quantifiedCount: 2,
        traceCount: 0,
        unknownCount: 1,
        unknownReasonCounts: {
          not_reported: 1,
          not_analyzed: 0,
          not_applicable: 0,
          withheld: 0,
        },
      },
      knownPercentOfScale: "70",
    };
    expect(reportAmountText(partial, "kcal")).toBe("At least 1400 kcal");
    expect(reportPointCoverageText(partial)).toContain("Known lower bound");
  });

  it("labels wholly unknown coverage as unknown instead of a zero lower bound", () => {
    const unknown = {
      ...missing,
      aggregate: {
        nutrientId: "1",
        code: "energy",
        name: "Energy",
        unit: "kcal",
        knownAmount: "0",
        completeness: "unknown" as const,
        isExact: false,
        contributorCount: 2,
        quantifiedCount: 0,
        traceCount: 0,
        unknownCount: 2,
        unknownReasonCounts: {
          not_reported: 2,
          not_analyzed: 0,
          not_applicable: 0,
          withheld: 0,
        },
      },
      knownPercentOfScale: "0",
    };
    expect(reportAmountText(unknown, "kcal")).toBe("Unknown");
    expect(reportPointCoverageText(unknown)).toContain("Amount unknown");
    expect(reportPointAccessibilityLabel(unknown, "Energy", "kcal")).toContain("Energy: Unknown;");
    expect(reportPointAccessibilityLabel(unknown, "Energy", "kcal")).not.toContain("At least 0");
  });

  it("explains why a saved zero target has no percentage", () => {
    const report = parseNutritionReport(zeroTargetNutritionReportFixture());
    const point = report.series[0]?.points[0];
    if (!point) throw new Error("Expected a zero-target energy point.");
    expect(reportComparisonText(point)).toContain(
      "target percentage unavailable because the saved target is zero",
    );
    expect(reportComparisonText(point)).not.toBe("No saved threshold");
  });
});
