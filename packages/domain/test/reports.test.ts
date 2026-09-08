import { describe, expect, it } from "vitest";

import {
  assertNutritionReportRange,
  nutritionReportLocalDates,
  nutritionReportScale,
  nutritionReportScalePercent,
} from "../src/index.js";

describe("nutrition report policies", () => {
  it("accepts one through 31 inclusive calendar days and rejects other ranges", () => {
    expect(assertNutritionReportRange("2026-01-01", "2026-01-01")).toBe(1);
    expect(assertNutritionReportRange("2026-01-01", "2026-01-31")).toBe(31);
    expect(() => assertNutritionReportRange("2026-01-01", "2026-02-01")).toThrow();
    expect(() => assertNutritionReportRange("2026-01-02", "2026-01-01")).toThrow();
    expect(() => assertNutritionReportRange("0000-01-01", "0000-01-01")).toThrow();
    expect(() => assertNutritionReportRange("0001-12-31", "0001-12-31")).toThrow();
    expect(() => assertNutritionReportRange("9999-01-01", "9999-01-01")).toThrow();
  });

  it("enumerates leap-day ranges without local-time or DST arithmetic", () => {
    expect(nutritionReportLocalDates("2028-02-28", "2028-03-01")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("derives bounded chart values from exact decimal strings", () => {
    const scale = nutritionReportScale(["0", "2.5", "10", null]);
    expect(scale).toBe("10");
    expect(nutritionReportScalePercent("2.5", scale)).toBe("25");
    expect(nutritionReportScalePercent("0.333333", "1")).toBe("33.333");
    expect(() => nutritionReportScalePercent("11", scale)).toThrow();
    expect(nutritionReportScale(["0", null])).toBe("1");
  });
});
