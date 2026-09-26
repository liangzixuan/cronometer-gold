import { describe, expect, it } from "vitest";
import { formatNutrientAmount } from "./nutrition-display";

describe("compact nutrition amount presentation", () => {
  it("rounds exact calories to whole values and groups thousands without changing the source", () => {
    const amount = "1683.975000000000";
    expect(formatNutrientAmount(amount, "kcal")).toBe("1,684 kcal");
    expect(formatNutrientAmount("1683.499999999999999999999", "kcal")).toBe("1,683 kcal");
    expect(formatNutrientAmount("1683.500000000000000000001", "kcal")).toBe("1,684 kcal");
    expect(amount).toBe("1683.975000000000");
  });
  it("uses at most one fractional digit for macros and micronutrients", () => {
    expect(formatNutrientAmount("57.650000", "g")).toBe("57.7 g");
    expect(formatNutrientAmount("57.649999999999999999999999", "g")).toBe("57.6 g");
    expect(formatNutrientAmount("54.000000", "g")).toBe("54 g");
    expect(formatNutrientAmount("1234.540000", "mg")).toBe("1,234.5 mg");
  });
  it("floors partial, trace and estimated lower bounds without overstating known intake", () => {
    expect(formatNutrientAmount("1683.975", "kcal", { lowerBound: true })).toBe("≥ 1,683 kcal");
    expect(formatNutrientAmount("57.699999999999999999999999", "g", { lowerBound: true })).toBe(
      "≥ 57.6 g",
    );
    expect(
      formatNutrientAmount("57.699", "g", { lowerBound: true, lowerBoundPrefix: "At least" }),
    ).toBe("At least 57.6 g");
  });
  it("distinguishes tiny exact values, tiny positive lower bounds and measured zero", () => {
    expect(formatNutrientAmount("0.04", "g")).toBe("<0.1 g");
    expect(formatNutrientAmount("0.4", "kcal")).toBe("<1 kcal");
    expect(formatNutrientAmount("0.04", "g", { lowerBound: true })).toBe(">0 g");
    expect(formatNutrientAmount("0.4", "kcal", { lowerBound: true })).toBe(">0 kcal");
    expect(formatNutrientAmount("0.000000", "g")).toBe("0 g");
    expect(formatNutrientAmount("0.000000", "g", { lowerBound: true })).toBe("≥ 0 g");
    expect(formatNutrientAmount(`0.${"0".repeat(166)}1`, "mg")).toBe("<0.1 mg");
  });
  it("preserves meaningful digits beyond binary floating-point precision", () => {
    expect(formatNutrientAmount("9007199254740993.49", "kcal")).toBe("9,007,199,254,740,993 kcal");
    expect(formatNutrientAmount("9007199254740993.5", "kcal")).toBe("9,007,199,254,740,994 kcal");
    expect(formatNutrientAmount("9007199254740993.19", "mg", { lowerBound: true })).toBe(
      "≥ 9,007,199,254,740,993.1 mg",
    );
  });
  it("rejects invalid display amounts rather than exposing NaN or Infinity", () => {
    for (const amount of ["", "NaN", "Infinity", "1e6", "-1", "1,000"])
      expect(() => formatNutrientAmount(amount, "kcal")).toThrow(TypeError);
  });
});
