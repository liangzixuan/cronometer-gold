import type { DecimalInput, DecimalString } from "./decimal.js";
import { canonicalPositiveDecimal } from "./decimal.js";
import { DomainError, domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";
import {
  combineNutrientAggregates,
  type NutrientAggregate,
  type NutrientDefinition,
  type NutrientId,
  normalizeNutrientAggregate,
} from "./nutrients.js";
import { canonicalRfc3339Instant, deriveDiaryLocalCoordinates } from "./time.js";

export type DiaryEntrySource =
  | {
      readonly kind: "food";
      readonly foodId: string;
      readonly foodVersionId: string;
      readonly sourceCode: string;
    }
  | {
      readonly kind: "recipe";
      readonly recipeId: string;
      readonly recipeVersionId: string;
    };

export interface DiaryPortionSnapshot {
  readonly enteredAmount: DecimalInput;
  readonly enteredUnit: string;
  readonly servingId: string | null;
  readonly resolvedGrams: DecimalInput;
}

export interface DiaryNutritionSnapshotInput {
  readonly snapshotId: string;
  readonly entryId: string;
  readonly entryRevisionId: string;
  readonly supersedesRevisionId: string | null;
  readonly source: DiaryEntrySource;
  /** User-local YYYY-MM-DD assigned at write time. */
  readonly diaryDate: string;
  /** ISO-8601 instant with offset or Z. */
  readonly occurredAt: string;
  /** Original IANA time-zone identifier or product-defined fixed-offset zone. */
  readonly timeZone: string;
  readonly meal: string;
  readonly portion: DiaryPortionSnapshot;
  readonly nutrients: readonly NutrientAggregate[];
  readonly nutritionEngineVersion: string;
  /** Supplied by the application clock; this pure package never reads time. */
  readonly capturedAt: string;
  readonly calculationWarnings?: readonly string[];
}

export interface DiaryNutritionSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly entryId: string;
  readonly entryRevisionId: string;
  readonly supersedesRevisionId: string | null;
  readonly source: DiaryEntrySource;
  readonly diaryDate: string;
  readonly occurredAt: string;
  readonly timeZone: string;
  readonly meal: string;
  readonly portion: {
    readonly enteredAmount: DecimalString;
    readonly enteredUnit: string;
    readonly servingId: string | null;
    readonly resolvedGrams: DecimalString;
  };
  readonly nutrients: readonly NutrientAggregate[];
  readonly nutritionEngineVersion: string;
  readonly capturedAt: string;
  readonly calculationWarnings: readonly string[];
}

/**
 * Copy, canonicalize, validate, sort, and runtime-freeze a diary revision. No
 * current food or recipe pointer is retained as a calculation dependency.
 */
export function createDiaryNutritionSnapshot(
  input: DiaryNutritionSnapshotInput,
): DiaryNutritionSnapshot {
  validateRequiredText("snapshotId", input.snapshotId);
  validateRequiredText("entryId", input.entryId);
  validateRequiredText("entryRevisionId", input.entryRevisionId);
  if (input.supersedesRevisionId !== null) {
    validateRequiredText("supersedesRevisionId", input.supersedesRevisionId);
    domainInvariant(
      input.supersedesRevisionId !== input.entryRevisionId,
      "INVALID_SNAPSHOT",
      "A diary revision cannot supersede itself",
    );
  }
  validateSource(input.source);
  validateLocalDate(input.diaryDate);
  const localCoordinates = deriveDiaryLocalCoordinates(input.occurredAt, input.timeZone);
  domainInvariant(
    input.diaryDate === localCoordinates.localDate,
    "INVALID_DATE",
    "diaryDate must be derived from occurredAt and timeZone",
    {
      diaryDate: input.diaryDate,
      derivedDiaryDate: localCoordinates.localDate,
    },
  );
  const capturedAt = canonicalRfc3339Instant(input.capturedAt, "capturedAt");
  validateRequiredText("meal", input.meal);
  validateRequiredText("enteredUnit", input.portion.enteredUnit);
  validateRequiredText("nutritionEngineVersion", input.nutritionEngineVersion);
  domainInvariant(
    input.nutrients.length > 0,
    "INVALID_SNAPSHOT",
    "Diary nutrition snapshot requires at least one nutrient",
  );

  const seen = new Set<NutrientId>();
  const nutrients = input.nutrients.map((aggregate) => {
    const normalized = normalizeNutrientAggregate(aggregate);
    if (seen.has(normalized.nutrientId)) {
      throw new DomainError(
        "DUPLICATE_NUTRIENT",
        `Duplicate nutrient in diary snapshot: ${normalized.nutrientId}`,
        { nutrientId: normalized.nutrientId },
      );
    }
    seen.add(normalized.nutrientId);
    return normalized;
  });
  nutrients.sort((left, right) => left.nutrientId.localeCompare(right.nutrientId));

  return deepFreeze<DiaryNutritionSnapshot>({
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    entryId: input.entryId,
    entryRevisionId: input.entryRevisionId,
    supersedesRevisionId: input.supersedesRevisionId,
    source: { ...input.source },
    diaryDate: input.diaryDate,
    occurredAt: localCoordinates.occurredAt,
    timeZone: localCoordinates.timeZone,
    meal: input.meal,
    portion: {
      enteredAmount: canonicalPositiveDecimal(input.portion.enteredAmount, "entered portion"),
      enteredUnit: input.portion.enteredUnit,
      servingId: input.portion.servingId,
      resolvedGrams: canonicalPositiveDecimal(input.portion.resolvedGrams, "resolved grams"),
    },
    nutrients,
    nutritionEngineVersion: input.nutritionEngineVersion,
    capturedAt,
    calculationWarnings: [...(input.calculationWarnings ?? [])],
  });
}

/**
 * Aggregate immutable entry snapshots for a report/day. Every absent expected
 * nutrient becomes one unknown contribution; it never becomes a zero.
 */
export function aggregateDiarySnapshots(
  snapshots: readonly DiaryNutritionSnapshot[],
  expectedNutrients: readonly NutrientDefinition[],
): readonly NutrientAggregate[] {
  domainInvariant(
    snapshots.length > 0,
    "INVALID_SNAPSHOT",
    "At least one diary snapshot is required",
  );
  const definitions = new Set(expectedNutrients.map((definition) => definition.id));
  domainInvariant(
    definitions.size === expectedNutrients.length,
    "DUPLICATE_NUTRIENT",
    "Expected diary nutrients must be unique",
  );

  const totals = expectedNutrients.map((definition) => {
    const contributions = snapshots.map((snapshot) => {
      const match = snapshot.nutrients.find((entry) => entry.nutrientId === definition.id);
      if (match) {
        return match;
      }
      return missingAggregate(definition);
    });
    return combineNutrientAggregates(definition, contributions);
  });
  return deepFreeze(totals);
}

function missingAggregate(definition: NutrientDefinition): NutrientAggregate {
  return normalizeNutrientAggregate({
    nutrientId: definition.id,
    unit: definition.canonicalUnit,
    knownAmount: "0",
    completeness: "unknown",
    isExact: false,
    contributorCount: 1,
    quantifiedCount: 0,
    traceCount: 0,
    unknownCount: 1,
    unknownReasons: { not_reported: 1 },
  });
}

function validateSource(source: DiaryEntrySource): void {
  if (source.kind === "food") {
    validateRequiredText("foodId", source.foodId);
    validateRequiredText("foodVersionId", source.foodVersionId);
    validateRequiredText("sourceCode", source.sourceCode);
  } else {
    validateRequiredText("recipeId", source.recipeId);
    validateRequiredText("recipeVersionId", source.recipeVersionId);
  }
}

function validateRequiredText(field: string, value: string): void {
  domainInvariant(value.trim().length > 0, "INVALID_SNAPSHOT", `${field} is required`, { field });
}

function validateLocalDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new DomainError("INVALID_DATE", "diaryDate must use YYYY-MM-DD", { value });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(0);
  check.setUTCHours(0, 0, 0, 0);
  check.setUTCFullYear(year, month - 1, day);
  domainInvariant(
    check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day,
    "INVALID_DATE",
    "diaryDate is not a valid calendar date",
    { value },
  );
}
