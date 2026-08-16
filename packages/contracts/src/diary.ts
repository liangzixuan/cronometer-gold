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

/** Immutable resolved portion returned with a logged diary revision. */
export type DiaryEntryPortion =
  | {
      readonly kind: "serving";
      readonly servingId: string;
      readonly amount: string;
      readonly servingLabel: string;
    }
  | { readonly kind: "grams"; readonly grams: string };

export interface DiaryFoodSourceSnapshot extends FoodSourceSummary {
  readonly releaseId: string;
}

export interface DiaryEntry {
  readonly id: string;
  readonly revision: string;
  readonly foodVersionId: string;
  readonly portion: DiaryEntryPortion;
  readonly food: { readonly name: string; readonly brandName: string | null };
  /** Immutable source/release and reviewed attribution captured when this revision was logged. */
  readonly source: DiaryFoodSourceSnapshot;
  readonly mealSlot: DiaryMealSlot;
  readonly resolvedGrams: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  /** IANA zone used to derive this immutable revision's local coordinates. */
  readonly timeZone: string;
  readonly position: number;
  readonly nutrients: readonly DiaryNutrientAggregate[];
}

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
}

export interface CreateDiaryEntryRequest {
  readonly foodVersionId: string;
  readonly portion: DiaryPortion;
  readonly mealSlot: DiaryMealSlot;
  readonly occurredAt: string;
  readonly position?: number;
}

export interface UpdateDiaryEntryRequest {
  readonly portion?: DiaryPortion;
  readonly mealSlot?: DiaryMealSlot;
  readonly occurredAt?: string;
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
  maxLength: 160,
  pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const positiveDecimalSchema = {
  type: "string",
  maxLength: 19,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$",
} as const;
const positiveResolvedDecimalSchema = {
  type: "string",
  maxLength: 37,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]{0,23})(?:\\.[0-9]{1,12})?$",
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

export const diaryEntrySchema = {
  $id: "DiaryEntry",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "foodVersionId",
    "portion",
    "food",
    "source",
    "mealSlot",
    "resolvedGrams",
    "occurredAt",
    "localDate",
    "localTime",
    "timeZone",
    "position",
    "nutrients",
  ],
  properties: {
    id: uuidSchema,
    revision: revisionSchema,
    foodVersionId: positiveIdentifierSchema,
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
    source: {
      type: "object",
      additionalProperties: false,
      required: [...foodSourceSummarySchema.required, "releaseId"],
      properties: {
        ...foodSourceSummarySchema.properties,
        releaseId: uuidSchema,
      },
    },
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
  },
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
  properties: { data: diaryDaySchema },
} as const;

const mutableEntryProperties = {
  portion: diaryPortionSchema,
  mealSlot: { type: "string", enum: diaryMealSlots },
  occurredAt: occurredAtSchema,
  position: { type: "integer", minimum: 0, maximum: 1000000 },
} as const;

export const createDiaryEntryRequestSchema = {
  $id: "CreateDiaryEntryRequest",
  type: "object",
  additionalProperties: false,
  required: ["foodVersionId", "portion", "mealSlot", "occurredAt"],
  properties: { foodVersionId: positiveIdentifierSchema, ...mutableEntryProperties },
} as const;

export const updateDiaryEntryRequestSchema = {
  $id: "UpdateDiaryEntryRequest",
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: mutableEntryProperties,
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
