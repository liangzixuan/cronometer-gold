export const foodSearchIntents = ["all", "generic", "branded"] as const;

export type FoodSearchIntent = (typeof foodSearchIntents)[number];
export type FoodKind = Exclude<FoodSearchIntent, "all">;

export interface FoodSourceSummary {
  readonly code: string;
  readonly displayName: string;
  readonly licenseExpression: string;
  readonly attributionRequired: boolean;
  readonly attributionText: string;
}

export interface FoodSearchHit {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: FoodKind;
  readonly name: string;
  readonly brandName: string | null;
  readonly marketCode: string;
  readonly languageTag: string;
  readonly source: FoodSourceSummary;
  readonly defaultServing: {
    readonly servingId: string;
    readonly label: string;
    readonly quantity: string;
    readonly unit: string;
    readonly gramWeight: string | null;
    readonly milliliterVolume: string | null;
  } | null;
}

export interface FoodSuggestion {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: FoodKind;
  readonly label: string;
  readonly brandName: string | null;
  readonly source: FoodSourceSummary;
}

export interface FoodSearchPage {
  readonly data: readonly FoodSearchHit[];
  readonly page: { readonly nextCursor: string | null };
}

const IDENTIFIER = /^[1-9][0-9]{0,19}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const CURSOR = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u;
const SOURCE_CODE = /^[A-Z][A-Z0-9_]{1,31}$/u;
const MARKET_CODE = /^[A-Z0-9]{2,3}$/u;
const BARCODE = /^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => key in value);
}

function bounded(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function nullableBounded(value: unknown, minimum: number, maximum: number): value is string | null {
  return value === null || bounded(value, minimum, maximum);
}

function nullableDecimal(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DECIMAL.test(value));
}

function isSource(value: unknown): value is FoodSourceSummary {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "code",
      "displayName",
      "licenseExpression",
      "attributionRequired",
      "attributionText",
    ]) &&
    typeof value.code === "string" &&
    SOURCE_CODE.test(value.code) &&
    bounded(value.displayName, 1, 200) &&
    bounded(value.licenseExpression, 1, 256) &&
    typeof value.attributionRequired === "boolean" &&
    bounded(value.attributionText, 1, 2_000)
  );
}

function isServing(value: unknown): value is NonNullable<FoodSearchHit["defaultServing"]> {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "servingId",
      "label",
      "quantity",
      "unit",
      "gramWeight",
      "milliliterVolume",
    ]) &&
    typeof value.servingId === "string" &&
    IDENTIFIER.test(value.servingId) &&
    bounded(value.label, 1, 200) &&
    typeof value.quantity === "string" &&
    DECIMAL.test(value.quantity) &&
    bounded(value.unit, 1, 50) &&
    nullableDecimal(value.gramWeight) &&
    nullableDecimal(value.milliliterVolume)
  );
}

function isHit(value: unknown): value is FoodSearchHit {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "foodId",
      "foodVersionId",
      "kind",
      "name",
      "brandName",
      "marketCode",
      "languageTag",
      "source",
      "defaultServing",
    ]) ||
    typeof value.foodId !== "string" ||
    !IDENTIFIER.test(value.foodId) ||
    typeof value.foodVersionId !== "string" ||
    !IDENTIFIER.test(value.foodVersionId) ||
    (value.kind !== "generic" && value.kind !== "branded") ||
    !bounded(value.name, 1, 500) ||
    !nullableBounded(value.brandName, 1, 300) ||
    typeof value.marketCode !== "string" ||
    !MARKET_CODE.test(value.marketCode) ||
    !bounded(value.languageTag, 2, 35) ||
    !isSource(value.source)
  ) {
    return false;
  }
  return value.defaultServing === null || isServing(value.defaultServing);
}

function isSuggestion(value: unknown): value is FoodSuggestion {
  return (
    isRecord(value) &&
    exactKeys(value, ["foodId", "foodVersionId", "kind", "label", "brandName", "source"]) &&
    typeof value.foodId === "string" &&
    IDENTIFIER.test(value.foodId) &&
    typeof value.foodVersionId === "string" &&
    IDENTIFIER.test(value.foodVersionId) &&
    (value.kind === "generic" || value.kind === "branded") &&
    bounded(value.label, 1, 500) &&
    nullableBounded(value.brandName, 1, 300) &&
    isSource(value.source)
  );
}

export function parseSearchPage(value: unknown): FoodSearchPage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["data", "page"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 50 ||
    !value.data.every(isHit) ||
    !isRecord(value.page) ||
    !exactKeys(value.page, ["nextCursor"]) ||
    !(
      value.page.nextCursor === null ||
      (typeof value.page.nextCursor === "string" &&
        value.page.nextCursor.length <= 512 &&
        CURSOR.test(value.page.nextCursor))
    )
  ) {
    throw new TypeError("Food search returned an unexpected response.");
  }
  return value as unknown as FoodSearchPage;
}

export function parseSuggestions(value: unknown): readonly FoodSuggestion[] {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["data"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 10 ||
    !value.data.every(isSuggestion)
  ) {
    throw new TypeError("Food suggestions returned an unexpected response.");
  }
  return value.data as readonly FoodSuggestion[];
}

export function parseBarcodeResult(value: unknown): FoodSearchHit {
  if (!isRecord(value) || !exactKeys(value, ["data"]) || !isHit(value.data)) {
    throw new TypeError("Barcode lookup returned an unexpected response.");
  }
  return value.data as FoodSearchHit;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function normalizeBarcodeInput(value: string): string {
  const candidate = value.normalize("NFKC").trim();
  if (!/^[0-9\s-]*$/u.test(candidate)) return candidate;
  return candidate.replace(/[\s-]/gu, "");
}

export function isExactBarcode(value: string): boolean {
  return BARCODE.test(value);
}

export function resolveMobileApiBase(
  configuredValue: string | undefined,
  platform: "android" | "ios" | "web",
): URL {
  const localDefault = platform === "android" ? "http://10.0.2.2:4000" : "http://127.0.0.1:4000";
  const base = new URL(configuredValue?.trim() || localDefault);
  const isLocalHost = ["127.0.0.1", "localhost", "10.0.2.2"].includes(base.hostname);
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && isLocalHost)) ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new TypeError("EXPO_PUBLIC_API_URL must be a safe API origin.");
  }
  return base;
}

function searchParameters(
  query: string,
  intent: FoodSearchIntent,
  limit: number,
  cursor?: string,
): URLSearchParams {
  const normalized = normalizeSearchText(query);
  if (normalized.length === 0 || [...normalized].length > 128) {
    throw new RangeError("Search text must contain between 1 and 128 characters.");
  }
  if (cursor !== undefined && (cursor.length > 512 || !CURSOR.test(cursor))) {
    throw new RangeError("The search cursor is invalid.");
  }
  const parameters = new URLSearchParams({ query: normalized, intent, limit: String(limit) });
  if (cursor !== undefined) parameters.set("cursor", cursor);
  return parameters;
}

export function buildSearchUrl(
  apiBase: URL,
  query: string,
  intent: FoodSearchIntent,
  cursor?: string,
): URL {
  const url = new URL("/v1/foods/search", apiBase);
  url.search = searchParameters(query, intent, 20, cursor).toString();
  return url;
}

export function buildAutocompleteUrl(apiBase: URL, query: string, intent: FoodSearchIntent): URL {
  const url = new URL("/v1/foods/autocomplete", apiBase);
  url.search = searchParameters(query, intent, 8).toString();
  return url;
}

export function buildBarcodeUrl(apiBase: URL, barcode: string): URL {
  if (!isExactBarcode(barcode)) {
    throw new RangeError("A barcode must contain exactly 8, 12, 13, or 14 digits.");
  }
  return new URL(`/v1/foods/barcodes/${barcode}`, apiBase);
}

export function mergeSearchResults(
  current: readonly FoodSearchHit[],
  incoming: readonly FoodSearchHit[],
  append: boolean,
): readonly FoodSearchHit[] {
  if (!append) return incoming;
  const seen = new Set(current.map((item) => item.foodVersionId));
  return [...current, ...incoming.filter((item) => !seen.has(item.foodVersionId))];
}

export function isInvalidContinuationResponse(status: number, cursor?: string): boolean {
  return status === 400 && cursor !== undefined;
}

export function isInvalidBarcodeResponse(status: number): boolean {
  return status === 400;
}
