import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DiaryNutrient } from "../../lib/diary";
import {
  type NutritionReport,
  type NutritionReportSeriesPoint,
  parseNutritionReport,
  REPORT_NUTRIENTS,
} from "../../lib/nutrition-reports";
import {
  emptyNutritionReportFixture,
  zeroTargetNutritionReportFixture,
} from "../../test/nutrition-report-fixture";
import { PrintableNutritionReport } from "./PrintableNutritionReport";

function render(report: NutritionReport, nutrientId = "1") {
  return renderToStaticMarkup(createElement(PrintableNutritionReport, { report, nutrientId }));
}

function text(markup: string) {
  return markup.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ");
}

function mixedReport(): NutritionReport {
  const base = parseNutritionReport(emptyNutritionReportFixture("2026-09-01", "2026-09-07"));
  const nutrient = base.series[0]?.nutrient;
  if (!nutrient) throw new Error("Missing fixture nutrient");
  const exact: DiaryNutrient = {
    nutrientId: nutrient.id,
    code: nutrient.code,
    name: nutrient.name,
    unit: nutrient.unit,
    knownAmount: "0",
    completeness: "complete",
    isExact: true,
    contributorCount: 1,
    quantifiedCount: 1,
    traceCount: 0,
    unknownCount: 0,
    unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
  };
  const aggregates: readonly (DiaryNutrient | null)[] = [
    exact,
    { ...exact, quantifiedCount: 0, traceCount: 1, isExact: false },
    {
      ...exact,
      knownAmount: "12.345678900123456789",
      completeness: "partial",
      isExact: false,
      contributorCount: 5,
      unknownCount: 4,
      unknownReasonCounts: { not_reported: 1, not_analyzed: 1, not_applicable: 1, withheld: 1 },
    },
    {
      ...exact,
      completeness: "unknown",
      isExact: false,
      quantifiedCount: 0,
      unknownCount: 1,
      unknownReasonCounts: { not_reported: 1, not_analyzed: 0, not_applicable: 0, withheld: 0 },
    },
    null,
    { ...exact, knownAmount: "9007199254740993.000000000000000001" },
    exact,
  ];
  return {
    ...base,
    snapshotAt: "2026-09-07T15:00:37.123Z",
    profileRevision: "9007199254740993",
    watermarkRevision: "18446744073709551615",
    days: base.days.map((day, index) => ({
      ...day,
      entryCount: aggregates[index]?.contributorCount ?? 0,
      sourceTimeZones: aggregates[index] ? ["America/New_York", "America/Chicago"] : [],
      sourceDiaries: aggregates[index]
        ? [{ id: "3bcfa2bf-4950-43f7-9f24-b983ac803012", localDate: day.localDate, revision: "25" }]
        : [],
    })),
    series: base.series.map((series, seriesIndex) =>
      seriesIndex === 0
        ? {
            ...series,
            scaleMaximum: "9007199254740993.000000000000000001",
            summary: {
              diaryDays: 6,
              completeDays: 4,
              exactDays: 3,
              partialDays: 1,
              unknownDays: 1,
              traceDays: 1,
              missingDays: 1,
            },
            points: series.points.map(
              (point, index): NutritionReportSeriesPoint => ({
                ...point,
                aggregate: aggregates[index] ?? null,
                knownPercentOfScale: index === 3 || index === 4 ? null : index === 5 ? "100" : "0",
              }),
            ),
          }
        : series,
    ),
  };
}

describe("printable nutrition report evidence", () => {
  it.each(
    REPORT_NUTRIENTS.map((nutrient, index) => [nutrient.code, nutrient.unit, String(index + 1)]),
  )(
    "prints selected %s with its exact %s unit and no other nutrient booklet",
    (code, unit, nutrientId) => {
      const report = parseNutritionReport(emptyNutritionReportFixture());
      const markup = render(report, nutrientId);
      const output = text(markup);
      expect(output).toContain(`${code} (${unit})`);
      expect(output).toContain(`Logged amount (${unit})`);
      expect(output).toContain(`Daily ${code} evidence`);
      expect(markup.match(/<h1>/gu)).toHaveLength(1);
      expect(markup.match(/Daily .*? evidence<\/h2>/gu)).toHaveLength(1);
    },
  );

  it.each([1, 7, 31])("retains every day and table header for a %i-day snapshot", (days) => {
    const end = `2026-09-${String(days === 31 ? 30 : days).padStart(2, "0")}`;
    const start = days === 31 ? "2026-08-31" : "2026-09-01";
    const report = parseNutritionReport(emptyNutritionReportFixture(start, end));
    const markup = render(report);
    expect(report.days).toHaveLength(days);
    for (const day of report.days) {
      expect(markup).toContain(`<time dateTime="${day.localDate}">${day.localDate}</time>`);
      expect(markup).toContain(day.startsAt);
      expect(markup).toContain(day.endsAt);
    }
    expect(markup.match(/<thead>/gu)).toHaveLength(3);
    expect(markup.match(/scope="row"/gu)).toHaveLength(days * 2);
    expect(markup).not.toMatch(/<(?:button|input|select|nav)\b/u);
  });

  it("keeps measured zero, trace, partial, unknown and missing distinct without decimal rounding", () => {
    const output = text(render(mixedReport()));
    expect(output).toContain("0 kcal");
    expect(output).toContain("At least 0 kcal");
    expect(output).toContain("Known lower bound with 1 trace contribution.");
    expect(output).toContain("At least 12.345678900123456789 kcal");
    expect(output).toContain("4 of 5 contributions lack values.");
    expect(output).toContain("Unknown");
    expect(output).toContain("every diary contribution lacks a quantified value.");
    expect(output).toContain("Missing");
    expect(output).toContain("No diary entries; this is missing, not zero.");
    expect(output).toContain("9007199254740993.000000000000000001 kcal");
    expect(output).toContain("1 not reported; 1 not analyzed; 1 not applicable; 1 withheld.");
    expect(output).toContain(
      "Complete days 4 Exact days 3 Partial days 1 Unknown days 1 Trace days 1 Missing days 1",
    );
  });

  it("preserves exact source instants, revisions, diary IDs and historical source zones", () => {
    const report = mixedReport();
    const output = text(render(report));
    for (const value of [
      report.snapshotAt,
      report.profileRevision,
      report.watermarkRevision,
      report.dateBasis,
      report.goalVersionBasis,
    ]) {
      expect(output).toContain(value);
    }
    expect(output).toContain("America/New_York, America/Chicago");
    expect(output).toContain(
      "Diary 3bcfa2bf-4950-43f7-9f24-b983ac803012 · original date 2026-09-01 · revision 25",
    );
    expect(output).toContain("Start instants are inclusive and end instants exclusive.");
  });

  it("omits the account identity while retaining report snapshot evidence", () => {
    const report = mixedReport();
    const output = text(render(report));
    expect(output).not.toContain(report.ownerUserId);
    expect(output).not.toContain("Account ID");
    expect(output).toContain(report.profileRevision);
    expect(output).toContain(report.watermarkRevision);
  });

  it("preserves a zero saved target and its unavailable percentage instead of dividing by zero", () => {
    const report = parseNutritionReport(zeroTargetNutritionReportFixture());
    const output = text(render(report));
    expect(output).toContain("Saved target 0 kcal");
    expect(output).toContain("target percentage unavailable because the saved target is zero");
    expect(output).toContain("22222222-2222-4222-8222-222222222222");
    expect(output).toContain("Source label user_fixed Source version 1");
  });

  it("prints full saved target provenance, exclusive applicability and expiry without truncation", () => {
    const base = parseNutritionReport(zeroTargetNutritionReportFixture());
    const goal = base.goalVersions[0];
    if (!goal) throw new Error("Missing fixture goal");
    const rationale = `Saved rationale <script>never execute</script> ${"long-evidence-".repeat(60)}`;
    const report: NutritionReport = {
      ...base,
      goalVersions: [
        {
          ...goal,
          effectiveTo: "2026-09-03",
          reference: {
            templateCode: "us-ca-dri-adults-19-50",
            templateVersion: "1",
            groupCode: "male-19-50",
            policyDigest: "abcdef0123456789".repeat(4),
            eligibleThroughExclusive: "2026-09-02",
          },
          targets: [
            {
              nutrientId: "1",
              snapshot: {
                minimumAmount: "0.000000000000000001",
                targetAmount: "12.345678900123456789",
                maximumAmount: "999999999999999999.999",
                source: { label: "Saved source label", version: "saved-source-version-2026" },
                rationale,
              },
            },
          ],
        },
      ],
    };
    const markup = render(report);
    const output = text(markup);
    expect(output).toContain("until 2026-09-03 (exclusive).");
    expect(output).toContain(
      "Reference eligibility ends on 2026-09-02 (exclusive). It does not apply on or after that date",
    );
    for (const value of [
      "0.000000000000000001 kcal",
      "12.345678900123456789 kcal",
      "999999999999999999.999 kcal",
      "Saved source label",
      "saved-source-version-2026",
      "us-ca-dri-adults-19-50",
      "male-19-50",
      "abcdef0123456789".repeat(4),
      "long-evidence-".repeat(60),
    ]) {
      expect(output).toContain(value);
    }
    expect(markup).toContain("&lt;script&gt;never execute&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    expect(output).toContain("It is not a reconstruction of an older goal revision.");
  });

  it("does not substitute another nutrient if the captured selection is unavailable", () => {
    expect(render(parseNutritionReport(emptyNutritionReportFixture()), "unavailable")).toBe("");
  });
});
