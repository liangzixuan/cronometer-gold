import type { NutritionReportResponse } from "@nutrition-tracker/contracts";

export const reportOwnerId = "10000000-0000-4000-8000-000000000001";

export function nutritionReportResponseFixture(
  ownerUserId = reportOwnerId,
): NutritionReportResponse {
  return {
    data: {
      dateBasis: "active-profile-time-zone-v1",
      days: [
        {
          endsAt: "2026-09-08T05:00:00.000Z",
          entryCount: 1,
          localDate: "2026-09-07",
          sourceDiaries: [
            {
              id: "20000000-0000-4000-8000-000000000001",
              localDate: "2026-09-07",
              revision: "2",
            },
          ],
          sourceTimeZones: ["America/Chicago"],
          startsAt: "2026-09-07T05:00:00.000Z",
        },
      ],
      from: "2026-09-07",
      goalVersionBasis: "current-version-at-report-snapshot-v1",
      goalVersions: [],
      notice: "General wellness estimate; not medical advice.",
      ownerUserId,
      profileRevision: "3",
      series: Array.from({ length: 15 }, (_, index) => {
        const id = String(index + 1);
        const code = index === 0 ? "energy" : `core-${index}`;
        return {
          nutrient: {
            category: index === 0 ? ("energy" as const) : ("other" as const),
            code,
            id,
            name: index === 0 ? "Energy" : `Core ${index}`,
            unit: index === 0 ? "kcal" : "g",
          },
          points: [
            {
              aggregate: {
                code,
                completeness: "complete" as const,
                contributorCount: 1,
                isExact: true,
                knownAmount: "0",
                name: index === 0 ? "Energy" : `Core ${index}`,
                nutrientId: id,
                quantifiedCount: 1,
                traceCount: 0,
                unit: index === 0 ? "kcal" : "g",
                unknownCount: 0,
                unknownReasonCounts: {
                  not_analyzed: 0,
                  not_applicable: 0,
                  not_reported: 0,
                  withheld: 0,
                },
              },
              comparison: null,
              goalVersionId: null,
              knownPercentOfScale: "0",
              localDate: "2026-09-07",
              maximumPercentOfScale: null,
              minimumPercentOfScale: null,
              targetPercentOfScale: null,
            },
          ],
          scaleMaximum: "1",
          scalePolicy: "max-intake-or-saved-threshold-v1" as const,
          summary: {
            completeDays: 1,
            diaryDays: 1,
            exactDays: 1,
            missingDays: 0,
            partialDays: 0,
            traceDays: 0,
            unknownDays: 0,
          },
        };
      }),
      snapshotAt: "2026-09-07T12:00:00.000Z",
      targetSegments: [{ from: "2026-09-07", goalVersionId: null, to: "2026-09-07" }],
      timeZone: "America/Chicago",
      to: "2026-09-07",
      watermarkRevision: "8",
    },
  };
}
