import { describe, expect, it } from "vitest";

import {
  createOperationId,
  entryEnergyDisplay,
  isLocalDate,
  localDateTimeToInstant,
  nutrientDisplay,
  parseDiaryDay,
  parseDiaryMutation,
  prepareQuickAddOperation,
  quickAddOccurredAt,
} from "./diary";

const nutrient = {
  nutrientId: "1008",
  code: "energy",
  name: "Energy",
  unit: "kcal",
  knownAmount: "95.25",
  completeness: "complete",
  isExact: true,
  contributorCount: 1,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 0,
  unknownReasonCounts: { not_reported: 0, not_analyzed: 0, not_applicable: 0, withheld: 0 },
} as const;

const entry = {
  id: "75d7fa63-4e26-42de-a1f8-0683ce268f62",
  revision: "3",
  entryKind: "food",
  foodVersionId: "202",
  recipeVersionId: null,
  portion: { kind: "serving", servingId: "303", amount: "1.5", servingLabel: "medium apple" },
  food: { name: "Apple", brandName: null },
  recipe: null,
  source: {
    code: "USDA_FDC",
    releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
  },
  foodProvenance: {
    kind: "public",
    source: {
      code: "USDA_FDC",
      releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
      displayName: "USDA FoodData Central",
      licenseExpression: "CC0-1.0",
      attributionRequired: true,
      attributionText: "Data source: USDA FoodData Central",
    },
  },
  mealSlot: "breakfast",
  resolvedGrams: "150",
  occurredAt: "2026-08-15T13:30:00.000Z",
  localDate: "2026-08-15",
  timeZone: "America/Chicago",
  localTime: "08:30:00.000",
  position: 0,
  nutrients: [nutrient],
} as const;

const { foodProvenance: _publicFoodProvenance, ...entryWithoutFoodProvenance } = entry;
const recipeEntry = {
  ...entryWithoutFoodProvenance,
  id: "c8a7c76f-3c1d-445c-9160-152e57b29e40",
  entryKind: "recipe" as const,
  foodVersionId: null,
  recipeVersionId: "de1f6d0a-f7dc-4b25-b7b9-3eef1d44779a",
  portion: { kind: "serving" as const, amount: "1", servingLabel: "bowl" },
  food: null,
  recipe: {
    id: "df94a52f-e84a-4cd5-873e-227d1e213d62",
    name: "Bean stew",
    versionNumber: 2,
    yieldGrams: "800",
    yieldSource: "measured" as const,
    servingCount: "4",
    servingLabel: "bowl",
    calculationVersion: "recipe-v1",
    retentionPolicy: {
      code: "identity-retention-default" as const,
      version: "1" as const,
      assumption: "No cooking-retention factor was applied.",
    },
    warnings: [
      {
        code: "RETENTION_FACTORS_DEFAULTED" as const,
        message: "Nutrients use identity retention.",
        nutrientIds: [],
      },
    ],
  },
  source: null,
  sources: [entry.source],
} as const;

const privateCustomEntry = {
  ...entry,
  id: "a8a7c76f-3c1d-445c-9160-152e57b29e41",
  foodVersionId: "404",
  source: null,
  food: { name: "Owner oats", brandName: null },
  foodProvenance: {
    kind: "private_custom" as const,
    customFoodId: "b8a7c76f-3c1d-445c-9160-152e57b29e42",
    customFoodVersionNumber: 3,
  },
} as const;

describe("mobile diary contract", () => {
  it("preserves portions, revisions, and exact nutrient decimal strings", () => {
    const day = parseDiaryDay({
      data: {
        id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "4",
        entries: [entry],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:30:01.000Z",
      },
    });
    expect(day.entries[0]?.portion).toEqual(entry.portion);
    const parsedEntry = day.entries[0];
    if (!parsedEntry) throw new Error("Expected a diary entry fixture.");
    expect(entryEnergyDisplay(parsedEntry)).toBe("95.25 kcal");
    expect(
      parseDiaryMutation({
        data: {
          replayed: false,
          entry,
          affectedDays: [{ localDate: "2026-08-15", revision: "4" }],
        },
      }).entry?.revision,
    ).toBe("3");
  });

  it("strictly parses a mixed food and immutable recipe day", () => {
    const day = parseDiaryDay({
      data: {
        id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "5",
        entries: [entry, recipeEntry],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:30:01.000Z",
      },
    });
    expect(day.entries.map((candidate) => candidate.entryKind)).toEqual(["food", "recipe"]);
    expect(day.entries[1]?.entryKind === "recipe" && day.entries[1].recipe.name).toBe("Bean stew");
  });

  it("accepts owner-entered private food without fabricating a public source", () => {
    const result = parseDiaryMutation({
      data: {
        replayed: true,
        entry: privateCustomEntry,
        affectedDays: [{ localDate: "2026-08-15", revision: "6" }],
      },
    });
    expect(result.entry?.entryKind).toBe("food");
    if (result.entry?.entryKind !== "food") throw new Error("Expected a food entry.");
    expect(result.entry.foodProvenance).toEqual(privateCustomEntry.foodProvenance);
    expect(result.entry.source).toBeNull();
  });

  it("preserves long exact subnormal nutrient amounts within the 160-character bound", () => {
    const knownAmount = `0.${"0".repeat(166)}1`;
    const day = parseDiaryDay({
      data: {
        id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "4",
        entries: [{ ...entry, nutrients: [{ ...nutrient, knownAmount }] }],
        totals: [{ ...nutrient, knownAmount }],
        updatedAt: "2026-08-15T13:30:01.000Z",
      },
    });
    expect(day.totals[0]?.knownAmount).toBe(knownAmount);
    expect(knownAmount.length).toBeGreaterThan(160);
  });

  it("accepts high-precision resolved recipe output without widening request portions", () => {
    const resolved = `33.${"3".repeat(100)}`;
    const day = parseDiaryDay({
      data: {
        id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "5",
        entries: [
          {
            ...recipeEntry,
            resolvedGrams: resolved,
            recipe: { ...recipeEntry.recipe, yieldGrams: resolved },
          },
        ],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:30:01.000Z",
      },
    });
    expect(day.entries[0]?.resolvedGrams).toBe(resolved);
    expect(day.entries[0]?.entryKind === "recipe" && day.entries[0].recipe.yieldGrams).toBe(
      resolved,
    );
  });

  it("rejects serving responses that omit the immutable label", () => {
    const { servingLabel: _omitted, ...portionWithoutLabel } = entry.portion;
    expect(() =>
      parseDiaryDay({
        data: {
          id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          status: "open",
          revision: "4",
          entries: [{ ...entry, portion: portionWithoutLabel }],
          totals: [nutrient],
          updatedAt: "2026-08-15T13:30:01.000Z",
        },
      }),
    ).toThrow(TypeError);
  });

  it("rejects a non-paginated day beyond the 50-entry response budget", () => {
    expect(() =>
      parseDiaryDay({
        data: {
          id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          status: "open",
          revision: "51",
          entries: Array.from({ length: 51 }, () => entry),
          totals: [nutrient],
          updatedAt: "2026-08-15T13:30:01.000Z",
        },
      }),
    ).toThrow(TypeError);
  });

  it("renders trace-containing complete totals as lower bounds", () => {
    expect(
      nutrientDisplay({ ...nutrient, isExact: false, quantifiedCount: 0, traceCount: 1 }),
    ).toEqual({
      amount: "≥ 95.25 kcal",
      qualification: "Complete coverage · includes trace values",
    });
  });

  it("rejects contradictory or negative nutrient certainty counts", () => {
    const day = (candidate: unknown) => ({
      data: {
        id: null,
        localDate: "2026-08-15",
        timeZone: "UTC",
        status: "open",
        revision: "0",
        entries: [],
        totals: [candidate],
        updatedAt: null,
      },
    });
    expect(() =>
      parseDiaryDay(day({ ...nutrient, completeness: "partial", isExact: false })),
    ).toThrow(TypeError);
    expect(() =>
      parseDiaryDay(
        day({ ...nutrient, contributorCount: 1, quantifiedCount: 2, unknownCount: -1 }),
      ),
    ).toThrow(TypeError);
  });

  it("does not describe complete reported coverage as measurement exactness", () => {
    expect(nutrientDisplay(nutrient).qualification).toBe("Complete coverage · quantified");
  });

  it("converts profile-zone local time and rejects DST gaps", () => {
    expect(isLocalDate("0000-01-01")).toBe(false);
    expect(localDateTimeToInstant("2026-08-15", "08:30", "America/Chicago")).toBe(
      "2026-08-15T13:30:00.000Z",
    );
    expect(localDateTimeToInstant("2026-08-15", "13:00", "America/New_York")).toBe(
      "2026-08-15T17:00:00.000Z",
    );
    expect(() => localDateTimeToInstant("2026-03-08", "02:30", "America/Chicago")).toThrow(
      RangeError,
    );
  });

  it("preserves the second repeated-hour instant when quick-adding today", () => {
    const secondFold = new Date("2026-11-01T07:30:45.123Z");
    expect(quickAddOccurredAt("2026-11-01", "America/Chicago", secondFold)).toBe(
      "2026-11-01T07:30:45.123Z",
    );
  });

  it("reuses the exact quick-add body and id after a lost response", () => {
    const pending = new Map<string, ReturnType<typeof prepareQuickAddOperation>>();
    const input = {
      foodVersionId: "202",
      servingId: "303",
      localDate: "2026-11-01",
      mealSlot: "breakfast" as const,
      timeZone: "America/Chicago",
    };
    const first = prepareQuickAddOperation(
      pending,
      input,
      new Date("2026-11-01T07:30:45.123Z"),
      () => "a7183708-7725-4b7c-a180-58e03ca01234",
    );
    pending.set(first.intentKey, first);
    const retry = prepareQuickAddOperation(
      pending,
      input,
      new Date("2026-11-01T07:31:59.999Z"),
      () => "f2a47c26-8e02-4057-8b48-cda619302452",
    );
    expect(retry).toBe(first);
    expect(retry.body).toEqual(first.body);
    expect(retry.operationId).toBe("a7183708-7725-4b7c-a180-58e03ca01234");

    const secondIntent = prepareQuickAddOperation(
      pending,
      { ...input, localDate: "2026-11-02" },
      new Date("2026-11-01T07:32:00.000Z"),
      () => "f2a47c26-8e02-4057-8b48-cda619302452",
    );
    pending.set(secondIntent.intentKey, secondIntent);
    expect(secondIntent.operationId).toBe("f2a47c26-8e02-4057-8b48-cda619302452");

    pending.delete(secondIntent.intentKey);
    const firstAfterSecond = prepareQuickAddOperation(
      pending,
      input,
      new Date("2026-11-01T07:33:00.000Z"),
      () => "93f88742-d39c-4f6c-95a1-8b292b12a93d",
    );
    expect(firstAfterSecond).toBe(first);
  });

  it("fails closed when the secure UUID source fails or returns malformed data", () => {
    expect(createOperationId(() => "a7183708-7725-4b7c-a180-58e03ca01234")).toBe(
      "a7183708-7725-4b7c-a180-58e03ca01234",
    );
    expect(() => createOperationId(() => "collision-prone")).toThrow(TypeError);
    expect(() =>
      createOperationId(() => {
        throw new Error("secure source unavailable");
      }),
    ).toThrow("secure source unavailable");
  });
});
