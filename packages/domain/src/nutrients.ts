import type { DecimalInput, DecimalString } from "./decimal.js";
import { canonicalNonNegativeDecimal, canonicalPositiveDecimal, decimal } from "./decimal.js";
import { DomainError, domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";

export type NutrientId = string;

/**
 * Nutrient units are semantic, not merely dimensional. For example, ug_DFE and
 * ug_RAE must never be converted to plain ug without nutrient-specific metadata.
 */
export const NUTRIENT_UNITS = [
  "kcal",
  "kJ",
  "g",
  "mg",
  "ug",
  "IU",
  "mg_NE",
  "ug_DFE",
  "ug_RAE",
] as const;
export type NutrientUnit = (typeof NUTRIENT_UNITS)[number];

export type NutrientCategory =
  | "energy"
  | "macronutrient"
  | "vitamin"
  | "mineral"
  | "amino-acid"
  | "fatty-acid"
  | "other";

export interface NutrientDefinition {
  readonly id: NutrientId;
  readonly name: string;
  readonly canonicalUnit: NutrientUnit;
  readonly category: NutrientCategory;
}

export const CORE_NUTRIENTS: readonly NutrientDefinition[] = deepFreeze([
  { id: "energy", name: "Energy", canonicalUnit: "kcal", category: "energy" },
  { id: "protein", name: "Protein", canonicalUnit: "g", category: "macronutrient" },
  {
    id: "carbohydrate",
    name: "Carbohydrate",
    canonicalUnit: "g",
    category: "macronutrient",
  },
  { id: "fat", name: "Fat", canonicalUnit: "g", category: "macronutrient" },
  { id: "fiber", name: "Fiber", canonicalUnit: "g", category: "macronutrient" },
  { id: "sugars", name: "Sugars", canonicalUnit: "g", category: "macronutrient" },
  { id: "sodium", name: "Sodium", canonicalUnit: "mg", category: "mineral" },
  { id: "potassium", name: "Potassium", canonicalUnit: "mg", category: "mineral" },
  { id: "calcium", name: "Calcium", canonicalUnit: "mg", category: "mineral" },
  { id: "iron", name: "Iron", canonicalUnit: "mg", category: "mineral" },
  { id: "vitamin-c", name: "Vitamin C", canonicalUnit: "mg", category: "vitamin" },
  { id: "vitamin-d", name: "Vitamin D", canonicalUnit: "ug", category: "vitamin" },
  { id: "vitamin-b12", name: "Vitamin B12", canonicalUnit: "ug", category: "vitamin" },
  { id: "folate-dfe", name: "Folate, DFE", canonicalUnit: "ug_DFE", category: "vitamin" },
  {
    id: "vitamin-a-rae",
    name: "Vitamin A, RAE",
    canonicalUnit: "ug_RAE",
    category: "vitamin",
  },
]);

export type KnownValueQuality = "measured" | "calculated" | "estimated" | "label";
export type UnknownNutrientReason = "not_reported" | "not_analyzed" | "not_applicable" | "withheld";

const UNKNOWN_NUTRIENT_REASONS: readonly UnknownNutrientReason[] = [
  "not_reported",
  "not_analyzed",
  "not_applicable",
  "withheld",
];

export interface KnownNutrientValue {
  readonly state: "known";
  /** A quantified zero is represented as state=known and amount="0". */
  readonly amount: DecimalString;
  readonly quality: KnownValueQuality;
}

export interface TraceNutrientValue {
  readonly state: "trace";
  /** Null means the source did not publish a quantification limit. */
  readonly detectionLimit: DecimalString | null;
}

export interface UnknownNutrientValue {
  readonly state: "unknown";
  readonly reason: UnknownNutrientReason;
}

export type NutrientValue = KnownNutrientValue | TraceNutrientValue | UnknownNutrientValue;

export interface NutrientDatum {
  readonly nutrientId: NutrientId;
  readonly unit: NutrientUnit;
  readonly value: NutrientValue;
}

export type NutrientCompleteness = "complete" | "partial" | "unknown";

/**
 * An aggregate's knownAmount is a lower-bound subtotal of quantified
 * contributors. Coverage counters must be inspected before interpreting it as a
 * total. In particular, knownAmount="0" with completeness="unknown" is not a
 * measured zero.
 */
export interface NutrientAggregate {
  readonly nutrientId: NutrientId;
  readonly unit: NutrientUnit;
  readonly knownAmount: DecimalString;
  readonly completeness: NutrientCompleteness;
  readonly isExact: boolean;
  readonly contributorCount: number;
  readonly quantifiedCount: number;
  readonly traceCount: number;
  readonly unknownCount: number;
  readonly unknownReasons: Readonly<Partial<Record<UnknownNutrientReason, number>>>;
}

export interface NutrientProfile {
  /** Gram basis for every nutrient aggregate in the profile. */
  readonly basisGrams: DecimalString;
  readonly nutrients: readonly NutrientAggregate[];
}

export function defineNutrient(definition: NutrientDefinition): NutrientDefinition {
  validateNutrientId(definition.id);
  validateNutrientUnit(definition.canonicalUnit);
  domainInvariant(
    definition.name.trim().length > 0,
    "INVALID_IDENTIFIER",
    "Nutrient name is required",
    { nutrientId: definition.id },
  );
  return deepFreeze({ ...definition });
}

export function knownNutrient(
  amount: DecimalInput,
  quality: KnownValueQuality = "measured",
): KnownNutrientValue {
  return Object.freeze({
    state: "known",
    amount: canonicalNonNegativeDecimal(amount, "nutrient amount"),
    quality,
  });
}

export function traceNutrient(detectionLimit: DecimalInput | null = null): TraceNutrientValue {
  return Object.freeze({
    state: "trace",
    detectionLimit:
      detectionLimit === null
        ? null
        : canonicalPositiveDecimal(detectionLimit, "trace detection limit"),
  });
}

export function unknownNutrient(
  reason: UnknownNutrientReason = "not_reported",
): UnknownNutrientValue {
  return Object.freeze({ state: "unknown", reason });
}

export function nutrientDatum(definition: NutrientDefinition, value: NutrientValue): NutrientDatum {
  const validated = defineNutrient(definition);
  return deepFreeze({
    nutrientId: validated.id,
    unit: validated.canonicalUnit,
    value: normalizeNutrientValue(value),
  });
}

/** Construct a source-food profile while preserving explicit missingness. */
export function createNutrientProfile(
  basisGrams: DecimalInput,
  nutrients: readonly NutrientDatum[],
): NutrientProfile {
  const aggregates = nutrients.map(aggregateFromDatum);
  return createResolvedNutrientProfile(basisGrams, aggregates);
}

/** Construct a profile from already aggregated facts, such as a nested recipe. */
export function createResolvedNutrientProfile(
  basisGrams: DecimalInput,
  nutrients: readonly NutrientAggregate[],
): NutrientProfile {
  const seen = new Set<NutrientId>();
  const normalized = nutrients.map((entry) => {
    validateNutrientId(entry.nutrientId);
    if (seen.has(entry.nutrientId)) {
      throw new DomainError(
        "DUPLICATE_NUTRIENT",
        `Duplicate nutrient in profile: ${entry.nutrientId}`,
        { nutrientId: entry.nutrientId },
      );
    }
    seen.add(entry.nutrientId);
    return normalizeNutrientAggregate(entry);
  });

  normalized.sort((left, right) => left.nutrientId.localeCompare(right.nutrientId));
  return deepFreeze({
    basisGrams: canonicalPositiveDecimal(basisGrams, "nutrient profile basis grams"),
    nutrients: normalized,
  });
}

export function calculatePortionNutrition(
  profile: NutrientProfile,
  portionGrams: DecimalInput,
  expectedNutrients?: readonly NutrientDefinition[],
): readonly NutrientAggregate[] {
  const grams = canonicalPositiveDecimal(portionGrams, "portion grams");
  const factor = decimal(grams).div(profile.basisGrams);
  const entries = new Map(profile.nutrients.map((entry) => [entry.nutrientId, entry]));
  const definitions = expectedNutrients ?? definitionsFromProfile(profile);
  validateUniqueDefinitions(definitions);

  const resolved = definitions.map((definition) => {
    const existing = entries.get(definition.id);
    if (!existing) {
      return scaleNutrientAggregate(
        aggregateFromDatum(nutrientDatum(definition, unknownNutrient("not_reported"))),
        factor,
      );
    }
    domainInvariant(
      existing.unit === definition.canonicalUnit,
      "UNIT_MISMATCH",
      `Nutrient ${definition.id} uses ${existing.unit}, expected ${definition.canonicalUnit}`,
      {
        nutrientId: definition.id,
        actualUnit: existing.unit,
        expectedUnit: definition.canonicalUnit,
      },
    );
    return scaleNutrientAggregate(existing, factor);
  });

  return deepFreeze(resolved);
}

export function combineNutrientAggregates(
  definition: NutrientDefinition,
  aggregates: readonly NutrientAggregate[],
): NutrientAggregate {
  defineNutrient(definition);
  domainInvariant(
    aggregates.length > 0,
    "INVALID_NUTRIENT_AGGREGATE",
    "At least one nutrient contribution is required",
    { nutrientId: definition.id },
  );

  let knownAmount = decimal(0);
  let contributorCount = 0;
  let quantifiedCount = 0;
  let traceCount = 0;
  let unknownCount = 0;
  const unknownReasons: Partial<Record<UnknownNutrientReason, number>> = {};

  for (const candidate of aggregates) {
    const aggregate = normalizeNutrientAggregate(candidate);
    domainInvariant(
      aggregate.nutrientId === definition.id && aggregate.unit === definition.canonicalUnit,
      "UNIT_MISMATCH",
      `Cannot combine incompatible contribution for ${definition.id}`,
      {
        expectedNutrientId: definition.id,
        actualNutrientId: aggregate.nutrientId,
        expectedUnit: definition.canonicalUnit,
        actualUnit: aggregate.unit,
      },
    );
    knownAmount = knownAmount.plus(aggregate.knownAmount);
    contributorCount = checkedCoverageSum(
      contributorCount,
      aggregate.contributorCount,
      definition.id,
      "contributorCount",
    );
    quantifiedCount = checkedCoverageSum(
      quantifiedCount,
      aggregate.quantifiedCount,
      definition.id,
      "quantifiedCount",
    );
    traceCount = checkedCoverageSum(traceCount, aggregate.traceCount, definition.id, "traceCount");
    unknownCount = checkedCoverageSum(
      unknownCount,
      aggregate.unknownCount,
      definition.id,
      "unknownCount",
    );
    for (const [reason, count] of Object.entries(aggregate.unknownReasons)) {
      const typedReason = reason as UnknownNutrientReason;
      unknownReasons[typedReason] = checkedCoverageSum(
        unknownReasons[typedReason] ?? 0,
        count ?? 0,
        definition.id,
        `${typedReason} unknown reason`,
      );
    }
  }

  return buildAggregate({
    nutrientId: definition.id,
    unit: definition.canonicalUnit,
    knownAmount: knownAmount.toFixed(),
    contributorCount,
    quantifiedCount,
    traceCount,
    unknownCount,
    unknownReasons,
  });
}

export function scaleNutrientAggregate(
  aggregate: NutrientAggregate,
  factor: DecimalInput,
): NutrientAggregate {
  const normalized = normalizeNutrientAggregate(aggregate);
  const multiplier = canonicalNonNegativeDecimal(factor, "nutrient scale factor");
  return buildAggregate({
    ...normalized,
    knownAmount: decimal(normalized.knownAmount).mul(multiplier).toFixed(),
  });
}

export function normalizeNutrientAggregate(aggregate: NutrientAggregate): NutrientAggregate {
  validateNutrientId(aggregate.nutrientId);
  validateNutrientUnit(aggregate.unit);
  for (const [name, count] of [
    ["contributorCount", aggregate.contributorCount],
    ["quantifiedCount", aggregate.quantifiedCount],
    ["traceCount", aggregate.traceCount],
    ["unknownCount", aggregate.unknownCount],
  ] as const) {
    domainInvariant(
      Number.isSafeInteger(count) && count >= 0,
      "INVALID_NUTRIENT_AGGREGATE",
      `${name} must be a non-negative safe integer`,
      { nutrientId: aggregate.nutrientId, [name]: count },
    );
  }
  const classifiedCount = checkedCoverageSum(
    checkedCoverageSum(
      aggregate.quantifiedCount,
      aggregate.traceCount,
      aggregate.nutrientId,
      "classified coverage",
    ),
    aggregate.unknownCount,
    aggregate.nutrientId,
    "classified coverage",
  );
  domainInvariant(
    aggregate.contributorCount > 0 && classifiedCount === aggregate.contributorCount,
    "INVALID_NUTRIENT_AGGREGATE",
    "Nutrient coverage counters do not reconcile",
    { nutrientId: aggregate.nutrientId },
  );
  let reasonTotal = 0;
  for (const [reason, count] of Object.entries(aggregate.unknownReasons)) {
    domainInvariant(
      UNKNOWN_NUTRIENT_REASONS.includes(reason as UnknownNutrientReason) &&
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0,
      "INVALID_NUTRIENT_AGGREGATE",
      "Unknown-reason counters require a supported reason and non-negative integer",
      { nutrientId: aggregate.nutrientId, reason, count },
    );
    reasonTotal = checkedCoverageSum(
      reasonTotal,
      count,
      aggregate.nutrientId,
      "unknown reason coverage",
    );
  }
  domainInvariant(
    reasonTotal === aggregate.unknownCount,
    "INVALID_NUTRIENT_AGGREGATE",
    "Unknown-reason counters do not reconcile",
    { nutrientId: aggregate.nutrientId, reasonTotal, unknownCount: aggregate.unknownCount },
  );

  return buildAggregate({
    nutrientId: aggregate.nutrientId,
    unit: aggregate.unit,
    knownAmount: aggregate.knownAmount,
    contributorCount: aggregate.contributorCount,
    quantifiedCount: aggregate.quantifiedCount,
    traceCount: aggregate.traceCount,
    unknownCount: aggregate.unknownCount,
    unknownReasons: aggregate.unknownReasons,
  });
}

function aggregateFromDatum(datum: NutrientDatum): NutrientAggregate {
  validateNutrientId(datum.nutrientId);
  validateNutrientUnit(datum.unit);
  const value = normalizeNutrientValue(datum.value);
  switch (value.state) {
    case "known":
      return buildAggregate({
        nutrientId: datum.nutrientId,
        unit: datum.unit,
        knownAmount: value.amount,
        contributorCount: 1,
        quantifiedCount: 1,
        traceCount: 0,
        unknownCount: 0,
        unknownReasons: {},
      });
    case "trace":
      return buildAggregate({
        nutrientId: datum.nutrientId,
        unit: datum.unit,
        knownAmount: "0",
        contributorCount: 1,
        quantifiedCount: 0,
        traceCount: 1,
        unknownCount: 0,
        unknownReasons: {},
      });
    case "unknown":
      return buildAggregate({
        nutrientId: datum.nutrientId,
        unit: datum.unit,
        knownAmount: "0",
        contributorCount: 1,
        quantifiedCount: 0,
        traceCount: 0,
        unknownCount: 1,
        unknownReasons: { [value.reason]: 1 },
      });
  }
}

interface AggregateParts {
  readonly nutrientId: NutrientId;
  readonly unit: NutrientUnit;
  readonly knownAmount: DecimalInput;
  readonly contributorCount: number;
  readonly quantifiedCount: number;
  readonly traceCount: number;
  readonly unknownCount: number;
  readonly unknownReasons: Readonly<Partial<Record<UnknownNutrientReason, number>>>;
}

function buildAggregate(parts: AggregateParts): NutrientAggregate {
  const completeness: NutrientCompleteness =
    parts.unknownCount === 0
      ? "complete"
      : parts.unknownCount === parts.contributorCount
        ? "unknown"
        : "partial";
  return deepFreeze({
    nutrientId: parts.nutrientId,
    unit: parts.unit,
    knownAmount: canonicalNonNegativeDecimal(parts.knownAmount, "known nutrient amount"),
    completeness,
    isExact: parts.traceCount === 0 && parts.unknownCount === 0,
    contributorCount: parts.contributorCount,
    quantifiedCount: parts.quantifiedCount,
    traceCount: parts.traceCount,
    unknownCount: parts.unknownCount,
    unknownReasons: { ...parts.unknownReasons },
  });
}

function checkedCoverageSum(
  left: number,
  right: number,
  nutrientId: NutrientId,
  counter: string,
): number {
  const sum = left + right;
  domainInvariant(
    Number.isSafeInteger(sum),
    "INVALID_NUTRIENT_AGGREGATE",
    `${counter} exceeds the exact integer range`,
    { counter, left, nutrientId, right },
  );
  return sum;
}

function normalizeNutrientValue(value: NutrientValue): NutrientValue {
  switch (value.state) {
    case "known":
      return knownNutrient(value.amount, value.quality);
    case "trace":
      return traceNutrient(value.detectionLimit);
    case "unknown":
      return unknownNutrient(value.reason);
  }
}

function definitionsFromProfile(profile: NutrientProfile): readonly NutrientDefinition[] {
  return profile.nutrients.map((entry) => ({
    id: entry.nutrientId,
    name: entry.nutrientId,
    canonicalUnit: entry.unit,
    category: "other",
  }));
}

function validateUniqueDefinitions(definitions: readonly NutrientDefinition[]): void {
  const seen = new Set<NutrientId>();
  for (const definition of definitions) {
    defineNutrient(definition);
    if (seen.has(definition.id)) {
      throw new DomainError("DUPLICATE_NUTRIENT", `Duplicate expected nutrient: ${definition.id}`, {
        nutrientId: definition.id,
      });
    }
    seen.add(definition.id);
  }
}

function validateNutrientId(id: NutrientId): void {
  domainInvariant(
    /^[a-z][a-z0-9._-]{1,63}$/.test(id),
    "INVALID_IDENTIFIER",
    "Nutrient id must be a stable lowercase ASCII identifier",
    { nutrientId: id },
  );
}

function validateNutrientUnit(unit: NutrientUnit): void {
  domainInvariant(
    NUTRIENT_UNITS.includes(unit),
    "INVALID_UNIT",
    `Unsupported nutrient unit: ${String(unit)}`,
    { unit },
  );
}
