import { InvalidSearchQueryError } from "./errors.js";
import type {
  FoodAutocompleteQuery,
  FoodSearchDocument,
  FoodSearchIntent,
  FoodSearchQuery,
  NormalizedFoodSearchQuery,
  PublicFoodKind,
} from "./types.js";

export const MAX_SEARCH_QUERY_CODE_POINTS = 160;
export const MAX_SEARCH_PAGE_SIZE = 50;
export const MAX_AUTOCOMPLETE_SIZE = 10;
export const MIN_AUTOCOMPLETE_CODE_POINTS = 2;

const MARKET_CODE = /^[A-Z0-9]{2,3}$/u;
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const GENERIC_CUES = new Set([
  "boiled",
  "cooked",
  "dried",
  "fresh",
  "frozen",
  "raw",
  "roasted",
  "steamed",
  "whole",
]);

export function normalizeQueryText(value: string): string {
  if (typeof value !== "string") {
    throw new InvalidSearchQueryError("query must be a string");
  }

  const normalized = value
    .normalize("NFKC")
    // Remove format controls that can obscure the visible query, including bidi overrides.
    .replace(/[\p{Cf}\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const length = [...normalized].length;
  if (length === 0) {
    throw new InvalidSearchQueryError("query must not be blank");
  }
  if (length > MAX_SEARCH_QUERY_CODE_POINTS) {
    throw new InvalidSearchQueryError(
      `query must contain at most ${MAX_SEARCH_QUERY_CODE_POINTS} Unicode characters`,
    );
  }
  return normalized;
}

export function normalizeGtin(value: string): string | null {
  if (typeof value !== "string" || !/^[\d\s-]+$/u.test(value)) {
    return null;
  }
  const digits = value.replace(/[\s-]/gu, "");
  if (!GTIN_LENGTHS.has(digits.length)) {
    return null;
  }
  const data = digits.slice(0, -1);
  let weightedSum = 0;
  for (let index = data.length - 1, position = 0; index >= 0; index -= 1, position += 1) {
    weightedSum += Number(data[index]) * (position % 2 === 0 ? 3 : 1);
  }
  const expectedCheckDigit = (10 - (weightedSum % 10)) % 10;
  if (Number(digits.at(-1)) !== expectedCheckDigit) {
    return null;
  }
  return digits.padStart(14, "0");
}

export function requireGtin(value: string): string {
  const gtin = normalizeGtin(value);
  if (gtin === null) {
    throw new InvalidSearchQueryError(
      "gtin must contain 8, 12, 13, or 14 digits with a valid GS1 check digit",
    );
  }
  return gtin;
}

function normalizeIntent(intent: FoodSearchIntent | undefined): FoodSearchIntent {
  const normalized = intent ?? "all";
  if (normalized !== "all" && normalized !== "generic" && normalized !== "branded") {
    throw new InvalidSearchQueryError("intent must be all, generic, or branded");
  }
  return normalized;
}

export function normalizeMarketCode(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!MARKET_CODE.test(normalized)) {
    throw new InvalidSearchQueryError("marketCode must be a 2-3 character market code");
  }
  return normalized;
}

export function normalizeLanguageTag(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (!LANGUAGE_TAG.test(normalized)) {
    throw new InvalidSearchQueryError("languageTag must be a structurally valid language tag");
  }
  try {
    return Intl.getCanonicalLocales(normalized)[0] ?? null;
  } catch {
    throw new InvalidSearchQueryError("languageTag must be a structurally valid language tag");
  }
}

function normalizeLimit(value: number | undefined, maximum: number, defaultValue: number): number {
  const normalized = value ?? defaultValue;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new InvalidSearchQueryError(`limit must be an integer between 1 and ${maximum}`);
  }
  return normalized;
}

export function normalizeFoodSearchQuery(query: FoodSearchQuery): NormalizedFoodSearchQuery {
  const normalizedText = normalizeQueryText(query.query);
  return {
    query: normalizedText,
    intent: normalizeIntent(query.intent),
    marketCode: normalizeMarketCode(query.marketCode),
    languageTag: normalizeLanguageTag(query.languageTag),
    limit: normalizeLimit(query.limit, MAX_SEARCH_PAGE_SIZE, 20),
    barcode: normalizeGtin(normalizedText),
  };
}

export function normalizeAutocompleteQuery(
  query: FoodAutocompleteQuery,
): NormalizedFoodSearchQuery | null {
  const normalized = normalizeFoodSearchQuery({
    ...query,
    limit: normalizeLimit(query.limit, MAX_AUTOCOMPLETE_SIZE, 8),
  });
  if ([...normalized.query].length < MIN_AUTOCOMPLETE_CODE_POINTS) {
    return null;
  }
  return normalized;
}

function filterLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Only validated/enumerated values enter filters; callers cannot inject Meilisearch expressions. */
export function buildFoodSearchFilters(
  query: Pick<NormalizedFoodSearchQuery, "barcode" | "intent" | "languageTag" | "marketCode">,
): readonly string[] {
  const filters: string[] = [];
  if (query.intent !== "all") {
    filters.push(`kind = ${filterLiteral(query.intent)}`);
  }
  if (query.marketCode !== null) {
    filters.push(
      query.marketCode === "001"
        ? `marketCode = ${filterLiteral(query.marketCode)}`
        : `(marketCode = ${filterLiteral(query.marketCode)} OR marketCode = "001")`,
    );
  }
  if (query.languageTag !== null) {
    filters.push(`languageTag = ${filterLiteral(query.languageTag)}`);
  }
  if (query.barcode !== null) {
    filters.push(`barcodes = ${filterLiteral(query.barcode)}`);
  }
  return filters;
}

export function inferPreferredKind(
  query: NormalizedFoodSearchQuery,
  documents: readonly FoodSearchDocument[],
): PublicFoodKind {
  if (query.intent !== "all") {
    return query.intent;
  }
  if (query.barcode !== null) {
    return "branded";
  }

  const normalizedQuery = query.query.toLocaleLowerCase("und");
  for (const document of documents) {
    const brand = document.brandName?.normalize("NFKC").trim().toLocaleLowerCase("und");
    if (brand !== undefined && brand.length >= 2) {
      if (normalizedQuery === brand || ` ${normalizedQuery} `.includes(` ${brand} `)) {
        return "branded";
      }
    }
  }
  const words = normalizedQuery.split(/\s+/u);
  if (words.some((word) => GENERIC_CUES.has(word))) {
    return "generic";
  }
  return "generic";
}
