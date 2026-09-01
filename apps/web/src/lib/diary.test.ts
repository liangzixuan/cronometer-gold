import { describe, expect, it } from "vitest";

import {
  diaryEditErrorMessage,
  diaryEditorOperationKey,
  diaryEditorOrigin,
  diaryEditorOriginMatches,
  diaryEntryNoteCharacterCount,
  diaryPagePath,
  entryEnergyDisplay,
  isDiaryPageStaleProblem,
  isLocalDate,
  localDateTimeToInstant,
  mergeDiaryPages,
  nutrientDisplay,
  parseDiaryDay,
  parseDiaryMutation,
  parseDiaryPage,
  prepareDiaryEntryNote,
  prepareDiaryEntryNotePatch,
  prepareQuickAddOperation,
  quickAddOccurredAt,
  resolveDiaryRouteDate,
  shiftLocalDate,
} from "./diary";

const nutrient = {
  nutrientId: "1",
  code: "ENERGY_KCAL",
  name: "Energy",
  unit: "kcal",
  knownAmount: "125.500000000000",
  completeness: "partial",
  isExact: false,
  contributorCount: 2,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 1,
  unknownReasonCounts: {
    not_reported: 1,
    not_analyzed: 0,
    not_applicable: 0,
    withheld: 0,
  },
} as const;

const entry = {
  id: "96aac405-c107-4776-923e-a40ca5014975",
  revision: "3",
  entryKind: "food",
  foodVersionId: "202",
  recipeVersionId: null,
  portion: { kind: "serving", servingId: "303", amount: "1", servingLabel: "medium apple" },
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
  resolvedGrams: "182.000000",
  note: null,
  occurredAt: "2026-08-15T13:30:00.000Z",
  localDate: "2026-08-15",
  timeZone: "America/Chicago",
  localTime: "08:30:00",
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
      id: "41b5f2ea-2274-4b98-8b13-96504d176917",
      localDate: "2026-08-15",
      timeZone: "America/Chicago",
      status: "open",
      revision: "8",
      entries,
      totals: [nutrient],
      updatedAt: "2026-08-15T13:31:00.000Z",
      ...overrides,
    },
    page: { nextCursor, totalEntries },
  };
}

describe("web diary contract", () => {
  it("preserves exact decimal strings and labels partial totals as lower bounds", () => {
    const diary = parseDiaryDay({
      data: {
        id: "41b5f2ea-2274-4b98-8b13-96504d176917",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "4",
        entries: [entry],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:31:00.000Z",
      },
    });
    expect(diary.totals[0]?.knownAmount).toBe("125.500000000000");
    const total = diary.totals[0];
    if (!total) throw new Error("Expected a nutrient total fixture.");
    expect(nutrientDisplay(total).amount).toBe("≥ 125.500000000000 kcal");
  });

  it("strictly parses a mixed food and immutable recipe day", () => {
    const diary = parseDiaryDay({
      data: {
        id: "41b5f2ea-2274-4b98-8b13-96504d176917",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "5",
        entries: [entry, recipeEntry],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:31:00.000Z",
      },
    });
    expect(diary.entries.map((candidate) => candidate.entryKind)).toEqual(["food", "recipe"]);
    expect(diary.entries[1]?.entryKind === "recipe" && diary.entries[1].recipe.name).toBe(
      "Bean stew",
    );
  });

  it("normalizes a missing legacy note and preserves exact multiline notes", () => {
    const note = "  Ate after a long run.\nSecond line stays exact.  ";
    const diary = parseDiaryDay({
      data: {
        id: "41b5f2ea-2274-4b98-8b13-96504d176917",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "5",
        entries: [{ ...entry, note }],
        totals: [nutrient],
        updatedAt: "2026-08-15T13:31:00.000Z",
      },
    });
    expect(diary.entries[0]?.note).toBe(note);

    const { note: _omitted, ...entryWithoutNote } = entry;
    expect(
      parseDiaryDay({
        data: {
          id: "41b5f2ea-2274-4b98-8b13-96504d176917",
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          status: "open",
          revision: "5",
          entries: [entryWithoutNote],
          totals: [nutrient],
          updatedAt: "2026-08-15T13:31:00.000Z",
        },
      }).entries[0]?.note,
    ).toBeNull();
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
    const diary = parseDiaryDay({
      data: {
        id: "41b5f2ea-2274-4b98-8b13-96504d176917",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "4",
        entries: [{ ...entry, nutrients: [{ ...nutrient, knownAmount }] }],
        totals: [{ ...nutrient, knownAmount }],
        updatedAt: "2026-08-15T13:31:00.000Z",
      },
    });
    expect(diary.totals[0]?.knownAmount).toBe(knownAmount);
    expect(knownAmount.length).toBeGreaterThan(160);
  });

  it("accepts high-precision resolved recipe output without widening request portions", () => {
    const resolved = `33.${"3".repeat(100)}`;
    const diary = parseDiaryDay({
      data: {
        id: "41b5f2ea-2274-4b98-8b13-96504d176917",
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
        updatedAt: "2026-08-15T13:31:00.000Z",
      },
    });
    expect(diary.entries[0]?.resolvedGrams).toBe(resolved);
    expect(diary.entries[0]?.entryKind === "recipe" && diary.entries[0].recipe.yieldGrams).toBe(
      resolved,
    );
  });

  it("requires the immutable serving label in diary responses", () => {
    const { servingLabel: _omitted, ...portionWithoutLabel } = entry.portion;
    expect(() =>
      parseDiaryDay({
        data: {
          id: "41b5f2ea-2274-4b98-8b13-96504d176917",
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          status: "open",
          revision: "4",
          entries: [{ ...entry, portion: portionWithoutLabel }],
          totals: [nutrient],
          updatedAt: "2026-08-15T13:31:00.000Z",
        },
      }),
    ).toThrow(TypeError);
  });

  it("rejects a non-paginated day beyond the 50-entry response budget", () => {
    expect(() =>
      parseDiaryDay({
        data: {
          id: "41b5f2ea-2274-4b98-8b13-96504d176917",
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          status: "open",
          revision: "51",
          entries: Array.from({ length: 51 }, () => entry),
          totals: [nutrient],
          updatedAt: "2026-08-15T13:31:00.000Z",
        },
      }),
    ).toThrow(TypeError);
  });

  it("rejects aggregates whose completeness counts cannot be audited", () => {
    expect(() =>
      parseDiaryDay({
        data: {
          id: null,
          localDate: "2026-08-15",
          timeZone: "UTC",
          status: "open",
          revision: "0",
          entries: [],
          totals: [{ ...nutrient, contributorCount: 9 }],
          updatedAt: null,
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseDiaryDay({
        data: {
          id: null,
          localDate: "2026-08-15",
          timeZone: "UTC",
          status: "open",
          revision: "0",
          entries: [],
          totals: [{ ...nutrient, completeness: "complete", isExact: true }],
          updatedAt: null,
        },
      }),
    ).toThrow(TypeError);
  });

  it("keeps complete trace-containing totals visibly lower-bounded", () => {
    const trace = {
      ...nutrient,
      completeness: "complete" as const,
      isExact: false,
      quantifiedCount: 1,
      traceCount: 1,
      unknownCount: 0,
      unknownReasonCounts: {
        not_reported: 0,
        not_analyzed: 0,
        not_applicable: 0,
        withheld: 0,
      },
    };
    expect(nutrientDisplay(trace)).toEqual({
      amount: "≥ 125.500000000000 kcal",
      qualification: "Complete coverage · includes trace values",
    });
    expect(entryEnergyDisplay({ ...entry, nutrients: [{ ...trace, code: "energy" }] })).toBe(
      "≥ 125.500000000000 kcal",
    );
  });

  it("does not conflate complete coverage with measurement exactness", () => {
    expect(
      nutrientDisplay({
        ...nutrient,
        completeness: "complete",
        isExact: true,
        contributorCount: 1,
        quantifiedCount: 1,
        traceCount: 0,
        unknownCount: 0,
        unknownReasonCounts: {
          not_reported: 0,
          not_analyzed: 0,
          not_applicable: 0,
          withheld: 0,
        },
      }).qualification,
    ).toBe("Complete coverage · quantified");
  });

  it("validates affected-day mutation receipts", () => {
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
});

describe("web diary editor snapshot binding", () => {
  it("binds edits to the original entry and day revisions, date, and zone", () => {
    const day = parseDiaryPage(diaryPageFixture([entry], null, 1)).data;
    const parsedEntry = day.entries[0];
    if (!parsedEntry) throw new Error("Expected a diary entry fixture.");
    const origin = diaryEditorOrigin(day, parsedEntry);

    expect(origin).toEqual({
      entryId: entry.id,
      originEntryRevision: "3",
      originLocalDate: "2026-08-15",
      originTimeZone: "America/Chicago",
      originDayRevision: "8",
    });
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
});

describe("web diary pagination", () => {
  it("builds an opt-in bounded page path and normalizes a legacy final page", () => {
    expect(diaryPagePath("2026-08-15")).toBe("/api/diary?date=2026-08-15&limit=20");
    expect(diaryPagePath("2026-08-15", "d1.next_page-2")).toBe(
      "/api/diary?date=2026-08-15&limit=20&cursor=d1.next_page-2",
    );
    expect(() => diaryPagePath("2026-08-15", "page_2.next")).toThrow(TypeError);
    expect(() => diaryPagePath("2026-08-15", "x".repeat(513))).toThrow(TypeError);
    const { page: _page, ...legacyWire } = diaryPageFixture([entry], null, 1);
    const legacy = parseDiaryPage(legacyWire);
    expect(legacy).toMatchObject({ legacy: true, page: { nextCursor: null, totalEntries: 1 } });
    expect(() => parseDiaryPage({ ...legacyWire, unexpected: true })).toThrow(TypeError);
    expect(() => parseDiaryPage(diaryPageFixture([], "d1.page_2", 1))).toThrow(TypeError);
    expect(() => parseDiaryPage(diaryPageFixture([entry], "page_2.next", 2))).toThrow(TypeError);
    expect(isDiaryPageStaleProblem(409, { code: "DIARY_PAGE_STALE" })).toBe(true);
    expect(isDiaryPageStaleProblem(409, { code: "CONFLICT" })).toBe(false);
    expect(isDiaryPageStaleProblem(400, { code: "DIARY_PAGE_STALE" })).toBe(false);
  });

  it("merges 20, 20, and 5 entries into one exact 45-entry snapshot", () => {
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
    expect(complete.page).toEqual({ nextCursor: null, totalEntries: 45 });
  });

  it("rejects duplicate IDs, page overflow, and mixed snapshot metadata", () => {
    const first = mergeDiaryPages(
      null,
      parseDiaryPage(diaryPageFixture(numberedEntries(1, 20), "d1.page_2", 40)),
    );
    expect(() =>
      mergeDiaryPages(first, parseDiaryPage(diaryPageFixture(numberedEntries(20, 20), null, 40))),
    ).toThrow(TypeError);
    expect(() => parseDiaryPage(diaryPageFixture(numberedEntries(1, 21), null, 21))).toThrow(
      TypeError,
    );
    expect(() =>
      mergeDiaryPages(
        first,
        parseDiaryPage(diaryPageFixture(numberedEntries(21, 20), null, 40, { revision: "9" })),
      ),
    ).toThrow(TypeError);
  });
});

describe("private diary entry notes", () => {
  it("normalizes only an explicit clear and preserves all other input bytes", () => {
    const exact = "  before meal\nafter meal  ";
    expect(prepareDiaryEntryNote("")).toBeNull();
    expect(prepareDiaryEntryNote(exact)).toBe(exact);

    const atLimit = "🥑".repeat(2_000);
    const overLimit = `${atLimit}🥑`;
    expect(atLimit.length).toBe(4_000);
    expect(diaryEntryNoteCharacterCount(atLimit)).toBe(2_000);
    expect(prepareDiaryEntryNote(atLimit)).toBe(atLimit);
    expect(() => prepareDiaryEntryNote(overLimit)).toThrow(RangeError);
    expect(() => prepareDiaryEntryNote("x".repeat(2_001))).toThrow(RangeError);
    expect(() => prepareDiaryEntryNote("before\u0000after")).toThrow("null character");
    expect(() => prepareDiaryEntryNote("unpaired \ud800")).toThrow("well-formed Unicode");
    expect(() => prepareDiaryEntryNote("unpaired \udc00")).toThrow("well-formed Unicode");
  });

  it("omits untouched legacy notes while keeping explicit clear and edit patches", () => {
    const legacyOverDraftLimit = "🥑".repeat(2_001);
    expect(prepareDiaryEntryNotePatch(legacyOverDraftLimit, legacyOverDraftLimit)).toEqual({});
    expect(prepareDiaryEntryNotePatch("", "")).toEqual({});
    expect(prepareDiaryEntryNotePatch("", null)).toEqual({});
    expect(prepareDiaryEntryNotePatch("", "clear me")).toEqual({ note: null });
    expect(prepareDiaryEntryNotePatch("  exact edit  ", "old")).toEqual({
      note: "  exact edit  ",
    });
    expect(() => prepareDiaryEntryNotePatch(legacyOverDraftLimit, "old")).toThrow(RangeError);
  });

  it("normalizes legacy empty notes and accepts valid response strings through 10,000 code points", () => {
    const mutation = (note: string | undefined) => ({
      data: {
        replayed: false,
        entry:
          note === undefined ? (({ note: _note, ...legacy }) => legacy)(entry) : { ...entry, note },
        affectedDays: [{ localDate: "2026-08-15", revision: "4" }],
      },
    });
    const atLimit = "🥑".repeat(10_000);
    expect(parseDiaryMutation(mutation(undefined)).entry?.note).toBeNull();
    expect(parseDiaryMutation(mutation("")).entry?.note).toBeNull();
    expect(parseDiaryMutation(mutation("valid 😀 text")).entry?.note).toBe("valid 😀 text");
    const accepted = parseDiaryMutation(mutation(atLimit));
    expect(accepted.entry?.note).toBe(atLimit);
    expect(() => parseDiaryMutation(mutation("contains\u0000null"))).toThrow(TypeError);
    expect(() => parseDiaryMutation(mutation("\uD800"))).toThrow(TypeError);
    expect(() => parseDiaryMutation(mutation("\uDC00"))).toThrow(TypeError);
    expect(() => parseDiaryMutation(mutation(`${atLimit}🥑`))).toThrow(TypeError);
  });
});

describe("local diary dates", () => {
  it("waits for the profile zone unless the route supplies a valid explicit date", () => {
    const now = new Date("2026-08-16T02:30:00.000Z");
    expect(resolveDiaryRouteDate(null, null, now)).toBeNull();
    expect(resolveDiaryRouteDate("2026-08-14", null, now)).toBe("2026-08-14");
    expect(resolveDiaryRouteDate(null, "America/Chicago", now)).toBe("2026-08-15");
    expect(resolveDiaryRouteDate("not-a-date", "America/Chicago", now)).toBe("2026-08-15");
  });

  it("shifts calendar dates without relying on browser UTC conversion", () => {
    expect(isLocalDate("2024-02-29")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("0000-01-01")).toBe(false);
    expect(shiftLocalDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("maps a wall-clock time through the persisted IANA zone", () => {
    expect(localDateTimeToInstant("2026-08-15", "08:30", "America/Chicago")).toBe(
      "2026-08-15T13:30:00.000Z",
    );
    expect(localDateTimeToInstant("2026-08-15", "13:00", "America/New_York")).toBe(
      "2026-08-15T17:00:00.000Z",
    );
    expect(() => localDateTimeToInstant("2026-03-08", "02:30", "America/Chicago")).toThrow(
      RangeError,
    );
    expect(
      diaryEditErrorMessage(
        new RangeError("That local time does not exist in the selected time zone."),
      ),
    ).toBe("That local time does not exist in your current diary time zone. Choose another time.");
  });

  it("preserves the actual instant during the repeated DST hour for a current-day quick add", () => {
    const secondFold = new Date("2026-11-01T07:30:45.123Z");
    expect(quickAddOccurredAt("2026-11-01", "America/Chicago", secondFold)).toBe(
      "2026-11-01T07:30:45.123Z",
    );
    expect(quickAddOccurredAt("2026-11-02", "America/Chicago", secondFold)).toBe(
      "2026-11-02T18:00:00.000Z",
    );
  });

  it("reuses identical quick-add bytes and identity after an ambiguous response", () => {
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
    expect(JSON.stringify(retry.body)).toBe(JSON.stringify(first.body));
    expect(retry.operationId).toBe("a7183708-7725-4b7c-a180-58e03ca01234");

    const secondIntent = prepareQuickAddOperation(
      pending,
      { ...input, mealSlot: "lunch" },
      new Date("2026-11-01T07:32:00.000Z"),
      () => "f2a47c26-8e02-4057-8b48-cda619302452",
    );
    pending.set(secondIntent.intentKey, secondIntent);
    expect(secondIntent.operationId).toBe("f2a47c26-8e02-4057-8b48-cda619302452");

    // A second food can finish without discarding the first food's ambiguous operation.
    pending.delete(secondIntent.intentKey);
    const firstAfterSecond = prepareQuickAddOperation(
      pending,
      input,
      new Date("2026-11-01T07:33:00.000Z"),
      () => "93f88742-d39c-4f6c-95a1-8b292b12a93d",
    );
    expect(firstAfterSecond).toBe(first);
  });
});
