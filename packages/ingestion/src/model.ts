import {
  canonicalNonNegativeDecimal,
  compareCodePoints,
  normalizeText,
  sha256CanonicalJson,
} from "./deterministic.js";
import { IngestionError, invariant } from "./errors.js";

export type StagedKnownQuality = "calculated" | "estimated" | "label" | "measured";
export type StagedUnknownReason = "not_analyzed" | "not_applicable" | "not_reported" | "withheld";

export type StagedNutrientValue =
  | {
      readonly state: "known";
      readonly amount: string;
      readonly quality: StagedKnownQuality;
    }
  | {
      readonly state: "trace";
      readonly detectionLimit: string | null;
    }
  | {
      readonly state: "unknown";
      readonly reason: StagedUnknownReason;
    };

export interface StagedNutrientRecord {
  readonly sourceNutrientId: string;
  readonly sourceName: string;
  readonly originalUnit: string;
  readonly canonicalNutrientId: string | null;
  readonly canonicalUnit: string | null;
  readonly provenance: {
    readonly derivationCode: string | null;
    readonly dataPoints: number | null;
  };
  readonly value: StagedNutrientValue;
}

export interface StagedServingRecord {
  readonly sourceServingId: string;
  readonly description: string;
  readonly amount: string;
  readonly unit: string;
  readonly gramWeight: string | null;
}

export interface StagedFoodRecord {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly source: {
    readonly sourceCode: string;
    readonly releaseKey: string;
    readonly sourceRecordId: string;
    readonly sourceDataType: string;
    readonly languageTag: string;
    readonly marketCode: string;
    readonly sourceModifiedAt: string | null;
  };
  readonly identity: {
    readonly description: string;
    readonly descriptionFr: string | null;
    readonly brandOwner: string | null;
    readonly gtin: string | null;
  };
  readonly basis: {
    readonly amount: string;
    readonly unit: "g";
  };
  /** Absence from nutrients is unknown/not-reported, never a quantified zero. */
  readonly unlistedNutrientPolicy: "unknown_not_reported";
  readonly nutrients: readonly StagedNutrientRecord[];
  readonly servings: readonly StagedServingRecord[];
  readonly sourcePayloadHash: string;
}

export interface MutableStagedFoodInput {
  readonly sourceCode: string;
  readonly releaseKey: string;
  readonly sourceRecordId: unknown;
  readonly sourceDataType: unknown;
  readonly languageTag: unknown;
  readonly marketCode: unknown;
  readonly sourceModifiedAt?: unknown;
  readonly description: unknown;
  readonly descriptionFr?: unknown;
  readonly brandOwner?: unknown;
  readonly gtin?: unknown;
  readonly nutrients: readonly StagedNutrientRecord[];
  readonly servings?: readonly StagedServingRecord[];
  readonly rawSourceRecord: unknown;
}

const CANONICAL_BY_FDC_ID: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "1003": ["protein", "g"],
  "1004": ["fat", "g"],
  "1005": ["carbohydrate", "g"],
  "1008": ["energy", "kcal"],
  "1079": ["fiber", "g"],
  "1087": ["calcium", "mg"],
  "1089": ["iron", "mg"],
  "1092": ["potassium", "mg"],
  "1093": ["sodium", "mg"],
  "1106": ["vitamin-a-rae", "ug_RAE"],
  "1114": ["vitamin-d", "ug"],
  "1162": ["vitamin-c", "mg"],
  "1177": ["folate-dfe", "ug_DFE"],
  "1178": ["vitamin-b12", "ug"],
  "2000": ["sugars", "g"],
});

const CANONICAL_BY_SYMBOL: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  CA: ["calcium", "mg"],
  CARB: ["carbohydrate", "g"],
  CHOCDF: ["carbohydrate", "g"],
  ENERC_KCAL: ["energy", "kcal"],
  FAT: ["fat", "g"],
  FE: ["iron", "mg"],
  FIBTG: ["fiber", "g"],
  FOLDFE: ["folate-dfe", "ug_DFE"],
  K: ["potassium", "mg"],
  KCAL: ["energy", "kcal"],
  NA: ["sodium", "mg"],
  PROCNT: ["protein", "g"],
  PROT: ["protein", "g"],
  SUGAR: ["sugars", "g"],
  TSUG: ["sugars", "g"],
  VITA_RAE: ["vitamin-a-rae", "ug_RAE"],
  VITB12: ["vitamin-b12", "ug"],
  VITC: ["vitamin-c", "mg"],
  VITD: ["vitamin-d", "ug"],
});

export interface NutrientMappingRequest {
  readonly source: "CNF" | "FDC";
  readonly sourceNutrientId: string;
  readonly sourceSymbol: string | null;
  readonly sourceTagname: string | null;
  readonly originalUnit: string;
}

export type NutrientMappingResolver = (
  request: NutrientMappingRequest,
) => { readonly nutrientId: string; readonly unit: string } | null;

/**
 * A convenience proposal for a human-reviewed mapping workflow, never an
 * authority for release promotion. Adapters default to no canonical mapping;
 * production resolution belongs to the versioned source-nutrient map.
 */
export function proposeCanonicalNutrientMapping(
  source: "CNF" | "FDC",
  sourceNutrientId: string,
  sourceSymbol?: string | null,
  sourceTagname?: string | null,
): { readonly nutrientId: string; readonly unit: string } | null {
  const match =
    source === "FDC"
      ? CANONICAL_BY_FDC_ID[sourceNutrientId]
      : (CANONICAL_BY_SYMBOL[(sourceTagname ?? "").trim().toUpperCase()] ??
        CANONICAL_BY_SYMBOL[(sourceSymbol ?? "").trim().toUpperCase()]);
  return match ? Object.freeze({ nutrientId: match[0], unit: match[1] }) : null;
}

export function parseSourceNutrientValue(
  rawValue: unknown,
  quality: StagedKnownQuality,
  field = "nutrient amount",
): StagedNutrientValue {
  if (rawValue === null || rawValue === undefined) {
    return Object.freeze({ state: "unknown", reason: "not_reported" });
  }
  if (typeof rawValue === "string") {
    const marker = rawValue.trim();
    if (marker.length === 0 || /^(?:--?|NQ|NOT[ _-]?REPORTED)$/i.test(marker)) {
      return Object.freeze({ state: "unknown", reason: "not_reported" });
    }
    if (/^(?:N\/A|NA|NOT[ _-]?ANALYZED)$/i.test(marker)) {
      return Object.freeze({ state: "unknown", reason: "not_analyzed" });
    }
    if (/^(?:NOT[ _-]?APPLICABLE)$/i.test(marker)) {
      return Object.freeze({ state: "unknown", reason: "not_applicable" });
    }
    if (/^(?:WITHHELD|SUPPRESSED)$/i.test(marker)) {
      return Object.freeze({ state: "unknown", reason: "withheld" });
    }
    if (/^(?:TR|TRACE)$/i.test(marker)) {
      return Object.freeze({ state: "trace", detectionLimit: null });
    }
    const lessThan = /^<\s*(.+)$/.exec(marker);
    if (lessThan) {
      return Object.freeze({
        state: "trace",
        detectionLimit: canonicalPositiveDecimal(lessThan[1], `${field} detection limit`),
      });
    }
  }
  return Object.freeze({
    state: "known",
    amount: canonicalNonNegativeDecimal(rawValue, field),
    quality,
  });
}

export function createStagedNutrient(input: {
  readonly sourceNutrientId: unknown;
  readonly sourceName: unknown;
  readonly originalUnit: unknown;
  readonly mapping?: { readonly nutrientId: string; readonly unit: string } | null;
  readonly derivationCode?: unknown;
  readonly dataPoints?: unknown;
  readonly value: StagedNutrientValue;
}): StagedNutrientRecord {
  const sourceNutrientId = identifier(input.sourceNutrientId, "source nutrient ID");
  const sourceName = normalizeText(input.sourceName, "source nutrient name");
  const originalUnit = normalizeText(input.originalUnit, "source nutrient unit");
  return deepFreeze({
    sourceNutrientId,
    sourceName,
    originalUnit,
    canonicalNutrientId: input.mapping?.nutrientId ?? null,
    canonicalUnit: input.mapping?.unit ?? null,
    provenance: {
      derivationCode:
        input.derivationCode === null ||
        input.derivationCode === undefined ||
        input.derivationCode === ""
          ? null
          : identifier(input.derivationCode, "nutrient derivation code"),
      dataPoints: optionalNonNegativeInteger(input.dataPoints, "nutrient data points"),
    },
    value: input.value,
  });
}

export function createStagedServing(input: {
  readonly sourceServingId: unknown;
  readonly description: unknown;
  readonly amount?: unknown;
  readonly unit: unknown;
  readonly gramWeight?: unknown;
}): StagedServingRecord {
  return deepFreeze({
    sourceServingId: identifier(input.sourceServingId, "source serving ID"),
    description: normalizeText(input.description, "serving description"),
    amount: canonicalPositiveDecimal(input.amount ?? 1, "serving amount"),
    unit: normalizeText(input.unit, "serving unit"),
    gramWeight:
      input.gramWeight === null || input.gramWeight === undefined || input.gramWeight === ""
        ? null
        : canonicalPositiveDecimal(input.gramWeight, "serving gram weight"),
  });
}

export function createStagedFood(input: MutableStagedFoodInput): StagedFoodRecord {
  const sourceCode = identifier(input.sourceCode, "source code");
  const releaseKey = identifier(input.releaseKey, "release key");
  const sourceRecordId = identifier(input.sourceRecordId, "source record ID");
  const sourceDataType = normalizeText(input.sourceDataType, "source data type");
  const languageTag = identifier(input.languageTag, "language tag");
  invariant(
    /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(languageTag),
    "INVALID_RECORD",
    "Language tag is invalid",
    { languageTag },
  );
  const marketCode = identifier(input.marketCode, "market code");
  invariant(/^(?:[A-Z]{2}|001)$/.test(marketCode), "INVALID_RECORD", "Market code is invalid", {
    marketCode,
  });
  const sourceModifiedAt = optionalSourceDate(input.sourceModifiedAt);
  const nutrients = [...input.nutrients].sort((left, right) =>
    compareCodePoints(left.sourceNutrientId, right.sourceNutrientId),
  );
  rejectDuplicates(nutrients, (entry) => entry.sourceNutrientId, "nutrient");
  const servings = [...(input.servings ?? [])].sort((left, right) =>
    compareCodePoints(left.sourceServingId, right.sourceServingId),
  );
  rejectDuplicates(servings, (entry) => entry.sourceServingId, "serving");

  const gtin = optionalText(input.gtin, "GTIN");
  if (gtin !== null) {
    invariant(
      /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(gtin),
      "INVALID_RECORD",
      "GTIN must contain exactly 8, 12, 13, or 14 digits",
      { gtin },
    );
    invariant(
      hasValidGs1CheckDigit(gtin),
      "INVALID_RECORD",
      "GTIN has an invalid GS1 check digit",
      {
        gtin,
      },
    );
  }
  const idempotencyKey = `${sourceCode}:${releaseKey}:${sourceDataType}:${sourceRecordId}`;
  return deepFreeze({
    schemaVersion: 1,
    idempotencyKey,
    source: {
      sourceCode,
      releaseKey,
      sourceRecordId,
      sourceDataType,
      languageTag,
      marketCode,
      sourceModifiedAt,
    },
    identity: {
      description: normalizeText(input.description, "food description"),
      descriptionFr: optionalText(input.descriptionFr, "French food description"),
      brandOwner: optionalText(input.brandOwner, "brand owner"),
      gtin,
    },
    basis: { amount: "100", unit: "g" },
    unlistedNutrientPolicy: "unknown_not_reported",
    nutrients,
    servings,
    sourcePayloadHash: sha256CanonicalJson(input.rawSourceRecord),
  });
}

function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric =
    typeof value === "string" && /^\d+(?:\.0+)?$/.test(value.trim()) ? Number(value) : value;
  invariant(
    Number.isSafeInteger(numeric) && (numeric as number) >= 0,
    "INVALID_RECORD",
    `${field} must be a non-negative integer`,
    { field },
  );
  return numeric as number;
}

function optionalSourceDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  invariant(typeof value === "string", "INVALID_RECORD", "Source modified date must be text");
  const normalized = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const parsed = new Date(`${normalized}T00:00:00.000Z`);
    invariant(
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === normalized,
      "INVALID_RECORD",
      "Source modified date is invalid",
    );
    return normalized;
  }
  invariant(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) && !Number.isNaN(Date.parse(normalized)),
    "INVALID_RECORD",
    "Source modified timestamp must be ISO-8601 with a timezone",
  );
  return normalized;
}

export function hasValidGs1CheckDigit(gtin: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(gtin)) {
    return false;
  }
  let sum = 0;
  for (let index = gtin.length - 2, position = 1; index >= 0; index -= 1, position += 1) {
    const digit = Number(gtin[index]);
    sum += digit * (position % 2 === 1 ? 3 : 1);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(gtin.at(-1));
}

export function identifier(value: unknown, field: string): string {
  invariant(
    typeof value === "string" || typeof value === "number",
    "INVALID_RECORD",
    `${field} must be a string or number`,
    { field },
  );
  const id = String(value).normalize("NFC").trim();
  invariant(id.length > 0 && id.length <= 256, "INVALID_RECORD", `${field} is invalid`, { field });
  invariant(!hasControlCharacters(id), "INVALID_RECORD", `${field} has control characters`, {
    field,
  });
  return id;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

export function asRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_RECORD",
    `${field} must be an object`,
    { field },
  );
  return value as Readonly<Record<string, unknown>>;
}

export function arrayValue(value: unknown, field: string): readonly unknown[] {
  invariant(Array.isArray(value), "INVALID_RECORD", `${field} must be an array`, { field });
  return value;
}

export function firstDefined(
  record: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function canonicalPositiveDecimal(value: unknown, field: string): string {
  const normalized = canonicalNonNegativeDecimal(value, field);
  invariant(normalized !== "0", "INVALID_RECORD", `${field} must be greater than zero`, { field });
  return normalized;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return normalizeText(value, field);
}

function rejectDuplicates<T>(entries: readonly T[], key: (entry: T) => string, kind: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = key(entry);
    if (seen.has(value)) {
      throw new IngestionError("DUPLICATE_KEY", `Duplicate ${kind} key: ${value}`, {
        kind,
        key: value,
      });
    }
    seen.add(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
