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

export const REFERENCE_TARGET_TEMPLATE_CODE = "us-ca-dri-adults-19-50" as const;
export const REFERENCE_TARGET_TEMPLATE_VERSION = "1" as const;
export const REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE =
  "us-ca-dri-adults-19-50-eligibility-ack" as const;
export const REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION = "1" as const;
export const REFERENCE_TARGET_NOTICE =
  "This optional template copies U.S.–Canada population reference values into your goals. It is for usual intake by apparently healthy adults in the selected group, not a diagnosis, prescription, or proof of adequacy. A single day above or below a reference does not determine nutrient status." as const;

export const referenceTargetGroupCodes = ["male-19-50", "female-19-50"] as const;
export type ReferenceTargetGroupCode = (typeof referenceTargetGroupCodes)[number];

export interface ReferenceTargetSetSelectionRequest {
  readonly templateCode: typeof REFERENCE_TARGET_TEMPLATE_CODE;
  readonly templateVersion: typeof REFERENCE_TARGET_TEMPLATE_VERSION;
  readonly groupCode: ReferenceTargetGroupCode;
  readonly eligibilityAcknowledgement: {
    readonly policyCode: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE;
    readonly policyVersion: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION;
    readonly accepted: true;
  };
}

export interface NutritionGoalCustomDraftRequest {
  readonly effectiveFrom: string;
  readonly energy: EnergyTargetRequest;
  readonly nutrientTargets: readonly NutrientTargetRequest[];
  /** Optional replay guard for clients that can detect an account switch. */
  readonly expectedOwnerUserId?: string;
  readonly expectedProfileRevision?: never;
  readonly referenceTargetSet?: never;
}

/** Revisions update target policy only; the immutable goal interval stays on the root. */
export interface NutritionGoalCustomRevisionRequest {
  readonly energy: EnergyTargetRequest;
  readonly nutrientTargets: readonly NutrientTargetRequest[];
  readonly expectedOwnerUserId?: string;
  readonly expectedProfileRevision?: never;
  readonly referenceTargetSet?: never;
}

export interface NutritionGoalReferenceDraftRequest {
  readonly effectiveFrom: string;
  readonly energy: EnergyTargetRequest;
  readonly nutrientTargets: readonly [];
  readonly expectedOwnerUserId: string;
  readonly expectedProfileRevision: string;
  readonly referenceTargetSet: ReferenceTargetSetSelectionRequest;
}

export interface NutritionGoalReferenceRevisionRequest {
  readonly energy: EnergyTargetRequest;
  readonly nutrientTargets: readonly [];
  readonly expectedOwnerUserId: string;
  readonly expectedProfileRevision: string;
  readonly referenceTargetSet: ReferenceTargetSetSelectionRequest;
}

export type NutritionGoalDraftRequest =
  | NutritionGoalCustomDraftRequest
  | NutritionGoalReferenceDraftRequest;
export type NutritionGoalRevisionRequest =
  | NutritionGoalCustomRevisionRequest
  | NutritionGoalReferenceRevisionRequest;

export interface ReferenceTargetSourceSet {
  readonly code: "health-canada-dri-tables";
  readonly version: "2025-11-19";
  readonly reviewedOn: "2026-09-07";
  readonly overviewUrl: string;
  readonly macronutrientsUrl: string;
  readonly elementsUrl: string;
  readonly vitaminsUrl: string;
  readonly reportListUrl: string;
}

export interface ResolvedReferenceTarget {
  readonly definition: TargetableNutrient;
  readonly minimumAmount: null;
  readonly targetAmount: string;
  readonly maximumAmount: string | null;
  readonly basis: {
    readonly timeBasis: "usual-average-daily-intake";
    readonly referenceType: "rda" | "ai";
    readonly maximumReferenceType: "ul" | null;
    readonly sourceRows: readonly string[];
  };
  readonly source: {
    readonly label: string;
    readonly version: string;
    readonly url: string;
    readonly table: string;
  };
  readonly rationale: string;
}

export interface ResolvedReferenceTargetSet {
  readonly templateCode: typeof REFERENCE_TARGET_TEMPLATE_CODE;
  readonly templateVersion: typeof REFERENCE_TARGET_TEMPLATE_VERSION;
  readonly groupCode: ReferenceTargetGroupCode;
  readonly title: string;
  readonly policyDigest: string;
  readonly eligibleThroughExclusive: string;
  readonly targets: readonly ResolvedReferenceTarget[];
}

export interface AppliedReferenceTargetAcknowledgement {
  readonly accepted: true;
  readonly acceptedAt: string;
  readonly policyCode: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE;
  readonly policyVersion: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION;
}

export type ReferenceTargetAvailabilityReasonCode =
  | "profile_missing_birth_date"
  | "profile_sex_unsupported"
  | "outside_reviewed_age"
  | "nutrient_registry_unavailable";

export interface ReferenceTargetSetListResponse {
  readonly data: {
    readonly date: string;
    readonly profileRevision: string;
    readonly availability: {
      readonly available: boolean;
      readonly reasonCodes: readonly ReferenceTargetAvailabilityReasonCode[];
    };
    readonly sets: readonly ResolvedReferenceTargetSet[];
    readonly acknowledgementPolicy: {
      readonly code: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE;
      readonly version: typeof REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION;
      readonly text: string;
    };
    readonly sources: ReferenceTargetSourceSet;
    readonly cautions: readonly { readonly code: string; readonly text: string }[];
    readonly applied: {
      readonly goalId: string;
      readonly goalVersionId: string;
      readonly goalRevision: string;
      readonly templateCode: typeof REFERENCE_TARGET_TEMPLATE_CODE;
      readonly templateVersion: typeof REFERENCE_TARGET_TEMPLATE_VERSION;
      readonly groupCode: ReferenceTargetGroupCode;
      readonly appliedProfileRevision: string;
      readonly policyDigest: string;
      readonly eligibleThroughExclusive: string;
      readonly acknowledgement: AppliedReferenceTargetAcknowledgement;
      readonly set: ResolvedReferenceTargetSet;
    } | null;
    readonly notice: typeof REFERENCE_TARGET_NOTICE;
  };
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
const nonNegativeRevisionSchema = {
  type: "string",
  pattern: "^(?:0|[1-9][0-9]{0,19})$",
} as const;
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

const energyTargetRequestValueSchema = {
  oneOf: [fixedEnergyRequestSchema, derivedEnergyRequestSchema],
} as const;

export const energyTargetRequestSchema = {
  $id: "EnergyTargetRequest",
  ...energyTargetRequestValueSchema,
} as const;

const nutrientTargetRequestValueSchema = {
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

export const nutrientTargetRequestSchema = {
  $id: "NutrientTargetRequest",
  ...nutrientTargetRequestValueSchema,
} as const;

const referenceTargetSetSelectionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["templateCode", "templateVersion", "groupCode", "eligibilityAcknowledgement"],
  properties: {
    templateCode: { type: "string", const: REFERENCE_TARGET_TEMPLATE_CODE },
    templateVersion: { type: "string", const: REFERENCE_TARGET_TEMPLATE_VERSION },
    groupCode: { type: "string", enum: referenceTargetGroupCodes },
    eligibilityAcknowledgement: {
      type: "object",
      additionalProperties: false,
      required: ["policyCode", "policyVersion", "accepted"],
      properties: {
        policyCode: {
          type: "string",
          const: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
        },
        policyVersion: {
          type: "string",
          const: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
        },
        accepted: { type: "boolean", const: true },
      },
    },
  },
} as const;

const nutritionGoalCustomDraftRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effectiveFrom", "energy", "nutrientTargets"],
  properties: {
    effectiveFrom: localDateSchema,
    energy: energyTargetRequestValueSchema,
    expectedOwnerUserId: uuidSchema,
    nutrientTargets: {
      type: "array",
      maxItems: 256,
      items: nutrientTargetRequestValueSchema,
    },
  },
} as const;

const nutritionGoalReferenceDraftRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "effectiveFrom",
    "energy",
    "nutrientTargets",
    "expectedOwnerUserId",
    "expectedProfileRevision",
    "referenceTargetSet",
  ],
  properties: {
    effectiveFrom: localDateSchema,
    energy: energyTargetRequestValueSchema,
    nutrientTargets: { type: "array", maxItems: 0 },
    expectedOwnerUserId: uuidSchema,
    expectedProfileRevision: nonNegativeRevisionSchema,
    referenceTargetSet: referenceTargetSetSelectionRequestSchema,
  },
} as const;

export const nutritionGoalDraftRequestSchema = {
  $id: "NutritionGoalDraftRequest",
  oneOf: [nutritionGoalCustomDraftRequestSchema, nutritionGoalReferenceDraftRequestSchema],
} as const;

const nutritionGoalCustomRevisionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["energy", "nutrientTargets"],
  properties: {
    energy: energyTargetRequestValueSchema,
    expectedOwnerUserId: uuidSchema,
    nutrientTargets: {
      type: "array",
      maxItems: 256,
      items: nutrientTargetRequestValueSchema,
    },
  },
} as const;

const nutritionGoalReferenceRevisionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "energy",
    "nutrientTargets",
    "expectedOwnerUserId",
    "expectedProfileRevision",
    "referenceTargetSet",
  ],
  properties: {
    energy: energyTargetRequestValueSchema,
    nutrientTargets: { type: "array", maxItems: 0 },
    expectedOwnerUserId: uuidSchema,
    expectedProfileRevision: nonNegativeRevisionSchema,
    referenceTargetSet: referenceTargetSetSelectionRequestSchema,
  },
} as const;

export const nutritionGoalRevisionRequestSchema = {
  $id: "NutritionGoalRevisionRequest",
  oneOf: [nutritionGoalCustomRevisionRequestSchema, nutritionGoalReferenceRevisionRequestSchema],
} as const;

const targetableNutrientValueSchema = {
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

export const targetableNutrientSchema = {
  $id: "TargetableNutrient",
  ...targetableNutrientValueSchema,
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
    definition: targetableNutrientValueSchema,
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

const referenceTargetSourceSetSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "code",
    "version",
    "reviewedOn",
    "overviewUrl",
    "macronutrientsUrl",
    "elementsUrl",
    "vitaminsUrl",
    "reportListUrl",
  ],
  properties: {
    code: { type: "string", const: "health-canada-dri-tables" },
    version: { type: "string", const: "2025-11-19" },
    reviewedOn: { type: "string", const: "2026-09-07" },
    overviewUrl: { type: "string", format: "uri", pattern: "^https://", maxLength: 500 },
    macronutrientsUrl: { type: "string", format: "uri", pattern: "^https://", maxLength: 500 },
    elementsUrl: { type: "string", format: "uri", pattern: "^https://", maxLength: 500 },
    vitaminsUrl: { type: "string", format: "uri", pattern: "^https://", maxLength: 500 },
    reportListUrl: { type: "string", format: "uri", pattern: "^https://", maxLength: 500 },
  },
} as const;

const resolvedReferenceTargetSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "definition",
    "minimumAmount",
    "targetAmount",
    "maximumAmount",
    "basis",
    "source",
    "rationale",
  ],
  properties: {
    definition: targetableNutrientValueSchema,
    minimumAmount: { type: "null" },
    targetAmount: nonNegativeExactDecimalSchema,
    maximumAmount: { anyOf: [nonNegativeExactDecimalSchema, { type: "null" }] },
    basis: {
      type: "object",
      additionalProperties: false,
      required: ["timeBasis", "referenceType", "maximumReferenceType", "sourceRows"],
      properties: {
        timeBasis: { type: "string", const: "usual-average-daily-intake" },
        referenceType: { type: "string", enum: ["rda", "ai"] },
        maximumReferenceType: { anyOf: [{ type: "string", const: "ul" }, { type: "null" }] },
        sourceRows: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
      },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["label", "version", "url", "table"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 160 },
        version: { type: "string", minLength: 1, maxLength: 100 },
        url: { type: "string", format: "uri", pattern: "^https://", maxLength: 500 },
        table: { type: "string", minLength: 1, maxLength: 32 },
      },
    },
    rationale: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

const resolvedReferenceTargetSetSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "templateCode",
    "templateVersion",
    "groupCode",
    "title",
    "policyDigest",
    "eligibleThroughExclusive",
    "targets",
  ],
  properties: {
    templateCode: { type: "string", const: REFERENCE_TARGET_TEMPLATE_CODE },
    templateVersion: { type: "string", const: REFERENCE_TARGET_TEMPLATE_VERSION },
    groupCode: { type: "string", enum: referenceTargetGroupCodes },
    title: { type: "string", minLength: 1, maxLength: 160 },
    policyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    eligibleThroughExclusive: localDateSchema,
    targets: {
      type: "array",
      minItems: 12,
      maxItems: 12,
      items: resolvedReferenceTargetSchema,
    },
  },
} as const;

const referenceTargetAppliedSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "goalId",
    "goalVersionId",
    "goalRevision",
    "templateCode",
    "templateVersion",
    "groupCode",
    "appliedProfileRevision",
    "policyDigest",
    "eligibleThroughExclusive",
    "acknowledgement",
    "set",
  ],
  properties: {
    goalId: uuidSchema,
    goalVersionId: uuidSchema,
    goalRevision: positiveIdentifierSchema,
    templateCode: { type: "string", const: REFERENCE_TARGET_TEMPLATE_CODE },
    templateVersion: { type: "string", const: REFERENCE_TARGET_TEMPLATE_VERSION },
    groupCode: { type: "string", enum: referenceTargetGroupCodes },
    appliedProfileRevision: nonNegativeRevisionSchema,
    policyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    eligibleThroughExclusive: localDateSchema,
    acknowledgement: {
      type: "object",
      additionalProperties: false,
      required: ["accepted", "acceptedAt", "policyCode", "policyVersion"],
      properties: {
        accepted: { type: "boolean", const: true },
        acceptedAt: {
          type: "string",
          format: "date-time",
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
        },
        policyCode: {
          type: "string",
          const: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
        },
        policyVersion: {
          type: "string",
          const: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
        },
      },
    },
    set: resolvedReferenceTargetSetSchema,
  },
} as const;

export const referenceTargetSetListResponseSchema = {
  $id: "ReferenceTargetSetListResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: [
        "date",
        "profileRevision",
        "availability",
        "sets",
        "acknowledgementPolicy",
        "sources",
        "cautions",
        "applied",
        "notice",
      ],
      properties: {
        date: localDateSchema,
        profileRevision: nonNegativeRevisionSchema,
        availability: {
          type: "object",
          additionalProperties: false,
          required: ["available", "reasonCodes"],
          properties: {
            available: { type: "boolean" },
            reasonCodes: {
              type: "array",
              maxItems: 4,
              uniqueItems: true,
              items: {
                type: "string",
                enum: [
                  "profile_missing_birth_date",
                  "profile_sex_unsupported",
                  "outside_reviewed_age",
                  "nutrient_registry_unavailable",
                ],
              },
            },
          },
        },
        sets: { type: "array", maxItems: 1, items: resolvedReferenceTargetSetSchema },
        acknowledgementPolicy: {
          type: "object",
          additionalProperties: false,
          required: ["code", "version", "text"],
          properties: {
            code: { type: "string", const: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE },
            version: {
              type: "string",
              const: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
            },
            text: { type: "string", minLength: 1, maxLength: 1_000 },
          },
        },
        sources: referenceTargetSourceSetSchema,
        cautions: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "text"],
            properties: {
              code: { type: "string", minLength: 1, maxLength: 80 },
              text: { type: "string", minLength: 1, maxLength: 1_000 },
            },
          },
        },
        applied: { anyOf: [referenceTargetAppliedSchema, { type: "null" }] },
        notice: { type: "string", const: REFERENCE_TARGET_NOTICE },
      },
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
  properties: { data: { type: "array", maxItems: 256, items: targetableNutrientValueSchema } },
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
