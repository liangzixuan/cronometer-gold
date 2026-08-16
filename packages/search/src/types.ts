export const FOOD_SEARCH_STABLE_INDEX = "foods";

export type FoodSearchIntent = "all" | "branded" | "generic";
export type PublicFoodKind = Exclude<FoodSearchIntent, "all">;
export type FoodDataQuality = "curated" | "provisional" | "verified";

/** Decimal quantities stay as canonical strings from PostgreSQL; never coerce them to JS numbers. */
export interface FoodSearchServing {
  readonly servingId: string;
  readonly label: string;
  readonly quantity: string;
  readonly unit: string;
  readonly gramWeight: string | null;
  readonly milliliterVolume: string | null;
}

export interface FoodSearchSource {
  readonly code: string;
  readonly displayName: string;
  readonly licenseExpression: string;
  readonly attributionRequired: boolean;
  readonly attributionText: string;
}

/**
 * The complete public document written to the shared search index.
 *
 * This intentionally has no owner, visibility, diary, biometric, favorite, recent-use, or user ID
 * fields. Custom/private foods belong in an authenticated private lookup, never this index.
 */
export interface FoodSearchDocument {
  readonly id: string;
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: PublicFoodKind;
  readonly name: string;
  readonly normalizedName: string;
  readonly brandName: string | null;
  readonly aliases: readonly string[];
  readonly barcodes: readonly string[];
  readonly servingLabels: readonly string[];
  readonly marketCode: string;
  readonly languageTag: string;
  readonly source: FoodSearchSource;
  readonly dataQuality: FoodDataQuality;
  readonly defaultServing: FoodSearchServing | null;
}

export interface FoodSearchHit {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: PublicFoodKind;
  readonly name: string;
  readonly brandName: string | null;
  readonly marketCode: string;
  readonly languageTag: string;
  readonly source: FoodSearchSource;
  readonly defaultServing: FoodSearchServing | null;
}

export interface RecentFoodPreference {
  readonly foodId: string;
  /** RFC 3339 timestamp. Used only for deterministic ordering, not embedded in the index. */
  readonly lastUsedAt: string;
}

export interface FoodSearchPreferences {
  readonly favoriteFoodIds?: readonly string[];
  readonly recentFoods?: readonly RecentFoodPreference[];
}

export interface FoodSearchQuery {
  readonly query: string;
  readonly intent?: FoodSearchIntent;
  readonly marketCode?: string;
  readonly languageTag?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly preferences?: FoodSearchPreferences;
  readonly signal?: AbortSignal;
}

export interface NormalizedFoodSearchQuery {
  readonly query: string;
  readonly intent: FoodSearchIntent;
  readonly marketCode: string | null;
  readonly languageTag: string | null;
  readonly limit: number;
  readonly barcode: string | null;
}

export interface FoodSearchPage {
  readonly hits: readonly FoodSearchHit[];
  readonly nextCursor: string | null;
  readonly estimatedTotalHits: number;
  /** True when more results are available inside the bounded personalization window. */
  readonly hasMore: boolean;
}

export interface FoodAutocompleteQuery {
  readonly query: string;
  readonly intent?: FoodSearchIntent;
  readonly marketCode?: string;
  readonly languageTag?: string;
  readonly limit?: number;
  readonly preferences?: FoodSearchPreferences;
  readonly signal?: AbortSignal;
}

export interface FoodAutocompleteSuggestion {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: PublicFoodKind;
  readonly label: string;
  readonly brandName: string | null;
  readonly source: FoodSearchSource;
}

export interface FoodAutocompleteResponse {
  readonly suggestions: readonly FoodAutocompleteSuggestion[];
}

export interface BarcodeLookupQuery {
  readonly gtin: string;
  readonly marketCode?: string;
  readonly signal?: AbortSignal;
}

export interface FoodSearchPort {
  search(query: FoodSearchQuery): Promise<FoodSearchPage>;
  autocomplete(query: FoodAutocompleteQuery): Promise<FoodAutocompleteResponse>;
  lookupBarcode(query: BarcodeLookupQuery): Promise<FoodSearchHit | null>;
}

export type FoodProjectionExclusionReason =
  | "archived"
  | "inactive-source"
  | "not-current-version"
  | "private"
  | "quarantined";

export type FoodSearchProjectionRow =
  | {
      readonly eligibility: "include";
      readonly document: FoodSearchDocument;
    }
  | {
      readonly eligibility: "exclude";
      readonly foodId: string;
      readonly reason: FoodProjectionExclusionReason;
    };

/** One repeatable-read PostgreSQL transaction should back both the count and this stream. */
export interface FoodSearchProjectionSnapshot {
  readonly expectedIncludedCount: number;
  /** Opaque authority revision captured with the coherent source snapshot. */
  readonly projectionRevision: string;
  stream(signal?: AbortSignal): AsyncIterable<FoodSearchProjectionRow>;
  close(): Promise<void>;
}

export interface FoodSearchProjectionSource {
  openSnapshot(signal?: AbortSignal): Promise<FoodSearchProjectionSnapshot>;
}

export interface SearchBackendRequest {
  readonly query: string;
  readonly filter: readonly string[];
  readonly limit: number;
  readonly offset: number;
}

export interface SearchBackendResponse {
  readonly hits: readonly FoodSearchDocument[];
  readonly estimatedTotalHits: number;
  /** Immutable generation that produced every hit, or null when the backend cannot prove one. */
  readonly generation: string | null;
}

export interface FoodSearchBackend {
  search(request: SearchBackendRequest, signal?: AbortSignal): Promise<SearchBackendResponse>;
}
