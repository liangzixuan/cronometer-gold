import { describe, expect, it } from "vitest";

import {
  calculatePortionNutrition,
  combineNutrientAggregates,
  createNutrientProfile,
  type DomainError,
  knownNutrient,
  nutrientDatum,
  traceNutrient,
  unknownNutrient,
} from "../src/index.js";
import { IRON, PROTEIN } from "./golden-vectors.js";

describe("nutrient missingness", () => {
  it("keeps a quantified zero distinct from unknown and trace", () => {
    const profile = createNutrientProfile("100", [
      nutrientDatum(PROTEIN, knownNutrient("0", "label")),
      nutrientDatum(IRON, unknownNutrient("not_analyzed")),
    ]);
    const resolved = calculatePortionNutrition(profile, "50", [PROTEIN, IRON]);

    expect(resolved[0]).toMatchObject({
      nutrientId: "protein",
      knownAmount: "0",
      completeness: "complete",
      isExact: true,
      quantifiedCount: 1,
      unknownCount: 0,
    });
    expect(resolved[1]).toMatchObject({
      nutrientId: "iron",
      knownAmount: "0",
      completeness: "unknown",
      isExact: false,
      quantifiedCount: 0,
      unknownCount: 1,
      unknownReasons: { not_analyzed: 1 },
    });
  });

  it("returns a lower-bound known subtotal plus coverage", () => {
    const known = calculatePortionNutrition(
      createNutrientProfile("100", [nutrientDatum(IRON, knownNutrient("6"))]),
      "50",
      [IRON],
    )[0];
    const missing = calculatePortionNutrition(
      createNutrientProfile("100", [nutrientDatum(IRON, unknownNutrient("not_reported"))]),
      "50",
      [IRON],
    )[0];
    if (!known || !missing) throw new Error("fixture did not resolve iron");

    expect(combineNutrientAggregates(IRON, [known, missing])).toMatchObject({
      knownAmount: "3",
      completeness: "partial",
      isExact: false,
      contributorCount: 2,
      quantifiedCount: 1,
      unknownCount: 1,
    });
  });

  it("marks analyzed trace as complete coverage but not exact", () => {
    const [resolved] = calculatePortionNutrition(
      createNutrientProfile("100", [nutrientDatum(IRON, traceNutrient("0.01"))]),
      "25",
      [IRON],
    );
    expect(resolved).toMatchObject({
      knownAmount: "0",
      completeness: "complete",
      isExact: false,
      traceCount: 1,
      unknownCount: 0,
    });
  });

  it("rejects coverage sums that cannot remain exact JavaScript integers", () => {
    const count = 5_000_000_000_000_000;
    const contribution = {
      nutrientId: IRON.id,
      unit: IRON.canonicalUnit,
      knownAmount: "1",
      completeness: "complete" as const,
      isExact: true,
      contributorCount: count,
      quantifiedCount: count,
      traceCount: 0,
      unknownCount: 0,
      unknownReasons: {},
    };
    expect(() => combineNutrientAggregates(IRON, [contribution, contribution])).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_NUTRIENT_AGGREGATE" }),
    );
  });

  it("rejects a profile with duplicate nutrient ids", () => {
    expect(() =>
      createNutrientProfile("100", [
        nutrientDatum(IRON, knownNutrient("1")),
        nutrientDatum(IRON, knownNutrient("2")),
      ]),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "DUPLICATE_NUTRIENT" }));
  });
});
