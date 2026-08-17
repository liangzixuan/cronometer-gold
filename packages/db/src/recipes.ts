import { randomUUID } from "node:crypto";

import {
  calculatePortionNutrition,
  calculateRecipeNutrition,
  canonicalNonNegativeDecimal,
  canonicalPositiveDecimal,
  createNutrientProfile,
  createResolvedNutrientProfile,
  DomainError,
  decimal,
  defineNutrient,
  knownNutrient,
  NUTRIENT_UNITS,
  NUTRITION_ENGINE_VERSION,
  type NutrientAggregate,
  type NutrientDefinition,
  type NutrientUnit,
  nutrientDatum,
  resolvePortionToGrams,
  traceNutrient,
  unknownNutrient,
} from "@nutrition-tracker/domain";
import { type Kysely, sql, type Transaction } from "kysely";

import type { DiaryNutrientAggregateRecord, DiaryPortionInput } from "./diary.js";
import type { Database, JsonArray, JsonObject } from "./types.js";

const MAX_INGREDIENTS = 50;
const MAX_NUTRIENTS = 256;
const MAX_SOURCES = 256;
const MAX_NESTED_DEPTH = 10;
const MAX_NESTED_CLOSURE = 500;
const RETENTION_POLICY_CODE = "identity-retention-default";
const RETENTION_POLICY_VERSION = "1";

export type RecipePersistenceErrorCode =
  | "RECIPE_IDEMPOTENCY_CONFLICT"
  | "RECIPE_NOT_FOUND"
  | "RECIPE_REVISION_CONFLICT"
  | "RECIPE_VALIDATION";

export class RecipePersistenceError extends Error {
  override readonly name: string = "RecipePersistenceError";
  constructor(
    readonly code: RecipePersistenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class RecipeNotFoundError extends RecipePersistenceError {
  constructor() {
    super("RECIPE_NOT_FOUND", "Recipe not found");
  }
}

export class RecipeRevisionConflictError extends RecipePersistenceError {
  constructor() {
    super("RECIPE_REVISION_CONFLICT", "Recipe revision does not match");
  }
}

export class RecipeIdempotencyConflictError extends RecipePersistenceError {
  constructor() {
    super("RECIPE_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
  }
}

export class RecipeValidationError extends RecipePersistenceError {
  constructor(message: string) {
    super("RECIPE_VALIDATION", message);
  }
}

export class RecipeCursorError extends RecipeValidationError {
  override readonly name = "RecipeCursorError";
  constructor() {
    super("Recipe cursor is invalid");
  }
}

export interface RecipeYieldInput {
  readonly grams: string;
  readonly source: "estimated" | "measured";
}

export type RecipeIngredientInput =
  | {
      readonly kind: "food";
      readonly foodVersionId: string;
      readonly portion: DiaryPortionInput;
      readonly position?: number;
      readonly note?: string | null;
    }
  | {
      readonly kind: "recipe";
      readonly recipeVersionId: string;
      readonly grams: string;
      readonly position?: number;
      readonly note?: string | null;
    };

export interface RecipeDraft {
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly ingredients: readonly RecipeIngredientInput[];
  readonly yield: RecipeYieldInput;
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
}

export interface RecipeSourceRecord {
  readonly foodSourceId: string;
  readonly releaseId: string;
  readonly code: string;
  readonly displayName: string;
  readonly licenseExpression: string;
  readonly attributionRequired: boolean;
  readonly attributionText: string;
}

export type RecipeIngredientRecord =
  | {
      readonly kind: "food";
      readonly position: number;
      readonly note: string | null;
      readonly food: {
        readonly foodVersionId: string;
        readonly name: string;
        readonly brandName: string | null;
      };
      readonly portion: {
        readonly amount: string;
        readonly inputUnit: "g" | "serving";
        readonly servingId: string | null;
        readonly servingLabel: string | null;
        readonly resolvedGrams: string;
      };
      readonly foodProvenance:
        | { readonly kind: "public"; readonly source: RecipeSourceRecord }
        | {
            readonly kind: "private_custom";
            readonly customFoodId: string;
            readonly customFoodVersionNumber: string;
          };
      readonly source: RecipeSourceRecord | null;
    }
  | {
      readonly kind: "recipe";
      readonly position: number;
      readonly note: string | null;
      readonly recipe: {
        readonly recipeId: string;
        readonly recipeVersionId: string;
        readonly versionNumber: string;
        readonly name: string;
        readonly yieldGrams: string;
        readonly servingCount: string | null;
        readonly servingLabel: string | null;
      };
      readonly grams: string;
    };

export interface RecipeWarningRecord {
  readonly code: string;
  readonly message: string;
  readonly nutrientIds: readonly string[];
}

export interface RecipeVersionRecord {
  readonly id: string;
  readonly versionNumber: string;
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly inputMassGrams: string;
  readonly yield: RecipeYieldInput & { readonly ratioToInputMass: string };
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
  readonly calculationVersion: string;
  readonly retentionPolicy: { readonly code: string; readonly version: string };
  readonly calculationAssumptions: JsonObject;
  readonly warnings: readonly RecipeWarningRecord[];
  readonly ingredients: readonly RecipeIngredientRecord[];
  readonly nutrients: readonly DiaryNutrientAggregateRecord[];
  readonly sources: readonly RecipeSourceRecord[];
  readonly createdAt: string;
}

export interface RecipeRecord {
  readonly id: string;
  readonly status: "active" | "archived";
  readonly currentRevision: string;
  readonly currentVersion: RecipeVersionRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeMutationResult {
  readonly replayed: boolean;
  readonly recipe: RecipeRecord;
}

export interface CreateRecipeInput {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly recipe: RecipeDraft;
}

export interface ReviseRecipeInput extends CreateRecipeInput {
  readonly recipeId: string;
  readonly expectedRevision: bigint | number | string;
}

export interface RecipeListRecord {
  readonly items: readonly RecipeRecord[];
  readonly nextCursor: string | null;
}

interface SourceIdentity {
  readonly foodSourceId: string;
  readonly releaseId: string;
}

type FoodDiscovery =
  | (SourceIdentity & {
      readonly kind: "public";
      readonly foodId: string;
      readonly foodVersionId: string;
    })
  | {
      readonly kind: "private_custom";
      readonly foodId: string;
      readonly foodVersionId: string;
      readonly customFoodId: string;
      readonly customFoodVersionNumber: string;
    };

interface MaterializedRecipe {
  readonly draft: RecipeDraft;
  readonly ingredients: readonly MaterializedIngredient[];
  readonly inputMassGrams: string;
  readonly nutrients: readonly DiaryNutrientAggregateRecord[];
  readonly sources: readonly RecipeSourceRecord[];
  readonly assumptions: JsonObject;
  readonly warnings: readonly RecipeWarningRecord[];
}

type MaterializedIngredient = RecipeIngredientRecord & {
  readonly nutrientProfile: ReturnType<typeof createResolvedNutrientProfile>;
};

export async function createRecipe(
  database: Kysely<Database>,
  input: CreateRecipeInput,
): Promise<RecipeMutationResult> {
  validateOperation(input.clientOperationId, input.requestDigest);
  validateDraft(input.recipe);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockRecipeUser(transaction, input.userId);
      await requireWritableRecipeUser(transaction, input.userId);
      const replay = await readRecipeReplay(transaction, input, "create");
      if (replay) return replay;
      const recipeId = randomUUID();
      const versionId = randomUUID();
      const materialized = await materializeRecipe(
        transaction,
        input.userId,
        recipeId,
        input.recipe,
      );
      await transaction
        .insertInto("recipe")
        .values({ current_version_id: null, id: recipeId, owner_user_id: input.userId })
        .execute();
      await insertRecipeVersion(transaction, {
        materialized,
        ownerUserId: input.userId,
        recipeId,
        versionId,
        versionNumber: 1,
      });
      await transaction
        .updateTable("recipe")
        .set({ current_version_id: versionId, status: "active" })
        .where("id", "=", recipeId)
        .where("owner_user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const recipe = await loadOwnedRecipe(transaction, input.userId, recipeId);
      const result = { recipe, replayed: false } satisfies RecipeMutationResult;
      await recordRecipeOperation(transaction, input, "create", recipeId, result);
      return result;
    });
}

export async function reviseRecipe(
  database: Kysely<Database>,
  input: ReviseRecipeInput,
): Promise<RecipeMutationResult> {
  validateOperation(input.clientOperationId, input.requestDigest);
  validateDraft(input.recipe);
  const expectedRevision = positiveRevision(input.expectedRevision);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockRecipeUser(transaction, input.userId);
      await requireWritableRecipeUser(transaction, input.userId);
      const replay = await readRecipeReplay(transaction, input, "revise", input.recipeId);
      if (replay) return replay;
      const discovered = await transaction
        .selectFrom("recipe as root")
        .innerJoin("recipe_version as version", "version.id", "root.current_version_id")
        .select(["root.id", "root.status", "version.version_number"])
        .where("root.id", "=", input.recipeId)
        .where("root.owner_user_id", "=", input.userId)
        .executeTakeFirst();
      if (discovered?.status !== "active") throw new RecipeNotFoundError();
      if (String(discovered.version_number) !== expectedRevision) {
        throw new RecipeRevisionConflictError();
      }
      const materialized = await materializeRecipe(
        transaction,
        input.userId,
        input.recipeId,
        input.recipe,
      );
      const locked = await transaction
        .selectFrom("recipe as root")
        .innerJoin("recipe_version as version", "version.id", "root.current_version_id")
        .select(["root.status", "version.version_number"])
        .where("root.id", "=", input.recipeId)
        .where("root.owner_user_id", "=", input.userId)
        .forUpdate("root")
        .executeTakeFirst();
      if (locked?.status !== "active") throw new RecipeNotFoundError();
      if (String(locked.version_number) !== expectedRevision) {
        throw new RecipeRevisionConflictError();
      }
      const versionId = randomUUID();
      const nextVersion = Number(expectedRevision) + 1;
      if (!Number.isSafeInteger(nextVersion) || nextVersion > 2_147_483_647) {
        throw new RecipeValidationError("Recipe revision is out of range");
      }
      await insertRecipeVersion(transaction, {
        materialized,
        ownerUserId: input.userId,
        recipeId: input.recipeId,
        versionId,
        versionNumber: nextVersion,
      });
      await transaction
        .updateTable("recipe")
        .set({ current_version_id: versionId, status: "active" })
        .where("id", "=", input.recipeId)
        .where("owner_user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const recipe = await loadOwnedRecipe(transaction, input.userId, input.recipeId);
      const result = { recipe, replayed: false } satisfies RecipeMutationResult;
      await recordRecipeOperation(transaction, input, "revise", input.recipeId, result);
      return result;
    });
}

export async function getRecipe(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly recipeId: string },
): Promise<RecipeRecord> {
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireReadableRecipeUser(transaction, input.userId);
      return loadOwnedRecipe(transaction, input.userId, input.recipeId);
    });
}

export async function listRecipes(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly limit: number; readonly cursor?: string },
): Promise<RecipeListRecord> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new RecipeValidationError("Recipe list limit must be between 1 and 50");
  }
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireReadableRecipeUser(transaction, input.userId);
      let query = transaction
        .selectFrom("recipe")
        .select([
          "id",
          sql<string>`to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            "cursor_updated_at",
          ),
        ])
        .where("owner_user_id", "=", input.userId)
        .where("status", "=", "active");
      if (cursor) {
        query = query.where((expression) =>
          expression.or([
            expression("updated_at", "<", sql<Date>`${cursor.updatedAt}::timestamptz`),
            expression.and([
              expression("updated_at", "=", sql<Date>`${cursor.updatedAt}::timestamptz`),
              expression("id", "<", cursor.id),
            ]),
          ]),
        );
      }
      const rows = await query
        .orderBy("updated_at", "desc")
        .orderBy("id", "desc")
        .limit(input.limit + 1)
        .execute();
      const page = rows.slice(0, input.limit);
      const items = await Promise.all(
        page.map((row) => loadOwnedRecipe(transaction, input.userId, row.id)),
      );
      const last = rows.length > input.limit ? page.at(-1) : null;
      return {
        items,
        nextCursor: last ? encodeCursor(last.cursor_updated_at, last.id) : null,
      };
    });
}

export interface RecipeDiaryPortionInput {
  readonly kind: "grams" | "serving";
  readonly grams?: string;
  readonly amount?: string;
}

export interface RecipeDiaryFacts {
  readonly recipeId: string;
  readonly recipeVersionId: string;
  readonly recipeName: string;
  readonly recipeVersionNumber: number;
  readonly yieldGrams: string;
  readonly yieldSource: "estimated" | "measured";
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
  readonly enteredAmount: string;
  readonly inputUnit: "g" | "serving";
  readonly resolvedGrams: string;
  readonly calculationVersion: string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: string;
  readonly calculationAssumptions: JsonObject;
  readonly warnings: readonly RecipeWarningRecord[];
  readonly nutrients: readonly DiaryNutrientAggregateRecord[];
  readonly sources: readonly RecipeSourceRecord[];
}

/** Internal diary materialization port; callers already hold the diary/user lock. */
export async function loadRecipeDiaryFacts(
  transaction: Transaction<Database>,
  input: {
    readonly userId: string;
    readonly recipeId: string;
    readonly recipeVersionId: string;
    readonly portion:
      | { readonly kind: "grams"; readonly grams: string }
      | {
          readonly kind: "serving";
          readonly amount: string;
        };
    readonly requireCurrent: boolean;
  },
): Promise<RecipeDiaryFacts> {
  const discovered = await transaction
    .selectFrom("recipe_version")
    .select("id")
    .where("id", "=", input.recipeVersionId)
    .where("recipe_id", "=", input.recipeId)
    .where("owner_user_id", "=", input.userId)
    .executeTakeFirst();
  if (!discovered) throw new RecipeNotFoundError();
  const sourceRows = await transaction
    .selectFrom("recipe_version_source")
    .select(["food_source_id", "source_release_id"])
    .where("recipe_version_id", "=", input.recipeVersionId)
    .execute();
  if (sourceRows.length > MAX_SOURCES) {
    throw new RecipeValidationError("Recipe source set is invalid");
  }
  await lockEligibleSources(
    transaction,
    sourceRows.map((row) => ({
      foodSourceId: row.food_source_id,
      releaseId: row.source_release_id,
    })),
  );
  const root = await transaction
    .selectFrom("recipe")
    .select(["id", "current_version_id", "status"])
    .where("id", "=", input.recipeId)
    .where("owner_user_id", "=", input.userId)
    .forShare()
    .executeTakeFirst();
  if (
    root?.status !== "active" ||
    (input.requireCurrent && root.current_version_id !== input.recipeVersionId)
  ) {
    throw new RecipeNotFoundError();
  }
  await sql`lock table nutrient in share mode`.execute(transaction);
  const definitions = await loadDefinitions(transaction);
  const version = await loadRecipeVersionRow(transaction, input.userId, input.recipeVersionId);
  if (version.recipe_id !== input.recipeId) throw new RecipeNotFoundError();
  const stored = await loadRecipeNutrients(transaction, input.recipeVersionId);
  const resolvedGrams =
    input.portion.kind === "grams"
      ? inputDecimal(input.portion.grams, "recipe grams")
      : resolveRecipeServingGrams(version, input.portion.amount);
  const enteredAmount =
    input.portion.kind === "grams"
      ? inputDecimal(input.portion.grams, "recipe grams")
      : inputDecimal(input.portion.amount, "recipe serving amount");
  const profile = createResolvedNutrientProfile(
    canonicalPositive(version.total_weight_grams, "recipe yield grams"),
    stored.map(toDomainAggregate),
  );
  const calculated = calculatePortionNutrition(profile, resolvedGrams, definitions.list);
  const nutrients = mapAggregates(calculated, definitions);
  const sources = await loadRecipeSources(transaction, input.recipeVersionId);
  return {
    calculationAssumptions: version.calculation_assumptions,
    calculationVersion: version.calculation_version,
    enteredAmount,
    inputUnit: input.portion.kind === "grams" ? "g" : "serving",
    nutrients,
    recipeId: version.recipe_id,
    recipeName: version.name,
    recipeVersionId: version.id,
    recipeVersionNumber: version.version_number,
    resolvedGrams,
    retentionPolicyCode: version.retention_policy_code,
    retentionPolicyVersion: version.retention_policy_version,
    servingCount: nullablePositive(version.serving_count, "recipe serving count"),
    servingLabel: version.serving_label,
    sources,
    warnings: parseWarnings(version.warnings),
    yieldGrams: canonicalPositive(version.total_weight_grams, "recipe yield grams"),
    yieldSource: version.final_yield_source,
  };
}

async function materializeRecipe(
  transaction: Transaction<Database>,
  userId: string,
  rootRecipeId: string,
  draft: RecipeDraft,
): Promise<MaterializedRecipe> {
  const foodIds = draft.ingredients
    .filter(
      (ingredient): ingredient is Extract<RecipeIngredientInput, { kind: "food" }> =>
        ingredient.kind === "food",
    )
    .map((ingredient) => ingredient.foodVersionId);
  const nestedIds = draft.ingredients
    .filter(
      (ingredient): ingredient is Extract<RecipeIngredientInput, { kind: "recipe" }> =>
        ingredient.kind === "recipe",
    )
    .map((ingredient) => ingredient.recipeVersionId);
  const foodDiscovery = await discoverFoods(transaction, userId, foodIds);
  const nestedClosure = await inspectNestedClosure(transaction, userId, rootRecipeId, nestedIds);
  const nestedSources =
    nestedClosure.versionIds.length === 0
      ? []
      : await transaction
          .selectFrom("recipe_version_source")
          .select(["food_source_id", "source_release_id"])
          .where("recipe_version_id", "in", nestedClosure.versionIds)
          .execute();
  const identities = dedupeIdentities([
    ...foodDiscovery.flatMap((food) =>
      food.kind === "public"
        ? [{ foodSourceId: food.foodSourceId, releaseId: food.releaseId }]
        : [],
    ),
    ...nestedSources.map((row) => ({
      foodSourceId: row.food_source_id,
      releaseId: row.source_release_id,
    })),
  ]);
  const sources = await lockEligibleSources(transaction, identities, () =>
    lockDiscoveredFoods(transaction, foodDiscovery),
  );
  if (nestedClosure.recipeIds.length > 0) {
    const roots = await transaction
      .selectFrom("recipe")
      .select("id")
      .where("owner_user_id", "=", userId)
      .where("id", "in", nestedClosure.recipeIds)
      .orderBy("id")
      .forShare()
      .execute();
    if (roots.length !== nestedClosure.recipeIds.length) throw new RecipeNotFoundError();
  }
  await sql`lock table nutrient in share mode`.execute(transaction);
  const definitions = await loadDefinitions(transaction);
  const sourceByIdentity = new Map(
    sources.map((source) => [`${source.foodSourceId}:${source.releaseId}`, source]),
  );
  const discoveryByVersion = new Map(foodDiscovery.map((food) => [food.foodVersionId, food]));
  const ingredients: MaterializedIngredient[] = [];
  for (const [index, ingredient] of draft.ingredients.entries()) {
    const position = ingredientPosition(ingredient.position ?? index);
    if (ingredient.kind === "food") {
      const discovery = discoveryByVersion.get(ingredient.foodVersionId);
      if (!discovery) throw new RecipeValidationError("Food ingredient is unavailable");
      ingredients.push(
        await materializeFoodIngredient(
          transaction,
          ingredient,
          position,
          definitions,
          discovery,
          discovery.kind === "public"
            ? sourceByIdentity.get(`${discovery.foodSourceId}:${discovery.releaseId}`)
            : undefined,
        ),
      );
    } else {
      ingredients.push(
        await materializeNestedIngredient(transaction, userId, ingredient, position),
      );
    }
  }
  let calculated: ReturnType<typeof calculateRecipeNutrition>;
  try {
    calculated = calculateRecipeNutrition({
      finalYield: draft.yield,
      ingredients: ingredients.map((ingredient, index) => ({
        grams: ingredient.kind === "food" ? ingredient.portion.resolvedGrams : ingredient.grams,
        id: String(index),
        name: ingredient.kind === "food" ? ingredient.food.name : ingredient.recipe.name,
        nutrientProfile: ingredient.nutrientProfile,
      })),
      nutrients: definitions.list,
      servingCount: draft.servingCount,
    });
  } catch (error) {
    if (error instanceof DomainError) throw new RecipeValidationError(error.message);
    throw error;
  }
  const nutrients = mapAggregates(calculated.totals, definitions);
  const nutrientIdByCode = new Map(definitions.rows.map((row) => [row.code, row.id]));
  const warnings = calculated.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    nutrientIds: warning.nutrientIds.map((code) => {
      const id = nutrientIdByCode.get(code);
      if (!id) throw new RecipeValidationError("Recipe warning nutrient mapping is incomplete");
      return id;
    }),
  }));
  return {
    assumptions: {
      retentionPolicy: {
        assumption: "No cooking-retention dataset was applied; omitted factors remain exactly one.",
        code: RETENTION_POLICY_CODE,
        defaultFactor: "1",
        ingredientOverrides: [],
        version: RETENTION_POLICY_VERSION,
      },
    },
    draft,
    ingredients,
    inputMassGrams: calculated.inputMassGrams,
    nutrients,
    sources,
    warnings,
  };
}

async function insertRecipeVersion(
  transaction: Transaction<Database>,
  input: {
    readonly materialized: MaterializedRecipe;
    readonly ownerUserId: string;
    readonly recipeId: string;
    readonly versionId: string;
    readonly versionNumber: number;
  },
): Promise<void> {
  const { draft } = input.materialized;
  await transaction
    .insertInto("recipe_version")
    .values({
      calculation_assumptions: input.materialized.assumptions,
      calculation_version: NUTRITION_ENGINE_VERSION,
      created_by_user_id: input.ownerUserId,
      description: draft.description,
      final_yield_source: draft.yield.source,
      id: input.versionId,
      input_mass_grams: input.materialized.inputMassGrams,
      ingredient_count: input.materialized.ingredients.length,
      instructions: draft.instructions,
      metadata: {},
      name: draft.name,
      nutrient_component_count: input.materialized.nutrients.length,
      owner_user_id: input.ownerUserId,
      recipe_id: input.recipeId,
      recipe_status: "active",
      retention_policy_code: RETENTION_POLICY_CODE,
      retention_policy_version: RETENTION_POLICY_VERSION,
      serving_count: draft.servingCount,
      serving_label: draft.servingLabel,
      source_component_count: input.materialized.sources.length,
      total_weight_grams: draft.yield.grams,
      total_yield_quantity: draft.yield.grams,
      total_yield_unit: "g",
      version_number: input.versionNumber,
      warnings: sql<JsonArray>`${JSON.stringify(input.materialized.warnings)}::jsonb`,
    })
    .execute();
  await transaction
    .insertInto("recipe_ingredient")
    .values(
      input.materialized.ingredients.map((ingredient) =>
        ingredient.kind === "food"
          ? {
              attribution_required: ingredient.source?.attributionRequired ?? null,
              attribution_text: ingredient.source?.attributionText ?? null,
              brand_name: ingredient.food.brandName,
              custom_food_id:
                ingredient.foodProvenance.kind === "private_custom"
                  ? ingredient.foodProvenance.customFoodId
                  : null,
              custom_food_version_number:
                ingredient.foodProvenance.kind === "private_custom"
                  ? Number(ingredient.foodProvenance.customFoodVersionNumber)
                  : null,
              food_name: ingredient.food.name,
              food_serving_id: ingredient.portion.servingId,
              food_version_id: ingredient.food.foodVersionId,
              ingredient_kind: "food" as const,
              input_unit: ingredient.portion.inputUnit,
              license_expression: ingredient.source?.licenseExpression ?? null,
              nested_recipe_id: null,
              nested_recipe_name: null,
              nested_recipe_version_number: null,
              nested_recipe_serving_count: null,
              nested_recipe_serving_label: null,
              nested_recipe_version_id: null,
              nested_recipe_yield_grams: null,
              note: ingredient.note,
              position: ingredient.position,
              quantity: ingredient.portion.amount,
              recipe_version_id: input.versionId,
              resolved_grams: ingredient.portion.resolvedGrams,
              retention_factor_set: null,
              serving_label: ingredient.portion.servingLabel,
              source_code: ingredient.source?.code ?? null,
              source_display_name: ingredient.source?.displayName ?? null,
              source_id: ingredient.source?.foodSourceId ?? null,
              source_release_id: ingredient.source?.releaseId ?? null,
              yield_factor: "1",
            }
          : {
              attribution_required: null,
              attribution_text: null,
              brand_name: null,
              custom_food_id: null,
              custom_food_version_number: null,
              food_name: null,
              food_serving_id: null,
              food_version_id: null,
              ingredient_kind: "recipe" as const,
              input_unit: "g",
              license_expression: null,
              nested_recipe_id: ingredient.recipe.recipeId,
              nested_recipe_name: ingredient.recipe.name,
              nested_recipe_version_number: Number(ingredient.recipe.versionNumber),
              nested_recipe_serving_count: ingredient.recipe.servingCount,
              nested_recipe_serving_label: ingredient.recipe.servingLabel,
              nested_recipe_version_id: ingredient.recipe.recipeVersionId,
              nested_recipe_yield_grams: ingredient.recipe.yieldGrams,
              note: ingredient.note,
              position: ingredient.position,
              quantity: ingredient.grams,
              recipe_version_id: input.versionId,
              resolved_grams: ingredient.grams,
              retention_factor_set: null,
              serving_label: null,
              source_code: null,
              source_display_name: null,
              source_id: null,
              source_release_id: null,
              yield_factor: "1",
            },
      ),
    )
    .execute();
  await transaction
    .insertInto("recipe_version_nutrient")
    .values(
      input.materialized.nutrients.map((nutrient) => ({
        calculation_version: NUTRITION_ENGINE_VERSION,
        completeness: nutrient.completeness,
        contributor_count: nutrient.contributorCount,
        is_exact: nutrient.isExact,
        known_amount: nutrient.knownAmount,
        nutrient_code: nutrient.code,
        nutrient_id: nutrient.nutrientId,
        nutrient_name: nutrient.name,
        quantified_count: nutrient.quantifiedCount,
        recipe_version_id: input.versionId,
        trace_count: nutrient.traceCount,
        unit: nutrient.unit,
        unknown_count: nutrient.unknownCount,
        unknown_reasons: nutrient.unknownReasons,
      })),
    )
    .execute();
  if (input.materialized.sources.length)
    await transaction
      .insertInto("recipe_version_source")
      .values(
        input.materialized.sources.map((source) => ({
          attribution_required: source.attributionRequired,
          attribution_text: source.attributionText,
          food_source_id: source.foodSourceId,
          license_expression: source.licenseExpression,
          recipe_version_id: input.versionId,
          source_code: source.code,
          source_display_name: source.displayName,
          source_release_id: source.releaseId,
        })),
      )
      .execute();
}

async function discoverFoods(
  transaction: Transaction<Database>,
  userId: string,
  versionIds: readonly string[],
): Promise<readonly FoodDiscovery[]> {
  const unique = [...new Set(versionIds)].sort();
  if (unique.length === 0) return [];
  const rows = await transaction
    .selectFrom("food_version as version")
    .innerJoin("food", "food.id", "version.food_id")
    .leftJoin(
      "custom_food_version as custom_version",
      "custom_version.food_version_id",
      "version.id",
    )
    .leftJoin("custom_food", "custom_food.id", "custom_version.custom_food_id")
    .select([
      "version.id",
      "version.food_id",
      "version.source_release_id",
      "food.food_source_id",
      "food.owner_user_id",
      "food.visibility",
      "custom_food.id as custom_food_id",
      "custom_food.status as custom_food_status",
      "custom_version.version_number as custom_food_version_number",
    ])
    .where("version.id", "in", unique)
    .execute();
  if (rows.length !== unique.length) {
    throw new RecipeValidationError("Food ingredient is unavailable");
  }
  return rows.map((row): FoodDiscovery => {
    if (row.food_source_id && row.source_release_id)
      return {
        foodId: row.food_id,
        foodSourceId: row.food_source_id,
        foodVersionId: row.id,
        kind: "public",
        releaseId: row.source_release_id,
      };
    if (
      row.owner_user_id === userId &&
      row.visibility === "private" &&
      row.custom_food_id &&
      row.custom_food_status === "active" &&
      row.custom_food_version_number
    )
      return {
        customFoodId: row.custom_food_id,
        customFoodVersionNumber: row.custom_food_version_number,
        foodId: row.food_id,
        foodVersionId: row.id,
        kind: "private_custom",
      };
    throw new RecipeValidationError("Food ingredient is unavailable");
  });
}

async function lockDiscoveredFoods(
  transaction: Transaction<Database>,
  foods: readonly FoodDiscovery[],
): Promise<void> {
  const foodIds = [...new Set(foods.map((food) => food.foodId))].sort(compareNumericText);
  if (foodIds.length > 0) {
    const lockedFoods = await transaction
      .selectFrom("food")
      .select("id")
      .where("id", "in", foodIds)
      .orderBy("id")
      .forShare()
      .execute();
    if (lockedFoods.length !== foodIds.length) throw new RecipeValidationError("Food unavailable");
  }
  const versionIds = [...new Set(foods.map((food) => food.foodVersionId))].sort(compareNumericText);
  if (versionIds.length > 0) {
    const lockedVersions = await transaction
      .selectFrom("food_version")
      .select("id")
      .where("id", "in", versionIds)
      .orderBy("id")
      .forShare()
      .execute();
    if (lockedVersions.length !== versionIds.length) {
      throw new RecipeValidationError("Food unavailable");
    }
  }
  const eligible =
    foods.filter((food) => food.kind === "public").length === 0
      ? []
      : await transaction
          .selectFrom("promoted_food_search_catalogue_v1")
          .select("food_version_id")
          .where(
            "food_version_id",
            "in",
            foods.flatMap((food) => (food.kind === "public" ? [food.foodVersionId] : [])),
          )
          .execute();
  if (eligible.length !== foods.filter((food) => food.kind === "public").length) {
    throw new RecipeValidationError("Food ingredient is no longer eligible");
  }
  const customIds = foods.flatMap((food) =>
    food.kind === "private_custom" ? [food.customFoodId] : [],
  );
  if (customIds.length) {
    const custom = await transaction
      .selectFrom("custom_food")
      .select("id")
      .where("id", "in", [...new Set(customIds)].sort())
      .where("status", "=", "active")
      .orderBy("id")
      .forShare()
      .execute();
    if (custom.length !== new Set(customIds).size)
      throw new RecipeValidationError("Custom food ingredient is no longer eligible");
  }
}

async function lockEligibleSources(
  transaction: Transaction<Database>,
  identities: readonly SourceIdentity[],
  afterSourcesLocked?: () => Promise<void>,
): Promise<readonly RecipeSourceRecord[]> {
  const deduped = dedupeIdentities(identities);
  if (deduped.length > MAX_SOURCES) {
    throw new RecipeValidationError("Recipe source set is invalid");
  }
  if (deduped.length === 0) {
    await afterSourcesLocked?.();
    return [];
  }
  const sourceIds = [...new Set(deduped.map((source) => source.foodSourceId))].sort(
    compareNumericText,
  );
  const rows = await transaction
    .selectFrom("food_source")
    .select([
      "id",
      "active",
      "code",
      "display_name",
      "license_expression",
      "attribution_required",
      "attribution_text",
      "commercial_use_allowed",
      "redistribution_allowed",
      "rights_review_status",
      "rights_reviewed_at",
      "rights_reviewed_by",
    ])
    .where("id", "in", sourceIds)
    .orderBy("id")
    .forShare()
    .execute();
  if (rows.length !== sourceIds.length)
    throw new RecipeValidationError("Recipe source unavailable");
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const identity of deduped) {
    const row = byId.get(identity.foodSourceId);
    if (
      !row?.active ||
      row.commercial_use_allowed !== true ||
      row.redistribution_allowed !== true ||
      !(row.rights_review_status === "approved" || row.rights_review_status === "restricted") ||
      !row.rights_reviewed_at ||
      !row.rights_reviewed_by
    ) {
      throw new RecipeValidationError("Recipe source is no longer eligible");
    }
  }
  await afterSourcesLocked?.();
  const releaseIds = [...new Set(deduped.map((source) => source.releaseId))].sort();
  const releases = await transaction
    .selectFrom("food_source_release")
    .select(["id", "food_source_id", "status", "promoted_at", "rights_manifest_sha256"])
    .where("id", "in", releaseIds)
    .orderBy("id")
    .forShare()
    .execute();
  if (releases.length !== releaseIds.length)
    throw new RecipeValidationError("Recipe source unavailable");
  const releaseById = new Map(releases.map((release) => [release.id, release]));
  for (const identity of deduped) {
    const release = releaseById.get(identity.releaseId);
    if (
      !release ||
      release.food_source_id !== identity.foodSourceId ||
      release.status !== "promoted" ||
      !release.promoted_at ||
      !release.rights_manifest_sha256
    ) {
      throw new RecipeValidationError("Recipe source release is no longer eligible");
    }
  }
  return deduped.map((identity) => {
    const row = byId.get(identity.foodSourceId);
    if (!row) throw new RecipeValidationError("Recipe source unavailable");
    return {
      attributionRequired: row.attribution_required,
      attributionText: row.attribution_text,
      code: row.code,
      displayName: row.display_name,
      foodSourceId: row.id,
      licenseExpression: row.license_expression,
      releaseId: identity.releaseId,
    };
  });
}

async function inspectNestedClosure(
  transaction: Transaction<Database>,
  userId: string,
  rootRecipeId: string,
  initialVersionIds: readonly string[],
): Promise<{ readonly recipeIds: readonly string[]; readonly versionIds: readonly string[] }> {
  let frontier = [...new Set(initialVersionIds)].sort();
  const visited = new Set<string>();
  const recipeIds = new Set<string>();
  const graph = new Map<string, readonly string[]>();
  while (frontier.length > 0) {
    const batch = frontier.filter((id) => !visited.has(id)).sort();
    if (batch.length === 0) break;
    if (visited.size + batch.length > MAX_NESTED_CLOSURE) {
      throw new RecipeValidationError("Nested recipe closure exceeds 500 versions");
    }
    const versions = await transaction
      .selectFrom("recipe_version")
      .select(["id", "recipe_id", "owner_user_id"])
      .where("id", "in", batch)
      .execute();
    if (versions.length !== batch.length || versions.some((row) => row.owner_user_id !== userId)) {
      throw new RecipeNotFoundError();
    }
    for (const version of versions) {
      if (version.recipe_id === rootRecipeId) {
        throw new RecipeValidationError("Nested recipe would create a cycle");
      }
      visited.add(version.id);
      recipeIds.add(version.recipe_id);
    }
    const children = await transaction
      .selectFrom("recipe_ingredient")
      .select(["recipe_version_id", "nested_recipe_version_id"])
      .where("recipe_version_id", "in", batch)
      .where("nested_recipe_version_id", "is not", null)
      .execute();
    for (const id of batch) {
      graph.set(
        id,
        children
          .filter((row) => row.recipe_version_id === id)
          .map((row) => row.nested_recipe_version_id)
          .filter((child): child is string => child !== null)
          .sort(),
      );
    }
    frontier = [...new Set(children.map((row) => row.nested_recipe_version_id))]
      .filter((id): id is string => id !== null && !visited.has(id))
      .sort();
  }
  const visiting = new Set<string>();
  const depths = new Map<string, number>();
  const longest = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new RecipeValidationError("Nested recipe graph contains a cycle");
    visiting.add(id);
    const children = graph.get(id) ?? [];
    const depth = 1 + children.reduce((maximum, child) => Math.max(maximum, longest(child)), 0);
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  const rootDepth =
    1 + [...new Set(initialVersionIds)].reduce((maximum, id) => Math.max(maximum, longest(id)), 0);
  if (rootDepth > MAX_NESTED_DEPTH) {
    throw new RecipeValidationError("Nested recipe depth exceeds 10");
  }
  return { recipeIds: [...recipeIds].sort(), versionIds: [...visited].sort() };
}

async function materializeFoodIngredient(
  transaction: Transaction<Database>,
  ingredient: Extract<RecipeIngredientInput, { kind: "food" }>,
  position: number,
  definitions: Definitions,
  discovery: FoodDiscovery,
  source: RecipeSourceRecord | undefined,
): Promise<MaterializedIngredient> {
  if (discovery.kind === "public" && !source)
    throw new RecipeValidationError("Food source snapshot is incomplete");
  const version =
    discovery.kind === "public"
      ? await transaction
          .selectFrom("promoted_food_search_catalogue_v1")
          .select(["food_version_id", "name", "brand_name", "basis_quantity", "basis_unit"])
          .where("food_version_id", "=", ingredient.foodVersionId)
          .executeTakeFirst()
      : await transaction
          .selectFrom("food_version as version")
          .innerJoin(
            "custom_food_version as custom_version",
            "custom_version.food_version_id",
            "version.id",
          )
          .innerJoin("custom_food", "custom_food.id", "custom_version.custom_food_id")
          .select([
            "version.id as food_version_id",
            "version.name",
            "version.brand_name",
            "version.basis_quantity",
            "version.basis_unit",
          ])
          .where("version.id", "=", ingredient.foodVersionId)
          .where("custom_food.id", "=", discovery.customFoodId)
          .where("custom_food.status", "=", "active")
          .executeTakeFirst();
  if (version?.basis_unit !== "g") {
    throw new RecipeValidationError("Food ingredient is unavailable");
  }
  let amount: string;
  let inputUnit: "g" | "serving";
  let servingId: string | null = null;
  let servingLabel: string | null = null;
  let grams: string;
  if (ingredient.portion.kind === "grams") {
    amount = inputDecimal(ingredient.portion.grams, "ingredient grams");
    inputUnit = "g";
    grams = amount;
  } else {
    const serving = await transaction
      .selectFrom("food_serving")
      .select(["id", "label", "quantity", "unit", "gram_weight"])
      .where("id", "=", ingredient.portion.servingId)
      .where("food_version_id", "=", ingredient.foodVersionId)
      .executeTakeFirst();
    if (!serving?.gram_weight) throw new RecipeValidationError("Ingredient serving is unavailable");
    amount = inputDecimal(ingredient.portion.amount, "ingredient serving amount");
    grams = resolvedDecimal(
      resolvePortionToGrams({
        count: amount,
        kind: "serving-count",
        serving: {
          gramWeight: serving.gram_weight,
          id: serving.id,
          label: serving.label,
          reference: { amount: serving.quantity, unit: serving.unit },
          source: source?.code ?? "user-custom",
        },
      }).grams,
    );
    inputUnit = "serving";
    servingId = serving.id;
    servingLabel = serving.label;
  }
  const values =
    discovery.kind === "public"
      ? (
          await transaction
            .selectFrom("food_nutrient_value as value")
            .innerJoin("nutrient", "nutrient.id", "value.nutrient_id")
            .select([
              "nutrient.code",
              "nutrient.canonical_unit",
              "value.amount",
              "value.basis_quantity",
              "value.basis_unit",
              "value.unit",
              "value.value_status",
            ])
            .where("value.food_version_id", "=", ingredient.foodVersionId)
            .where("nutrient.active", "=", true)
            .execute()
        ).map((value) => ({
          amount: value.amount,
          basisQuantity: value.basis_quantity,
          basisUnit: value.basis_unit,
          canonicalUnit: value.canonical_unit,
          code: value.code,
          state: value.value_status === "trace" ? ("trace" as const) : ("quantified" as const),
          unit: value.unit,
          unknownReason: null,
          valueStatus: value.value_status,
        }))
      : (
          await transaction
            .selectFrom("custom_food_version_nutrient as value")
            .innerJoin("nutrient", "nutrient.id", "value.nutrient_id")
            .select([
              "nutrient.code",
              "nutrient.canonical_unit",
              "value.amount_per_100_grams",
              "value.value_state",
              "value.unknown_reason",
              "value.unit",
            ])
            .where("value.food_version_id", "=", ingredient.foodVersionId)
            .where("nutrient.active", "=", true)
            .execute()
        ).map((value) => ({
          amount: value.amount_per_100_grams ?? "0",
          basisQuantity: "100",
          basisUnit: "g" as const,
          canonicalUnit: value.canonical_unit,
          code: value.code,
          state: value.value_state,
          unit: value.unit,
          unknownReason: value.unknown_reason,
          valueStatus: "estimated" as const,
        }));
  const profile = createNutrientProfile(
    version.basis_quantity,
    values.map((value) => {
      if (
        value.unit !== value.canonicalUnit ||
        value.basisUnit !== "g" ||
        !decimal(value.basisQuantity).eq(version.basis_quantity)
      ) {
        throw new RecipeValidationError("Food nutrient unit or basis is incompatible");
      }
      const definition = definitions.byCode.get(value.code);
      if (!definition) throw new RecipeValidationError("Nutrient ontology changed during recipe");
      return nutrientDatum(
        definition,
        value.state === "trace"
          ? traceNutrient(null)
          : value.state === "unknown"
            ? unknownNutrient(value.unknownReason ?? "not_reported")
            : knownNutrient(value.amount, normalizeQuality(value.valueStatus)),
      );
    }),
  );
  return {
    food: {
      brandName: version.brand_name,
      foodVersionId: version.food_version_id,
      name: version.name,
    },
    kind: "food",
    note: boundedNote(ingredient.note ?? null),
    nutrientProfile: profile,
    portion: { amount, inputUnit, resolvedGrams: grams, servingId, servingLabel },
    position,
    foodProvenance:
      discovery.kind === "public"
        ? { kind: "public", source: source as RecipeSourceRecord }
        : {
            customFoodId: discovery.customFoodId,
            customFoodVersionNumber: discovery.customFoodVersionNumber,
            kind: "private_custom",
          },
    source: source ?? null,
  };
}

async function materializeNestedIngredient(
  transaction: Transaction<Database>,
  userId: string,
  ingredient: Extract<RecipeIngredientInput, { kind: "recipe" }>,
  position: number,
): Promise<MaterializedIngredient> {
  const version = await loadRecipeVersionRow(transaction, userId, ingredient.recipeVersionId);
  const nutrients = await loadRecipeNutrients(transaction, ingredient.recipeVersionId);
  const grams = inputDecimal(ingredient.grams, "nested recipe grams");
  return {
    grams,
    kind: "recipe",
    note: boundedNote(ingredient.note ?? null),
    nutrientProfile: createResolvedNutrientProfile(
      canonicalPositive(version.total_weight_grams, "nested recipe yield"),
      nutrients.map(toDomainAggregate),
    ),
    position,
    recipe: {
      name: version.name,
      recipeId: version.recipe_id,
      recipeVersionId: version.id,
      versionNumber: String(version.version_number),
      servingCount: nullablePositive(version.serving_count, "nested recipe serving count"),
      servingLabel: version.serving_label,
      yieldGrams: canonicalPositive(version.total_weight_grams, "nested recipe yield"),
    },
  };
}

type RecipeVersionRow = Awaited<ReturnType<typeof loadRecipeVersionRow>>;

async function loadRecipeVersionRow(database: Kysely<Database>, userId: string, versionId: string) {
  const row = await database
    .selectFrom("recipe_version")
    .selectAll()
    .where("id", "=", versionId)
    .where("owner_user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new RecipeNotFoundError();
  return row;
}

async function loadOwnedRecipe(
  database: Kysely<Database>,
  userId: string,
  recipeId: string,
): Promise<RecipeRecord> {
  const root = await database
    .selectFrom("recipe as root")
    .innerJoin("recipe_version as version", "version.id", "root.current_version_id")
    .select([
      "root.id",
      "root.status",
      "root.created_at",
      "root.updated_at",
      "version.id as version_id",
      "version.version_number",
    ])
    .where("root.id", "=", recipeId)
    .where("root.owner_user_id", "=", userId)
    .executeTakeFirst();
  if (!root) throw new RecipeNotFoundError();
  const currentVersion = await loadRecipeVersionRecord(database, userId, root.version_id);
  return {
    createdAt: root.created_at.toISOString(),
    currentRevision: String(root.version_number),
    currentVersion,
    id: root.id,
    status: root.status,
    updatedAt: root.updated_at.toISOString(),
  };
}

async function loadRecipeVersionRecord(
  database: Kysely<Database>,
  userId: string,
  versionId: string,
): Promise<RecipeVersionRecord> {
  const version = await loadRecipeVersionRow(database, userId, versionId);
  const [rows, nutrients, sources] = await Promise.all([
    database
      .selectFrom("recipe_ingredient")
      .selectAll()
      .where("recipe_version_id", "=", versionId)
      .orderBy("position")
      .limit(MAX_INGREDIENTS + 1)
      .execute(),
    loadRecipeNutrients(database, versionId),
    loadRecipeSources(database, versionId),
  ]);
  if (rows.length !== version.ingredient_count || rows.length > MAX_INGREDIENTS) {
    throw new RecipeValidationError("Recipe ingredient count is inconsistent");
  }
  const ingredients = rows.map((row): RecipeIngredientRecord => {
    if (
      row.ingredient_kind === "food" &&
      row.food_version_id &&
      row.food_name &&
      ((row.custom_food_id !== null && row.custom_food_version_number !== null) ||
        (row.source_id !== null &&
          row.source_code !== null &&
          row.source_release_id !== null &&
          row.source_display_name !== null &&
          row.license_expression !== null &&
          row.attribution_required !== null &&
          row.attribution_text !== null))
    ) {
      const source =
        row.source_id &&
        row.source_code &&
        row.source_release_id &&
        row.source_display_name &&
        row.license_expression &&
        row.attribution_required !== null &&
        row.attribution_text !== null
          ? {
              attributionRequired: row.attribution_required,
              attributionText: row.attribution_text,
              code: row.source_code,
              displayName: row.source_display_name,
              foodSourceId: row.source_id,
              licenseExpression: row.license_expression,
              releaseId: row.source_release_id,
            }
          : null;
      return {
        food: {
          brandName: row.brand_name,
          foodVersionId: row.food_version_id,
          name: row.food_name,
        },
        kind: "food",
        foodProvenance:
          row.custom_food_id && row.custom_food_version_number !== null
            ? {
                customFoodId: row.custom_food_id,
                customFoodVersionNumber: String(row.custom_food_version_number),
                kind: "private_custom",
              }
            : { kind: "public", source: source as RecipeSourceRecord },
        note: row.note,
        portion: {
          amount: canonicalPositive(row.quantity, "ingredient amount"),
          inputUnit: row.input_unit as "g" | "serving",
          resolvedGrams: canonicalPositive(row.resolved_grams, "ingredient grams"),
          servingId: row.food_serving_id,
          servingLabel: row.serving_label,
        },
        position: row.position,
        source,
      };
    }
    if (
      row.ingredient_kind === "recipe" &&
      row.nested_recipe_id &&
      row.nested_recipe_version_id &&
      row.nested_recipe_name &&
      row.nested_recipe_version_number !== null &&
      row.nested_recipe_yield_grams
    ) {
      return {
        grams: canonicalPositive(row.resolved_grams, "nested recipe grams"),
        kind: "recipe",
        note: row.note,
        position: row.position,
        recipe: {
          name: row.nested_recipe_name,
          recipeId: row.nested_recipe_id,
          recipeVersionId: row.nested_recipe_version_id,
          versionNumber: String(row.nested_recipe_version_number),
          servingCount: nullablePositive(row.nested_recipe_serving_count, "serving count"),
          servingLabel: row.nested_recipe_serving_label,
          yieldGrams: canonicalPositive(row.nested_recipe_yield_grams, "nested yield"),
        },
      };
    }
    throw new RecipeValidationError("Recipe ingredient snapshot is invalid");
  });
  return {
    calculationAssumptions: version.calculation_assumptions,
    calculationVersion: version.calculation_version,
    createdAt: version.created_at.toISOString(),
    description: version.description,
    id: version.id,
    ingredients,
    instructions: version.instructions,
    inputMassGrams: canonicalPositive(version.input_mass_grams, "recipe input mass"),
    name: version.name,
    nutrients,
    retentionPolicy: {
      code: version.retention_policy_code,
      version: version.retention_policy_version,
    },
    servingCount: nullablePositive(version.serving_count, "recipe serving count"),
    servingLabel: version.serving_label,
    sources,
    versionNumber: String(version.version_number),
    warnings: parseWarnings(version.warnings),
    yield: {
      grams: canonicalPositive(version.total_weight_grams, "recipe yield"),
      ratioToInputMass: decimal(version.total_weight_grams).div(version.input_mass_grams).toFixed(),
      source: version.final_yield_source,
    },
  };
}

async function loadRecipeNutrients(
  database: Kysely<Database>,
  versionId: string,
): Promise<readonly DiaryNutrientAggregateRecord[]> {
  const rows = await database
    .selectFrom("recipe_version_nutrient")
    .selectAll()
    .where("recipe_version_id", "=", versionId)
    .orderBy("nutrient_code")
    .limit(MAX_NUTRIENTS + 1)
    .execute();
  if (rows.length < 1 || rows.length > MAX_NUTRIENTS) {
    throw new RecipeValidationError("Recipe nutrient vector is invalid");
  }
  return rows.map((row) => ({
    code: row.nutrient_code,
    completeness: row.completeness,
    contributorCount: row.contributor_count,
    isExact: row.is_exact,
    knownAmount: knownAmount(row.known_amount),
    name: row.nutrient_name,
    nutrientId: row.nutrient_id,
    quantifiedCount: row.quantified_count,
    traceCount: row.trace_count,
    unit: supportedUnit(row.unit),
    unknownCount: row.unknown_count,
    unknownReasons: closedReasons(row.unknown_reasons),
  }));
}

async function loadRecipeSources(
  database: Kysely<Database>,
  versionId: string,
): Promise<readonly RecipeSourceRecord[]> {
  const rows = await database
    .selectFrom("recipe_version_source")
    .selectAll()
    .where("recipe_version_id", "=", versionId)
    .orderBy("source_code")
    .orderBy("source_release_id")
    .limit(MAX_SOURCES + 1)
    .execute();
  if (rows.length > MAX_SOURCES) {
    throw new RecipeValidationError("Recipe source set is invalid");
  }
  return rows.map((row) => ({
    attributionRequired: row.attribution_required,
    attributionText: row.attribution_text,
    code: row.source_code,
    displayName: row.source_display_name,
    foodSourceId: row.food_source_id,
    licenseExpression: row.license_expression,
    releaseId: row.source_release_id,
  }));
}

interface Definitions {
  readonly list: readonly NutrientDefinition[];
  readonly byCode: ReadonlyMap<string, NutrientDefinition>;
  readonly rows: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly canonicalUnit: NutrientUnit;
  }[];
}

async function loadDefinitions(database: Kysely<Database>): Promise<Definitions> {
  const rows = await database
    .selectFrom("nutrient")
    .select(["id", "code", "name", "canonical_unit"])
    .where("active", "=", true)
    .orderBy("display_order")
    .orderBy("id")
    .execute();
  if (rows.length < 1 || rows.length > MAX_NUTRIENTS) {
    throw new RecipeValidationError("Active nutrient registry is invalid");
  }
  const mapped = rows.map((row) => ({
    canonicalUnit: supportedUnit(row.canonical_unit),
    code: row.code,
    id: row.id,
    name: row.name,
  }));
  const list = mapped.map((row) =>
    defineNutrient({
      canonicalUnit: row.canonicalUnit,
      category: "other",
      id: row.code,
      name: row.name,
    }),
  );
  return {
    byCode: new Map(list.map((definition) => [definition.id, definition])),
    list,
    rows: mapped,
  };
}

function mapAggregates(
  aggregates: readonly NutrientAggregate[],
  definitions: Definitions,
): readonly DiaryNutrientAggregateRecord[] {
  const rows = new Map(definitions.rows.map((row) => [row.code, row]));
  return aggregates.map((aggregate) => {
    const row = rows.get(aggregate.nutrientId);
    if (!row) throw new RecipeValidationError("Nutrient mapping is incomplete");
    return {
      code: row.code,
      completeness: aggregate.completeness,
      contributorCount: aggregate.contributorCount,
      isExact: aggregate.isExact,
      knownAmount: knownAmount(aggregate.knownAmount),
      name: row.name,
      nutrientId: row.id,
      quantifiedCount: aggregate.quantifiedCount,
      traceCount: aggregate.traceCount,
      unit: aggregate.unit,
      unknownCount: aggregate.unknownCount,
      unknownReasons: closedReasons(aggregate.unknownReasons),
    };
  });
}

function toDomainAggregate(value: DiaryNutrientAggregateRecord): NutrientAggregate {
  return {
    completeness: value.completeness,
    contributorCount: value.contributorCount,
    isExact: value.isExact,
    knownAmount: value.knownAmount,
    nutrientId: value.code,
    quantifiedCount: value.quantifiedCount,
    traceCount: value.traceCount,
    unit: value.unit as NutrientUnit,
    unknownCount: value.unknownCount,
    unknownReasons: value.unknownReasons,
  };
}

async function requireWritableRecipeUser(
  transaction: Transaction<Database>,
  userId: string,
): Promise<void> {
  const user = await transaction
    .selectFrom("app_user")
    .select("id")
    .where("id", "=", userId)
    .where("status", "=", "active")
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  if (!user) throw new RecipeNotFoundError();
}

async function requireReadableRecipeUser(
  database: Kysely<Database>,
  userId: string,
): Promise<void> {
  const user = await database
    .selectFrom("app_user")
    .select("id")
    .where("id", "=", userId)
    .where("status", "=", "active")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!user) throw new RecipeNotFoundError();
}

async function lockRecipeUser(transaction: Transaction<Database>, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:recipe:${userId}`}, 0))`.execute(
    transaction,
  );
}

async function readRecipeReplay(
  transaction: Transaction<Database>,
  input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
  },
  operation: "create" | "revise",
  recipeId?: string,
): Promise<RecipeMutationResult | null> {
  const row = await transaction
    .selectFrom("recipe_operation")
    .select(["request_digest", "operation", "recipe_id", "result_payload"])
    .where("user_id", "=", input.userId)
    .where("client_operation_id", "=", input.clientOperationId)
    .executeTakeFirst();
  if (!row) return null;
  if (
    row.request_digest !== input.requestDigest ||
    row.operation !== operation ||
    (recipeId !== undefined && row.recipe_id !== recipeId)
  ) {
    throw new RecipeIdempotencyConflictError();
  }
  return { ...(row.result_payload as unknown as RecipeMutationResult), replayed: true };
}

async function recordRecipeOperation(
  transaction: Transaction<Database>,
  input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
  },
  operation: "create" | "revise",
  recipeId: string,
  result: RecipeMutationResult,
): Promise<void> {
  await transaction
    .insertInto("recipe_operation")
    .values({
      client_operation_id: input.clientOperationId,
      operation,
      recipe_id: recipeId,
      request_digest: input.requestDigest,
      result_payload: JSON.parse(JSON.stringify(result)) as JsonObject,
      user_id: input.userId,
    })
    .execute();
}

function validateDraft(draft: RecipeDraft): void {
  if (
    draft.name.trim().length < 1 ||
    [...draft.name].length > 200 ||
    Buffer.byteLength(draft.name) > 800
  ) {
    throw new RecipeValidationError("Recipe name is invalid");
  }
  if (
    draft.description !== null &&
    ([...draft.description].length > 2000 || Buffer.byteLength(draft.description) > 8000)
  ) {
    throw new RecipeValidationError("Recipe description is too long");
  }
  if (
    draft.instructions !== null &&
    ([...draft.instructions].length > 10000 || Buffer.byteLength(draft.instructions) > 40000)
  ) {
    throw new RecipeValidationError("Recipe instructions are too long");
  }
  if (draft.ingredients.length < 1 || draft.ingredients.length > MAX_INGREDIENTS) {
    throw new RecipeValidationError("A recipe requires between 1 and 50 ingredients");
  }
  inputDecimal(draft.yield.grams, "recipe yield grams");
  if (draft.yield.source !== "estimated" && draft.yield.source !== "measured") {
    throw new RecipeValidationError("Recipe yield source is invalid");
  }
  if ((draft.servingCount === null) !== (draft.servingLabel === null)) {
    throw new RecipeValidationError(
      "Recipe serving count and label must both be present or absent",
    );
  }
  if (draft.servingCount !== null) inputDecimal(draft.servingCount, "recipe serving count");
  if (
    draft.servingLabel !== null &&
    (draft.servingLabel.trim().length < 1 ||
      [...draft.servingLabel].length > 100 ||
      Buffer.byteLength(draft.servingLabel) > 400)
  ) {
    throw new RecipeValidationError("Recipe serving label is invalid");
  }
  const positions = new Set<number>();
  for (const [index, ingredient] of draft.ingredients.entries()) {
    const position = ingredientPosition(ingredient.position ?? index);
    if (positions.has(position))
      throw new RecipeValidationError("Ingredient positions must be unique");
    positions.add(position);
    boundedNote(ingredient.note ?? null);
    if (ingredient.kind === "recipe") inputDecimal(ingredient.grams, "nested recipe grams");
  }
}

function validateOperation(clientOperationId: string, requestDigest: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      clientOperationId,
    )
  ) {
    throw new RecipeValidationError("clientOperationId must be a UUID");
  }
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) {
    throw new RecipeValidationError("requestDigest must be a lowercase SHA-256 hex");
  }
}

function inputDecimal(value: string, label: string): string {
  try {
    if (!/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value)) throw new Error();
    return canonicalPositiveDecimal(value, label);
  } catch {
    throw new RecipeValidationError(`${label} is invalid or out of range`);
  }
}

function resolvedDecimal(value: string): string {
  const result = canonicalPositive(value, "resolved grams");
  if (decimal(result).gte("1000000000000000000") || result.length > 160) {
    throw new RecipeValidationError("Resolved grams are out of range");
  }
  return result;
}

function knownAmount(value: string): string {
  try {
    const result = canonicalNonNegativeDecimal(value, "nutrient amount");
    if (result.length > 160) throw new Error();
    return result;
  } catch {
    throw new RecipeValidationError("Nutrient amount is out of range");
  }
}

function canonicalPositive(value: string | null, label: string): string {
  if (value === null) throw new RecipeValidationError(`${label} is missing`);
  try {
    return canonicalPositiveDecimal(value, label);
  } catch {
    throw new RecipeValidationError(`${label} is invalid`);
  }
}

function nullablePositive(value: string | null, label: string): string | null {
  return value === null ? null : canonicalPositive(value, label);
}

function resolveRecipeServingGrams(version: RecipeVersionRow, rawAmount: string): string {
  if (version.serving_count === null || version.serving_label === null) {
    throw new RecipeValidationError("Recipe version does not define servings");
  }
  const amount = inputDecimal(rawAmount, "recipe serving amount");
  return resolvedDecimal(
    decimal(amount).mul(version.total_weight_grams).div(version.serving_count).toFixed(),
  );
}

function ingredientPosition(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 49) {
    throw new RecipeValidationError("Ingredient position is invalid");
  }
  return value;
}

function boundedNote(value: string | null): string | null {
  if (value !== null && Buffer.byteLength(value) > 2000) {
    throw new RecipeValidationError("Ingredient note is too long");
  }
  return value;
}

function supportedUnit(value: string): NutrientUnit {
  if (value.length > 32 || !NUTRIENT_UNITS.includes(value as NutrientUnit)) {
    throw new RecipeValidationError("Nutrient unit is unsupported");
  }
  return value as NutrientUnit;
}

function closedReasons(value: Readonly<Record<string, unknown>>): JsonObject {
  return {
    not_analyzed: reasonCount(value.not_analyzed),
    not_applicable: reasonCount(value.not_applicable),
    not_reported: reasonCount(value.not_reported),
    withheld: reasonCount(value.withheld),
  };
}

function reasonCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeQuality(value: string): "calculated" | "estimated" | "label" | "measured" {
  return value === "calculated" ||
    value === "estimated" ||
    value === "label" ||
    value === "measured"
    ? value
    : "estimated";
}

function dedupeIdentities(values: readonly SourceIdentity[]): readonly SourceIdentity[] {
  const map = new Map(values.map((value) => [`${value.foodSourceId}:${value.releaseId}`, value]));
  return [...map.values()].sort(
    (left, right) =>
      compareNumericText(left.foodSourceId, right.foodSourceId) ||
      left.releaseId.localeCompare(right.releaseId),
  );
}

function compareNumericText(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function positiveRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text) || BigInt(text) > 2_147_483_647n) {
    throw new RecipeValidationError("Recipe revision is invalid");
  }
  return text;
}

function parseWarnings(value: JsonArray): readonly RecipeWarningRecord[] {
  if (!Array.isArray(value)) throw new RecipeValidationError("Recipe warnings are invalid");
  return value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof candidate.code !== "string" ||
      typeof candidate.message !== "string" ||
      !Array.isArray(candidate.nutrientIds) ||
      candidate.nutrientIds.some((id: unknown) => typeof id !== "string")
    ) {
      throw new RecipeValidationError("Recipe warning snapshot is invalid");
    }
    return {
      code: candidate.code,
      message: candidate.message,
      nutrientIds: candidate.nutrientIds as string[],
    };
  });
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ id, updatedAt }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { readonly id: string; readonly updatedAt: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      !("updatedAt" in parsed) ||
      typeof parsed.id !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      Object.keys(parsed).sort().join(",") !== "id,updatedAt" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.id)
    ) {
      throw new Error();
    }
    const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(
      parsed.updatedAt,
    );
    if (!timestamp || Number(timestamp[1]) === 0) {
      throw new Error();
    }
    const instant = new Date(
      `${timestamp[1]}-${timestamp[2]}-${timestamp[3]}T${timestamp[4]}:${timestamp[5]}:${timestamp[6]}.${timestamp[7]?.slice(0, 3)}Z`,
    );
    if (
      Number.isNaN(instant.getTime()) ||
      instant.getUTCFullYear() !== Number(timestamp[1]) ||
      instant.getUTCMonth() + 1 !== Number(timestamp[2]) ||
      instant.getUTCDate() !== Number(timestamp[3]) ||
      instant.getUTCHours() !== Number(timestamp[4]) ||
      instant.getUTCMinutes() !== Number(timestamp[5]) ||
      instant.getUTCSeconds() !== Number(timestamp[6]) ||
      instant.getUTCMilliseconds() !== Number(timestamp[7]?.slice(0, 3))
    ) {
      throw new Error();
    }
    return { id: parsed.id, updatedAt: parsed.updatedAt };
  } catch {
    throw new RecipeCursorError();
  }
}
