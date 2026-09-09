/** Operational product bounds, not exercise or medical guidance. */
export const MAX_ACTIVITY_NAME_CODE_POINTS = 120;
export const MAX_ACTIVITY_NAME_UTF8_BYTES = 480;
export const MAX_ACTIVITY_DURATION_MINUTES = 1_440;
export const MAX_ACTIVITY_ENTRIES_PER_DAY = 64;
export const MAX_ACTIVITY_DAY_DURATION_MINUTES =
  MAX_ACTIVITY_DURATION_MINUTES * MAX_ACTIVITY_ENTRIES_PER_DAY;
export const MAX_ACTIVITY_SELF_REPORTED_ENERGY_KILOCALORIES = "20000";
export const MAX_ACTIVITY_ENERGY_DECIMAL_PLACES = 3;

export interface ActivityEntry {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  /** Exact positive whole minutes. */
  readonly durationMinutes: number;
  /** Optional user-entered value for history only; never an energy-balance input. */
  readonly selfReportedEnergyKilocalories: string | null;
  /** Activity start instant; it determines the entry's profile-local day. */
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  /** IANA zone used to derive this immutable revision's local coordinates. */
  readonly timeZone: string;
  readonly createdAt: string;
}

export interface ActivityDay {
  readonly localDate: string;
  readonly timeZone: string;
  /** Day synchronization token. */
  readonly revision: string;
  readonly entries: readonly ActivityEntry[];
  /** Exact sum of active entry durations; overlap is intentionally not removed. */
  readonly totalDurationMinutes: number;
  readonly updatedAt: string | null;
}

export interface ActivityDayResponse {
  readonly data: ActivityDay;
}

export interface CreateActivityEntryRequest {
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories: string | null;
  readonly occurredAt: string;
}

/** Optional guarded-create precondition; unrelated standard headers remain allowed. */
export interface ActivityOwnerHeaders {
  readonly "x-expected-owner-user-id"?: string;
}

export interface CreateActivityEntryHeaders extends ActivityOwnerHeaders {
  readonly "x-expected-profile-time-zone"?: string;
}

export interface CreateActivityEntryQuery {
  readonly profileTimeZonePrecondition?: "v1";
}

export interface UpdateActivityEntryRequest {
  readonly name?: string;
  readonly durationMinutes?: number;
  readonly selfReportedEnergyKilocalories?: string | null;
  readonly occurredAt?: string;
}

export interface ActivityMutationResponse {
  readonly data: {
    readonly replayed: boolean;
    readonly entry: ActivityEntry | null;
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

const activityNameSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_ACTIVITY_NAME_CODE_POINTS,
  pattern: "^(?!.*[\\u0000-\\u001F\\u007F-\\u009F])(?!.*[\\uD800-\\uDFFF])[^\\s]+(?: [^\\s]+)*$",
} as const;

const durationMinutesSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_ACTIVITY_DURATION_MINUTES,
} as const;

/** Canonical positive decimal, <=20000, <=3 fractional digits, no trailing zero. */
const selfReportedEnergyKilocaloriesSchema = {
  type: "string",
  pattern:
    "^(?:20000|[1-9][0-9]{0,3}|1[0-9]{4}|(?:0|[1-9][0-9]{0,3}|1[0-9]{4})\\.(?:[0-9]{0,2}[1-9]))$",
} as const;

export const activityEntrySchema = {
  $id: "ActivityEntry",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "revision",
    "name",
    "durationMinutes",
    "selfReportedEnergyKilocalories",
    "occurredAt",
    "localDate",
    "localTime",
    "timeZone",
    "createdAt",
  ],
  properties: {
    id: uuidSchema,
    revision: revisionSchema,
    name: activityNameSchema,
    durationMinutes: durationMinutesSchema,
    selfReportedEnergyKilocalories: {
      anyOf: [selfReportedEnergyKilocaloriesSchema, { type: "null" }],
    },
    occurredAt: occurredAtSchema,
    localDate: localDateSchema,
    localTime: localTimeSchema,
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const activityDaySchema = {
  $id: "ActivityDay",
  type: "object",
  additionalProperties: false,
  required: ["localDate", "timeZone", "revision", "entries", "totalDurationMinutes", "updatedAt"],
  properties: {
    localDate: localDateSchema,
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    revision: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    entries: {
      type: "array",
      maxItems: MAX_ACTIVITY_ENTRIES_PER_DAY,
      items: activityEntrySchema,
    },
    totalDurationMinutes: {
      type: "integer",
      minimum: 0,
      maximum: MAX_ACTIVITY_DAY_DURATION_MINUTES,
    },
    updatedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
} as const;

export const activityDayResponseSchema = {
  $id: "ActivityDayResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: activityDaySchema },
} as const;

export const createActivityEntryRequestSchema = {
  $id: "CreateActivityEntryRequest",
  type: "object",
  additionalProperties: false,
  required: ["name", "durationMinutes", "selfReportedEnergyKilocalories", "occurredAt"],
  properties: {
    name: activityNameSchema,
    durationMinutes: durationMinutesSchema,
    selfReportedEnergyKilocalories: {
      anyOf: [selfReportedEnergyKilocaloriesSchema, { type: "null" }],
    },
    occurredAt: occurredAtSchema,
  },
} as const;

export const createActivityEntryHeadersSchema = {
  $id: "CreateActivityEntryHeaders",
  type: "object",
  additionalProperties: true,
  properties: {
    "x-expected-owner-user-id": uuidSchema,
    "x-expected-profile-time-zone": { type: "string", minLength: 1, maxLength: 63 },
  },
} as const;

export const activityOwnerHeadersSchema = {
  $id: "ActivityOwnerHeaders",
  type: "object",
  additionalProperties: true,
  properties: {
    "x-expected-owner-user-id": uuidSchema,
  },
} as const;

export const createActivityEntryQuerySchema = {
  $id: "CreateActivityEntryQuery",
  type: "object",
  additionalProperties: false,
  properties: {
    profileTimeZonePrecondition: { type: "string", const: "v1" },
  },
} as const;

export const updateActivityEntryRequestSchema = {
  $id: "UpdateActivityEntryRequest",
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: activityNameSchema,
    durationMinutes: durationMinutesSchema,
    selfReportedEnergyKilocalories: {
      anyOf: [selfReportedEnergyKilocaloriesSchema, { type: "null" }],
    },
    occurredAt: occurredAtSchema,
  },
} as const;

export const activityMutationResponseSchema = {
  $id: "ActivityMutationResponse",
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
        entry: { anyOf: [activityEntrySchema, { type: "null" }] },
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
