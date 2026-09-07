import { defaultDiaryGroups } from "@nutrition-tracker/contracts";
import type { JsonObject } from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";

import {
  diaryGroupsFromPreferences,
  normalizeDiaryGroups,
  preferencesWithDiaryGroups,
} from "../src/modules/profile/diary-groups.js";

const reorderedGroups = [
  { mealSlot: "snacks", label: "Small bites" },
  { mealSlot: "breakfast", label: "Morning" },
  { mealSlot: "dinner", label: "Evening" },
  { mealSlot: "lunch", label: "Midday" },
] as const;

describe("diary group profile preferences", () => {
  it("preserves display order and canonicalizes labels", () => {
    expect(
      normalizeDiaryGroups([
        { mealSlot: "snacks", label: "  Small bites  " },
        { mealSlot: "breakfast", label: "Ｍｏｒｎｉｎｇ" },
        { mealSlot: "dinner", label: "Evening" },
        { mealSlot: "lunch", label: "Midday" },
      ]),
    ).toEqual(reorderedGroups);
  });

  it("accepts both scalar and UTF-8 byte boundaries", () => {
    expect(
      normalizeDiaryGroups([
        { mealSlot: "breakfast", label: "a".repeat(40) },
        { mealSlot: "lunch", label: "😀".repeat(30) },
        { mealSlot: "dinner", label: "Dinner" },
        { mealSlot: "snacks", label: "Snacks" },
      ]),
    ).toHaveLength(4);
  });

  it.each([
    {
      name: "the wrong item count",
      value: reorderedGroups.slice(0, 3),
    },
    {
      name: "a duplicate stable slot",
      value: [
        reorderedGroups[0],
        reorderedGroups[1],
        reorderedGroups[2],
        { mealSlot: "breakfast", label: "Second morning" },
      ],
    },
    {
      name: "an unknown stable slot",
      value: [
        reorderedGroups[0],
        reorderedGroups[1],
        reorderedGroups[2],
        { mealSlot: "brunch", label: "Midday" },
      ],
    },
    {
      name: "case-insensitive duplicate labels",
      value: [
        { mealSlot: "breakfast", label: "Morning" },
        { mealSlot: "lunch", label: "morning" },
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
    {
      name: "default-Unicode-lowercase duplicate labels",
      value: [
        { mealSlot: "breakfast", label: "CAFÉ" },
        { mealSlot: "lunch", label: "café" },
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
    {
      name: "more than 40 Unicode scalars",
      value: [
        { mealSlot: "breakfast", label: "a".repeat(41) },
        reorderedGroups[3],
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
    {
      name: "more than 120 UTF-8 bytes",
      value: [
        { mealSlot: "breakfast", label: "😀".repeat(31) },
        reorderedGroups[3],
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
    {
      name: "a control character",
      value: [
        { mealSlot: "breakfast", label: "Morning\n" },
        reorderedGroups[3],
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
    {
      name: "a format character",
      value: [
        { mealSlot: "breakfast", label: "Morn\u200bing" },
        reorderedGroups[3],
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
    {
      name: "an unpaired surrogate",
      value: [
        { mealSlot: "breakfast", label: "\ud800" },
        reorderedGroups[3],
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
    {
      name: "an unexpected entry field",
      value: [
        { mealSlot: "breakfast", label: "Morning", hidden: true },
        reorderedGroups[3],
        reorderedGroups[2],
        reorderedGroups[0],
      ],
    },
  ])("rejects $name", ({ value }) => {
    expect(() => normalizeDiaryGroups(value)).toThrow(RangeError);
  });

  it("defaults missing and malformed stored configuration without exposing it", () => {
    expect(diaryGroupsFromPreferences({ theme: "dark" })).toEqual(defaultDiaryGroups);
    expect(
      diaryGroupsFromPreferences({
        diaryGroups: { version: 1, groups: [{ mealSlot: "breakfast", label: "Only one" }] },
      }),
    ).toEqual(defaultDiaryGroups);
    expect(
      diaryGroupsFromPreferences({
        diaryGroups: { version: 2, groups: reorderedGroups },
      }),
    ).toEqual(defaultDiaryGroups);
  });

  it("replaces only the versioned diary namespace and preserves unrelated preferences", () => {
    const original: JsonObject = {
      theme: "dark",
      nested: { compact: true },
      diaryGroups: { version: 0, groups: [] },
    };

    const merged = preferencesWithDiaryGroups(original, reorderedGroups);

    expect(merged).toEqual({
      theme: "dark",
      nested: { compact: true },
      diaryGroups: { version: 1, groups: reorderedGroups },
    });
    expect(original).toEqual({
      theme: "dark",
      nested: { compact: true },
      diaryGroups: { version: 0, groups: [] },
    });
    expect(diaryGroupsFromPreferences(merged)).toEqual(reorderedGroups);
  });
});
