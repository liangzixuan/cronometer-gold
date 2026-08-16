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

export interface FoodServingSummary {
  readonly servingId: string;
  readonly label: string;
  readonly quantity: string;
  readonly unit: string;
  readonly gramWeight: string | null;
  readonly milliliterVolume: string | null;
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
  readonly defaultServing: FoodServingSummary | null;
}

export interface FoodSearchPage {
  readonly data: readonly FoodSearchHit[];
  readonly page: { readonly nextCursor: string | null };
}

export interface FoodAutocompleteSuggestion {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: FoodKind;
  readonly label: string;
  readonly brandName: string | null;
  readonly source: FoodSourceSummary;
}

export interface FoodAutocompleteResponse {
  readonly data: readonly FoodAutocompleteSuggestion[];
}

export interface FoodBarcodeResponse {
  readonly data: FoodSearchHit;
}

export interface SearchRequestInput {
  readonly query: string;
  readonly intent: FoodSearchIntent;
  readonly cursor?: string;
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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => key in value);
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isNullableBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string | null {
  return value === null || isBoundedString(value, minimum, maximum);
}

function isNullableDecimal(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DECIMAL.test(value));
}

function isSource(value: unknown): value is FoodSourceSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "code",
      "displayName",
      "licenseExpression",
      "attributionRequired",
      "attributionText",
    ]) &&
    typeof value.code === "string" &&
    SOURCE_CODE.test(value.code) &&
    isBoundedString(value.displayName, 1, 200) &&
    isBoundedString(value.licenseExpression, 1, 256) &&
    typeof value.attributionRequired === "boolean" &&
    isBoundedString(value.attributionText, 1, 2_000)
  );
}

function isServing(value: unknown): value is FoodServingSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "servingId",
      "label",
      "quantity",
      "unit",
      "gramWeight",
      "milliliterVolume",
    ]) &&
    typeof value.servingId === "string" &&
    IDENTIFIER.test(value.servingId) &&
    isBoundedString(value.label, 1, 200) &&
    typeof value.quantity === "string" &&
    DECIMAL.test(value.quantity) &&
    isBoundedString(value.unit, 1, 50) &&
    isNullableDecimal(value.gramWeight) &&
    isNullableDecimal(value.milliliterVolume)
  );
}

export function isFoodSearchHit(value: unknown): value is FoodSearchHit {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "foodId",
      "foodVersionId",
      "kind",
      "name",
      "brandName",
      "marketCode",
      "languageTag",
      "source",
      "defaultServing",
    ]) &&
    typeof value.foodId === "string" &&
    IDENTIFIER.test(value.foodId) &&
    typeof value.foodVersionId === "string" &&
    IDENTIFIER.test(value.foodVersionId) &&
    (value.kind === "generic" || value.kind === "branded") &&
    isBoundedString(value.name, 1, 500) &&
    isNullableBoundedString(value.brandName, 1, 300) &&
    typeof value.marketCode === "string" &&
    MARKET_CODE.test(value.marketCode) &&
    isBoundedString(value.languageTag, 2, 35) &&
    isSource(value.source) &&
    (value.defaultServing === null || isServing(value.defaultServing))
  );
}

function isSuggestion(value: unknown): value is FoodAutocompleteSuggestion {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["foodId", "foodVersionId", "kind", "label", "brandName", "source"]) &&
    typeof value.foodId === "string" &&
    IDENTIFIER.test(value.foodId) &&
    typeof value.foodVersionId === "string" &&
    IDENTIFIER.test(value.foodVersionId) &&
    (value.kind === "generic" || value.kind === "branded") &&
    isBoundedString(value.label, 1, 500) &&
    isNullableBoundedString(value.brandName, 1, 300) &&
    isSource(value.source)
  );
}

export function parseFoodSearchPage(value: unknown): FoodSearchPage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["data", "page"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 50 ||
    !value.data.every(isFoodSearchHit) ||
    !isRecord(value.page) ||
    !hasOnlyKeys(value.page, ["nextCursor"]) ||
    !(
      value.page.nextCursor === null ||
      (typeof value.page.nextCursor === "string" &&
        value.page.nextCursor.length <= 512 &&
        CURSOR.test(value.page.nextCursor))
    )
  ) {
    throw new TypeError("The food-search response did not match the public contract.");
  }
  return value as unknown as FoodSearchPage;
}

export function parseFoodAutocompleteResponse(value: unknown): FoodAutocompleteResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["data"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 10 ||
    !value.data.every(isSuggestion)
  ) {
    throw new TypeError("The autocomplete response did not match the public contract.");
  }
  return value as unknown as FoodAutocompleteResponse;
}

export function parseFoodBarcodeResponse(value: unknown): FoodBarcodeResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ["data"]) || !isFoodSearchHit(value.data)) {
    throw new TypeError("The barcode response did not match the public contract.");
  }
  return value as unknown as FoodBarcodeResponse;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function normalizeBarcodeInput(value: string): string {
  const candidate = value.normalize("NFKC").trim();
  if (!/^[0-9\s-]*$/u.test(candidate)) return candidate;
  return candidate.replace(/[\s-]/gu, "");
}

export function isFoodSearchIntent(value: string): value is FoodSearchIntent {
  return foodSearchIntents.some((intent) => intent === value);
}

function validatedSearchText(value: string): string {
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0 || [...normalized].length > 128) {
    throw new RangeError("Search text must contain between 1 and 128 characters.");
  }
  return normalized;
}

function searchParameters(input: SearchRequestInput): URLSearchParams {
  const parameters = new URLSearchParams({
    query: validatedSearchText(input.query),
    intent: input.intent,
  });
  if (input.cursor !== undefined) {
    if (input.cursor.length > 512 || !CURSOR.test(input.cursor)) {
      throw new RangeError("The food-search cursor is invalid.");
    }
    parameters.set("cursor", input.cursor);
  }
  return parameters;
}

export function buildSearchRequestPath(input: SearchRequestInput): string {
  const parameters = searchParameters(input);
  parameters.set("limit", "20");
  return `/api/foods/search?${parameters.toString()}`;
}

export function buildAutocompleteRequestPath(input: Omit<SearchRequestInput, "cursor">): string {
  const parameters = searchParameters(input);
  parameters.set("limit", "8");
  return `/api/foods/autocomplete?${parameters.toString()}`;
}

export function buildBarcodeRequestPath(gtin: string): string {
  const normalized = gtin.trim();
  if (!BARCODE.test(normalized)) {
    throw new RangeError("A barcode must contain exactly 8, 12, 13, or 14 digits.");
  }
  return `/api/foods/barcodes/${normalized}`;
}

export function mergeFoodSearchResults(
  current: readonly FoodSearchHit[],
  incoming: readonly FoodSearchHit[],
  append: boolean,
): readonly FoodSearchHit[] {
  if (!append) return incoming;
  const seenVersions = new Set(current.map((food) => food.foodVersionId));
  return [...current, ...incoming.filter((food) => !seenVersions.has(food.foodVersionId))];
}

export function isInvalidContinuationResponse(status: number, cursor?: string): boolean {
  return status === 400 && cursor !== undefined;
}

export function isInvalidBarcodeResponse(status: number): boolean {
  return status === 400;
}

export function resolveInternalApiBase(configuredValue?: string): URL {
  const base = new URL(configuredValue?.trim() || "http://127.0.0.1:4000");
  const isLoopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopback)) ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new TypeError(
      "API_INTERNAL_URL must be an HTTPS origin, or a loopback HTTP origin in development.",
    );
  }
  return base;
}

export function buildAllowedUpstreamUrl(
  requestUrl: string,
  upstreamPath: string,
  allowedQueryFields: readonly string[],
  configuredBase?: string,
): URL {
  if (
    !/^\/v1\/foods\/(?:search|autocomplete|barcodes\/(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14}))$/u.test(
      upstreamPath,
    )
  ) {
    throw new TypeError("The upstream food-search path is invalid.");
  }
  const incoming = new URL(requestUrl);
  const allowed = new Set(allowedQueryFields);
  const output = new URL(upstreamPath, resolveInternalApiBase(configuredBase));

  for (const key of incoming.searchParams.keys()) {
    const values = incoming.searchParams.getAll(key);
    if (!allowed.has(key) || values.length !== 1) {
      throw new TypeError("The request contains an unsupported or duplicate query field.");
    }
    const [value] = values;
    if (value === undefined) throw new TypeError("The request query field is invalid.");
    output.searchParams.set(key, value);
  }

  return output;
}
