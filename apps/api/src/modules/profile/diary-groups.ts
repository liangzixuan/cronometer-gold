import {
  type DiaryGroup,
  type DiaryMealSlot,
  defaultDiaryGroups,
  diaryMealSlots,
} from "@nutrition-tracker/contracts";
import type { JsonObject } from "@nutrition-tracker/db";

const MAX_DIARY_GROUP_LABEL_SCALARS = 40;
const MAX_DIARY_GROUP_LABEL_UTF8_BYTES = 120;
const forbiddenLabelCharacters = /[\p{Cc}\p{Cf}]/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDiaryMealSlot(value: unknown): value is DiaryMealSlot {
  return typeof value === "string" && diaryMealSlots.some((candidate) => candidate === value);
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    !hasOnlyUnicodeScalars(value) ||
    forbiddenLabelCharacters.test(value)
  ) {
    throw new RangeError("Diary group label contains invalid Unicode");
  }
  const label = value.normalize("NFKC").trim();
  if (
    label.length === 0 ||
    [...label].length > MAX_DIARY_GROUP_LABEL_SCALARS ||
    Buffer.byteLength(label, "utf8") > MAX_DIARY_GROUP_LABEL_UTF8_BYTES ||
    forbiddenLabelCharacters.test(label)
  ) {
    throw new RangeError("Diary group label is invalid or too long");
  }
  return label;
}

function clonedDefaults(): readonly DiaryGroup[] {
  return defaultDiaryGroups.map((group) => ({ ...group }));
}

/** Validate and canonicalize the complete four-slot user-facing diary grouping. */
export function normalizeDiaryGroups(value: unknown): readonly DiaryGroup[] {
  if (!Array.isArray(value) || value.length !== diaryMealSlots.length) {
    throw new RangeError("Diary groups must contain exactly four items");
  }
  const seenSlots = new Set<DiaryMealSlot>();
  const seenLabels = new Set<string>();
  const groups = value.map((candidate): DiaryGroup => {
    if (!record(candidate) || !exactKeys(candidate, ["label", "mealSlot"])) {
      throw new RangeError("Diary group entries must contain only mealSlot and label");
    }
    if (!isDiaryMealSlot(candidate.mealSlot) || seenSlots.has(candidate.mealSlot)) {
      throw new RangeError("Diary groups must contain each stable meal slot exactly once");
    }
    const label = normalizeLabel(candidate.label);
    const foldedLabel = label.toLowerCase();
    if (seenLabels.has(foldedLabel)) {
      throw new RangeError("Diary group labels must be unique");
    }
    seenSlots.add(candidate.mealSlot);
    seenLabels.add(foldedLabel);
    return { mealSlot: candidate.mealSlot, label };
  });
  if (seenSlots.size !== diaryMealSlots.length) {
    throw new RangeError("Diary groups must contain each stable meal slot exactly once");
  }
  return groups;
}

/** Stored malformed or absent configuration never escapes into a client session. */
export function diaryGroupsFromPreferences(preferences: JsonObject): readonly DiaryGroup[] {
  const stored = preferences.diaryGroups;
  if (!record(stored) || !exactKeys(stored, ["groups", "version"]) || stored.version !== 1) {
    return clonedDefaults();
  }
  try {
    return normalizeDiaryGroups(stored.groups);
  } catch {
    return clonedDefaults();
  }
}

/** Replace only the diaryGroups namespace while preserving every unrelated preference. */
export function preferencesWithDiaryGroups(
  preferences: JsonObject,
  groups: readonly DiaryGroup[],
): JsonObject {
  const normalized = normalizeDiaryGroups(groups);
  const storedGroups = normalized.map(
    (group): JsonObject => ({ mealSlot: group.mealSlot, label: group.label }),
  );
  return {
    ...preferences,
    diaryGroups: {
      version: 1,
      groups: storedGroups,
    },
  };
}
