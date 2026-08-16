export const sexAtBirthValues = ["female", "intersex", "male", "not_specified"] as const;
export const unitSystemValues = ["metric", "us_customary"] as const;

export type SexAtBirth = (typeof sexAtBirthValues)[number];
export type UnitSystem = (typeof unitSystemValues)[number];

export interface UserProfile {
  readonly displayName: string | null;
  readonly birthDate: string | null;
  readonly sexAtBirth: SexAtBirth;
  /** Exact decimal centimetres serialized as a string. */
  readonly heightCm: string | null;
  /** Exact decimal kilograms serialized as a string. */
  readonly baselineWeightKg: string | null;
  readonly activityLevelCode: string | null;
  readonly locale: string;
  readonly timeZone: string;
  readonly unitSystem: UnitSystem;
  readonly onboardingCompletedAt: string | null;
  /** Monotonic optimistic-concurrency token serialized as a string. */
  readonly revision: string;
}

export interface UserProfileResponse {
  readonly data: { readonly profile: UserProfile };
}

export interface UpdateUserProfileRequest {
  readonly displayName?: string | null;
  readonly birthDate?: string | null;
  readonly sexAtBirth?: SexAtBirth;
  readonly heightCm?: string | null;
  readonly baselineWeightKg?: string | null;
  readonly activityLevelCode?: string | null;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly unitSystem?: UnitSystem;
}

const nullableString = (schema: Readonly<Record<string, unknown>>) => ({
  anyOf: [schema, { type: "null" }],
});

const heightCmSchema = {
  type: "string",
  maxLength: 7,
  pattern: "^(?:(?:[3-9][0-9]|[12][0-9]{2})(?:\\.[0-9]{1,3})?|300(?:\\.0{1,3})?)$",
} as const;
const weightKgSchema = {
  type: "string",
  maxLength: 8,
  pattern: "^(?:(?:[1-9]|[1-9][0-9]{1,2})(?:\\.[0-9]{1,3})?|1000(?:\\.0{1,3})?)$",
} as const;

export const userProfileSchema = {
  $id: "UserProfile",
  type: "object",
  additionalProperties: false,
  required: [
    "displayName",
    "birthDate",
    "sexAtBirth",
    "heightCm",
    "baselineWeightKg",
    "activityLevelCode",
    "locale",
    "timeZone",
    "unitSystem",
    "onboardingCompletedAt",
    "revision",
  ],
  properties: {
    displayName: nullableString({ type: "string", minLength: 1, maxLength: 100 }),
    birthDate: nullableString({ type: "string", format: "date" }),
    sexAtBirth: { type: "string", enum: sexAtBirthValues },
    heightCm: nullableString(heightCmSchema),
    baselineWeightKg: nullableString(weightKgSchema),
    activityLevelCode: nullableString({
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_]*$",
    }),
    locale: { type: "string", minLength: 2, maxLength: 35 },
    timeZone: { type: "string", minLength: 1, maxLength: 63 },
    unitSystem: { type: "string", enum: unitSystemValues },
    onboardingCompletedAt: nullableString({ type: "string", format: "date-time" }),
    revision: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
  },
} as const;

export const userProfileResponseSchema = {
  $id: "UserProfileResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["profile"],
      properties: { profile: userProfileSchema },
    },
  },
} as const;

export const updateUserProfileRequestSchema = {
  $id: "UpdateUserProfileRequest",
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: userProfileSchema.properties.displayName,
    birthDate: userProfileSchema.properties.birthDate,
    sexAtBirth: userProfileSchema.properties.sexAtBirth,
    heightCm: userProfileSchema.properties.heightCm,
    baselineWeightKg: userProfileSchema.properties.baselineWeightKg,
    activityLevelCode: userProfileSchema.properties.activityLevelCode,
    locale: userProfileSchema.properties.locale,
    timeZone: userProfileSchema.properties.timeZone,
    unitSystem: userProfileSchema.properties.unitSystem,
  },
} as const;
