import { FoodSearchError } from "./errors.js";
import { normalizeGtin } from "./query.js";
import type {
  FoodSearchDocument,
  FoodSearchHit,
  FoodSearchServing,
  FoodSearchSource,
} from "./types.js";

const DOCUMENT_KEYS = new Set([
  "aliases",
  "barcodes",
  "brandName",
  "dataQuality",
  "defaultServing",
  "foodId",
  "foodVersionId",
  "id",
  "kind",
  "languageTag",
  "marketCode",
  "name",
  "normalizedName",
  "servingLabels",
  "source",
]);
const SOURCE_KEYS = new Set([
  "attributionRequired",
  "attributionText",
  "code",
  "displayName",
  "licenseExpression",
]);
const SERVING_KEYS = new Set([
  "gramWeight",
  "label",
  "milliliterVolume",
  "quantity",
  "servingId",
  "unit",
]);
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]+$/u;
const MARKET_CODE = /^[A-Z0-9]{2,3}$/u;
const LANGUAGE_TAG = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const SOURCE_CODE = /^[A-Z][A-Z0-9_]{1,31}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  return (
    Object.keys(record).length === expected.size &&
    Object.keys(record).every((key) => expected.has(key))
  );
}

function nonBlankString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isNullableDecimal(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DECIMAL.test(value) && value !== "0");
}

function isServing(value: unknown): value is FoodSearchServing {
  if (!isRecord(value) || !hasExactKeys(value, SERVING_KEYS)) {
    return false;
  }
  return (
    nonBlankString(value.servingId, 128) &&
    nonBlankString(value.label, 200) &&
    typeof value.quantity === "string" &&
    DECIMAL.test(value.quantity) &&
    value.quantity !== "0" &&
    nonBlankString(value.unit, 50) &&
    isNullableDecimal(value.gramWeight) &&
    isNullableDecimal(value.milliliterVolume)
  );
}

function isSource(value: unknown): value is FoodSearchSource {
  return (
    isRecord(value) &&
    hasExactKeys(value, SOURCE_KEYS) &&
    nonBlankString(value.code, 32) &&
    SOURCE_CODE.test(value.code) &&
    nonBlankString(value.displayName, 200) &&
    nonBlankString(value.licenseExpression, 256) &&
    typeof value.attributionRequired === "boolean" &&
    nonBlankString(value.attributionText, 2000)
  );
}

function isStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => nonBlankString(item, maximumLength))
  );
}

export function isFoodSearchDocument(value: unknown): value is FoodSearchDocument {
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENT_KEYS)) {
    return false;
  }
  if (
    !nonBlankString(value.id, 128) ||
    !SAFE_DOCUMENT_ID.test(value.id) ||
    !nonBlankString(value.foodId, 128) ||
    !nonBlankString(value.foodVersionId, 128) ||
    (value.kind !== "generic" && value.kind !== "branded") ||
    !nonBlankString(value.name, 500) ||
    !nonBlankString(value.normalizedName, 512) ||
    (value.brandName !== null && !nonBlankString(value.brandName, 300)) ||
    !isStringArray(value.aliases, 64, 256) ||
    !isStringArray(value.barcodes, 32, 14) ||
    !value.barcodes.every((barcode) => normalizeGtin(barcode) === barcode) ||
    !isStringArray(value.servingLabels, 64, 256) ||
    typeof value.marketCode !== "string" ||
    !MARKET_CODE.test(value.marketCode) ||
    typeof value.languageTag !== "string" ||
    value.languageTag.length > 35 ||
    !LANGUAGE_TAG.test(value.languageTag) ||
    !isCanonicalLanguageTag(value.languageTag) ||
    !isSource(value.source) ||
    (value.dataQuality !== "curated" &&
      value.dataQuality !== "provisional" &&
      value.dataQuality !== "verified") ||
    (value.defaultServing !== null && !isServing(value.defaultServing))
  ) {
    return false;
  }
  return value.kind !== "generic" || value.brandName === null;
}

function isCanonicalLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}

export function assertFoodSearchDocument(value: unknown): asserts value is FoodSearchDocument {
  if (!isFoodSearchDocument(value)) {
    throw new FoodSearchError(
      "INVALID_SEARCH_DOCUMENT",
      "search projection emitted a malformed, non-public, or unsupported food document",
    );
  }
}

export function toFoodSearchHit(document: FoodSearchDocument): FoodSearchHit {
  return {
    foodId: document.foodId,
    foodVersionId: document.foodVersionId,
    kind: document.kind,
    name: document.name,
    brandName: document.brandName,
    marketCode: document.marketCode,
    languageTag: document.languageTag,
    source: { ...document.source },
    defaultServing: document.defaultServing === null ? null : { ...document.defaultServing },
  };
}
