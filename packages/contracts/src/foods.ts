export const publicFoodKinds = ["generic", "branded"] as const;
export const foodSearchIntents = ["all", ...publicFoodKinds] as const;

export type PublicFoodKind = (typeof publicFoodKinds)[number];
export type FoodSearchIntent = (typeof foodSearchIntents)[number];

export interface FoodSourceSummary {
  readonly code: string;
  readonly displayName: string;
  /** SPDX expression or reviewed source licence identifier. */
  readonly licenseExpression: string;
  readonly attributionRequired: boolean;
  /** Reviewed product-facing attribution text. Render when attributionRequired is true. */
  readonly attributionText: string;
}

export interface FoodServingSummary {
  readonly servingId: string;
  readonly label: string;
  /** Exact decimal serialized as a string. */
  readonly quantity: string;
  readonly unit: string;
  /** Exact decimal serialized as a string, or null when the source does not provide it. */
  readonly gramWeight: string | null;
  /** Exact decimal serialized as a string, or null when the source does not provide it. */
  readonly milliliterVolume: string | null;
}

export interface FoodSearchHit {
  /** Database identifiers are strings so JSON consumers never lose bigint precision. */
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: PublicFoodKind;
  readonly name: string;
  readonly brandName: string | null;
  readonly marketCode: string;
  readonly languageTag: string;
  readonly source: FoodSourceSummary;
  readonly defaultServing: FoodServingSummary | null;
}

export interface FoodSearchPage {
  readonly data: readonly FoodSearchHit[];
  readonly page: {
    /** Opaque, stable continuation token. Null means there is no next page. */
    readonly nextCursor: string | null;
  };
}

export interface FoodAutocompleteSuggestion {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: PublicFoodKind;
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

export interface FoodBarcodeNotFound {
  readonly type: "about:blank";
  readonly title: "Not Found";
  readonly status: 404;
  readonly code: "NOT_FOUND";
  readonly detail: "No current public food matches this barcode.";
  readonly requestId: string;
}

const positiveIdentifierSchema = {
  type: "string",
  pattern: "^[1-9][0-9]{0,19}$",
} as const;

const nullableExactDecimalSchema = {
  anyOf: [{ type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" }, { type: "null" }],
} as const;

export const foodSourceSummarySchema = {
  $id: "FoodSourceSummary",
  type: "object",
  additionalProperties: false,
  required: ["code", "displayName", "licenseExpression", "attributionRequired", "attributionText"],
  properties: {
    code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,31}$" },
    displayName: { type: "string", minLength: 1, maxLength: 200 },
    licenseExpression: { type: "string", minLength: 1, maxLength: 256 },
    attributionRequired: { type: "boolean" },
    attributionText: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

export const foodServingSummarySchema = {
  $id: "FoodServingSummary",
  type: "object",
  additionalProperties: false,
  required: ["servingId", "label", "quantity", "unit", "gramWeight", "milliliterVolume"],
  properties: {
    servingId: positiveIdentifierSchema,
    label: { type: "string", minLength: 1, maxLength: 200 },
    quantity: { type: "string", pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" },
    unit: { type: "string", minLength: 1, maxLength: 50 },
    gramWeight: nullableExactDecimalSchema,
    milliliterVolume: nullableExactDecimalSchema,
  },
} as const;

export const foodSearchHitSchema = {
  $id: "FoodSearchHit",
  type: "object",
  additionalProperties: false,
  required: [
    "foodId",
    "foodVersionId",
    "kind",
    "name",
    "brandName",
    "marketCode",
    "languageTag",
    "source",
    "defaultServing",
  ],
  properties: {
    foodId: positiveIdentifierSchema,
    foodVersionId: positiveIdentifierSchema,
    kind: { type: "string", enum: publicFoodKinds },
    name: { type: "string", minLength: 1, maxLength: 500 },
    brandName: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 300 }, { type: "null" }],
    },
    marketCode: { type: "string", pattern: "^[A-Z0-9]{2,3}$" },
    languageTag: { type: "string", minLength: 2, maxLength: 35 },
    source: foodSourceSummarySchema,
    defaultServing: {
      anyOf: [foodServingSummarySchema, { type: "null" }],
    },
  },
} as const;

export const foodSearchPageSchema = {
  $id: "FoodSearchPage",
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: {
      type: "array",
      maxItems: 50,
      items: foodSearchHitSchema,
    },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["nextCursor"],
      properties: {
        nextCursor: {
          anyOf: [
            {
              type: "string",
              minLength: 1,
              maxLength: 512,
              pattern: "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)?$",
            },
            { type: "null" },
          ],
        },
      },
    },
  },
} as const;

export const foodAutocompleteSuggestionSchema = {
  $id: "FoodAutocompleteSuggestion",
  type: "object",
  additionalProperties: false,
  required: ["foodId", "foodVersionId", "kind", "label", "brandName", "source"],
  properties: {
    foodId: positiveIdentifierSchema,
    foodVersionId: positiveIdentifierSchema,
    kind: { type: "string", enum: publicFoodKinds },
    label: { type: "string", minLength: 1, maxLength: 500 },
    brandName: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 300 }, { type: "null" }],
    },
    source: foodSourceSummarySchema,
  },
} as const;

export const foodAutocompleteResponseSchema = {
  $id: "FoodAutocompleteResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "array",
      maxItems: 10,
      items: foodAutocompleteSuggestionSchema,
    },
  },
} as const;

export const foodBarcodeResponseSchema = {
  $id: "FoodBarcodeResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: foodSearchHitSchema,
  },
} as const;

export const foodBarcodeNotFoundSchema = {
  $id: "FoodBarcodeNotFound",
  type: "object",
  additionalProperties: false,
  required: ["type", "title", "status", "code", "detail", "requestId"],
  properties: {
    type: { type: "string", const: "about:blank" },
    title: { type: "string", const: "Not Found" },
    status: { type: "integer", const: 404 },
    code: { type: "string", const: "NOT_FOUND" },
    detail: { type: "string", const: "No current public food matches this barcode." },
    requestId: { type: "string", minLength: 1 },
  },
} as const;
