import { diaryNutrientAggregateSchema, nutrientCompletenessValues } from "./diary.js";

export const goalStatuses = ["active", "archived", "draft"] as const;
export const palLevelCodes = ["sedentary_or_light", "active_or_moderate", "vigorous"] as const;
export const nutrientCategories = [
  "energy",
  "macronutrient",
  "vitamin",
  "mineral",
  "amino-acid",
  "fatty-acid",
  "other",
] as const;
export const thresholdStates = ["met", "below", "within", "exceeded", "indeterminate"] as const;
export const GENERAL_WELLNESS_NOTICE = "General wellness estimate; not medical advice." as const;
/** Allows the largest valid 160-character diary amount scaled by a 1e-12 target and 100. */
export const MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH = 200;

export type GoalStatus = (typeof goalStatuses)[number];
export type PalLevelCode = (typeof palLevelCodes)[number];
export type NutrientCategory = (typeof nutrientCategories)[number];
export type ThresholdState = (typeof thresholdStates)[number];

export type EnergyTargetRequest =
  | { readonly mode: "fixed"; readonly targetKcal: string; readonly rationale: string }
  | {
      readonly mode: "derived";
      readonly activityLevelCode: PalLevelCode;
      readonly activityFactor: string;
      readonly adjustmentKcal?: string;
      readonly rationale: string;
    };

export interface NutrientTargetRequest {
  readonly nutrientId: string;
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly source: { readonly label: string; readonly version: string | null };
  readonly rationale: string | null;
}

export interface NutritionGoalDraftRequest {
  readonly effectiveFrom: string;
  readonly energy: EnergyTargetRequest;
  readonly nutrientTargets: readonly NutrientTargetRequest[];
}

/** Revisions update target policy only; the immutable goal interval stays on the root. */
export interface NutritionGoalRevisionRequest {
  readonly energy: EnergyTargetRequest;
  readonly nutrientTargets: readonly NutrientTargetRequest[];
}

export interface TargetableNutrient {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly category: NutrientCategory;
}

export type EnergyTargetSnapshot =
  | {
      readonly mode: "fixed";
      readonly targetKcal: string;
      readonly source: { readonly code: "user-fixed"; readonly version: "1" };
      readonly rationale: string;
    }
  | {
      readonly mode: "derived";
      readonly targetKcal: string;
      readonly bmrKcal: string;
      readonly ageYears: number;
      readonly heightCm: string;
      readonly weightKg: string;
      readonly sexAtBirth: "female" | "male";
      readonly profileRevision: string;
      readonly activityLevelCode: PalLevelCode;
      readonly activityFactor: string;
      readonly adjustmentKcal: string;
      readonly source: {
        readonly equation: {
          readonly code: "mifflin-st-jeor-ree";
          readonly version: "1990-original";
          readonly url: string;
        };
        readonly activityPolicy: {
          readonly code: "fao-who-unu-pal-policy";
          readonly version: "2004-reviewed-v1";
          readonly sourceUrl: string;
        };
      };
      readonly rationale: string;
    };

export interface NutritionGoalTarget {
  readonly definition: TargetableNutrient;
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly source: { readonly label: string; readonly version: string | null };
  readonly rationale: string | null;
}

export interface NutritionGoalVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly energy: EnergyTargetSnapshot;
  readonly nutrientTargets: readonly NutritionGoalTarget[];
  readonly createdAt: string;
}

export interface NutritionGoal {
  readonly id: string;
  readonly status: GoalStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly revision: string;
  readonly currentVersion: NutritionGoalVersion;
  readonly notice: typeof GENERAL_WELLNESS_NOTICE;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NutritionGoalResponse {
  readonly data: { readonly goal: NutritionGoal | null };
}

export interface NutritionGoalMutationResponse {
  readonly data: { readonly replayed: boolean; readonly goal: NutritionGoal };
}

export interface GoalProgressRow {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly amountInterpretation: "exact" | "lower_bound";
  readonly completeness: "complete" | "partial" | "unknown";
  readonly minimum: { readonly amount: string; readonly state: ThresholdState } | null;
  readonly target: {
    readonly amount: string;
    readonly lowerBoundPercent: string | null;
    readonly percentIsExact: boolean;
  } | null;
  readonly maximum: { readonly amount: string; readonly state: ThresholdState } | null;
}

export interface NutritionGoalProgressResponse {
  readonly data: {
    readonly localDate: string;
    readonly timeZone: string;
    readonly diaryRevision: string;
    readonly goal: {
      readonly id: string;
      readonly versionId: string;
      readonly revision: string;
    } | null;
    readonly energy: GoalProgressRow | null;
    readonly nutrients: readonly GoalProgressRow[];
    readonly notice: typeof GENERAL_WELLNESS_NOTICE;
  };
}

export interface TargetableNutrientListResponse {
  readonly data: readonly TargetableNutrient[];
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const positiveIdentifierSchema = { type: "string", pattern: "^[1-9][0-9]{0,19}$" } as const;
const nonNegativeExactDecimalSchema = {
  type: "string",
  maxLength: 160,
  pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const nonNegativePercentageOutputSchema = {
  type: "string",
  maxLength: MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH,
  pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const positiveExactDecimalSchema = {
  type: "string",
  maxLength: 160,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const positiveInputDecimalSchema = {
  type: "string",
  maxLength: 19,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$",
} as const;
const signedInputDecimalSchema = {
  type: "string",
  maxLength: 20,
  pattern: "^-?(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$",
} as const;
const nonNegativeTargetInputSchema = {
  type: "string",
  maxLength: 31,
  pattern: "^(?:0|[1-9][0-9]{0,17})(?:\\.[0-9]{1,12})?$",
} as const;
const signedExactDecimalSchema = {
  type: "string",
  maxLength: 160,
  pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const nullableAmountSchema = { anyOf: [nonNegativeTargetInputSchema, { type: "null" }] } as const;
const localDateSchema = {
  type: "string",
  format: "date",
  pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;
const nullableText = (maximum: number) => ({
  anyOf: [{ type: "string", minLength: 1, maxLength: maximum }, { type: "null" }],
});

const fixedEnergyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "targetKcal", "rationale"],
  properties: {
    mode: { type: "string", const: "fixed" },
    targetKcal: positiveInputDecimalSchema,
    rationale: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

const derivedEnergyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "activityLevelCode", "activityFactor", "rationale"],
  properties: {
    mode: { type: "string", const: "derived" },
    activityLevelCode: { type: "string", enum: palLevelCodes },
    activityFactor: positiveInputDecimalSchema,
    adjustmentKcal: signedInputDecimalSchema,
    rationale: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

export const energyTargetRequestSchema = {
  $id: "EnergyTargetRequest",
  oneOf: [fixedEnergyRequestSchema, derivedEnergyRequestSchema],
} as const;

export const nutrientTargetRequestSchema = {
  $id: "NutrientTargetRequest",
  type: "object",
  additionalProperties: false,
  required: ["nutrientId", "minimumAmount", "targetAmount", "maximumAmount", "source", "rationale"],
  properties: {
    nutrientId: positiveIdentifierSchema,
    minimumAmount: nullableAmountSchema,
    targetAmount: nullableAmountSchema,
    maximumAmount: nullableAmountSchema,
    source: {
      type: "object",
      additionalProperties: false,
      required: ["label", "version"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 160 },
        version: nullableText(100),
      },
    },
    rationale: nullableText(1_000),
  },
  anyOf: [
    { properties: { minimumAmount: nonNegativeTargetInputSchema } },
    { properties: { targetAmount: nonNegativeTargetInputSchema } },
    { properties: { maximumAmount: nonNegativeTargetInputSchema } },
  ],
} as const;

export const nutritionGoalDraftRequestSchema = {
  $id: "NutritionGoalDraftRequest",
  type: "object",
  additionalProperties: false,
  required: ["effectiveFrom", "energy", "nutrientTargets"],
  properties: {
    effectiveFrom: localDateSchema,
    energy: energyTargetRequestSchema,
    nutrientTargets: {
      type: "array",
      maxItems: 256,
      items: nutrientTargetRequestSchema,
    },
  },
} as const;

export const nutritionGoalRevisionRequestSchema = {
  $id: "NutritionGoalRevisionRequest",
  type: "object",
  additionalProperties: false,
  required: ["energy", "nutrientTargets"],
  properties: {
    energy: energyTargetRequestSchema,
    nutrientTargets: {
      type: "array",
      maxItems: 256,
      items: nutrientTargetRequestSchema,
    },
  },
} as const;

export const targetableNutrientSchema = {
  $id: "TargetableNutrient",
  type: "object",
  additionalProperties: false,
  required: ["id", "code", "name", "unit", "category"],
  properties: {
    id: positiveIdentifierSchema,
    code: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    unit: { type: "string", minLength: 1, maxLength: 32 },
    category: { type: "string", enum: nutrientCategories },
  },
} as const;

const fixedEnergySnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "targetKcal", "source", "rationale"],
  properties: {
    mode: { type: "string", const: "fixed" },
    targetKcal: positiveExactDecimalSchema,
    source: {
      type: "object",
      additionalProperties: false,
      required: ["code", "version"],
      properties: {
        code: { type: "string", const: "user-fixed" },
        version: { type: "string", const: "1" },
      },
    },
    rationale: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

const derivedEnergySnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "mode",
    "targetKcal",
    "bmrKcal",
    "ageYears",
    "heightCm",
    "weightKg",
    "sexAtBirth",
    "profileRevision",
    "activityLevelCode",
    "activityFactor",
    "adjustmentKcal",
    "source",
    "rationale",
  ],
  properties: {
    mode: { type: "string", const: "derived" },
    targetKcal: positiveExactDecimalSchema,
    bmrKcal: positiveExactDecimalSchema,
    ageYears: { type: "integer", minimum: 19, maximum: 78 },
    heightCm: positiveExactDecimalSchema,
    weightKg: positiveExactDecimalSchema,
    sexAtBirth: { type: "string", enum: ["female", "male"] },
    profileRevision: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
    activityLevelCode: { type: "string", enum: palLevelCodes },
    activityFactor: positiveExactDecimalSchema,
    adjustmentKcal: signedExactDecimalSchema,
    source: {
      type: "object",
      additionalProperties: false,
      required: ["equation", "activityPolicy"],
      properties: {
        equation: {
          type: "object",
          additionalProperties: false,
          required: ["code", "version", "url"],
          properties: {
            code: { type: "string", const: "mifflin-st-jeor-ree" },
            version: { type: "string", const: "1990-original" },
            url: { type: "string", format: "uri", maxLength: 500 },
          },
        },
        activityPolicy: {
          type: "object",
          additionalProperties: false,
          required: ["code", "version", "sourceUrl"],
          properties: {
            code: { type: "string", const: "fao-who-unu-pal-policy" },
            version: { type: "string", const: "2004-reviewed-v1" },
            sourceUrl: { type: "string", format: "uri", maxLength: 500 },
          },
        },
      },
    },
    rationale: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

export const energyTargetSnapshotSchema = {
  $id: "EnergyTargetSnapshot",
  oneOf: [fixedEnergySnapshotSchema, derivedEnergySnapshotSchema],
} as const;

export const nutritionGoalTargetSchema = {
  $id: "NutritionGoalTarget",
  type: "object",
  additionalProperties: false,
  required: ["definition", "minimumAmount", "targetAmount", "maximumAmount", "source", "rationale"],
  properties: {
    definition: targetableNutrientSchema,
    minimumAmount: nullableAmountSchema,
    targetAmount: nullableAmountSchema,
    maximumAmount: nullableAmountSchema,
    source: nutrientTargetRequestSchema.properties.source,
    rationale: nullableText(1_000),
  },
} as const;

export const nutritionGoalVersionSchema = {
  $id: "NutritionGoalVersion",
  type: "object",
  additionalProperties: false,
  required: ["id", "versionNumber", "energy", "nutrientTargets", "createdAt"],
  properties: {
    id: uuidSchema,
    versionNumber: { type: "integer", minimum: 1 },
    energy: energyTargetSnapshotSchema,
    nutrientTargets: { type: "array", maxItems: 256, items: nutritionGoalTargetSchema },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const nutritionGoalSchema = {
  $id: "NutritionGoal",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "status",
    "effectiveFrom",
    "effectiveTo",
    "revision",
    "currentVersion",
    "notice",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    status: { type: "string", enum: goalStatuses },
    effectiveFrom: localDateSchema,
    effectiveTo: { anyOf: [localDateSchema, { type: "null" }] },
    revision: { type: "string", pattern: "^[1-9][0-9]*$" },
    currentVersion: nutritionGoalVersionSchema,
    notice: { type: "string", const: GENERAL_WELLNESS_NOTICE },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const nutritionGoalResponseSchema = {
  $id: "NutritionGoalResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["goal"],
      properties: { goal: { anyOf: [nutritionGoalSchema, { type: "null" }] } },
    },
  },
} as const;

export const nutritionGoalMutationResponseSchema = {
  $id: "NutritionGoalMutationResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "goal"],
      properties: { replayed: { type: "boolean" }, goal: nutritionGoalSchema },
    },
  },
} as const;

const progressThresholdSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["amount", "state"],
      properties: {
        amount: nonNegativeExactDecimalSchema,
        state: { type: "string", enum: thresholdStates },
      },
    },
    { type: "null" },
  ],
} as const;

export const goalProgressRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "nutrientId",
    "code",
    "name",
    "unit",
    "knownAmount",
    "amountInterpretation",
    "completeness",
    "minimum",
    "target",
    "maximum",
  ],
  properties: {
    nutrientId: positiveIdentifierSchema,
    code: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    unit: { type: "string", minLength: 1, maxLength: 32 },
    knownAmount: nonNegativeExactDecimalSchema,
    amountInterpretation: { type: "string", enum: ["exact", "lower_bound"] },
    completeness: { type: "string", enum: nutrientCompletenessValues },
    minimum: progressThresholdSchema,
    target: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["amount", "lowerBoundPercent", "percentIsExact"],
          properties: {
            amount: nonNegativeExactDecimalSchema,
            lowerBoundPercent: {
              anyOf: [nonNegativePercentageOutputSchema, { type: "null" }],
            },
            percentIsExact: { type: "boolean" },
          },
        },
        { type: "null" },
      ],
    },
    maximum: progressThresholdSchema,
  },
} as const;

export const nutritionGoalProgressResponseSchema = {
  $id: "NutritionGoalProgressResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["localDate", "timeZone", "diaryRevision", "goal", "energy", "nutrients", "notice"],
      properties: {
        localDate: localDateSchema,
        timeZone: { type: "string", minLength: 1, maxLength: 63 },
        diaryRevision: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
        goal: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["id", "versionId", "revision"],
              properties: {
                id: uuidSchema,
                versionId: uuidSchema,
                revision: { type: "string", pattern: "^[1-9][0-9]*$" },
              },
            },
            { type: "null" },
          ],
        },
        energy: { anyOf: [goalProgressRowSchema, { type: "null" }] },
        nutrients: { type: "array", maxItems: 256, items: goalProgressRowSchema },
        notice: { type: "string", const: GENERAL_WELLNESS_NOTICE },
      },
    },
  },
} as const;

export const targetableNutrientListResponseSchema = {
  $id: "TargetableNutrientListResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: { type: "array", maxItems: 256, items: targetableNutrientSchema } },
} as const;

export const goalDateQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["date"],
  properties: { date: localDateSchema },
} as const;

export const goalParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["goalId"],
  properties: { goalId: uuidSchema },
} as const;

// Re-exported so API invariant validation can compare against diary aggregate shape.
export const goalDiaryNutrientAggregateSchema = diaryNutrientAggregateSchema;
