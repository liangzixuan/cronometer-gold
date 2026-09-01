import { describe, expect, it } from "vitest";

import {
  createDiaryUnauthorizedSingleFlight,
  createOperationId,
  diaryEditorOperationKey,
  diaryEditorOrigin,
  diaryEditorOriginMatches,
  diaryNoteFromDraft,
  diaryPagePath,
  diaryRouteTransitionGeneration,
  entryEnergyDisplay,
  isDiaryPageStaleProblem,
  isLocalDate,
  localDateTimeToInstant,
  mergeDiaryPages,
  nutrientDisplay,
  parseDiaryDay,
  parseDiaryMutation,
  parseDiaryPage,
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
  note: null,
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
  note: "Batch cooked\nKeep half for tomorrow.",
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

function numberedEntries(from: number, count: number) {
  return Array.from({ length: count }, (_, offset) => {
    const number = from + offset;
    return {
      ...entry,
      id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
      position: number,
    };
  });
}

function diaryPageFixture(
  entries: readonly unknown[],
  nextCursor: string | null,
  totalEntries: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    data: {
      id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
      localDate: "2026-08-15",
      timeZone: "America/Chicago",
      status: "open",
      revision: "8",
      entries,
      totals: [nutrient],
      updatedAt: "2026-08-15T13:30:01.000Z",
      ...overrides,
    },
    page: { nextCursor, totalEntries },
  };
}

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
    const exactNote = "  Batch cooked\nKeep half for tomorrow.  ";
    const recipeWithExactNote = { ...recipeEntry, note: exactNote };
    const day = parseDiaryDay({
      data: {
        id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "5",
        entries: [entry, recipeWithExactNote],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:30:01.000Z",
      },
    });
    expect(day.entries.map((candidate) => candidate.entryKind)).toEqual(["food", "recipe"]);
    expect(day.entries[1]?.entryKind === "recipe" && day.entries[1].recipe.name).toBe("Bean stew");
    expect(day.entries[1]?.note).toBe(exactNote);
  });

  it("normalizes missing or empty notes and accepts valid legacy text through 10,000 characters", () => {
    const day = (candidate: unknown) => ({
      data: {
        id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "4",
        entries: [candidate],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:30:01.000Z",
      },
    });
    const { note: _omitted, ...withoutNote } = entry;
    expect(parseDiaryDay(day(withoutNote)).entries[0]?.note).toBeNull();
    expect(parseDiaryDay(day({ ...entry, note: null })).entries[0]?.note).toBeNull();
    expect(parseDiaryDay(day({ ...entry, note: "" })).entries[0]?.note).toBeNull();
    expect(parseDiaryDay(day({ ...entry, note: "valid 🙂 text" })).entries[0]?.note).toBe(
      "valid 🙂 text",
    );
    const maximumLegacyNote = "🙂".repeat(10_000);
    expect(parseDiaryDay(day({ ...entry, note: maximumLegacyNote })).entries[0]?.note).toBe(
      maximumLegacyNote,
    );
    expect(() => parseDiaryDay(day({ ...entry, note: "🙂".repeat(10_001) }))).toThrow(TypeError);
    expect(() => parseDiaryDay(day({ ...entry, note: "contains\u0000null" }))).toThrow(TypeError);
    expect(() => parseDiaryDay(day({ ...entry, note: "\uD800" }))).toThrow(TypeError);
    expect(() => parseDiaryDay(day({ ...entry, note: "\uDC00" }))).toThrow(TypeError);
    expect(() => parseDiaryDay(day({ ...entry, note: 42 }))).toThrow(TypeError);
  });

  it("validates new note drafts while preserving exact well-formed text", () => {
    const note = "  pre-run\nfelt strong 🙂  ";
    expect(diaryNoteFromDraft(note)).toBe(note);
    expect(diaryNoteFromDraft("")).toBeNull();
    expect(diaryNoteFromDraft("🙂".repeat(2_000))).toBe("🙂".repeat(2_000));
    expect(() => diaryNoteFromDraft("a".repeat(2_001))).toThrow(RangeError);
    expect(() => diaryNoteFromDraft("contains\u0000null")).toThrow(TypeError);
    expect(() => diaryNoteFromDraft("\ud800")).toThrow(TypeError);
    expect(() => diaryNoteFromDraft("\udc00")).toThrow(TypeError);
    expect(() => diaryNoteFromDraft("\ud800not-a-pair")).toThrow(TypeError);
    expect(diaryNoteFromDraft("\ud83d\ude42")).toBe("🙂");
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

describe("mobile diary screen guards", () => {
  it("binds edits to the original entry and day snapshot", () => {
    const day = parseDiaryPage(diaryPageFixture([entry], null, 1)).data;
    const parsedEntry = day.entries[0];
    if (!parsedEntry) throw new Error("Expected a diary entry fixture.");
    const origin = diaryEditorOrigin(day, parsedEntry);

    expect(diaryEditorOriginMatches(origin, day, parsedEntry)).toBe(true);
    expect(diaryEditorOriginMatches(origin, { ...day, revision: "9" }, parsedEntry)).toBe(false);
    expect(diaryEditorOriginMatches(origin, { ...day, localDate: "2026-08-16" }, parsedEntry)).toBe(
      false,
    );
    expect(diaryEditorOriginMatches(origin, { ...day, timeZone: "UTC" }, parsedEntry)).toBe(false);
    expect(diaryEditorOriginMatches(origin, day, { ...parsedEntry, revision: "4" })).toBe(false);
    expect(diaryEditorOperationKey(origin, { mealSlot: "lunch" })).toBe(
      `edit:${entry.id}:3:8:{"mealSlot":"lunch"}`,
    );
  });

  it("treats requested date plus refresh key as one route transition generation", () => {
    const first = diaryRouteTransitionGeneration("2026-08-15", "route-1");
    expect(first).toBe(diaryRouteTransitionGeneration("2026-08-15", "route-1"));
    expect(diaryRouteTransitionGeneration("2026-08-15", "route-2")).not.toBe(first);
    expect(diaryRouteTransitionGeneration("2026-08-16", "route-1")).not.toBe(first);
    expect(diaryRouteTransitionGeneration("partial", "route-2")).toBeNull();
    expect(diaryRouteTransitionGeneration(undefined, "route-2")).toBeNull();
  });

  it("single-flights concurrent unauthorized cleanup callbacks", async () => {
    const flight = createDiaryUnauthorizedSingleFlight();
    let calls = 0;
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = async () => {
      calls += 1;
      await blocked;
    };

    const first = flight.run(action);
    const second = flight.run(action);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await first;
    expect(flight.run(action)).toBe(first);
    expect(calls).toBe(1);
  });
});

describe("mobile diary pagination", () => {
  it("builds a limit-20 page path and treats legacy data as a final page", () => {
    expect(diaryPagePath("2026-08-15")).toBe("/v1/diary?date=2026-08-15&limit=20");
    expect(diaryPagePath("2026-08-15", "d1.page_2-next")).toBe(
      "/v1/diary?date=2026-08-15&limit=20&cursor=d1.page_2-next",
    );
    expect(() => diaryPagePath("2026-08-15", "page_2.next")).toThrow(TypeError);
    expect(() => diaryPagePath("2026-08-15", "x".repeat(513))).toThrow(TypeError);
    const { page: _page, ...legacyWire } = diaryPageFixture([entry], null, 1);
    expect(parseDiaryPage(legacyWire)).toMatchObject({
      legacy: true,
      page: { nextCursor: null, totalEntries: 1 },
    });
    expect(() => parseDiaryPage({ ...legacyWire, unexpected: true })).toThrow(TypeError);
    expect(() => parseDiaryPage(diaryPageFixture([], "d1.page_2", 1))).toThrow(TypeError);
    expect(() => parseDiaryPage(diaryPageFixture([entry], "page_2.next", 2))).toThrow(TypeError);
    expect(isDiaryPageStaleProblem(409, { code: "DIARY_PAGE_STALE" })).toBe(true);
    expect(isDiaryPageStaleProblem(409, { code: "CONFLICT" })).toBe(false);
    expect(isDiaryPageStaleProblem(400, { code: "DIARY_PAGE_STALE" })).toBe(false);
  });

  it("merges 20, 20, and 5 entries without changing whole-day totals", () => {
    const first = mergeDiaryPages(
      null,
      parseDiaryPage(diaryPageFixture(numberedEntries(1, 20), "d1.page_2", 45)),
    );
    const second = mergeDiaryPages(
      first,
      parseDiaryPage(diaryPageFixture(numberedEntries(21, 20), "d1.page_3", 45)),
    );
    const complete = mergeDiaryPages(
      second,
      parseDiaryPage(diaryPageFixture(numberedEntries(41, 5), null, 45)),
    );
    expect(complete.data.entries).toHaveLength(45);
    expect(complete.data.totals).toEqual(first.data.totals);
    expect(complete.page.nextCursor).toBeNull();
  });

  it("rejects duplicate IDs, mismatched snapshots, and page overflow", () => {
    const first = mergeDiaryPages(
      null,
      parseDiaryPage(diaryPageFixture(numberedEntries(1, 20), "d1.page_2", 40)),
    );
    expect(() =>
      mergeDiaryPages(first, parseDiaryPage(diaryPageFixture(numberedEntries(20, 20), null, 40))),
    ).toThrow(TypeError);
    expect(() =>
      mergeDiaryPages(
        first,
        parseDiaryPage(
          diaryPageFixture(numberedEntries(21, 20), null, 40, {
            updatedAt: "2026-08-15T13:30:02.000Z",
          }),
        ),
      ),
    ).toThrow(TypeError);
    expect(() => parseDiaryPage(diaryPageFixture(numberedEntries(1, 21), null, 21))).toThrow(
      TypeError,
    );
  });
});
