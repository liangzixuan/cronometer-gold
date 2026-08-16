import type {
  DiaryEntryPortion,
  DiaryFoodSourceSnapshot,
  DiaryNutrientAggregate,
  DiaryPortion,
} from "./diary.js";
import {
  diaryEntryPortionSchema,
  diaryNutrientAggregateSchema,
  diaryPortionSchema,
} from "./diary.js";
import { foodSourceSummarySchema } from "./foods.js";

export const recipeStatuses = ["active", "archived"] as const;
export const recipeYieldSources = ["measured", "estimated"] as const;
export const recipeWarningCodes = [
  "ESTIMATED_YIELD",
  "PARTIAL_NUTRIENT_DATA",
  "RETENTION_FACTORS_DEFAULTED",
  "YIELD_ABOVE_INPUT_MASS",
  "YIELD_BELOW_HALF_INPUT_MASS",
] as const;

export type RecipeStatus = (typeof recipeStatuses)[number];
export type RecipeYieldSource = (typeof recipeYieldSources)[number];
export type RecipeWarningCode = (typeof recipeWarningCodes)[number];

export type RecipeIngredientRequest =
  | {
      readonly kind: "food";
      readonly foodVersionId: string;
      readonly portion: DiaryPortion;
      readonly position?: number;
      readonly note?: string | null;
    }
  | {
      readonly kind: "recipe";
      /** Exact immutable nested revision, never a mutable current recipe pointer. */
      readonly recipeVersionId: string;
      readonly grams: string;
      readonly position?: number;
      readonly note?: string | null;
    };

export interface RecipeDraftRequest {
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly ingredients: readonly RecipeIngredientRequest[];
  readonly finalYield: { readonly grams: string; readonly source: RecipeYieldSource };
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
}

export type ResolvedRecipeIngredient =
  | {
      readonly kind: "food";
      readonly position: number;
      readonly foodVersionId: string;
      readonly name: string;
      readonly brandName: string | null;
      readonly portion: DiaryEntryPortion;
      readonly resolvedGrams: string;
      readonly note: string | null;
      readonly source: DiaryFoodSourceSnapshot;
    }
  | {
      readonly kind: "recipe";
      readonly position: number;
      readonly recipeId: string;
      readonly recipeVersionId: string;
      readonly versionNumber: number;
      readonly name: string;
      readonly grams: string;
      readonly resolvedGrams: string;
      readonly note: string | null;
    };

export interface RecipeWarning {
  readonly code: RecipeWarningCode;
  readonly message: string;
  readonly nutrientIds: readonly string[];
}

export interface RecipeVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly ingredients: readonly ResolvedRecipeIngredient[];
  readonly finalYield: {
    readonly grams: string;
    readonly source: RecipeYieldSource;
    readonly ratioToInputMass: string;
  };
  readonly inputMassGrams: string;
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
  readonly nutrition: {
    readonly totals: readonly DiaryNutrientAggregate[];
    readonly per100Grams: readonly DiaryNutrientAggregate[];
    readonly perServing: readonly DiaryNutrientAggregate[] | null;
  };
  /** Deterministic, de-duplicated, transitive attribution for every ingredient source. */
  readonly sources: readonly DiaryFoodSourceSnapshot[];
  readonly retentionPolicy: {
    readonly code: "identity-retention-default";
    readonly version: "1";
    readonly assumption: string;
  };
  readonly calculationVersion: string;
  readonly warnings: readonly RecipeWarning[];
  readonly createdAt: string;
}

export interface Recipe {
  readonly id: string;
  readonly status: RecipeStatus;
  /** Strong root precondition; changes whenever currentVersion changes. */
  readonly revision: string;
  readonly currentVersion: RecipeVersion;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeSummary {
  readonly id: string;
  readonly status: RecipeStatus;
  readonly revision: string;
  readonly currentVersion: {
    readonly id: string;
    readonly versionNumber: number;
    readonly name: string;
    readonly description: string | null;
    readonly finalYield: { readonly grams: string; readonly source: RecipeYieldSource };
    readonly inputMassGrams: string;
    readonly servingCount: string | null;
    readonly servingLabel: string | null;
    readonly warnings: readonly RecipeWarning[];
    readonly createdAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeResponse {
  readonly data: { readonly recipe: Recipe };
}

export interface RecipeMutationResponse {
  readonly data: { readonly replayed: boolean; readonly recipe: Recipe };
}

export interface RecipeListResponse {
  readonly data: readonly RecipeSummary[];
  readonly page: { readonly nextCursor: string | null };
}

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
} as const;
const positiveIdentifierSchema = { type: "string", pattern: "^[1-9][0-9]{0,19}$" } as const;
const exactDecimalSchema = {
  type: "string",
  maxLength: 160,
  pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
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
const nullableText = (maximum: number) => ({
  anyOf: [{ type: "string", minLength: 1, maxLength: maximum }, { type: "null" }],
});
const timestampSchema = { type: "string", format: "date-time" } as const;

const recipeSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [...foodSourceSummarySchema.required, "releaseId"],
  properties: { ...foodSourceSummarySchema.properties, releaseId: uuidSchema },
} as const;

const foodIngredientRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "foodVersionId", "portion"],
  properties: {
    kind: { type: "string", const: "food" },
    foodVersionId: positiveIdentifierSchema,
    portion: diaryPortionSchema,
    position: { type: "integer", minimum: 0, maximum: 49 },
    note: nullableText(500),
  },
} as const;

const nestedIngredientRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "recipeVersionId", "grams"],
  properties: {
    kind: { type: "string", const: "recipe" },
    recipeVersionId: uuidSchema,
    grams: positiveInputDecimalSchema,
    position: { type: "integer", minimum: 0, maximum: 49 },
    note: nullableText(500),
  },
} as const;

export const recipeIngredientRequestSchema = {
  $id: "RecipeIngredientRequest",
  oneOf: [foodIngredientRequestSchema, nestedIngredientRequestSchema],
} as const;

export const recipeDraftRequestSchema = {
  $id: "RecipeDraftRequest",
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "description",
    "instructions",
    "ingredients",
    "finalYield",
    "servingCount",
    "servingLabel",
  ],
  not: {
    anyOf: [
      {
        type: "object",
        required: ["servingCount", "servingLabel"],
        properties: { servingCount: { type: "null" }, servingLabel: { type: "string" } },
      },
      {
        type: "object",
        required: ["servingCount", "servingLabel"],
        properties: { servingCount: { type: "string" }, servingLabel: { type: "null" } },
      },
    ],
  },
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: nullableText(2_000),
    instructions: nullableText(10_000),
    ingredients: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: recipeIngredientRequestSchema,
    },
    finalYield: {
      type: "object",
      additionalProperties: false,
      required: ["grams", "source"],
      properties: {
        grams: positiveInputDecimalSchema,
        source: { type: "string", enum: recipeYieldSources },
      },
    },
    servingCount: { anyOf: [positiveInputDecimalSchema, { type: "null" }] },
    servingLabel: nullableText(100),
  },
} as const;

const foodResolvedIngredientSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "position",
    "foodVersionId",
    "name",
    "brandName",
    "portion",
    "resolvedGrams",
    "note",
    "source",
  ],
  properties: {
    kind: { type: "string", const: "food" },
    position: { type: "integer", minimum: 0, maximum: 49 },
    foodVersionId: positiveIdentifierSchema,
    name: { type: "string", minLength: 1, maxLength: 500 },
    brandName: nullableText(300),
    portion: diaryEntryPortionSchema,
    resolvedGrams: positiveExactDecimalSchema,
    note: nullableText(500),
    source: recipeSourceSchema,
  },
} as const;

const nestedResolvedIngredientSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "position",
    "recipeId",
    "recipeVersionId",
    "versionNumber",
    "name",
    "grams",
    "resolvedGrams",
    "note",
  ],
  properties: {
    kind: { type: "string", const: "recipe" },
    position: { type: "integer", minimum: 0, maximum: 49 },
    recipeId: uuidSchema,
    recipeVersionId: uuidSchema,
    versionNumber: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    grams: positiveExactDecimalSchema,
    resolvedGrams: positiveExactDecimalSchema,
    note: nullableText(500),
  },
} as const;

export const resolvedRecipeIngredientSchema = {
  $id: "ResolvedRecipeIngredient",
  oneOf: [foodResolvedIngredientSchema, nestedResolvedIngredientSchema],
} as const;

export const recipeWarningSchema = {
  $id: "RecipeWarning",
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "nutrientIds"],
  properties: {
    code: { type: "string", enum: recipeWarningCodes },
    message: { type: "string", minLength: 1, maxLength: 500 },
    nutrientIds: { type: "array", maxItems: 256, items: positiveIdentifierSchema },
  },
} as const;

const recipeVersionSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "versionNumber",
    "name",
    "description",
    "finalYield",
    "inputMassGrams",
    "servingCount",
    "servingLabel",
    "warnings",
    "createdAt",
  ],
  not: {
    anyOf: [
      {
        type: "object",
        required: ["servingCount", "servingLabel"],
        properties: { servingCount: { type: "null" }, servingLabel: { type: "string" } },
      },
      {
        type: "object",
        required: ["servingCount", "servingLabel"],
        properties: { servingCount: { type: "string" }, servingLabel: { type: "null" } },
      },
    ],
  },
  properties: {
    id: uuidSchema,
    versionNumber: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: nullableText(2_000),
    finalYield: {
      type: "object",
      additionalProperties: false,
      required: ["grams", "source"],
      properties: {
        grams: positiveExactDecimalSchema,
        source: { type: "string", enum: recipeYieldSources },
      },
    },
    inputMassGrams: positiveExactDecimalSchema,
    servingCount: { anyOf: [positiveExactDecimalSchema, { type: "null" }] },
    servingLabel: nullableText(100),
    warnings: { type: "array", maxItems: 5, items: recipeWarningSchema },
    createdAt: timestampSchema,
  },
} as const;

export const recipeVersionSchema = {
  $id: "RecipeVersion",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "versionNumber",
    "name",
    "description",
    "instructions",
    "ingredients",
    "finalYield",
    "inputMassGrams",
    "servingCount",
    "servingLabel",
    "nutrition",
    "sources",
    "retentionPolicy",
    "calculationVersion",
    "warnings",
    "createdAt",
  ],
  not: {
    anyOf: [
      {
        type: "object",
        required: ["servingCount", "servingLabel"],
        properties: { servingCount: { type: "null" }, servingLabel: { type: "string" } },
      },
      {
        type: "object",
        required: ["servingCount", "servingLabel"],
        properties: { servingCount: { type: "string" }, servingLabel: { type: "null" } },
      },
      {
        type: "object",
        required: ["servingCount", "nutrition"],
        properties: {
          servingCount: { type: "null" },
          nutrition: {
            type: "object",
            required: ["perServing"],
            properties: { perServing: { type: "array" } },
          },
        },
      },
      {
        type: "object",
        required: ["servingCount", "nutrition"],
        properties: {
          servingCount: { type: "string" },
          nutrition: {
            type: "object",
            required: ["perServing"],
            properties: { perServing: { type: "null" } },
          },
        },
      },
    ],
  },
  properties: {
    ...recipeVersionSummarySchema.properties,
    instructions: nullableText(10_000),
    ingredients: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: resolvedRecipeIngredientSchema,
    },
    finalYield: {
      type: "object",
      additionalProperties: false,
      required: ["grams", "source", "ratioToInputMass"],
      properties: {
        grams: positiveExactDecimalSchema,
        source: { type: "string", enum: recipeYieldSources },
        ratioToInputMass: positiveExactDecimalSchema,
      },
    },
    nutrition: {
      type: "object",
      additionalProperties: false,
      required: ["totals", "per100Grams", "perServing"],
      properties: {
        totals: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: diaryNutrientAggregateSchema,
        },
        per100Grams: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: diaryNutrientAggregateSchema,
        },
        perServing: {
          anyOf: [
            {
              type: "array",
              minItems: 1,
              maxItems: 256,
              items: diaryNutrientAggregateSchema,
            },
            { type: "null" },
          ],
        },
      },
    },
    sources: { type: "array", minItems: 1, maxItems: 256, items: recipeSourceSchema },
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
    calculationVersion: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

export const recipeSchema = {
  $id: "Recipe",
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "revision", "currentVersion", "createdAt", "updatedAt"],
  properties: {
    id: uuidSchema,
    status: { type: "string", enum: recipeStatuses },
    revision: { type: "string", pattern: "^[1-9][0-9]*$" },
    currentVersion: recipeVersionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
} as const;

export const recipeSummarySchema = {
  $id: "RecipeSummary",
  type: "object",
  additionalProperties: false,
  required: ["id", "status", "revision", "currentVersion", "createdAt", "updatedAt"],
  properties: {
    ...recipeSchema.properties,
    currentVersion: recipeVersionSummarySchema,
  },
} as const;

export const recipeResponseSchema = {
  $id: "RecipeResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["recipe"],
      properties: { recipe: recipeSchema },
    },
  },
} as const;

export const recipeMutationResponseSchema = {
  $id: "RecipeMutationResponse",
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["replayed", "recipe"],
      properties: { replayed: { type: "boolean" }, recipe: recipeSchema },
    },
  },
} as const;

export const recipeListResponseSchema = {
  $id: "RecipeListResponse",
  type: "object",
  additionalProperties: false,
  required: ["data", "page"],
  properties: {
    data: { type: "array", maxItems: 50, items: recipeSummarySchema },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["nextCursor"],
      properties: {
        nextCursor: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 512 }, { type: "null" }],
        },
      },
    },
  },
} as const;

export const recipeListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  },
} as const;

export const recipeParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["recipeId"],
  properties: { recipeId: uuidSchema },
} as const;

// Exported for schema composition in the diary recipe-entry union.
export const recipeUuidSchema = uuidSchema;
export const recipePositiveExactDecimalSchema = positiveExactDecimalSchema;
export const recipeExactDecimalSchema = exactDecimalSchema;
export const recipeSourceSnapshotSchema = recipeSourceSchema;
