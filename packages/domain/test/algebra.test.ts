import { describe, expect, it } from "vitest";

import {
  calculatePortionNutrition,
  combineNutrientAggregates,
  convertQuantity,
  createNutrientProfile,
  knownNutrient,
  nutrientDatum,
  quantity,
  sumDecimals,
} from "../src/index.js";
import { ENERGY } from "./golden-vectors.js";

/** Deterministic edge-heavy cases provide property coverage without RNG flakes. */
const POSITIVE_DECIMAL_CASES = [
  "0.000001",
  "0.1",
  "0.333333333333333333",
  "1",
  "2.5",
  "99.999",
  "1000",
] as const;

describe("calculation algebra properties", () => {
  it.each(POSITIVE_DECIMAL_CASES)("round-trips mass units for %s g", (amount) => {
    const roundTrip = convertQuantity(convertQuantity(quantity(amount, "g"), "ug"), "g");
    expect(roundTrip).toEqual({ amount, unit: "g" });
  });

  it("portion scaling is additive over exact decimal quantities", () => {
    const profile = createNutrientProfile("100", [
      nutrientDatum(ENERGY, knownNutrient("123.456", "measured")),
    ]);

    for (const leftGrams of POSITIVE_DECIMAL_CASES) {
      for (const rightGrams of POSITIVE_DECIMAL_CASES) {
        const left = calculatePortionNutrition(profile, leftGrams, [ENERGY])[0];
        const right = calculatePortionNutrition(profile, rightGrams, [ENERGY])[0];
        const whole = calculatePortionNutrition(profile, sumDecimals([leftGrams, rightGrams]), [
          ENERGY,
        ])[0];
        if (!left || !right || !whole) throw new Error("energy fixture did not resolve");

        const combined = combineNutrientAggregates(ENERGY, [left, right]);
        expect(combined.knownAmount).toBe(whole.knownAmount);
        expect(combined.isExact).toBe(true);
      }
    }
  });
});
