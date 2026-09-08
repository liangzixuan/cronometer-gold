import { shiftLocalDate } from "../lib/diary";
import {
  NUTRITION_REPORT_NOTICE,
  nutritionReportDates,
  REPORT_NUTRIENTS,
} from "../lib/nutrition-reports";

export const ZERO_TARGET_GOAL_VERSION_ID = "22222222-2222-4222-8222-222222222222";

export function emptyNutritionReportFixture(from = "2026-09-01", to = from) {
  const dates = nutritionReportDates(from, to);
  return {
    data: {
      ownerUserId: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
      profileRevision: "4",
      timeZone: "America/Chicago",
      watermarkRevision: "12",
      snapshotAt: "2026-09-07T15:00:00.000Z",
      dateBasis: "active-profile-time-zone-v1",
      goalVersionBasis: "current-version-at-report-snapshot-v1",
      from,
      to,
      days: dates.map((localDate) => ({
        localDate,
        startsAt: `${localDate}T05:00:00.000Z`,
        endsAt: `${shiftLocalDate(localDate, 1)}T05:00:00.000Z`,
        entryCount: 0,
        sourceDiaries: [],
        sourceTimeZones: [],
      })),
      goalVersions: [],
      targetSegments: [{ from, to, goalVersionId: null }],
      series: REPORT_NUTRIENTS.map((nutrient, index) => ({
        nutrient: {
          id: String(index + 1),
          code: nutrient.code,
          name: nutrient.code,
          unit: nutrient.unit,
          category: nutrient.category,
        },
        scalePolicy: "max-intake-or-saved-threshold-v1",
        scaleMaximum: "1",
        summary: {
          diaryDays: 0,
          completeDays: 0,
          exactDays: 0,
          partialDays: 0,
          unknownDays: 0,
          traceDays: 0,
          missingDays: dates.length,
        },
        points: dates.map((localDate) => ({
          localDate,
          goalVersionId: null,
          aggregate: null,
          knownPercentOfScale: null,
          minimumPercentOfScale: null,
          targetPercentOfScale: null,
          maximumPercentOfScale: null,
          comparison: null,
        })),
      })),
      notice: NUTRITION_REPORT_NOTICE,
    },
  };
}

export function zeroTargetNutritionReportFixture() {
  const fixture = emptyNutritionReportFixture();
  const localDate = fixture.data.from;
  return {
    data: {
      ...fixture.data,
      days: fixture.data.days.map((day) => ({
        ...day,
        entryCount: 1,
        sourceDiaries: [
          {
            id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
            localDate,
            revision: "2",
          },
        ],
        sourceTimeZones: ["America/Chicago"],
      })),
      goalVersions: [
        {
          goalId: "11111111-1111-4111-8111-111111111111",
          versionId: ZERO_TARGET_GOAL_VERSION_ID,
          revision: "3",
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          reference: null,
          targets: [
            {
              nutrientId: "1",
              snapshot: {
                minimumAmount: null,
                targetAmount: "0",
                maximumAmount: null,
                source: { label: "user_fixed", version: "1" },
                rationale: null,
              },
            },
          ],
        },
      ],
      targetSegments: [
        { from: localDate, to: localDate, goalVersionId: ZERO_TARGET_GOAL_VERSION_ID },
      ],
      series: fixture.data.series.map((series, index) => ({
        ...series,
        summary: {
          diaryDays: 1,
          completeDays: 1,
          exactDays: 1,
          partialDays: 0,
          unknownDays: 0,
          traceDays: 0,
          missingDays: 0,
        },
        points: series.points.map((point) => ({
          ...point,
          goalVersionId: ZERO_TARGET_GOAL_VERSION_ID,
          aggregate: {
            nutrientId: series.nutrient.id,
            code: series.nutrient.code,
            name: series.nutrient.name,
            unit: series.nutrient.unit,
            knownAmount: "1",
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
          knownPercentOfScale: "100",
          ...(index === 0
            ? {
                targetPercentOfScale: "0",
                comparison: {
                  minimumState: null,
                  targetLowerBoundPercent: null,
                  targetPercentIsExact: true,
                  maximumState: null,
                },
              }
            : {}),
        })),
      })),
    },
  };
}
