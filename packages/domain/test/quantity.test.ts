import { describe, expect, it } from "vitest";

import {
  convertQuantity,
  type DomainError,
  quantity,
  resolvePortionToGrams,
  type ServingDefinition,
} from "../src/index.js";

const CUP_SERVING: ServingDefinition = {
  id: "fdc-measure-1",
  label: "1 cup",
  reference: { amount: "1", unit: "cup" },
  gramWeight: "240",
  source: "FDC release fixture",
};

describe("quantity conversion", () => {
  it("uses exact decimal mass conversion", () => {
    expect(convertQuantity(quantity("1.25", "kg"), "g")).toEqual({
      amount: "1250",
      unit: "g",
    });
    expect(convertQuantity(quantity("250000", "ug"), "mg")).toEqual({
      amount: "250",
      unit: "mg",
    });
  });

  it("rejects cross-dimensional generic conversion", () => {
    expect(() => convertQuantity(quantity("100", "kcal"), "g")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INCOMPATIBLE_UNITS" }),
    );
  });
});

describe("portion resolution", () => {
  it("uses a food-specific household gram weight", () => {
    expect(
      resolvePortionToGrams({
        kind: "household",
        amount: "1.5",
        unit: "cup",
        serving: CUP_SERVING,
      }),
    ).toEqual({
      grams: "360",
      conversion: {
        kind: "source-serving",
        servingId: "fdc-measure-1",
        servingSource: "FDC release fixture",
      },
    });
  });

  it("converts an explicit US volume only with a sourced density", () => {
    expect(
      resolvePortionToGrams({
        kind: "volume-with-density",
        quantity: quantity("2", "cup_us"),
        density: { gramsPerMilliliter: "1", source: "water density fixture" },
      }),
    ).toEqual({
      grams: "473.176473",
      conversion: { kind: "food-density", densitySource: "water density fixture" },
    });
  });

  it("does not silently use a selected serving for another household unit", () => {
    expect(() =>
      resolvePortionToGrams({
        kind: "household",
        amount: "1",
        unit: "tablespoon",
        serving: CUP_SERVING,
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "MISSING_CONVERSION" }));
  });

  it("rejects non-positive portions", () => {
    expect(() =>
      resolvePortionToGrams({ kind: "mass", quantity: quantity("0", "g") }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DECIMAL" }));
  });
});
