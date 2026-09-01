import type { FoodSourceSummary } from "./foods.js";
import { foodSourceSummarySchema } from "./foods.js";

export const diaryMealSlots = ["breakfast", "lunch", "dinner", "snacks"] as const;
export const nutrientCompletenessValues = ["complete", "partial", "unknown"] as const;
export const nutrientUnknownReasons = [
  "not_reported",
  "not_analyzed",
  "not_applicable",
  "withheld",
] as const;

/** Derived recipe views may add scale digits beyond the 160-character persisted snapshot bound. */
export const MAX_NUTRIENT_AGGREGATE_OUTPUT_LENGTH = 200;
/** New note writes are bounded by Unicode code points before persistence. */
export const MAX_DIARY_NOTE_INPUT_CODE_POINTS = 2_000;
/** Legacy migration 0004 allows stored notes up to this exact UTF-8 byte bound. */
export const MAX_STORED_DIARY_NOTE_UTF8_BYTES = 10_000;
const validDiaryNoteInputPattern =
  "^(?![\\s\\S]*\\u0000)(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$";
const validStoredDiaryNotePattern =
  "^(?![\\s\\S]*\\u0000)(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$";
export type DiaryMealSlot = (typeof diaryMealSlots)[number];
export type NutrientCompleteness = (typeof nutrientCompletenessValues)[number];
export type NutrientUnknownReason = (typeof nutrientUnknownReasons)[number];

/** Additive nutrient state that never presents missing data as a measured zero. */
export interface DiaryNutrientAggregate {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Exact quantified lower bound. Inspect completeness before presenting it as a total. */
  readonly knownAmount: string;
  readonly completeness: NutrientCompleteness;
  /** True when no contribution is trace/unknown; not a claim of laboratory measurement quality. */
  readonly isExact: boolean;
  readonly contributorCount: number;
  readonly quantifiedCount: number;
  readonly traceCount: number;
  readonly unknownCount: number;
  readonly unknownReasonCounts: Readonly<Record<NutrientUnknownReason, number>>;
}

export type DiaryPortion =
  | { readonly kind: "serving"; readonly servingId: string; readonly amount: string }
  | { readonly kind: "grams"; readonly grams: string };

export type RecipeDiaryPortion =
  | { readonly kind: "serving"; readonly amount: string }
  | { readonly kind: "grams"; readonly grams: string };

export type DiaryMutablePortion = DiaryPortion | RecipeDiaryPortion;

/** Immutable resolved portion returned with a logged diary revision. */
export type DiaryEntryPortion =
  | {
      readonly kind: "serving";
      readonly servingId: string;
      readonly amount: string;
      readonly servingLabel: string;
    }
  | { readonly kind: "grams"; readonly grams: string };

export type RecipeDiaryEntryPortion =
  | { readonly kind: "serving"; readonly amount: string; readonly servingLabel: string }
  | { readonly kind: "grams"; readonly grams: string };

export interface DiaryFoodSourceSnapshot extends FoodSourceSummary {
  readonly releaseId: string;
}

interface DiaryEntryCommon {
  readonly id: string;
  readonly revision: string;
  readonly mealSlot: DiaryMealSlot;
  readonly resolvedGrams: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  /** IANA zone used to derive this immutable revision's local coordinates. */
  readonly timeZone: string;
  readonly position: number;
  readonly nutrients: readonly DiaryNutrientAggregate[];
  /** Private owner-authored text, returned exactly as entered. */
  readonly note: string | null;
}

interface DiaryFoodEntryCommon extends DiaryEntryCommon {
  readonly entryKind: "food";
  readonly foodVersionId: string;
  readonly recipeVersionId: null;
  readonly portion: DiaryEntryPortion;
  readonly food: { readonly name: string; readonly brandName: string | null };
  readonly recipe: null;
}

export interface DiaryPublicFoodEntry extends DiaryFoodEntryCommon {
  /** Immutable source/release and reviewed attribution captured when this revision was logged. */
  readonly source: DiaryFoodSourceSnapshot;
  readonly foodProvenance: {
    readonly kind: "public";
    readonly source: DiaryFoodSourceSnapshot;
  };
}

export interface DiaryPrivateCustomFoodEntry extends DiaryFoodEntryCommon {
  /** Private foods never fabricate public licensing provenance. */
  readonly source: null;
  readonly foodProvenance: {
    readonly kind: "private_custom";
    readonly customFoodId: string;
    readonly customFoodVersionNumber: number;
  };
}

export type DiaryFoodEntry = DiaryPublicFoodEntry | DiaryPrivateCustomFoodEntry;

export interface DiaryRecipeEntry extends DiaryEntryCommon {
  readonly entryKind: "recipe";
  readonly foodVersionId: null;
  /** Exact immutable version selected by the client and pinned in the idempotency digest. */
  readonly recipeVersionId: string;
  readonly portion: RecipeDiaryEntryPortion;
  readonly food: null;
  readonly recipe: {
    readonly id: string;
    readonly name: string;
    readonly versionNumber: number;
    readonly yieldGrams: string;
    readonly yieldSource: "measured" | "estimated";
    readonly servingCount: string | null;
    readonly servingLabel: string | null;
    readonly calculationVersion: string;
    readonly retentionPolicy: {
      readonly code: "identity-retention-default";
      readonly version: "1";
      readonly assumption: string;
    };
    readonly warnings: readonly {
      readonly code:
        | "ESTIMATED_YIELD"
        | "PARTIAL_NUTRIENT_DATA"
        | "RETENTION_FACTORS_DEFAULTED"
        | "YIELD_ABOVE_INPUT_MASS"
        | "YIELD_BELOW_HALF_INPUT_MASS";
      readonly message: string;
      readonly nutrientIds: readonly string[];
    }[];
  };
  /** Deterministic transitive food-source attribution; there is no invented singular source. */
  readonly sources: readonly DiaryFoodSourceSnapshot[];
  readonly source: null;
}

export type DiaryEntry = DiaryFoodEntry | DiaryRecipeEntry;

export interface DiaryDay {
  readonly id: string | null;
  readonly localDate: string;
  readonly timeZone: string;
  readonly status: "open" | "locked";
  /** Day synchronization token, not an entry write precondition. */
  readonly revision: string;
  readonly entries: readonly DiaryEntry[];
  readonly totals: readonly DiaryNutrientAggregate[];
  readonly updatedAt: string | null;
}

export interface DiaryDayResponse {
  readonly data: DiaryDay;
  /** Present only when the caller explicitly opts into bounded diary pagination. */
  readonly page?: {
    readonly nextCursor: string | null;
    /** Authoritative count for the whole coherent day snapshot, not just this page. */
    readonly totalEntries: number;
  };
}

export interface CreateDiaryEntryRequest {
  readonly foodVersionId: string;
  readonly portion: DiaryPortion;
  readonly mealSlot: DiaryMealSlot;
  readonly occurredAt: string;
  readonly position?: number;
}

/** Optional guarded-create precondition; unrelated standard headers remain allowed. */
export interface CreateDiaryEntryHeaders {
  readonly "x-expected-profile-time-zone"?: string;
}

export interface CreateDiaryEntryQuery {
  readonly profileTimeZonePrecondition?: "v1";
}

export interface UpdateDiaryEntryRequest {
  readonly portion?: DiaryMutablePortion;
  readonly mealSlot?: DiaryMealSlot;
  readonly occurredAt?: string;
  readonly position?: number;
  /** Omit to preserve, use null to clear, or provide exact non-empty text. */
  readonly note?: string | null;
}

export interface CreateRecipeDiaryEntryRequest {
  readonly recipeVersionId: string;
  readonly portion: RecipeDiaryPortion;
  readonly mealSlot: DiaryMealSlot;
  readonly occurredAt: string;
  readonly position?: number;
}

export interface DiaryMutationResponse {
  readonly data: {
    readonly replayed: boolean;
    readonly entry: DiaryEntry | null;
    readonly affectedDays: readonly { readonly localDate: string; readonly revision: string }[];
  };
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const positiveIdentifierSchema = { type: "string", pattern: "^[1-9][0-9]{0,19}$" } as const;
const nonNegativeDecimalSchema = {
  type: "string",
  maxLength: MAX_NUTRIENT_AGGREGATE_OUTPUT_LENGTH,
  pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const positiveDecimalSchema = {
  type: "string",
  maxLength: 19,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$",
} as const;
const positiveResolvedDecimalSchema = {
  type: "string",
  maxLength: 160,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]{0,17})(?:\\.[0-9]+)?$",
} as const;
const localDateSchema = {
  type: "string",
  format: "date",
  pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;
const revisionSchema = { type: "string", pattern: "^[1-9][0-9]*$" } as const;
const occurredAtSchema = {
  type: "string",
  format: "date-time",
  pattern:
    "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$",
} as const;

export const diaryNutrientAggregateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "nutrientId",
    "code",
    "name",
    "unit",
    "knownAmount",
    "completeness",
    "isExact",
    "contributorCount",
    "quantifiedCount",
    "traceCount",
    "unknownCount",
    "unknownReasonCounts",
  ],
  properties: {
    nutrientId: positiveIdentifierSchema,
    code: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    unit: { type: "string", minLength: 1, maxLength: 32 },
    knownAmount: nonNegativeDecimalSchema,
    completeness: { type: "string", enum: nutrientCompletenessValues },
    isExact: { type: "boolean" },
    contributorCount: { type: "integer", minimum: 1 },
    quantifiedCount: { type: "integer", minimum: 0 },
    traceCount: { type: "integer", minimum: 0 },
    unknownCount: { type: "integer", minimum: 0 },
    unknownReasonCounts: {
      type: "object",
      additionalProperties: false,
      required: ["not_reported", "not_analyzed", "not_applicable", "withheld"],
      properties: {
        not_reported: { type: "integer", minimum: 0 },
        not_analyzed: { type: "integer", minimum: 0 },
        not_applicable: { type: "integer", minimum: 0 },
        withheld: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

const servingPortionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "servingId", "amount"],
  properties: {
    kind: { type: "string", const: "serving" },
    servingId: positiveIdentifierSchema,
    amount: positiveDecimalSchema,
  },
} as const;
const diaryEntryServingPortionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "servingId", "amount", "servingLabel"],
  properties: {
    ...servingPortionSchema.properties,
    servingLabel: { type: "string", minLength: 1, maxLength: 300 },
  },
} as const;
const recipeServingPortionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "amount"],
  properties: {
    kind: { type: "string", const: "serving" },
    amount: positiveDecimalSchema,
  },
} as const;
const recipeDiaryEntryServingPortionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "amount", "servingLabel"],
  properties: {
    ...recipeServingPortionSchema.properties,
    servingLabel: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;
const gramPortionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "grams"],
  properties: {
    kind: { type: "string", const: "grams" },
    grams: positiveDecimalSchema,
  },
} as const;

export const diaryPortionSchema = {
  $id: "DiaryPortion",
  oneOf: [servingPortionSchema, gramPortionSchema],
} as const;

export const diaryEntryPortionSchema = {
  $id: "DiaryEntryPortion",
  oneOf: [diaryEntryServingPortionSchema, gramPortionSchema],
} as const;

export const recipeDiaryPortionSchema = {
  $id: "RecipeDiaryPortion",
  oneOf: [recipeServingPortionSchema, gramPortionSchema],
} as const;

export const diaryMutablePortionSchema = {
  $id: "DiaryMutablePortion",
  oneOf: [servingPortionSchema, recipeServingPortionSchema, gramPortionSchema],
} as const;

export const recipeDiaryEntryPortionSchema = {
  $id: "RecipeDiaryEntryPortion",
  oneOf: [recipeDiaryEntryServingPortionSchema, gramPortionSchema],
} as const;

const diaryEntryCommonRequired = [
  "id",
  "revision",
  "entryKind",
  "foodVersionId",
  "recipeVersionId",
  "portion",
  "food",
  "recipe",
  "source",
  "mealSlot",
  "resolvedGrams",
  "occurredAt",
  "localDate",
  "localTime",
  "timeZone",
  "position",
  "nutrients",
  "note",
] as const;

/**
 * Response compatibility for migration 0004 rows. The database's UTF-8 byte
 * constraint is stricter than this safe JSON Schema code-point ceiling.
 */
export const diaryStoredNoteSchema = {
  anyOf: [
    {
      type: "string",
      maxLength: MAX_STORED_DIARY_NOTE_UTF8_BYTES,
      pattern: validStoredDiaryNotePattern,
    },
    {
      type: "null",
    },
  ],
} as const;

export const diaryNotePatchSchema = {
  anyOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: MAX_DIARY_NOTE_INPUT_CODE_POINTS,
      pattern: validDiaryNoteInputPattern,
    },
    { type: "null" },
  ],
} as const;

const diaryEntryCommonProperties = {
  id: uuidSchema,
  revision: revisionSchema,
  mealSlot: { type: "string", enum: diaryMealSlots },
  resolvedGrams: positiveResolvedDecimalSchema,
  occurredAt: occurredAtSchema,
  localDate: localDateSchema,
  localTime: {
    type: "string",
    pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?$",
  },
  timeZone: { type: "string", minLength: 1, maxLength: 63 },
  position: { type: "integer", minimum: 0, maximum: 1000000 },
  nutrients: { type: "array", maxItems: 256, items: diaryNutrientAggregateSchema },
  note: diaryStoredNoteSchema,
} as const;

const foodSourceSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: [...foodSourceSummarySchema.required, "releaseId"],
  properties: {
    ...foodSourceSummarySchema.properties,
    releaseId: uuidSchema,
  },
} as const;

const publicFoodProvenanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "source"],
  properties: {
    kind: { type: "string", const: "public" },
    source: foodSourceSnapshotSchema,
  },
} as const;

const privateCustomFoodProvenanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "customFoodId", "customFoodVersionNumber"],
  properties: {
    kind: { type: "string", const: "private_custom" },
    customFoodId: uuidSchema,
    customFoodVersionNumber: { type: "integer", minimum: 1 },
  },
} as const;

export const diaryFoodEntrySchema = {
  $id: "DiaryFoodEntry",
  type: "object",
  additionalProperties: false,
  required: [...diaryEntryCommonRequired, "foodProvenance"],
  properties: {
    ...diaryEntryCommonProperties,
    entryKind: { type: "string", const: "food" },
    foodVersionId: positiveIdentifierSchema,
    recipeVersionId: { type: "null" },
    portion: diaryEntryPortionSchema,
    food: {
      type: "object",
      additionalProperties: false,
      required: ["name", "brandName"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 500 },
        brandName: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 300 }, { type: "null" }],
        },
      },
    },
    recipe: { type: "null" },
    source: { anyOf: [foodSourceSnapshotSchema, { type: "null" }] },
    foodProvenance: {
      oneOf: [publicFoodProvenanceSchema, privateCustomFoodProvenanceSchema],
    },
  },
} as const;

const diaryRecipeWarningSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "nutrientIds"],
  properties: {
    code: {
      type: "string",
      enum: [
        "ESTIMATED_YIELD",
        "PARTIAL_NUTRIENT_DATA",
        "RETENTION_FACTORS_DEFAULTED",
        "YIELD_ABOVE_INPUT_MASS",
        "YIELD_BELOW_HALF_INPUT_MASS",
      ],
    },
    message: { type: "string", minLength: 1, maxLength: 500 },
    nutrientIds: { type: "array", maxItems: 256, items: positiveIdentifierSchema },
  },
} as const;

export const diaryRecipeEntrySchema = {
  $id: "DiaryRecipeEntry",
  type: "object",
  additionalProperties: false,
  required: [...diaryEntryCommonRequired, "sources"],
  properties: {
    ...diaryEntryCommonProperties,
    entryKind: { type: "string", const: "recipe" },
    foodVersionId: { type: "null" },
    recipeVersionId: uuidSchema,
    portion: recipeDiaryEntryPortionSchema,
    food: { type: "null" },
    recipe: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "name",
        "versionNumber",
        "yieldGrams",
        "yieldSource",
        "servingCount",
        "servingLabel",
        "calculationVersion",
        "retentionPolicy",
        "warnings",
      ],
      not: {
        anyOf: [
          {
            type: "object",
            required: ["servingCount", "servingLabel"],
            properties: {
              servingCount: { type: "null" },
              servingLabel: { type: "string" },
            },
          },
          {
            type: "object",
            required: ["servingCount", "servingLabel"],
            properties: {
              servingCount: { type: "string" },
              servingLabel: { type: "null" },
            },
          },
        ],
      },
      properties: {
        id: uuidSchema,
        name: { type: "string", minLength: 1, maxLength: 200 },
        versionNumber: { type: "integer", minimum: 1 },
        yieldGrams: positiveResolvedDecimalSchema,
        yieldSource: { type: "string", enum: ["measured", "estimated"] },
        servingCount: { anyOf: [positiveDecimalSchema, { type: "null" }] },
        servingLabel: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 100 }, { type: "null" }],
        },
        calculationVersion: { type: "string", minLength: 1, maxLength: 100 },
        retentionPolicy: {
          type: "object",
          additionalProperties: false,
          required: ["code", "version", "assumption"],
          properties: {
            code: { type: "string", const: "identity-retention-default" },
            version: { type: "string", const: "1" },
            assumption: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        warnings: { type: "array", maxItems: 5, items: diaryRecipeWarningSchema },
      },
    },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: foodSourceSnapshotSchema,
    },
    source: { type: "null" },
  },
} as const;

export const diaryEntrySchema = {
  $id: "DiaryEntry",
  oneOf: [diaryFoodEntrySchema, diaryRecipeEntrySchema],
} as const;

export const diaryDaySchema = {
  $id: "DiaryDay",
  type: "object",
  additionalProperties: false,
  required: ["id", "localDate", "timeZone", "status", "revision", "entries", "totals", "updatedAt"],
  properties: {
    id: { anyOf: [uuidSchema, { type: "null" }] },
    localDate: localDateSchema,
    timeZone: { type: "string", minLength: 1, maxLength: 100 },
    status: { type: "string", enum: ["open", "locked"] },
    revision: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    entries: { type: "array", maxItems: 50, items: diaryEntrySchema },
    totals: { type: "array", maxItems: 256, items: diaryNutrientAggregateSchema },
    updatedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
} as const;

export const diaryDayResponseSchema = {
  $id: "DiaryDayResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: diaryDaySchema,
    page: {
      type: "object",
      additionalProperties: false,
      required: ["nextCursor", "totalEntries"],
      properties: {
        nextCursor: {
          anyOf: [
            {
              type: "string",
              minLength: 1,
              maxLength: 512,
              pattern: "^d1\\.[A-Za-z0-9_-]+$",
            },
            { type: "null" },
          ],
        },
        totalEntries: { type: "integer", minimum: 0, maximum: 50 },
      },
    },
  },
  dependencies: {
    page: {
      oneOf: [
        {
          properties: {
            data: {
              type: "object",
              properties: { entries: { type: "array", maxItems: 0 } },
            },
            page: {
              type: "object",
              properties: {
                nextCursor: { type: "null" },
                totalEntries: { const: 0 },
              },
            },
          },
        },
        {
          properties: {
            data: {
              type: "object",
              properties: { entries: { type: "array", minItems: 1, maxItems: 20 } },
            },
            page: {
              type: "object",
              properties: { totalEntries: { type: "integer", minimum: 1, maximum: 50 } },
            },
          },
        },
      ],
    },
  },
} as const;

const mutableEntryProperties = {
  portion: diaryMutablePortionSchema,
  mealSlot: { type: "string", enum: diaryMealSlots },
  occurredAt: occurredAtSchema,
  position: { type: "integer", minimum: 0, maximum: 1000000 },
} as const;

export const createDiaryEntryRequestSchema = {
  $id: "CreateDiaryEntryRequest",
  type: "object",
  additionalProperties: false,
  required: ["foodVersionId", "portion", "mealSlot", "occurredAt"],
  properties: {
    foodVersionId: positiveIdentifierSchema,
    ...mutableEntryProperties,
    portion: diaryPortionSchema,
  },
} as const;

export const createDiaryEntryHeadersSchema = {
  $id: "CreateDiaryEntryHeaders",
  type: "object",
  additionalProperties: true,
  properties: {
    "x-expected-profile-time-zone": { type: "string", minLength: 1, maxLength: 63 },
  },
} as const;

export const createDiaryEntryQuerySchema = {
  $id: "CreateDiaryEntryQuery",
  type: "object",
  additionalProperties: false,
  properties: {
    profileTimeZonePrecondition: { type: "string", const: "v1" },
  },
} as const;

export const createRecipeDiaryEntryRequestSchema = {
  $id: "CreateRecipeDiaryEntryRequest",
  type: "object",
  additionalProperties: false,
  required: ["recipeVersionId", "portion", "mealSlot", "occurredAt"],
  properties: {
    recipeVersionId: uuidSchema,
    portion: recipeDiaryPortionSchema,
    mealSlot: mutableEntryProperties.mealSlot,
    occurredAt: mutableEntryProperties.occurredAt,
    position: mutableEntryProperties.position,
  },
} as const;

export const updateDiaryEntryRequestSchema = {
  $id: "UpdateDiaryEntryRequest",
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    ...mutableEntryProperties,
    note: diaryNotePatchSchema,
  },
} as const;

export const diaryMutationResponseSchema = {
  $id: "DiaryMutationResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "entry", "affectedDays"],
      properties: {
        replayed: { type: "boolean" },
        entry: { anyOf: [diaryEntrySchema, { type: "null" }] },
        affectedDays: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["localDate", "revision"],
            properties: { localDate: localDateSchema, revision: revisionSchema },
          },
        },
      },
    },
  },
} as const;
