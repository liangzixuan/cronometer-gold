import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DiaryNutrient } from "../../lib/diary";
import { DailySummary } from "./DailySummary";

function nutrient(code: string, overrides: Partial<DiaryNutrient> = {}): DiaryNutrient {
  return {
    nutrientId: code,
    code,
    name: code,
    unit: code === "energy" ? "kcal" : "g",
    knownAmount: "125.500000",
    completeness: "complete",
    isExact: true,
    contributorCount: 1,
    quantifiedCount: 1,
    traceCount: 0,
    unknownCount: 0,
    unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
    ...overrides,
  };
}

function renderSummary(totals: readonly DiaryNutrient[], totalEntries = 45) {
  return renderToStaticMarkup(<DailySummary totals={totals} totalEntries={totalEntries} />);
}

describe("daily nutrition summary", () => {
  it("renders authoritative whole-day totals and entry counts with compact display values", () => {
    const markup = renderSummary([
      nutrient("energy", { knownAmount: "1540.750000" }),
      nutrient("protein", { knownAmount: "96.125000" }),
      nutrient("carbohydrate", { knownAmount: "0" }),
      nutrient("fat", { knownAmount: "54.375000" }),
    ]);

    expect(markup).toContain('aria-labelledby="daily-summary-title"');
    expect(markup).toContain("45 entries logged");
    expect(markup).toContain("Totals cover all 45 diary entries for this day.");
    expect(markup).toContain("1,541 kcal");
    expect(markup).toContain("96.1 g");
    expect(markup).toContain("54.4 g");
    expect(markup).toMatch(/data-nutrient="carbohydrate".*?>Carbs<.*?>0 g</su);
    expect(markup.match(/Complete coverage · quantified/gu)).toHaveLength(4);
  });

  it("preserves partial, trace and estimated lower bounds", () => {
    const markup = renderSummary([
      nutrient("energy", {
        completeness: "partial",
        isExact: false,
        contributorCount: 3,
        quantifiedCount: 2,
        unknownCount: 1,
        unknownReasonCounts: { not_reported: 1, not_analyzed: 0, not_applicable: 0, withheld: 0 },
      }),
      nutrient("protein", { isExact: false, traceCount: 1, quantifiedCount: 0 }),
      nutrient("fat", { isExact: false }),
    ]);

    expect(markup).toContain("≥ 125 kcal");
    expect(markup).toContain("Partial · 2/3 contributions quantified");
    expect(markup).toContain("Complete coverage · includes trace values");
    expect(markup).toContain("Complete coverage · estimated");
    expect(markup.match(/≥ 125.5 g/gu)).toHaveLength(2);
    expect(markup).toContain("Partial totals are lower bounds.");
  });

  it("keeps unknown and absent nutrient totals distinct from measured zero", () => {
    const markup = renderSummary(
      [
        nutrient("energy", {
          knownAmount: "0",
          completeness: "unknown",
          isExact: false,
          quantifiedCount: 0,
          unknownCount: 1,
          unknownReasonCounts: { not_reported: 1, not_analyzed: 0, not_applicable: 0, withheld: 0 },
        }),
      ],
      1,
    );

    expect(markup).toContain("1 entry logged");
    expect(markup.match(/>Unknown</gu)).toHaveLength(4);
    expect(markup).toContain("0/1 contributions quantified");
    expect(markup.match(/No nutrient total available/gu)).toHaveLength(3);
    expect(markup).not.toMatch(/>0 (g|kcal)</u);
    expect(markup).toContain("Unknown values are never counted as zero.");
  });

  it("shows an empty diary without inventing zero nutrition or targets", () => {
    const markup = renderSummary([], 0);

    expect(markup).toContain("0 entries logged");
    expect(markup.match(/>Unknown</gu)).toHaveLength(4);
    expect(markup).not.toMatch(/>0 (g|kcal)<|progressbar|%|remaining|net calories/iu);
  });
});
