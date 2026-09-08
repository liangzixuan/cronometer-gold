import { Ajv, type AnySchema } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import { nutritionReportQuerySchema, nutritionReportResponseSchema } from "./index.js";

const addFormats = addFormatsModule.default as unknown as (ajv: Ajv) => Ajv;

function validator(schema: AnySchema) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const nutrient = {
  id: "1",
  code: "energy",
  name: "Energy",
  unit: "kcal",
  category: "energy",
} as const;
const aggregate = {
  nutrientId: "1",
  code: "energy",
  name: "Energy",
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
} as const;

function fixture() {
  return {
    data: {
      ownerUserId: "10000000-0000-4000-8000-000000000001",
      profileRevision: "2",
      timeZone: "America/Chicago",
      watermarkRevision: "9",
      snapshotAt: "2026-09-07T12:00:00.000Z",
      dateBasis: "active-profile-time-zone-v1",
      goalVersionBasis: "current-version-at-report-snapshot-v1",
      from: "2026-09-07",
      to: "2026-09-07",
      days: [
        {
          localDate: "2026-09-07",
          startsAt: "2026-09-07T05:00:00.000Z",
          endsAt: "2026-09-08T05:00:00.000Z",
          entryCount: 1,
          sourceDiaries: [
            {
              id: "20000000-0000-4000-8000-000000000001",
              localDate: "2026-09-07",
              revision: "3",
            },
          ],
          sourceTimeZones: ["America/Chicago"],
        },
      ],
      goalVersions: [],
      targetSegments: [{ from: "2026-09-07", to: "2026-09-07", goalVersionId: null }],
      series: Array.from({ length: 15 }, (_, index) => ({
        nutrient: {
          ...nutrient,
          id: String(index + 1),
          code: index === 0 ? "energy" : `nutrient-${index}`,
        },
        scalePolicy: "max-intake-or-saved-threshold-v1",
        scaleMaximum: "1",
        summary: {
          completeDays: 1,
          diaryDays: 1,
          exactDays: 1,
          partialDays: 0,
          unknownDays: 0,
          traceDays: 0,
          missingDays: 0,
        },
        points: [
          {
            localDate: "2026-09-07",
            goalVersionId: null,
            aggregate: {
              ...aggregate,
              nutrientId: String(index + 1),
              code: index === 0 ? "energy" : `nutrient-${index}`,
            },
            knownPercentOfScale: "0",
            minimumPercentOfScale: null,
            targetPercentOfScale: null,
            maximumPercentOfScale: null,
            comparison: null,
          },
        ],
      })),
      notice: "General wellness estimate; not medical advice.",
    },
  };
}

describe("nutrition report schemas", () => {
  it("accepts only the closed from/to query", () => {
    const validate = validator(nutritionReportQuerySchema);
    expect(validate({ from: "2026-09-01", to: "2026-09-07" })).toBe(true);
    expect(validate({ from: "2026-09-01", to: "2026-09-07", nutrientId: "1" })).toBe(false);
    expect(validate({ from: "0000-09-01", to: "2026-09-07" })).toBe(false);
  });

  it("validates the complete closed response and preserves exact zero", () => {
    const validate = validator(nutritionReportResponseSchema);
    const report = fixture();
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...report, data: { ...report.data, unexpected: true } })).toBe(false);
    expect(
      validate({ ...report, data: { ...report.data, series: report.data.series.slice(0, 14) } }),
    ).toBe(false);
    const broken = fixture();
    const brokenAggregate = broken.data.series[0]?.points[0]?.aggregate as {
      contributorCount: number;
    } | null;
    if (!brokenAggregate) throw new TypeError("Test fixture aggregate is missing");
    brokenAggregate.contributorCount = 0;
    expect(validate(broken)).toBe(false);
  });
});
