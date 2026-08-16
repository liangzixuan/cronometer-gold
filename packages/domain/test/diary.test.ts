import { describe, expect, it } from "vitest";

import {
  aggregateDiarySnapshots,
  createDiaryNutritionSnapshot,
  type DiaryNutritionSnapshotInput,
  type DomainError,
  type NutrientAggregate,
} from "../src/index.js";
import { calculateRecipeNutrition } from "../src/recipe.js";
import { ENERGY, PORRIDGE_GOLDEN_VECTOR, PROTEIN } from "./golden-vectors.js";

function snapshotInput(nutrients: readonly NutrientAggregate[]): DiaryNutritionSnapshotInput {
  return {
    snapshotId: "snapshot-01",
    entryId: "entry-01",
    entryRevisionId: "entry-01-r1",
    supersedesRevisionId: null,
    source: {
      kind: "recipe",
      recipeId: "recipe-01",
      recipeVersionId: "recipe-01-v1",
    },
    diaryDate: "2026-08-15",
    occurredAt: "2026-08-15T08:30:00-05:00",
    timeZone: "America/Chicago",
    meal: "breakfast",
    portion: {
      enteredAmount: "1",
      enteredUnit: "serving",
      servingId: "recipe-serving",
      resolvedGrams: "200",
    },
    nutrients,
    nutritionEngineVersion: "nutrition-core@0.1.0",
    capturedAt: "2026-08-15T13:30:01Z",
    calculationWarnings: ["iron coverage is partial"],
  };
}

describe("immutable diary nutrition snapshots", () => {
  it("copies, sorts, canonicalizes, and runtime-freezes a resolved revision", () => {
    const recipe = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);
    const warnings = ["source fixture"];
    const input = { ...snapshotInput(recipe.perServing ?? []), calculationWarnings: warnings };
    const snapshot = createDiaryNutritionSnapshot(input);
    warnings.push("added after snapshot");

    expect(snapshot.calculationWarnings).toEqual(["source fixture"]);
    expect(snapshot.nutrients.map((row) => row.nutrientId)).toEqual(["energy", "iron", "protein"]);
    expect(snapshot.portion.resolvedGrams).toBe("200");
    expect(snapshot.occurredAt).toBe("2026-08-15T13:30:00.000Z");
    expect(snapshot.capturedAt).toBe("2026-08-15T13:30:01.000Z");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.source)).toBe(true);
    expect(Object.isFrozen(snapshot.nutrients)).toBe(true);
    expect(Object.isFrozen(snapshot.nutrients[0])).toBe(true);
  });

  it("propagates an absent diary nutrient as unknown, not zero", () => {
    const recipe = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);
    const first = createDiaryNutritionSnapshot(snapshotInput(recipe.perServing ?? []));
    const energyOnly = recipe.perServing?.filter((row) => row.nutrientId === "energy") ?? [];
    const second = createDiaryNutritionSnapshot({
      ...snapshotInput(energyOnly),
      snapshotId: "snapshot-02",
      entryId: "entry-02",
      entryRevisionId: "entry-02-r1",
      occurredAt: "2026-08-15T12:00:00-05:00",
    });

    const totals = aggregateDiarySnapshots([first, second], [ENERGY, PROTEIN]);
    expect(totals.find((row) => row.nutrientId === "energy")).toMatchObject({
      knownAmount: "564.4",
      completeness: "complete",
    });
    expect(totals.find((row) => row.nutrientId === "protein")).toMatchObject({
      knownAmount: "11.194",
      completeness: "partial",
      unknownCount: 1,
      unknownReasons: { not_reported: 1 },
    });
  });

  it("rejects invalid local calendar dates", () => {
    const recipe = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);
    expect(() =>
      createDiaryNutritionSnapshot({
        ...snapshotInput(recipe.perServing ?? []),
        diaryDate: "2026-02-30",
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DATE" }));
  });

  it("rejects normalized invalid instants and unsupported time zones", () => {
    const recipe = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);
    expect(() =>
      createDiaryNutritionSnapshot({
        ...snapshotInput(recipe.perServing ?? []),
        occurredAt: "2026-02-30T08:00:00Z",
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DATE" }));
    expect(() =>
      createDiaryNutritionSnapshot({
        ...snapshotInput(recipe.perServing ?? []),
        timeZone: "UTC-05:00",
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_TIME_ZONE" }));
  });

  it("rejects a client-supplied day that disagrees with the instant and profile zone", () => {
    const recipe = calculateRecipeNutrition(PORRIDGE_GOLDEN_VECTOR);
    expect(() =>
      createDiaryNutritionSnapshot({
        ...snapshotInput(recipe.perServing ?? []),
        diaryDate: "2026-08-16",
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_DATE" }));
  });
});
