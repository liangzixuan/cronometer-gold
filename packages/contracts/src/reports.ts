import { type DiaryNutrientAggregate, diaryNutrientAggregateSchema } from "./diary.js";
import {
  GENERAL_WELLNESS_NOTICE,
  type NutrientCategory,
  nutrientCategories,
  type ThresholdState,
  thresholdStates,
} from "./goals.js";

export const MAX_NUTRITION_REPORT_DAYS = 31;
export const NUTRITION_REPORT_NOTICE = GENERAL_WELLNESS_NOTICE;

export interface NutritionReportNutrientDefinition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly category: NutrientCategory;
}

export interface NutritionReportSourceDiary {
  readonly id: string;
  readonly localDate: string;
  readonly revision: string;
}

export interface NutritionReportTargetSnapshot {
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly source: { readonly label: string; readonly version: string | null };
  readonly rationale: string | null;
}

export interface NutritionReportGoalVersion {
  readonly goalId: string;
  readonly versionId: string;
  readonly revision: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly reference: {
    readonly templateCode: string;
    readonly templateVersion: string;
    readonly groupCode: string;
    readonly policyDigest: string;
    readonly eligibleThroughExclusive: string;
  } | null;
  readonly targets: readonly {
    readonly nutrientId: string;
    readonly snapshot: NutritionReportTargetSnapshot;
  }[];
}

export interface NutritionReportTargetSegment {
  readonly from: string;
  readonly to: string;
  readonly goalVersionId: string | null;
}

export interface NutritionReportComparison {
  readonly minimumState: ThresholdState | null;
  readonly targetLowerBoundPercent: string | null;
  readonly targetPercentIsExact: boolean | null;
  readonly maximumState: ThresholdState | null;
}

export interface NutritionReportSeriesPoint {
  readonly localDate: string;
  readonly goalVersionId: string | null;
  readonly aggregate: DiaryNutrientAggregate | null;
  readonly knownPercentOfScale: string | null;
  readonly minimumPercentOfScale: string | null;
  readonly targetPercentOfScale: string | null;
  readonly maximumPercentOfScale: string | null;
  readonly comparison: NutritionReportComparison | null;
}

export interface NutritionReportSeries {
  readonly nutrient: NutritionReportNutrientDefinition;
  readonly scalePolicy: "max-intake-or-saved-threshold-v1";
  readonly scaleMaximum: string;
  readonly summary: {
    readonly diaryDays: number;
    readonly completeDays: number;
    readonly exactDays: number;
    readonly partialDays: number;
    readonly unknownDays: number;
    readonly traceDays: number;
    readonly missingDays: number;
  };
  readonly points: readonly NutritionReportSeriesPoint[];
}

export interface NutritionReportDay {
  readonly localDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly entryCount: number;
  readonly sourceDiaries: readonly NutritionReportSourceDiary[];
  readonly sourceTimeZones: readonly string[];
}

export interface NutritionReportResponse {
  readonly data: {
    readonly ownerUserId: string;
    readonly profileRevision: string;
    readonly timeZone: string;
    readonly watermarkRevision: string;
    readonly snapshotAt: string;
    readonly dateBasis: "active-profile-time-zone-v1";
    readonly goalVersionBasis: "current-version-at-report-snapshot-v1";
    readonly from: string;
    readonly to: string;
    readonly days: readonly NutritionReportDay[];
    readonly goalVersions: readonly NutritionReportGoalVersion[];
    readonly targetSegments: readonly NutritionReportTargetSegment[];
    readonly series: readonly NutritionReportSeries[];
    readonly notice: typeof NUTRITION_REPORT_NOTICE;
  };
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const localDateSchema = {
  type: "string",
  format: "date",
  pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
} as const;
const instantSchema = { type: "string", format: "date-time" } as const;
const positiveIdentifierSchema = {
  type: "string",
  pattern: "^[1-9][0-9]{0,19}$",
} as const;
const revisionSchema = {
  type: "string",
  pattern: "^(?:0|[1-9][0-9]{0,19})$",
} as const;
const positiveRevisionSchema = {
  type: "string",
  pattern: "^[1-9][0-9]{0,19}$",
} as const;
const amountSchema = {
  type: "string",
  maxLength: 200,
  pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const positiveAmountSchema = {
  type: "string",
  maxLength: 200,
  pattern: "^(?=.*[1-9])(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
} as const;
const percentageSchema = {
  type: "string",
  maxLength: 7,
  pattern: "^(?:0|[1-9][0-9]?|100)(?:\\.[0-9]{1,3})?$",
} as const;
const nullableAmountSchema = { anyOf: [amountSchema, { type: "null" }] } as const;
const nullablePercentageSchema = {
  anyOf: [percentageSchema, { type: "null" }],
} as const;

const nutrientDefinitionSchema = {
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

const targetSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["minimumAmount", "targetAmount", "maximumAmount", "source", "rationale"],
  properties: {
    minimumAmount: nullableAmountSchema,
    targetAmount: nullableAmountSchema,
    maximumAmount: nullableAmountSchema,
    source: {
      type: "object",
      additionalProperties: false,
      required: ["label", "version"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 160 },
        version: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 100 }, { type: "null" }],
        },
      },
    },
    rationale: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 1_000 }, { type: "null" }],
    },
  },
} as const;

const comparisonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["minimumState", "targetLowerBoundPercent", "targetPercentIsExact", "maximumState"],
  properties: {
    minimumState: {
      anyOf: [{ type: "string", enum: thresholdStates }, { type: "null" }],
    },
    targetLowerBoundPercent: {
      anyOf: [amountSchema, { type: "null" }],
    },
    targetPercentIsExact: {
      anyOf: [{ type: "boolean" }, { type: "null" }],
    },
    maximumState: {
      anyOf: [{ type: "string", enum: thresholdStates }, { type: "null" }],
    },
  },
} as const;

const summaryProperties = {
  diaryDays: { type: "integer", minimum: 0, maximum: MAX_NUTRITION_REPORT_DAYS },
  completeDays: { type: "integer", minimum: 0, maximum: MAX_NUTRITION_REPORT_DAYS },
  exactDays: { type: "integer", minimum: 0, maximum: MAX_NUTRITION_REPORT_DAYS },
  partialDays: { type: "integer", minimum: 0, maximum: MAX_NUTRITION_REPORT_DAYS },
  unknownDays: { type: "integer", minimum: 0, maximum: MAX_NUTRITION_REPORT_DAYS },
  traceDays: { type: "integer", minimum: 0, maximum: MAX_NUTRITION_REPORT_DAYS },
  missingDays: { type: "integer", minimum: 0, maximum: MAX_NUTRITION_REPORT_DAYS },
} as const;

export const nutritionReportResponseSchema = {
  $id: "NutritionReportResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: [
        "ownerUserId",
        "profileRevision",
        "timeZone",
        "watermarkRevision",
        "snapshotAt",
        "dateBasis",
        "goalVersionBasis",
        "from",
        "to",
        "days",
        "goalVersions",
        "targetSegments",
        "series",
        "notice",
      ],
      properties: {
        ownerUserId: uuidSchema,
        profileRevision: revisionSchema,
        timeZone: { type: "string", minLength: 1, maxLength: 63 },
        watermarkRevision: revisionSchema,
        snapshotAt: instantSchema,
        dateBasis: { type: "string", const: "active-profile-time-zone-v1" },
        goalVersionBasis: {
          type: "string",
          const: "current-version-at-report-snapshot-v1",
        },
        from: localDateSchema,
        to: localDateSchema,
        days: {
          type: "array",
          minItems: 1,
          maxItems: MAX_NUTRITION_REPORT_DAYS,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "localDate",
              "startsAt",
              "endsAt",
              "entryCount",
              "sourceDiaries",
              "sourceTimeZones",
            ],
            properties: {
              localDate: localDateSchema,
              startsAt: instantSchema,
              endsAt: instantSchema,
              entryCount: { type: "integer", minimum: 0 },
              sourceDiaries: {
                type: "array",
                maxItems: 31,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "localDate", "revision"],
                  properties: {
                    id: uuidSchema,
                    localDate: localDateSchema,
                    revision: positiveRevisionSchema,
                  },
                },
              },
              sourceTimeZones: {
                type: "array",
                maxItems: 50,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 63 },
              },
            },
          },
        },
        goalVersions: {
          type: "array",
          maxItems: 31,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "goalId",
              "versionId",
              "revision",
              "effectiveFrom",
              "effectiveTo",
              "reference",
              "targets",
            ],
            properties: {
              goalId: uuidSchema,
              versionId: uuidSchema,
              revision: positiveRevisionSchema,
              effectiveFrom: localDateSchema,
              effectiveTo: { anyOf: [localDateSchema, { type: "null" }] },
              reference: {
                anyOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "templateCode",
                      "templateVersion",
                      "groupCode",
                      "policyDigest",
                      "eligibleThroughExclusive",
                    ],
                    properties: {
                      templateCode: { type: "string", minLength: 1, maxLength: 100 },
                      templateVersion: { type: "string", minLength: 1, maxLength: 100 },
                      groupCode: { type: "string", minLength: 1, maxLength: 100 },
                      policyDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
                      eligibleThroughExclusive: localDateSchema,
                    },
                  },
                  { type: "null" },
                ],
              },
              targets: {
                type: "array",
                minItems: 1,
                maxItems: 15,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["nutrientId", "snapshot"],
                  properties: {
                    nutrientId: positiveIdentifierSchema,
                    snapshot: targetSnapshotSchema,
                  },
                },
              },
            },
          },
        },
        targetSegments: {
          type: "array",
          minItems: 1,
          maxItems: MAX_NUTRITION_REPORT_DAYS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["from", "to", "goalVersionId"],
            properties: {
              from: localDateSchema,
              to: localDateSchema,
              goalVersionId: { anyOf: [uuidSchema, { type: "null" }] },
            },
          },
        },
        series: {
          type: "array",
          minItems: 15,
          maxItems: 15,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["nutrient", "scalePolicy", "scaleMaximum", "summary", "points"],
            properties: {
              nutrient: nutrientDefinitionSchema,
              scalePolicy: { type: "string", const: "max-intake-or-saved-threshold-v1" },
              scaleMaximum: positiveAmountSchema,
              summary: {
                type: "object",
                additionalProperties: false,
                required: [
                  "diaryDays",
                  "completeDays",
                  "exactDays",
                  "partialDays",
                  "unknownDays",
                  "traceDays",
                  "missingDays",
                ],
                properties: summaryProperties,
              },
              points: {
                type: "array",
                minItems: 1,
                maxItems: MAX_NUTRITION_REPORT_DAYS,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "localDate",
                    "goalVersionId",
                    "aggregate",
                    "knownPercentOfScale",
                    "minimumPercentOfScale",
                    "targetPercentOfScale",
                    "maximumPercentOfScale",
                    "comparison",
                  ],
                  properties: {
                    localDate: localDateSchema,
                    goalVersionId: { anyOf: [uuidSchema, { type: "null" }] },
                    aggregate: {
                      anyOf: [diaryNutrientAggregateSchema, { type: "null" }],
                    },
                    knownPercentOfScale: nullablePercentageSchema,
                    minimumPercentOfScale: nullablePercentageSchema,
                    targetPercentOfScale: nullablePercentageSchema,
                    maximumPercentOfScale: nullablePercentageSchema,
                    comparison: { anyOf: [comparisonSchema, { type: "null" }] },
                  },
                },
              },
            },
          },
        },
        notice: { type: "string", const: NUTRITION_REPORT_NOTICE },
      },
    },
  },
} as const;

export const nutritionReportQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: { from: localDateSchema, to: localDateSchema },
} as const;
