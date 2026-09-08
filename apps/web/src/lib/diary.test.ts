import { describe, expect, it } from "vitest";

import {
  defaultDiaryGroups,
  diaryCorrectionMatchesRequest,
  diaryDayOrderDigest,
  diaryEditErrorMessage,
  diaryEditorOperationKey,
  diaryEditorOrigin,
  diaryEditorOriginMatches,
  diaryEntryNoteCharacterCount,
  diaryGroupLabel,
  diaryPagePath,
  diaryRepeatOperationKey,
  entryEnergyDisplay,
  isDiaryPageStaleProblem,
  isLocalDate,
  localDateTimeToInstant,
  mergeDiaryPages,
  moveDiaryGroup,
  nutrientDisplay,
  parseDiaryCorrectionMutation,
  parseDiaryDay,
  parseDiaryDayReorder,
  parseDiaryGroups,
  parseDiaryMutation,
  parseDiaryPage,
  parseProfileResponse,
  parseSession,
  prepareDiaryDayReorder,
  prepareDiaryDayReorderOperation,
  prepareDiaryEntryNote,
  prepareDiaryEntryNotePatch,
  prepareDiaryGroups,
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

const arbitraryDayOrderDigest = "a".repeat(64);

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
      orderDigest: "d33348ee457d853020d5d62579569a8a8a592675d9505c51b1f7e588a0a124e8",
      entries,
      totals: [nutrient],
      updatedAt: "2026-08-15T13:31:00.000Z",
      ...overrides,
    },
    page: { nextCursor, totalEntries },
  };
}

describe("web diary contract", () => {
  it("supplies cloned defaults for legacy profiles but rejects malformed present groups", () => {
    const legacyProfile = {
      displayName: null,
      birthDate: null,
      sexAtBirth: "not_specified",
      heightCm: null,
      baselineWeightKg: null,
      activityLevelCode: null,
      locale: "en-US",
      timeZone: "America/Chicago",
      unitSystem: "metric",
      onboardingCompletedAt: null,
      revision: "1",
    };
    const parsed = parseSession({
      data: {
        user: {
          id: "70eedafb-9d6e-4adc-b924-8e55e87ff5d0",
          email: "ada@example.com",
          emailVerified: true,
        },
        profile: legacyProfile,
      },
    });

    expect(parsed.profile.diaryGroups).toEqual(defaultDiaryGroups);
    expect(parsed.profile.diaryGroups).not.toBe(defaultDiaryGroups);
    expect(parsed.profile.diaryGroups[0]).not.toBe(defaultDiaryGroups[0]);
    expect(() =>
      parseProfileResponse({
        data: { profile: { ...legacyProfile, diaryGroups: [] } },
      }),
    ).toThrow(TypeError);
  });

  it("parses custom diary group order and resolves labels by stable meal slot", () => {
    const groups = parseDiaryGroups([
      { mealSlot: "snacks", label: "Evening snack" },
      { mealSlot: "breakfast", label: "Morning" },
      { mealSlot: "lunch", label: "Midday" },
      { mealSlot: "dinner", label: "Supper" },
    ]);
    expect(groups.map((group) => group.mealSlot)).toEqual([
      "snacks",
      "breakfast",
      "lunch",
      "dinner",
    ]);
    expect(diaryGroupLabel(groups, "dinner")).toBe("Supper");
  });

  it("normalizes editable group labels and reorders without changing canonical slot values", () => {
    const normalized = prepareDiaryGroups([
      { mealSlot: "breakfast", label: "  Morning  " },
      { mealSlot: "lunch", label: "Midday" },
      { mealSlot: "dinner", label: "Supper" },
      { mealSlot: "snacks", label: "Treats" },
    ]);
    expect(normalized[0]).toEqual({ mealSlot: "breakfast", label: "Morning" });
    expect(moveDiaryGroup(normalized, 0, 1).map((group) => group.mealSlot)).toEqual([
      "lunch",
      "breakfast",
      "dinner",
      "snacks",
    ]);
    expect(defaultDiaryGroups.map((group) => group.mealSlot)).toEqual([
      "breakfast",
      "lunch",
      "dinner",
      "snacks",
    ]);
  });

  it("rejects malformed, duplicate, non-canonical, or oversized diary group labels", () => {
    expect(() =>
      parseDiaryGroups([
        { mealSlot: "breakfast", label: "Morning" },
        { mealSlot: "lunch", label: "morning" },
        { mealSlot: "dinner", label: "Dinner" },
        { mealSlot: "snacks", label: "Snacks" },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      parseDiaryGroups([
        { mealSlot: "breakfast", label: " Breakfast " },
        ...defaultDiaryGroups.slice(1),
      ]),
    ).toThrow(TypeError);
    expect(() =>
      prepareDiaryGroups([
        { mealSlot: "breakfast", label: "Morning\nmeal" },
        ...defaultDiaryGroups.slice(1),
      ]),
    ).toThrow(TypeError);
    expect(() =>
      prepareDiaryGroups([
        { mealSlot: "breakfast", label: "🍽".repeat(40) },
        ...defaultDiaryGroups.slice(1),
      ]),
    ).toThrow(TypeError);
    expect(() =>
      prepareDiaryGroups([
        { mealSlot: "breakfast", label: "\ud800" },
        ...defaultDiaryGroups.slice(1),
      ]),
    ).toThrow(TypeError);
  });

  it("preserves exact decimal strings and labels partial totals as lower bounds", () => {
    const diary = parseDiaryDay({
      data: {
        id: "41b5f2ea-2274-4b98-8b13-96504d176917",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "4",
        orderDigest: arbitraryDayOrderDigest,
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
        orderDigest: arbitraryDayOrderDigest,
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
        orderDigest: arbitraryDayOrderDigest,
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
          orderDigest: arbitraryDayOrderDigest,
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
        orderDigest: arbitraryDayOrderDigest,
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
        orderDigest: arbitraryDayOrderDigest,
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
          orderDigest: arbitraryDayOrderDigest,
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
          orderDigest: arbitraryDayOrderDigest,
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
          orderDigest: arbitraryDayOrderDigest,
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
          orderDigest: arbitraryDayOrderDigest,
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
  it("binds edits to entry/day revisions and the separate current profile zone", () => {
    const day = parseDiaryPage(diaryPageFixture([entry], null, 1)).data;
    const parsedEntry = day.entries[0];
    if (!parsedEntry) throw new Error("Expected a diary entry fixture.");
    const origin = diaryEditorOrigin(day, parsedEntry, "America/Denver");

    expect(origin).toEqual({
      entryId: entry.id,
      originEntryRevision: "3",
      originLocalDate: "2026-08-15",
      originTimeZone: "America/Denver",
      originDayRevision: "8",
    });
    expect(diaryEditorOriginMatches(origin, day, parsedEntry, "America/Denver")).toBe(true);
    expect(
      diaryEditorOriginMatches(origin, { ...day, revision: "9" }, parsedEntry, "America/Denver"),
    ).toBe(false);
    expect(
      diaryEditorOriginMatches(
        origin,
        { ...day, localDate: "2026-08-16" },
        parsedEntry,
        "America/Denver",
      ),
    ).toBe(false);
    expect(
      diaryEditorOriginMatches(origin, { ...day, timeZone: "UTC" }, parsedEntry, "America/Denver"),
    ).toBe(true);
    expect(diaryEditorOriginMatches(origin, day, parsedEntry, "UTC")).toBe(false);
    expect(
      diaryEditorOriginMatches(origin, day, { ...parsedEntry, revision: "4" }, "America/Denver"),
    ).toBe(false);
    expect(diaryEditorOperationKey(origin, { mealSlot: "lunch" })).toBe(
      `edit:${entry.id}:3:8:{"mealSlot":"lunch"}`,
    );
    const repeatBody = { occurredAt: "2026-08-15T18:00:00.000Z", mealSlot: "lunch" };
    const chicagoRepeat = diaryRepeatOperationKey(entry.id, "3", "America/Chicago", repeatBody);
    const newYorkRepeat = diaryRepeatOperationKey(entry.id, "3", "America/New_York", repeatBody);
    expect(chicagoRepeat).not.toBe(newYorkRepeat);
    expect(chicagoRepeat).toBe(
      `repeat:${entry.id}:3:America/Chicago:{"occurredAt":"2026-08-15T18:00:00.000Z","mealSlot":"lunch"}`,
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

describe("atomic diary entry ordering", () => {
  const completeDay = () =>
    parseDiaryPage(
      diaryPageFixture(
        [
          ...numberedEntries(1, 3),
          ...numberedEntries(4, 2).map((item) => ({ ...item, mealSlot: "lunch" })),
        ],
        null,
        5,
      ),
    );

  const requiredEntryId = (page: ReturnType<typeof completeDay>, index: number): string => {
    const entry = page.data.entries[index];
    if (!entry) throw new Error(`Missing test diary entry at index ${index}.`);
    return entry.id;
  };

  it("encodes a complete within-meal move as compact baseline indices", () => {
    const page = completeDay();
    const moved = prepareDiaryDayReorder(page, requiredEntryId(page, 1), "up");
    expect(moved).toEqual({
      expectedDayRevision: "8",
      dayTimeZone: "America/Chicago",
      body: {
        groups: {
          breakfast: [1, 0, 2],
          lunch: [0, 1],
          dinner: [],
          snacks: [],
        },
      },
    });
  });

  it("binds compact reorder intent to exact pre- and post-operation digests", async () => {
    const page = completeDay();
    const moved = await prepareDiaryDayReorderOperation(
      page,
      "America/Denver",
      requiredEntryId(page, 1),
      "up",
    );
    expect(moved.expectedProfileTimeZone).toBe("America/Denver");
    expect(moved.dayTimeZone).toBe("America/Chicago");
    expect(moved.expectedOrderDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(moved.expectedResultOrderDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(moved.expectedOrderDigest).toBe(
      "d33348ee457d853020d5d62579569a8a8a592675d9505c51b1f7e588a0a124e8",
    );
    expect(moved.expectedResultOrderDigest).toBe(
      "6a2d01106e01280585fce93967841c4e3629f8d9fc07ce7f76268565c22b107b",
    );
    expect(moved.expectedResultOrderDigest).not.toBe(moved.expectedOrderDigest);

    const resultGroups = [
      {
        mealSlot: "breakfast" as const,
        entries: [
          { entryId: requiredEntryId(page, 1), entryRevision: "4", position: 0 },
          { entryId: requiredEntryId(page, 0), entryRevision: "3", position: 1 },
          { entryId: requiredEntryId(page, 2), entryRevision: "4", position: 2 },
        ],
      },
      {
        mealSlot: "lunch" as const,
        entries: [
          { entryId: requiredEntryId(page, 3), entryRevision: "4", position: 0 },
          { entryId: requiredEntryId(page, 4), entryRevision: "4", position: 1 },
        ],
      },
      { mealSlot: "dinner" as const, entries: [] },
      { mealSlot: "snacks" as const, entries: [] },
    ] as const;
    expect(await diaryDayOrderDigest(page.data.localDate, page.data.timeZone, resultGroups)).toBe(
      moved.expectedResultOrderDigest,
    );
  });

  it("refuses partial pages, locked days, missing entries, and meal boundaries", () => {
    const partial = parseDiaryPage(diaryPageFixture(numberedEntries(1, 2), "d1.next", 3));
    expect(() => prepareDiaryDayReorder(partial, requiredEntryId(partial, 0), "down")).toThrow(
      "complete diary day",
    );
    const complete = completeDay();
    expect(() =>
      prepareDiaryDayReorder(
        { ...complete, data: { ...complete.data, status: "locked" } },
        requiredEntryId(complete, 0),
        "down",
      ),
    ).toThrow("Locked diary days");
    expect(() =>
      prepareDiaryDayReorder(complete, "ffffffff-ffff-4fff-8fff-ffffffffffff", "down"),
    ).toThrow("not in the loaded day");
    expect(() => prepareDiaryDayReorder(complete, requiredEntryId(complete, 0), "up")).toThrow(
      "cannot move up",
    );
  });
});

describe("durable diary correction and reorder receipts", () => {
  const affectedDays = [{ localDate: "2026-08-15", revision: "9" }] as const;
  const operationId = "61eec75e-fe16-47e4-9f7b-efb6914ad9dc"; // gitleaks:allow -- fixture UUID

  it("retains an exact strong update receipt and rejects a mismatched result subject", () => {
    const response = {
      data: {
        replayed: false,
        entry: { ...entry, revision: "4" },
        affectedDays,
        receipt: {
          protocol: "v1",
          operationId,
          kind: "update",
          expectedSubjects: [{ entryId: entry.id, revision: "3" }],
          resultSubjects: [{ entryId: entry.id, revision: "4", state: "active" }],
          affectedDays,
        },
      },
    };
    const mutation = parseDiaryCorrectionMutation(response);
    expect(mutation.receipt).toMatchObject({
      operationId,
      kind: "update",
      expectedSubjects: [{ entryId: entry.id, revision: "3" }],
      resultSubjects: [{ entryId: entry.id, revision: "4", state: "active" }],
    });
    expect(
      diaryCorrectionMatchesRequest(mutation, {
        body: {
          portion: { kind: "serving", servingId: "303", amount: "1.0" },
          mealSlot: "breakfast",
          occurredAt: "2026-08-15T13:30:00.000Z",
          position: 0,
          note: null,
        },
        entryId: entry.id,
        entryRevision: "3",
        expectedTimeZone: "America/Chicago",
        kind: "update",
        operationId,
        sourceLocalDate: "2026-08-15",
      }),
    ).toBe(true);
    for (const requestMismatch of [
      { portion: { kind: "serving", servingId: "303", amount: "2" } },
      { mealSlot: "lunch" },
      { occurredAt: "2026-08-15T14:30:00.000Z" },
      { position: 1 },
      { note: "different note" },
    ] as const) {
      expect(
        diaryCorrectionMatchesRequest(mutation, {
          body: requestMismatch,
          entryId: entry.id,
          entryRevision: "3",
          expectedTimeZone: "occurredAt" in requestMismatch ? "America/Chicago" : null,
          kind: "update",
          operationId,
          sourceLocalDate: "2026-08-15",
        }),
      ).toBe(false);
    }
    const skippedRevision = parseDiaryCorrectionMutation({
      ...response,
      data: {
        ...response.data,
        entry: { ...response.data.entry, revision: "5" },
        receipt: {
          ...response.data.receipt,
          resultSubjects: [{ entryId: entry.id, revision: "5", state: "active" }],
        },
      },
    });
    expect(
      diaryCorrectionMatchesRequest(skippedRevision, {
        body: { note: null },
        entryId: entry.id,
        entryRevision: "3",
        expectedTimeZone: null,
        kind: "update",
        operationId,
        sourceLocalDate: "2026-08-15",
      }),
    ).toBe(false);
    expect(() =>
      parseDiaryCorrectionMutation({
        ...response,
        data: {
          ...response.data,
          receipt: {
            ...response.data.receipt,
            resultSubjects: [{ entryId: entry.id, revision: "5", state: "active" }],
          },
        },
      }),
    ).toThrow("did not match");
  });

  it("binds delete and repeat results to the exact requested revision, fields, day, and zone", () => {
    const deletion = parseDiaryCorrectionMutation({
      data: {
        replayed: false,
        entry: null,
        affectedDays,
        receipt: {
          protocol: "v1",
          operationId,
          kind: "delete",
          expectedSubjects: [{ entryId: entry.id, revision: "3" }],
          resultSubjects: [{ entryId: entry.id, revision: "4", state: "deleted" }],
          affectedDays,
        },
      },
    });
    expect(
      diaryCorrectionMatchesRequest(deletion, {
        body: null,
        entryId: entry.id,
        entryRevision: "3",
        expectedTimeZone: null,
        kind: "delete",
        operationId,
        sourceLocalDate: "2026-08-15",
      }),
    ).toBe(true);
    expect(
      diaryCorrectionMatchesRequest(
        parseDiaryCorrectionMutation({
          data: {
            replayed: false,
            entry: null,
            affectedDays,
            receipt: {
              ...deletion.receipt,
              resultSubjects: [{ entryId: entry.id, revision: "5", state: "deleted" }],
            },
          },
        }),
        {
          body: null,
          entryId: entry.id,
          entryRevision: "3",
          expectedTimeZone: null,
          kind: "delete",
          operationId,
          sourceLocalDate: "2026-08-15",
        },
      ),
    ).toBe(false);

    const repeatedEntryId = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";
    const repeatedAt = "2026-08-16T13:30:00.000Z";
    const repeatedAffectedDays = [{ localDate: "2026-08-16", revision: "1" }] as const;
    const repeatResponse = {
      data: {
        replayed: false,
        entry: {
          ...entry,
          id: repeatedEntryId,
          revision: "1",
          mealSlot: "lunch",
          occurredAt: repeatedAt,
          localDate: "2026-08-16",
        },
        affectedDays: repeatedAffectedDays,
        receipt: {
          protocol: "v1",
          operationId,
          kind: "repeat",
          expectedSubjects: [{ entryId: entry.id, revision: "3" }],
          resultSubjects: [{ entryId: repeatedEntryId, revision: "1", state: "active" }],
          affectedDays: repeatedAffectedDays,
        },
      },
    } as const;
    const repeat = parseDiaryCorrectionMutation(repeatResponse);
    const repeatEvidence = {
      body: { occurredAt: repeatedAt, mealSlot: "lunch" },
      entryId: entry.id,
      entryRevision: "3",
      expectedTimeZone: "America/Chicago",
      kind: "repeat",
      operationId,
      sourceLocalDate: "2026-08-15",
    } as const;
    expect(diaryCorrectionMatchesRequest(repeat, repeatEvidence)).toBe(true);
    for (const entryPatch of [
      { mealSlot: "dinner" },
      { occurredAt: "2026-08-16T14:30:00.000Z" },
      { localDate: "2026-08-15" },
      { timeZone: "America/Denver" },
    ] as const) {
      expect(
        diaryCorrectionMatchesRequest(
          parseDiaryCorrectionMutation({
            ...repeatResponse,
            data: {
              ...repeatResponse.data,
              entry: { ...repeatResponse.data.entry, ...entryPatch },
            },
          }),
          repeatEvidence,
        ),
      ).toBe(false);
    }
    for (const identityPatch of [
      { id: entry.id, revision: "1" },
      { id: repeatedEntryId, revision: "2" },
    ] as const) {
      expect(
        diaryCorrectionMatchesRequest(
          parseDiaryCorrectionMutation({
            ...repeatResponse,
            data: {
              ...repeatResponse.data,
              entry: { ...repeatResponse.data.entry, ...identityPatch },
              receipt: {
                ...repeatResponse.data.receipt,
                resultSubjects: [
                  {
                    entryId: identityPatch.id,
                    revision: identityPatch.revision,
                    state: "active",
                  },
                ],
              },
            },
          }),
          repeatEvidence,
        ),
      ).toBe(false);
    }
  });

  it("requires canonical complete groups and contiguous positions in a reorder receipt", () => {
    const groups = [
      {
        mealSlot: "breakfast",
        entries: [{ entryId: entry.id, entryRevision: "4", position: 0 }],
      },
      { mealSlot: "lunch", entries: [] },
      { mealSlot: "dinner", entries: [] },
      { mealSlot: "snacks", entries: [] },
    ];
    const response = {
      data: {
        replayed: false,
        receipt: {
          operationId,
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
          expectedDayRevision: "8",
          resultingDayRevision: "9",
          previousOrderDigest: "a".repeat(64),
          orderDigest: "b".repeat(64),
          groups,
        },
      },
    };
    expect(parseDiaryDayReorder(response).receipt.groups[0]?.entries[0]?.entryId).toBe(entry.id);
    expect(() =>
      parseDiaryDayReorder({
        ...response,
        data: {
          ...response.data,
          receipt: {
            ...response.data.receipt,
            groups: [groups[1], groups[0], groups[2], groups[3]],
          },
        },
      }),
    ).toThrow("group");
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
      portion: { kind: "serving" as const, servingId: "303", amount: "1" },
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
    expect(retry.expectedTimeZone).toBe("America/Chicago");

    const retryAfterProfileZoneChange = prepareQuickAddOperation(
      pending,
      { ...input, timeZone: "Pacific/Kiritimati" },
      new Date("2026-11-01T07:32:00.000Z"),
      () => "f2a47c26-8e02-4057-8b48-cda619302452",
    );
    expect(retryAfterProfileZoneChange).toBe(first);
    expect(retryAfterProfileZoneChange.expectedTimeZone).toBe("America/Chicago");
    expect(JSON.stringify(retryAfterProfileZoneChange.body)).toBe(JSON.stringify(first.body));

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

  it("binds serving or gram quantity into an exact independent quick-add intent", () => {
    const pending = new Map<string, ReturnType<typeof prepareQuickAddOperation>>();
    const common = {
      foodVersionId: "202",
      localDate: "2026-11-01",
      mealSlot: "breakfast" as const,
      timeZone: "America/Chicago",
    };
    const serving = prepareQuickAddOperation(
      pending,
      {
        ...common,
        portion: { kind: "serving", servingId: "303", amount: "2.500" },
      },
      new Date("2026-11-01T07:30:45.123Z"),
      () => "a7183708-7725-4b7c-a180-58e03ca01234",
    );
    pending.set(serving.intentKey, serving);
    const grams = prepareQuickAddOperation(
      pending,
      { ...common, portion: { kind: "grams", grams: "125.500" } },
      new Date("2026-11-01T07:30:45.123Z"),
      () => "f2a47c26-8e02-4057-8b48-cda619302452",
    );
    const anotherServingAmount = prepareQuickAddOperation(
      pending,
      {
        ...common,
        portion: { kind: "serving", servingId: "303", amount: "3.000" },
      },
      new Date("2026-11-01T07:30:45.123Z"),
      () => "93f88742-d39c-4f6c-95a1-8b292b12a93d",
    );

    expect(serving.body.portion).toEqual({ kind: "serving", servingId: "303", amount: "2.5" });
    expect(grams.body.portion).toEqual({ kind: "grams", grams: "125.5" });
    expect(grams.intentKey).not.toBe(serving.intentKey);
    expect(anotherServingAmount.intentKey).not.toBe(serving.intentKey);
    expect(
      prepareQuickAddOperation(
        pending,
        {
          ...common,
          portion: { kind: "serving", servingId: "303", amount: "2.5" },
        },
        new Date("2026-11-01T07:31:00.000Z"),
        () => "7ab34784-068d-4a3a-ac42-205058e35526",
      ),
    ).toBe(serving);
    expect(() =>
      prepareQuickAddOperation(
        pending,
        { ...common, portion: { kind: "grams", grams: "0" } },
        new Date("2026-11-01T07:30:45.123Z"),
        () => "7ab34784-068d-4a3a-ac42-205058e35526",
      ),
    ).toThrow(RangeError);
    expect(() =>
      prepareQuickAddOperation(
        pending,
        { ...common, portion: { kind: "grams", grams: "01" } },
        new Date("2026-11-01T07:30:45.123Z"),
        () => "7ab34784-068d-4a3a-ac42-205058e35526",
      ),
    ).toThrow(RangeError);
  });
});
