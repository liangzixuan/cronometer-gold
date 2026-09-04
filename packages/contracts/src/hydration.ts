/** Operational product bounds, not medical intake recommendations. */
export const MAX_HYDRATION_AMOUNT_MILLILITERS = 20_000;
export const MAX_HYDRATION_ENTRIES_PER_DAY = 64;
export const MAX_HYDRATION_DAY_TOTAL_MILLILITERS = 100_000;

export interface HydrationEntry {
  readonly id: string;
  readonly revision: string;
  /** Exact positive integer volume in milliliters. */
  readonly amountMilliliters: number;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  /** IANA zone used to derive this immutable revision's local coordinates. */
  readonly timeZone: string;
  readonly createdAt: string;
}

export interface HydrationDay {
  readonly localDate: string;
  readonly timeZone: string;
  /** Day synchronization token. */
  readonly revision: string;
  readonly entries: readonly HydrationEntry[];
  /** Exact sum of active entry amounts. */
  readonly totalMilliliters: number;
  readonly updatedAt: string | null;
}

export interface HydrationDayResponse {
  readonly data: HydrationDay;
}

export interface CreateHydrationEntryRequest {
  readonly amountMilliliters: number;
  readonly occurredAt: string;
}

/** Optional guarded-create precondition; unrelated standard headers remain allowed. */
export interface CreateHydrationEntryHeaders {
  readonly "x-expected-profile-time-zone"?: string;
}

export interface CreateHydrationEntryQuery {
  readonly profileTimeZonePrecondition?: "v1";
}

export interface UpdateHydrationEntryRequest {
  readonly amountMilliliters?: number;
  readonly occurredAt?: string;
}

export interface HydrationMutationResponse {
  readonly data: {
    readonly replayed: boolean;
    readonly entry: HydrationEntry | null;
    readonly affectedDays: readonly { readonly localDate: string; readonly revision: string }[];
  };
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;

const revisionSchema = { type: "string", pattern: "^[1-9][0-9]*$" } as const;

const localDateSchema = {
  type: "string",
  format: "date",
  pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;

const localTimeSchema = {
  type: "string",
  pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,3})?$",
} as const;

const occurredAtSchema = {
  type: "string",
  format: "date-time",
  pattern:
    "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$",
} as const;

const amountMillilitersSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_HYDRATION_AMOUNT_MILLILITERS,
} as const;

export const hydrationEntrySchema = {
  $id: "HydrationEntry",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "amountMilliliters",
    "occurredAt",
    "localDate",
    "localTime",
    "timeZone",
    "createdAt",
  ],
  properties: {
    id: uuidSchema,
    revision: revisionSchema,
    amountMilliliters: amountMillilitersSchema,
    occurredAt: occurredAtSchema,
    localDate: localDateSchema,
    localTime: localTimeSchema,
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const hydrationDaySchema = {
  $id: "HydrationDay",
  type: "object",
  additionalProperties: false,
  required: ["localDate", "timeZone", "revision", "entries", "totalMilliliters", "updatedAt"],
  properties: {
    localDate: localDateSchema,
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    revision: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    entries: {
      type: "array",
      maxItems: MAX_HYDRATION_ENTRIES_PER_DAY,
      items: hydrationEntrySchema,
    },
    totalMilliliters: {
      type: "integer",
      minimum: 0,
      maximum: MAX_HYDRATION_DAY_TOTAL_MILLILITERS,
    },
    updatedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
} as const;

export const hydrationDayResponseSchema = {
  $id: "HydrationDayResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: hydrationDaySchema },
} as const;

export const createHydrationEntryRequestSchema = {
  $id: "CreateHydrationEntryRequest",
  type: "object",
  additionalProperties: false,
  required: ["amountMilliliters", "occurredAt"],
  properties: {
    amountMilliliters: amountMillilitersSchema,
    occurredAt: occurredAtSchema,
  },
} as const;

export const createHydrationEntryHeadersSchema = {
  $id: "CreateHydrationEntryHeaders",
  type: "object",
  additionalProperties: true,
  properties: {
    "x-expected-profile-time-zone": { type: "string", minLength: 1, maxLength: 63 },
  },
} as const;

export const createHydrationEntryQuerySchema = {
  $id: "CreateHydrationEntryQuery",
  type: "object",
  additionalProperties: false,
  properties: {
    profileTimeZonePrecondition: { type: "string", const: "v1" },
  },
} as const;

export const updateHydrationEntryRequestSchema = {
  $id: "UpdateHydrationEntryRequest",
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    amountMilliliters: amountMillilitersSchema,
    occurredAt: occurredAtSchema,
  },
} as const;

export const hydrationMutationResponseSchema = {
  $id: "HydrationMutationResponse",
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
        entry: { anyOf: [hydrationEntrySchema, { type: "null" }] },
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
