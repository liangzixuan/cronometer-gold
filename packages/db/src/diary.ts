import { createHash, randomUUID } from "node:crypto";

import {
  calculatePortionNutrition,
  canonicalIanaTimeZone,
  canonicalNonNegativeDecimal,
  canonicalPositiveDecimal,
  combineNutrientAggregates,
  createNutrientProfile,
  decimal,
  defineNutrient,
  deriveDiaryLocalCoordinates,
  knownNutrient,
  NUTRIENT_UNITS,
  NUTRITION_ENGINE_VERSION,
  type NutrientAggregate,
  type NutrientDefinition,
  type NutrientUnit,
  nutrientDatum,
  quantity,
  resolvePortionToGrams,
  traceNutrient,
  unknownNutrient,
} from "@nutrition-tracker/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import {
  loadRecipeDiaryFacts,
  RecipeNotFoundError,
  type RecipeSourceRecord,
  type RecipeWarningRecord,
} from "./recipes.js";
import type { Database, JsonArray, JsonObject } from "./types.js";

export type DiaryPersistenceErrorCode =
  | "DIARY_ENTRY_REVISION_CONFLICT"
  | "DIARY_IDEMPOTENCY_CONFLICT"
  | "DIARY_LOCKED"
  | "DIARY_NOT_FOUND"
  | "DIARY_PAGE_STALE"
  | "DIARY_TIME_ZONE_CHANGED"
  | "DIARY_VALIDATION";

export class DiaryPersistenceError extends Error {
  override readonly name = "DiaryPersistenceError";
  constructor(
    readonly code: DiaryPersistenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class DiaryNotFoundError extends DiaryPersistenceError {
  constructor() {
    super("DIARY_NOT_FOUND", "Diary entry not found");
  }
}

export class DiaryEntryRevisionConflictError extends DiaryPersistenceError {
  constructor() {
    super("DIARY_ENTRY_REVISION_CONFLICT", "Diary entry revision does not match");
  }
}

export class DiaryIdempotencyConflictError extends DiaryPersistenceError {
  constructor() {
    super("DIARY_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
  }
}

export class DiaryTimeZoneChangedError extends DiaryPersistenceError {
  constructor() {
    super("DIARY_TIME_ZONE_CHANGED", "Profile time zone changed before diary entry creation");
  }
}

export class DiaryValidationError extends DiaryPersistenceError {
  constructor(message: string) {
    super("DIARY_VALIDATION", message);
  }
}

export class DiaryLockedError extends DiaryPersistenceError {
  constructor() {
    super("DIARY_LOCKED", "Diary day is locked");
  }
}

export class DiaryPageStaleError extends DiaryPersistenceError {
  constructor() {
    super("DIARY_PAGE_STALE", "Diary day changed while reading pages");
  }
}

export type DiaryMealSlot = "breakfast" | "dinner" | "lunch" | "snacks";
export type DiaryPortionInput =
  | { readonly kind: "grams"; readonly grams: string }
  | { readonly kind: "serving"; readonly servingId: string; readonly amount: string };

export interface DiaryNutrientAggregateRecord {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly isExact: boolean;
  readonly contributorCount: number;
  readonly quantifiedCount: number;
  readonly traceCount: number;
  readonly unknownCount: number;
  readonly unknownReasons: JsonObject;
}

export interface DiaryFoodEntryRecord {
  readonly id: string;
  readonly currentRevision: string;
  readonly operation: "create" | "delete" | "move" | "update";
  readonly kind: "food";
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly mealSlot: DiaryMealSlot;
  readonly position: number;
  readonly note: string | null;
  readonly food: {
    readonly foodVersionId: string;
    readonly name: string;
    readonly brandName: string | null;
    readonly customFoodId: string | null;
    readonly customFoodVersionNumber: number | null;
  };
  readonly source: {
    readonly code: string;
    readonly releaseId: string;
    readonly displayName: string;
    readonly licenseExpression: string;
    readonly attributionRequired: boolean;
    readonly attributionText: string;
  } | null;
  readonly foodProvenance:
    | { readonly kind: "public" }
    | {
        readonly kind: "private_custom";
        readonly customFoodId: string;
        readonly versionNumber: number;
        readonly statement: "Entered by the owner; not independently verified.";
      };
  readonly repeatedFromRevisionId: string | null;
  readonly portion: {
    readonly amount: string;
    readonly inputUnit: string;
    readonly servingId: string | null;
    readonly servingLabel: string | null;
    readonly resolvedGrams: string;
  };
  readonly snapshotStatus: "complete" | "partial";
  readonly snapshotEngineVersion: string;
  readonly nutrients: readonly DiaryNutrientAggregateRecord[];
  readonly createdAt: string;
}

export interface DiaryRecipeEntryRecord {
  readonly id: string;
  readonly currentRevision: string;
  readonly operation: "create" | "delete" | "move" | "update";
  readonly kind: "recipe";
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly mealSlot: DiaryMealSlot;
  readonly position: number;
  readonly note: string | null;
  readonly recipe: {
    readonly recipeId: string;
    readonly recipeVersionId: string;
    readonly versionNumber: number;
    readonly name: string;
    readonly yieldGrams: string;
    readonly yieldSource: "estimated" | "measured";
    readonly servingCount: string | null;
    readonly servingLabel: string | null;
    readonly calculationVersion: string;
    readonly retentionPolicy: { readonly code: string; readonly version: string };
    readonly calculationAssumptions: JsonObject;
    readonly warnings: readonly RecipeWarningRecord[];
    readonly sources: readonly RecipeSourceRecord[];
  };
  readonly portion: {
    readonly amount: string;
    readonly inputUnit: "g" | "serving";
    readonly resolvedGrams: string;
  };
  readonly snapshotStatus: "complete" | "partial";
  readonly snapshotEngineVersion: string;
  readonly repeatedFromRevisionId: string | null;
  readonly nutrients: readonly DiaryNutrientAggregateRecord[];
  readonly createdAt: string;
}

export type DiaryEntryRecord = DiaryFoodEntryRecord | DiaryRecipeEntryRecord;

export interface DiaryDayRevisionRecord {
  readonly localDate: string;
  readonly revision: string;
}

export interface DiaryMutationResult {
  readonly replayed: boolean;
  readonly entry: DiaryEntryRecord;
  readonly days: readonly DiaryDayRevisionRecord[];
}

export interface DiaryFoodMutationResult extends Omit<DiaryMutationResult, "entry"> {
  readonly entry: DiaryFoodEntryRecord;
}

export interface DiaryRecipeMutationResult extends Omit<DiaryMutationResult, "entry"> {
  readonly entry: DiaryRecipeEntryRecord;
}

export interface DiaryDayRecord {
  readonly id: string | null;
  readonly localDate: string;
  readonly timeZone: string;
  readonly status: "locked" | "open";
  readonly revision: string;
  readonly entries: readonly DiaryEntryRecord[];
  readonly totals: readonly DiaryNutrientAggregateRecord[];
  readonly totalEntries: number;
  readonly updatedAt: string | null;
}

/** Server-only continuation state. The API seals this before it crosses the trust boundary. */
export interface DiaryPageContinuationRecord {
  readonly dayId: string;
  readonly dayRevision: string;
  readonly offset: number;
  readonly snapshotDigest: string;
  readonly status: "locked" | "open";
  readonly tailEntryId: string;
  readonly timeZone: string;
  readonly updatedAtMicroseconds: string;
}

export interface DiaryDayPageRecord {
  readonly day: DiaryDayRecord;
  readonly page: {
    readonly next: DiaryPageContinuationRecord | null;
    readonly totalEntries: number;
  };
}

export interface CreateFoodDiaryEntryInput {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedProfileTimeZone?: string;
  readonly occurredAt: string;
  readonly foodVersionId: string;
  /** Binds a private custom-food route to the exact owner-scoped custom root. */
  readonly expectedCustomFoodId?: string;
  readonly portion: DiaryPortionInput;
  readonly mealSlot: DiaryMealSlot;
  readonly position?: number;
  readonly note?: string | null;
}

export interface RepeatDiaryEntryInput {
  readonly userId: string;
  readonly sourceEntryId: string;
  readonly sourceRevision: bigint | number | string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly occurredAt: string;
  readonly mealSlot?: DiaryMealSlot;
  readonly position?: number;
  readonly note?: string | null;
}

export interface UpdateFoodDiaryEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
  readonly occurredAt?: string;
  readonly portion?: DiaryPortionInput;
  readonly mealSlot?: DiaryMealSlot;
  readonly position?: number;
  readonly note?: string | null;
}

export interface CreateRecipeDiaryEntryInput {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly occurredAt: string;
  readonly recipeId: string;
  readonly recipeVersionId: string;
  readonly portion:
    | { readonly kind: "grams"; readonly grams: string }
    | { readonly kind: "serving"; readonly amount: string };
  readonly mealSlot: DiaryMealSlot;
  readonly position?: number;
  readonly note?: string | null;
}

export interface UpdateRecipeDiaryEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
  readonly occurredAt?: string;
  readonly portion?: CreateRecipeDiaryEntryInput["portion"];
  readonly mealSlot?: DiaryMealSlot;
  readonly position?: number;
  readonly note?: string | null;
}

export interface UpdateDiaryEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
  readonly occurredAt?: string;
  readonly portion?: DiaryPortionInput | { readonly kind: "serving"; readonly amount: string };
  readonly mealSlot?: DiaryMealSlot;
  readonly position?: number;
  readonly note?: string | null;
}

export interface DeleteDiaryEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
}

const SNAPSHOT_ENGINE_VERSION = NUTRITION_ENGINE_VERSION;
const MAX_DAY_ENTRIES = 50;
const MAX_NUTRIENT_VECTOR_SIZE = 256;
const MAX_MUTABLE_DIARY_NOTE_CODE_POINTS = 2_000;

export async function createFoodDiaryEntry(
  database: Kysely<Database>,
  input: CreateFoodDiaryEntryInput,
): Promise<DiaryFoodMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const expectedProfileTimeZone = optionalExpectedProfileTimeZone(input.expectedProfileTimeZone);
  validateMealSlot(input.mealSlot);
  validateMutableDiaryNote(input.note);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserDiary(transaction, input.userId);
      await lockActiveDiaryUser(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "create",
      );
      if (replay) {
        if (replay.entry.kind !== "food") throw new DiaryIdempotencyConflictError();
        return { ...replay, entry: replay.entry };
      }
      const profile = await requireLockedProfile(transaction, input.userId);
      if (expectedProfileTimeZone !== undefined && profile.timeZone !== expectedProfileTimeZone) {
        throw new DiaryTimeZoneChangedError();
      }
      const coordinates = deriveLocalCoordinates(input.occurredAt, profile.timeZone);
      const facts = await loadFoodFacts(
        transaction,
        input.userId,
        input.foodVersionId,
        input.portion,
        true,
        input.expectedCustomFoodId,
      );
      const day = await ensureDiaryDay(transaction, input.userId, coordinates, profile.timeZone);
      const [lockedDay] = await lockDiaryDays(transaction, input.userId, [day.id]);
      if (!lockedDay || lockedDay.status === "locked") throw new DiaryLockedError();
      await assertDayHasCapacity(transaction, input.userId, day.id);
      await assertDayNutrientUnion(transaction, input.userId, day.id, facts.nutrients);
      const entryId = randomUUID();
      const revisionId = randomUUID();
      const position = canonicalPosition(input.position ?? 0);

      await transaction
        .insertInto("diary_entry")
        .values({
          client_operation_id: input.clientOperationId,
          custom_food_id: facts.customFoodId,
          custom_food_version_number: facts.customFoodVersionNumber,
          current_revision_id: revisionId,
          current_revision_number: "1",
          diary_id: day.id,
          entry_kind: "food",
          food_serving_id: facts.servingId,
          food_version_id: facts.foodVersionId,
          id: entryId,
          input_unit: facts.inputUnit,
          local_time: coordinates.localTime,
          meal_slot: input.mealSlot,
          note: input.note ?? null,
          occurred_at: coordinates.occurredAt,
          position,
          quantity: facts.enteredAmount,
          recipe_version_id: null,
          resolved_grams: facts.resolvedGrams,
          repeated_from_revision_id: null,
          snapshot_engine_version: SNAPSHOT_ENGINE_VERSION,
          snapshot_status: snapshotStatus(facts.nutrients),
          user_id: input.userId,
        })
        .execute();
      await insertRevision(transaction, {
        coordinates,
        dayId: day.id,
        entryId,
        facts,
        mealSlot: input.mealSlot,
        note: input.note ?? null,
        operation: "create",
        position,
        revisionId,
        revisionNumber: "1",
        userId: input.userId,
      });
      const dayRevision = await incrementDay(transaction, day.id, input.userId);
      const entry = await loadEntryByRevision(transaction, input.userId, revisionId);
      if (entry.kind !== "food") throw new DiaryValidationError("Food diary result is invalid");
      const result: DiaryFoodMutationResult = {
        days: [{ localDate: coordinates.localDate, revision: dayRevision }],
        entry,
        replayed: false,
      };
      await recordOperation(transaction, input, "create", entryId, result);
      return result;
    });
}

export async function createRecipeDiaryEntry(
  database: Kysely<Database>,
  input: CreateRecipeDiaryEntryInput,
): Promise<DiaryRecipeMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  validateMealSlot(input.mealSlot);
  validateMutableDiaryNote(input.note);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserDiary(transaction, input.userId);
      const profile = await requireWritableProfile(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "create",
      );
      if (replay) {
        if (replay.entry.kind !== "recipe") throw new DiaryIdempotencyConflictError();
        return { ...replay, entry: replay.entry };
      }
      const coordinates = deriveLocalCoordinates(input.occurredAt, profile.timeZone);
      let facts: Awaited<ReturnType<typeof loadRecipeDiaryFacts>>;
      try {
        facts = await loadRecipeDiaryFacts(transaction, {
          portion: input.portion,
          recipeId: input.recipeId,
          recipeVersionId: input.recipeVersionId,
          requireCurrent: false,
          userId: input.userId,
        });
      } catch (error) {
        if (error instanceof RecipeNotFoundError) throw new DiaryNotFoundError();
        throw error;
      }
      const day = await ensureDiaryDay(transaction, input.userId, coordinates, profile.timeZone);
      const [lockedDay] = await lockDiaryDays(transaction, input.userId, [day.id]);
      if (!lockedDay || lockedDay.status === "locked") throw new DiaryLockedError();
      await assertDayHasCapacity(transaction, input.userId, day.id);
      await assertDayNutrientUnion(transaction, input.userId, day.id, facts.nutrients);
      const entryId = randomUUID();
      const revisionId = randomUUID();
      const position = canonicalPosition(input.position ?? 0);
      await transaction
        .insertInto("diary_entry")
        .values({
          client_operation_id: input.clientOperationId,
          current_revision_id: revisionId,
          current_revision_number: "1",
          diary_id: day.id,
          entry_kind: "recipe",
          food_serving_id: null,
          food_version_id: null,
          id: entryId,
          input_unit: facts.inputUnit,
          local_time: coordinates.localTime,
          meal_slot: input.mealSlot,
          note: input.note ?? null,
          occurred_at: coordinates.occurredAt,
          position,
          quantity: facts.enteredAmount,
          recipe_version_id: facts.recipeVersionId,
          resolved_grams: facts.resolvedGrams,
          snapshot_engine_version: facts.calculationVersion,
          snapshot_status: snapshotStatus(facts.nutrients),
          user_id: input.userId,
        })
        .execute();
      await insertRecipeDiaryRevision(transaction, {
        coordinates,
        dayId: day.id,
        entryId,
        facts,
        mealSlot: input.mealSlot,
        note: input.note ?? null,
        operation: "create",
        position,
        revisionId,
        revisionNumber: "1",
        userId: input.userId,
      });
      const dayRevision = await incrementDay(transaction, day.id, input.userId);
      const entry = await loadEntryByRevision(transaction, input.userId, revisionId);
      if (entry.kind !== "recipe") throw new DiaryValidationError("Recipe diary result is invalid");
      const result: DiaryRecipeMutationResult = {
        days: [{ localDate: coordinates.localDate, revision: dayRevision }],
        entry,
        replayed: false,
      };
      await recordOperation(transaction, input, "create", entryId, result);
      return result;
    });
}

/** Create a new logical entry from one exact immutable historical revision. */
export async function repeatDiaryEntry(
  database: Kysely<Database>,
  input: RepeatDiaryEntryInput,
): Promise<DiaryMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const sourceRevision = canonicalRevision(input.sourceRevision);
  if (input.mealSlot !== undefined) validateMealSlot(input.mealSlot);
  if (input.note !== undefined) validateMutableDiaryNote(input.note);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserDiary(transaction, input.userId);
      const profile = await requireWritableProfile(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "create",
      );
      if (replay) return replay;
      const source = await transaction
        .selectFrom("diary_entry_revision")
        .select("id")
        .where("diary_entry_id", "=", input.sourceEntryId)
        .where("user_id", "=", input.userId)
        .where("revision_number", "=", sourceRevision)
        .where("operation", "!=", "delete")
        .executeTakeFirst();
      if (!source) throw new DiaryNotFoundError();
      const pinned = await loadEntryByRevision(transaction, input.userId, source.id);
      const coordinates = deriveLocalCoordinates(input.occurredAt, profile.timeZone);
      const day = await ensureDiaryDay(transaction, input.userId, coordinates, profile.timeZone);
      const [lockedDay] = await lockDiaryDays(transaction, input.userId, [day.id]);
      if (!lockedDay || lockedDay.status === "locked") throw new DiaryLockedError();
      await assertDayHasCapacity(transaction, input.userId, day.id);
      await assertDayNutrientUnion(transaction, input.userId, day.id, pinned.nutrients);
      const entryId = randomUUID();
      const revisionId = randomUUID();
      const mealSlot = input.mealSlot ?? pinned.mealSlot;
      const position = canonicalPosition(input.position ?? pinned.position);
      const note = input.note === undefined ? pinned.note : input.note;
      if (pinned.kind === "food") {
        await lockRepeatFoodEligibility(transaction, input.userId, pinned);
        const facts: FoodFacts = {
          attributionRequired: pinned.source?.attributionRequired ?? null,
          attributionText: pinned.source?.attributionText ?? null,
          brandName: pinned.food.brandName,
          customFoodId: pinned.food.customFoodId,
          customFoodVersionNumber: pinned.food.customFoodVersionNumber,
          enteredAmount: pinned.portion.amount,
          foodName: pinned.food.name,
          foodVersionId: pinned.food.foodVersionId,
          inputUnit: pinned.portion.inputUnit,
          licenseExpression: pinned.source?.licenseExpression ?? null,
          nutrients: pinned.nutrients,
          resolvedGrams: pinned.portion.resolvedGrams,
          servingId: pinned.portion.servingId,
          servingLabel: pinned.portion.servingLabel,
          sourceCode: pinned.source?.code ?? null,
          sourceDisplayName: pinned.source?.displayName ?? null,
          sourceReleaseId: pinned.source?.releaseId ?? null,
        };
        await transaction
          .insertInto("diary_entry")
          .values({
            client_operation_id: input.clientOperationId,
            current_revision_id: revisionId,
            current_revision_number: "1",
            custom_food_id: facts.customFoodId,
            custom_food_version_number: facts.customFoodVersionNumber,
            diary_id: day.id,
            entry_kind: "food",
            food_serving_id: facts.servingId,
            food_version_id: facts.foodVersionId,
            id: entryId,
            input_unit: facts.inputUnit,
            local_time: coordinates.localTime,
            meal_slot: mealSlot,
            note,
            occurred_at: coordinates.occurredAt,
            position,
            quantity: facts.enteredAmount,
            recipe_version_id: null,
            repeated_from_revision_id: source.id,
            resolved_grams: facts.resolvedGrams,
            snapshot_engine_version: pinned.snapshotEngineVersion,
            snapshot_status: pinned.snapshotStatus,
            user_id: input.userId,
          })
          .execute();
        await insertRevision(transaction, {
          coordinates,
          dayId: day.id,
          entryId,
          facts,
          mealSlot,
          note,
          operation: "create",
          position,
          repeatedFromRevisionId: source.id,
          revisionId,
          revisionNumber: "1",
          userId: input.userId,
        });
      } else {
        await lockRepeatRecipeEligibility(transaction, pinned);
        const facts: Awaited<ReturnType<typeof loadRecipeDiaryFacts>> = {
          calculationAssumptions: pinned.recipe.calculationAssumptions,
          calculationVersion: pinned.recipe.calculationVersion,
          enteredAmount: pinned.portion.amount,
          inputUnit: pinned.portion.inputUnit,
          nutrients: pinned.nutrients,
          recipeId: pinned.recipe.recipeId,
          recipeName: pinned.recipe.name,
          recipeVersionId: pinned.recipe.recipeVersionId,
          recipeVersionNumber: pinned.recipe.versionNumber,
          resolvedGrams: pinned.portion.resolvedGrams,
          retentionPolicyCode: pinned.recipe.retentionPolicy.code,
          retentionPolicyVersion: pinned.recipe.retentionPolicy.version,
          servingCount: pinned.recipe.servingCount,
          servingLabel: pinned.recipe.servingLabel,
          sources: pinned.recipe.sources,
          warnings: pinned.recipe.warnings,
          yieldGrams: pinned.recipe.yieldGrams,
          yieldSource: pinned.recipe.yieldSource,
        };
        await transaction
          .insertInto("diary_entry")
          .values({
            client_operation_id: input.clientOperationId,
            current_revision_id: revisionId,
            current_revision_number: "1",
            custom_food_id: null,
            custom_food_version_number: null,
            diary_id: day.id,
            entry_kind: "recipe",
            food_serving_id: null,
            food_version_id: null,
            id: entryId,
            input_unit: facts.inputUnit,
            local_time: coordinates.localTime,
            meal_slot: mealSlot,
            note,
            occurred_at: coordinates.occurredAt,
            position,
            quantity: facts.enteredAmount,
            recipe_version_id: facts.recipeVersionId,
            repeated_from_revision_id: source.id,
            resolved_grams: facts.resolvedGrams,
            snapshot_engine_version: facts.calculationVersion,
            snapshot_status: snapshotStatus(facts.nutrients),
            user_id: input.userId,
          })
          .execute();
        await insertRecipeDiaryRevision(transaction, {
          coordinates,
          dayId: day.id,
          entryId,
          facts,
          mealSlot,
          note,
          operation: "create",
          position,
          repeatedFromRevisionId: source.id,
          revisionId,
          revisionNumber: "1",
          userId: input.userId,
        });
      }
      const dayRevision = await incrementDay(transaction, day.id, input.userId);
      const entry = await loadEntryByRevision(transaction, input.userId, revisionId);
      const result: DiaryMutationResult = {
        days: [{ localDate: coordinates.localDate, revision: dayRevision }],
        entry,
        replayed: false,
      };
      await recordOperation(transaction, input, "create", entryId, result);
      return result;
    });
}

export async function updateFoodDiaryEntry(
  database: Kysely<Database>,
  input: UpdateFoodDiaryEntryInput,
): Promise<DiaryFoodMutationResult> {
  const result = await runDiaryEntryUpdate(database, input, "food");
  if (result.entry.kind !== "food") throw new DiaryValidationError("Food diary result is invalid");
  return { ...result, entry: result.entry };
}

export async function updateRecipeDiaryEntry(
  database: Kysely<Database>,
  input: UpdateRecipeDiaryEntryInput,
): Promise<DiaryRecipeMutationResult> {
  const result = await runDiaryEntryUpdate(database, input, "recipe");
  if (result.entry.kind !== "recipe")
    throw new DiaryValidationError("Recipe diary result is invalid");
  return { ...result, entry: result.entry };
}

/** Transaction-safe dispatcher for PATCH when grams alone does not reveal the entry kind. */
export async function updateDiaryEntry(
  database: Kysely<Database>,
  input: UpdateDiaryEntryInput,
): Promise<DiaryMutationResult> {
  return runDiaryEntryUpdate(database, input);
}

async function runDiaryEntryUpdate(
  database: Kysely<Database>,
  input: UpdateDiaryEntryInput,
  expectedKind?: "food" | "recipe",
): Promise<DiaryMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  if (input.mealSlot !== undefined) validateMealSlot(input.mealSlot);
  if (input.note !== undefined) validateMutableDiaryNote(input.note);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserDiary(transaction, input.userId);
      const profile = await requireWritableProfile(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "update",
      );
      if (replay) return replay;
      const head = await loadOwnedHeadForUpdate(transaction, input.userId, input.entryId);
      if (!head || head.operation === "delete") throw new DiaryNotFoundError();
      if (expectedKind !== undefined && head.kind !== expectedKind) throw new DiaryNotFoundError();
      const expectedRevision = canonicalRevision(input.expectedEntryRevision);
      if (head.revisionNumber !== expectedRevision) throw new DiaryEntryRevisionConflictError();
      const coordinates = input.occurredAt
        ? deriveLocalCoordinates(input.occurredAt, profile.timeZone)
        : {
            localDate: head.localDate,
            localTime: head.localTime,
            occurredAt: head.occurredAt,
            timeZone: head.timeZone,
          };
      const targetDay = input.occurredAt
        ? await ensureDiaryDay(transaction, input.userId, coordinates, profile.timeZone)
        : { id: head.diaryId };
      const lockedDays = await lockDiaryDays(transaction, input.userId, [
        head.diaryId,
        targetDay.id,
      ]);
      if (lockedDays.some((day) => day.status === "locked")) throw new DiaryLockedError();
      const facts =
        head.kind === "food"
          ? input.portion
            ? preservePinnedProvenance(
                await loadFoodFacts(
                  transaction,
                  input.userId,
                  head.foodVersionId,
                  toFoodPortion(input.portion),
                  false,
                ),
                head,
              )
            : await loadPinnedFacts(transaction, head)
          : input.portion
            ? await loadRecipeDiaryFacts(transaction, {
                portion: toRecipePortion(input.portion),
                recipeId: head.recipeId,
                recipeVersionId: head.recipeVersionId,
                requireCurrent: false,
                userId: input.userId,
              })
            : await loadPinnedRecipeFacts(transaction, head);
      const revisionId = randomUUID();
      const revisionNumber = (BigInt(head.revisionNumber) + 1n).toString();
      const moved = head.diaryId !== targetDay.id;
      if (moved) await assertDayHasCapacity(transaction, input.userId, targetDay.id);
      await assertDayNutrientUnion(
        transaction,
        input.userId,
        targetDay.id,
        facts.nutrients,
        input.entryId,
      );
      const revisionInput = {
        coordinates,
        dayId: targetDay.id,
        entryId: input.entryId,
        facts,
        mealSlot: input.mealSlot ?? head.mealSlot,
        note: input.note === undefined ? head.note : input.note,
        operation: moved ? ("move" as const) : ("update" as const),
        position: canonicalPosition(input.position ?? head.position),
        revisionId,
        revisionNumber,
        userId: input.userId,
      };
      if (head.kind === "food" && "foodVersionId" in facts) {
        await insertRevision(transaction, { ...revisionInput, facts });
      } else if (head.kind === "recipe" && "recipeVersionId" in facts) {
        await insertRecipeDiaryRevision(transaction, { ...revisionInput, facts });
      } else {
        throw new DiaryValidationError("Diary entry facts do not match the entry kind");
      }
      await transaction
        .updateTable("diary_entry")
        .set({
          current_revision_id: revisionId,
          current_revision_number: revisionNumber,
          diary_id: targetDay.id,
        })
        .where("id", "=", input.entryId)
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const days: DiaryDayRevisionRecord[] = [];
      const sourceRevision = await incrementDay(transaction, head.diaryId, input.userId);
      days.push({ localDate: head.localDate, revision: sourceRevision });
      if (moved) {
        const targetRevision = await incrementDay(transaction, targetDay.id, input.userId);
        days.push({ localDate: coordinates.localDate, revision: targetRevision });
      }
      const entry = await loadEntryByRevision(transaction, input.userId, revisionId);
      const result: DiaryMutationResult = { days, entry, replayed: false };
      await recordOperation(transaction, input, "update", input.entryId, result);
      return result;
    });
}

export async function deleteDiaryEntry(
  database: Kysely<Database>,
  input: DeleteDiaryEntryInput,
): Promise<DiaryMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserDiary(transaction, input.userId);
      await requireWritableProfile(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "delete",
      );
      if (replay) return replay;
      const head = await loadOwnedHeadForUpdate(transaction, input.userId, input.entryId);
      if (!head || head.operation === "delete") throw new DiaryNotFoundError();
      if (head.revisionNumber !== canonicalRevision(input.expectedEntryRevision)) {
        throw new DiaryEntryRevisionConflictError();
      }
      const [lockedDay] = await lockDiaryDays(transaction, input.userId, [head.diaryId]);
      if (!lockedDay || lockedDay.status === "locked") throw new DiaryLockedError();
      const revisionId = randomUUID();
      const revisionNumber = (BigInt(head.revisionNumber) + 1n).toString();
      if (head.kind === "food") {
        const facts = await loadPinnedFacts(transaction, head);
        await insertRevision(transaction, {
          coordinates: {
            localDate: head.localDate,
            localTime: head.localTime,
            occurredAt: head.occurredAt,
            timeZone: head.timeZone,
          },
          dayId: head.diaryId,
          entryId: input.entryId,
          facts,
          mealSlot: head.mealSlot,
          note: head.note,
          operation: "delete",
          position: head.position,
          revisionId,
          revisionNumber,
          userId: input.userId,
        });
      } else {
        const facts = await loadPinnedRecipeFacts(transaction, head);
        await insertRecipeDiaryRevision(transaction, {
          coordinates: {
            localDate: head.localDate,
            localTime: head.localTime,
            occurredAt: head.occurredAt,
            timeZone: head.timeZone,
          },
          dayId: head.diaryId,
          entryId: input.entryId,
          facts,
          mealSlot: head.mealSlot,
          note: head.note,
          operation: "delete",
          position: head.position,
          revisionId,
          revisionNumber,
          userId: input.userId,
        });
      }
      await transaction
        .updateTable("diary_entry")
        .set({ current_revision_id: revisionId, current_revision_number: revisionNumber })
        .where("id", "=", input.entryId)
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const dayRevision = await incrementDay(transaction, head.diaryId, input.userId);
      const entry = await loadEntryByRevision(transaction, input.userId, revisionId);
      const result: DiaryMutationResult = {
        days: [{ localDate: head.localDate, revision: dayRevision }],
        entry,
        replayed: false,
      };
      await recordOperation(transaction, input, "delete", input.entryId, result);
      return result;
    });
}

export async function getDiaryDay(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly localDate: string },
): Promise<DiaryDayRecord> {
  validateLocalDate(input.localDate);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => readDiaryDaySnapshot(transaction, input));
}

export async function getDiaryDayPage(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly localDate: string;
    readonly limit: number;
    readonly continuation?: DiaryPageContinuationRecord;
  },
): Promise<DiaryDayPageRecord> {
  validateLocalDate(input.localDate);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
    throw new DiaryValidationError("Diary page limit must be between 1 and 20");
  }
  validateDiaryContinuation(input.continuation);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      const snapshot = await loadDiaryDaySnapshot(transaction, input);
      const offset = input.continuation?.offset ?? 0;
      if (input.continuation) {
        const continuation = input.continuation;
        if (
          snapshot.day.id === null ||
          snapshot.day.id !== continuation.dayId ||
          snapshot.day.revision !== continuation.dayRevision ||
          snapshot.day.status !== continuation.status ||
          snapshot.day.timeZone !== continuation.timeZone ||
          snapshot.snapshotDigest !== continuation.snapshotDigest ||
          snapshot.updatedAtMicroseconds !== continuation.updatedAtMicroseconds ||
          snapshot.entryIds[offset - 1] !== continuation.tailEntryId
        ) {
          throw new DiaryPageStaleError();
        }
      }
      const end = Math.min(offset + input.limit, snapshot.day.totalEntries);
      const entries = snapshot.day.entries.slice(offset, end);
      const nextTail = snapshot.entryIds[end - 1];
      const next =
        end < snapshot.day.totalEntries &&
        snapshot.day.id !== null &&
        snapshot.snapshotDigest !== null &&
        snapshot.updatedAtMicroseconds !== null &&
        nextTail
          ? {
              dayId: snapshot.day.id,
              dayRevision: snapshot.day.revision,
              offset: end,
              snapshotDigest: snapshot.snapshotDigest,
              status: snapshot.day.status,
              tailEntryId: nextTail,
              timeZone: snapshot.day.timeZone,
              updatedAtMicroseconds: snapshot.updatedAtMicroseconds,
            }
          : null;
      return {
        day: { ...snapshot.day, entries },
        page: { next, totalEntries: snapshot.day.totalEntries },
      };
    });
}

export async function readDiaryDaySnapshot(
  database: Transaction<Database>,
  input: { readonly userId: string; readonly localDate: string },
): Promise<DiaryDayRecord> {
  return (await loadDiaryDaySnapshot(database, input)).day;
}

interface DiaryDaySnapshot {
  readonly day: DiaryDayRecord;
  readonly entryIds: readonly string[];
  readonly snapshotDigest: string | null;
  readonly updatedAtMicroseconds: string | null;
}

async function loadDiaryDaySnapshot(
  database: Transaction<Database>,
  input: { readonly userId: string; readonly localDate: string },
): Promise<DiaryDaySnapshot> {
  const profile = await requireProfile(database, input.userId);
  const day = await database
    .selectFrom("diary")
    .select([
      "id",
      "revision",
      "status",
      "time_zone",
      "updated_at",
      sql<string>`to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        "updated_at_microseconds",
      ),
    ])
    .where("user_id", "=", input.userId)
    .where("local_date", "=", input.localDate)
    .executeTakeFirst();
  if (!day) {
    return {
      day: {
        entries: [],
        id: null,
        localDate: input.localDate,
        revision: "0",
        status: "open",
        timeZone: profile.timeZone,
        totalEntries: 0,
        totals: [],
        updatedAt: null,
      },
      entryIds: [],
      snapshotDigest: null,
      updatedAtMicroseconds: null,
    };
  }
  const heads = await database
    .selectFrom("diary_entry as entry")
    .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
    .select(["revision.id as revisionId", "entry.id as entryId"])
    .where("entry.user_id", "=", input.userId)
    .where("entry.diary_id", "=", day.id)
    .where("revision.operation", "!=", "delete")
    .orderBy(
      sql<number>`case revision.meal_slot when 'breakfast' then 0 when 'lunch' then 1 when 'dinner' then 2 when 'snacks' then 3 end`,
    )
    .orderBy("revision.position")
    .orderBy("revision.occurred_at")
    .orderBy("entry.id")
    .limit(MAX_DAY_ENTRIES + 1)
    .execute();
  if (heads.length > MAX_DAY_ENTRIES) {
    throw new DiaryValidationError("Diary day exceeds the supported entry limit");
  }
  const entries = await Promise.all(
    heads.map((head) => loadEntryByRevision(database, input.userId, head.revisionId)),
  );
  const snapshotDigest = createHash("sha256")
    .update(
      JSON.stringify([
        "diary-page-snapshot-v1",
        day.id,
        input.localDate,
        day.revision,
        day.status,
        profile.timeZone,
        day.updated_at_microseconds,
        heads.map((head) => [head.entryId, head.revisionId]),
      ]),
    )
    .digest("hex");
  return {
    day: {
      entries,
      id: day.id,
      localDate: input.localDate,
      revision: day.revision,
      status: day.status,
      timeZone: profile.timeZone,
      totalEntries: entries.length,
      totals: aggregateDayTotals(entries),
      updatedAt: day.updated_at.toISOString(),
    },
    entryIds: heads.map((head) => head.entryId),
    snapshotDigest,
    updatedAtMicroseconds: day.updated_at_microseconds,
  };
}

function validateDiaryContinuation(continuation: DiaryPageContinuationRecord | undefined): void {
  if (!continuation) return;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      continuation.dayId,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      continuation.tailEntryId,
    ) ||
    !/^[1-9][0-9]*$/u.test(continuation.dayRevision) ||
    !Number.isSafeInteger(continuation.offset) ||
    continuation.offset < 1 ||
    continuation.offset > MAX_DAY_ENTRIES ||
    !/^[0-9a-f]{64}$/u.test(continuation.snapshotDigest) ||
    !["locked", "open"].includes(continuation.status) ||
    continuation.timeZone.length < 1 ||
    continuation.timeZone.length > 100 ||
    !isCanonicalPostgresMicrosecondInstant(continuation.updatedAtMicroseconds)
  ) {
    throw new DiaryValidationError("Diary page continuation is invalid");
  }
}

function isCanonicalPostgresMicrosecondInstant(value: string): boolean {
  if (!/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(value))
    return false;
  const millisecondInstant = `${value.slice(0, 23)}Z`;
  const milliseconds = Date.parse(millisecondInstant);
  return (
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === millisecondInstant
  );
}

interface Coordinates {
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
}

interface FoodFacts {
  readonly foodVersionId: string;
  readonly foodName: string;
  readonly brandName: string | null;
  readonly servingId: string | null;
  readonly servingLabel: string | null;
  readonly enteredAmount: string;
  readonly inputUnit: string;
  readonly resolvedGrams: string;
  readonly nutrients: readonly DiaryNutrientAggregateRecord[];
  readonly sourceCode: string | null;
  readonly sourceReleaseId: string | null;
  readonly sourceDisplayName: string | null;
  readonly licenseExpression: string | null;
  readonly attributionRequired: boolean | null;
  readonly attributionText: string | null;
  readonly customFoodId: string | null;
  readonly customFoodVersionNumber: number | null;
}

interface FoodHeadRecord {
  readonly kind: "food";
  readonly diaryId: string;
  readonly revisionId: string;
  readonly revisionNumber: string;
  readonly operation: "create" | "delete" | "move" | "update";
  readonly foodVersionId: string;
  readonly foodName: string;
  readonly brandName: string | null;
  readonly servingId: string | null;
  readonly servingLabel: string | null;
  readonly enteredAmount: string;
  readonly inputUnit: string;
  readonly resolvedGrams: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly mealSlot: DiaryMealSlot;
  readonly position: number;
  readonly note: string | null;
  readonly timeZone: string;
  readonly sourceCode: string | null;
  readonly sourceReleaseId: string | null;
  readonly sourceDisplayName: string | null;
  readonly licenseExpression: string | null;
  readonly attributionRequired: boolean | null;
  readonly attributionText: string | null;
  readonly customFoodId: string | null;
  readonly customFoodVersionNumber: number | null;
}

interface RecipeHeadRecord {
  readonly kind: "recipe";
  readonly diaryId: string;
  readonly revisionId: string;
  readonly revisionNumber: string;
  readonly operation: "create" | "delete" | "move" | "update";
  readonly recipeId: string;
  readonly recipeVersionId: string;
  readonly recipeVersionNumber: number;
  readonly recipeName: string;
  readonly yieldGrams: string;
  readonly yieldSource: "estimated" | "measured";
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
  readonly enteredAmount: string;
  readonly inputUnit: "g" | "serving";
  readonly resolvedGrams: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly mealSlot: DiaryMealSlot;
  readonly position: number;
  readonly note: string | null;
  readonly timeZone: string;
  readonly calculationVersion: string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: string;
  readonly calculationAssumptions: JsonObject;
  readonly warnings: readonly RecipeWarningRecord[];
}

type HeadRecord = FoodHeadRecord | RecipeHeadRecord;

async function loadFoodFacts(
  transaction: Transaction<Database>,
  userId: string,
  foodVersionId: string,
  portion: DiaryPortionInput,
  requireEligible: boolean,
  expectedCustomFoodId?: string,
): Promise<FoodFacts> {
  const custom = await transaction
    .selectFrom("food_version as version")
    .innerJoin("food", "food.id", "version.food_id")
    .leftJoin("custom_food", "custom_food.food_id", "food.id")
    .select([
      "food.kind",
      "food.owner_user_id",
      "food.archived_at",
      "custom_food.id as custom_food_id",
      "custom_food.status as custom_status",
      "custom_food.current_food_version_id",
      "version.version_number",
    ])
    .where("version.id", "=", foodVersionId)
    .executeTakeFirst();
  const isCustom = custom?.kind === "custom";
  if (isCustom) {
    if (
      custom.owner_user_id !== userId ||
      !custom.custom_food_id ||
      (expectedCustomFoodId !== undefined && custom.custom_food_id !== expectedCustomFoodId)
    ) {
      throw new DiaryValidationError("Food version is unavailable for diary logging");
    }
    const locked = await transaction
      .selectFrom("custom_food")
      .select("id")
      .where("id", "=", custom.custom_food_id)
      .where("user_id", "=", userId)
      .forShare()
      .executeTakeFirst();
    if (!locked) throw new DiaryValidationError("Food version is unavailable for diary logging");
  } else if (requireEligible) {
    await lockFoodEligibility(transaction, foodVersionId);
  }
  // The nutrient registry is intentionally small and bounded. A table SHARE
  // lock gives this write one coherent active-definition generation and makes
  // activation/deactivation commit either wholly before or wholly after the
  // immutable snapshot. Source-backed creates acquire the canonical catalogue
  // locks first (source -> food -> version -> release -> nutrient) so source
  // mapping registration cannot deadlock with diary logging.
  await sql`lock table nutrient in share mode`.execute(transaction);
  const version =
    requireEligible && !isCustom
      ? await transaction
          .selectFrom("promoted_food_search_catalogue_v1")
          .select([
            "food_version_id",
            "name",
            "brand_name",
            "basis_quantity",
            "basis_unit",
            "source_code",
            "source_release_id",
            "source_display_name",
            "license_expression",
            "attribution_required",
            "attribution_text",
          ])
          .where("food_version_id", "=", foodVersionId)
          .executeTakeFirst()
      : await transaction
          .selectFrom("food_version as version")
          .innerJoin("food as food", "food.id", "version.food_id")
          .leftJoin("food_source as source", "source.id", "food.food_source_id")
          .select([
            "version.id as food_version_id",
            "version.name",
            "version.brand_name",
            "version.basis_quantity",
            "version.basis_unit",
            "source.code as source_code",
            "version.source_release_id",
            "source.display_name as source_display_name",
            "source.license_expression",
            "source.attribution_required",
            "source.attribution_text",
          ])
          .where("version.id", "=", foodVersionId)
          .executeTakeFirst();
  if (version?.basis_unit !== "g") {
    throw new DiaryValidationError("Food version is unavailable for diary logging");
  }
  if (
    !isCustom &&
    (!version.source_code ||
      !version.source_release_id ||
      !version.source_display_name ||
      !version.license_expression ||
      version.attribution_required === null ||
      !version.attribution_text)
  )
    throw new DiaryValidationError("Food version is unavailable for diary logging");
  let servingId: string | null = null;
  let servingLabel: string | null = null;
  let enteredAmount: string;
  let inputUnit: string;
  let resolvedGrams: string;
  if (portion.kind === "grams") {
    const grams = boundedPositiveDecimal(portion.grams, "grams");
    const resolved = resolvePortionToGrams({ kind: "mass", quantity: quantity(grams, "g") });
    enteredAmount = grams;
    inputUnit = "g";
    resolvedGrams = resolved.grams;
  } else {
    const serving = await transaction
      .selectFrom("food_serving")
      .select(["id", "label", "quantity", "unit", "gram_weight"])
      .where("id", "=", portion.servingId)
      .where("food_version_id", "=", foodVersionId)
      .executeTakeFirst();
    if (!serving?.gram_weight) throw new DiaryValidationError("Serving cannot resolve to grams");
    const amount = boundedPositiveDecimal(portion.amount, "serving amount");
    const resolved = resolvePortionToGrams({
      count: amount,
      kind: "serving-count",
      serving: {
        gramWeight: serving.gram_weight,
        id: serving.id,
        label: serving.label,
        reference: { amount: serving.quantity, unit: serving.unit },
        source: version.source_code ?? "pinned-food-version",
      },
    });
    servingId = serving.id;
    servingLabel = serving.label;
    enteredAmount = amount;
    inputUnit = "serving";
    resolvedGrams = boundedResolvedDecimal(resolved.grams);
  }
  const definitions = await loadNutrientDefinitions(transaction);
  const values = isCustom
    ? await transaction
        .selectFrom("custom_food_version_nutrient as value")
        .innerJoin("nutrient", "nutrient.id", "value.nutrient_id")
        .select([
          "nutrient.id",
          "nutrient.code",
          "nutrient.canonical_unit",
          "value.amount_per_100_grams as amount",
          sql<string>`100`.as("basis_quantity"),
          sql<"g">`'g'`.as("basis_unit"),
          "value.unit",
          "value.value_state",
          "value.unknown_reason",
        ])
        .where("value.food_version_id", "=", foodVersionId)
        .where("nutrient.active", "=", true)
        .execute()
    : await transaction
        .selectFrom("food_nutrient_value as value")
        .innerJoin("nutrient", "nutrient.id", "value.nutrient_id")
        .select([
          "nutrient.id",
          "nutrient.code",
          "nutrient.canonical_unit",
          "value.amount",
          "value.basis_quantity",
          "value.basis_unit",
          "value.unit",
          "value.value_status as value_state",
          sql<null>`null`.as("unknown_reason"),
        ])
        .where("value.food_version_id", "=", foodVersionId)
        .where("nutrient.active", "=", true)
        .execute();
  const profile = createNutrientProfile(
    version.basis_quantity,
    values.map((value) => {
      if (
        value.unit !== value.canonical_unit ||
        value.basis_unit !== "g" ||
        !decimal(value.basis_quantity).eq(version.basis_quantity)
      ) {
        throw new DiaryValidationError("Food nutrient facts use an incompatible unit or basis");
      }
      return nutrientDatum(
        definitions.byCode.get(value.code) ??
          defineNutrient({
            canonicalUnit: supportedNutrientUnit(value.canonical_unit),
            category: "other",
            id: value.code,
            name: value.code,
          }),
        value.value_state === "trace"
          ? traceNutrient(null)
          : value.value_state === "unknown"
            ? unknownNutrient(value.unknown_reason ?? "not_reported")
            : knownNutrient(value.amount ?? "0", normalizeQuality(value.value_state)),
      );
    }),
  );
  const calculated = calculatePortionNutrition(profile, resolvedGrams, definitions.list);
  const idByCode = new Map(definitions.rows.map((row) => [row.code, row.id]));
  const nameByCode = new Map(definitions.rows.map((row) => [row.code, row.name]));
  const nutrients = calculated.map((aggregate) => {
    const nutrientId = idByCode.get(aggregate.nutrientId);
    if (!nutrientId) throw new DiaryValidationError("Nutrient snapshot mapping is incomplete");
    return {
      code: aggregate.nutrientId,
      completeness: aggregate.completeness,
      contributorCount: aggregate.contributorCount,
      isExact: aggregate.isExact,
      knownAmount: boundedKnownAmount(aggregate.knownAmount),
      name: nameByCode.get(aggregate.nutrientId) ?? aggregate.nutrientId,
      nutrientId,
      quantifiedCount: aggregate.quantifiedCount,
      traceCount: aggregate.traceCount,
      unit: aggregate.unit,
      unknownCount: aggregate.unknownCount,
      unknownReasons: closedUnknownReasons(aggregate.unknownReasons),
    } satisfies DiaryNutrientAggregateRecord;
  });
  if (nutrients.length === 0) throw new DiaryValidationError("Nutrient snapshot is empty");
  return {
    brandName: version.brand_name,
    enteredAmount,
    foodName: version.name,
    foodVersionId: version.food_version_id,
    inputUnit,
    nutrients,
    resolvedGrams: boundedResolvedDecimal(resolvedGrams),
    servingId,
    servingLabel,
    sourceCode: version.source_code,
    sourceReleaseId: version.source_release_id,
    sourceDisplayName: version.source_display_name,
    licenseExpression: version.license_expression,
    attributionRequired: version.attribution_required,
    attributionText: version.attribution_text,
    customFoodId: isCustom ? (custom.custom_food_id ?? null) : null,
    customFoodVersionNumber: isCustom ? (custom.version_number ?? null) : null,
  };
}

async function lockFoodEligibility(
  transaction: Transaction<Database>,
  foodVersionId: string,
): Promise<void> {
  // Discover immutable identifiers without locks, then follow the catalogue
  // promotion order: source -> food -> version -> release. The promoted view is
  // queried only after all locks are held, so a concurrent pointer/rights change
  // is either fully visible or commits after this diary snapshot.
  const discovered = await transaction
    .selectFrom("food_version as version")
    .innerJoin("food", "food.id", "version.food_id")
    .select(["version.food_id", "version.source_release_id", "food.food_source_id"])
    .where("version.id", "=", foodVersionId)
    .executeTakeFirst();
  if (!discovered?.source_release_id || !discovered.food_source_id) {
    throw new DiaryValidationError("Food version is unavailable for diary logging");
  }
  const source = await transaction
    .selectFrom("food_source")
    .select("id")
    .where("id", "=", discovered.food_source_id)
    .forShare()
    .executeTakeFirst();
  if (!source) throw new DiaryValidationError("Food version is unavailable for diary logging");
  const food = await transaction
    .selectFrom("food")
    .select("food_source_id")
    .where("id", "=", discovered.food_id)
    .forShare()
    .executeTakeFirst();
  if (food?.food_source_id !== discovered.food_source_id) {
    throw new DiaryValidationError("Food version is unavailable for diary logging");
  }
  const version = await transaction
    .selectFrom("food_version")
    .select(["food_id", "source_release_id"])
    .where("id", "=", foodVersionId)
    .forShare()
    .executeTakeFirst();
  if (
    version?.food_id !== discovered.food_id ||
    version.source_release_id !== discovered.source_release_id
  ) {
    throw new DiaryValidationError("Food version is unavailable for diary logging");
  }
  const release = await transaction
    .selectFrom("food_source_release")
    .select("id")
    .where("id", "=", discovered.source_release_id)
    .where("food_source_id", "=", discovered.food_source_id)
    .forShare()
    .executeTakeFirst();
  if (!release) throw new DiaryValidationError("Food version is unavailable for diary logging");
}

async function lockRepeatFoodEligibility(
  transaction: Transaction<Database>,
  userId: string,
  entry: DiaryFoodEntryRecord,
): Promise<void> {
  if (entry.food.customFoodId) {
    const row = await transaction
      .selectFrom("custom_food as custom")
      .innerJoin("custom_food_version as version", "version.custom_food_id", "custom.id")
      .select("custom.id")
      .where("custom.id", "=", entry.food.customFoodId)
      .where("custom.user_id", "=", userId)
      .where("custom.status", "=", "active")
      .where("version.food_version_id", "=", entry.food.foodVersionId)
      .forShare("custom")
      .executeTakeFirst();
    if (!row) throw new DiaryNotFoundError();
    return;
  }
  if (!entry.source) throw new DiaryNotFoundError();
  const source = await transaction
    .selectFrom("food_source")
    .select("id")
    .where("code", "=", entry.source.code)
    .where("active", "=", true)
    .where("commercial_use_allowed", "=", true)
    .where("redistribution_allowed", "=", true)
    .where("rights_review_status", "in", ["approved", "restricted"])
    .where("rights_reviewed_at", "is not", null)
    .where(sql<boolean>`char_length(btrim(rights_reviewed_by)) > 0`)
    .forShare()
    .executeTakeFirst();
  if (!source) throw new DiaryNotFoundError();
  const release = await transaction
    .selectFrom("food_source_release")
    .select("id")
    .where("id", "=", entry.source.releaseId)
    .where("food_source_id", "=", source.id)
    .where("status", "=", "promoted")
    .where("promoted_at", "is not", null)
    .where("rights_manifest_sha256", "is not", null)
    .forShare()
    .executeTakeFirst();
  if (!release) throw new DiaryNotFoundError();
}

async function lockRepeatRecipeEligibility(
  transaction: Transaction<Database>,
  entry: DiaryRecipeEntryRecord,
): Promise<void> {
  for (const identity of [...entry.recipe.sources].sort((a, b) =>
    a.foodSourceId.localeCompare(b.foodSourceId),
  )) {
    const source = await transaction
      .selectFrom("food_source")
      .select("id")
      .where("id", "=", identity.foodSourceId)
      .where("code", "=", identity.code)
      .where("active", "=", true)
      .where("commercial_use_allowed", "=", true)
      .where("redistribution_allowed", "=", true)
      .where("rights_review_status", "in", ["approved", "restricted"])
      .where("rights_reviewed_at", "is not", null)
      .where(sql<boolean>`char_length(btrim(rights_reviewed_by)) > 0`)
      .forShare()
      .executeTakeFirst();
    if (!source) throw new DiaryNotFoundError();
    const release = await transaction
      .selectFrom("food_source_release")
      .select("id")
      .where("id", "=", identity.releaseId)
      .where("food_source_id", "=", identity.foodSourceId)
      .where("status", "=", "promoted")
      .where("promoted_at", "is not", null)
      .where("rights_manifest_sha256", "is not", null)
      .forShare()
      .executeTakeFirst();
    if (!release) throw new DiaryNotFoundError();
  }
}

async function loadPinnedFacts(
  database: Kysely<Database>,
  head: FoodHeadRecord,
): Promise<FoodFacts> {
  const nutrients = await loadRevisionNutrients(database, head.revisionId);
  return {
    brandName: head.brandName,
    enteredAmount: head.enteredAmount,
    foodName: head.foodName,
    foodVersionId: head.foodVersionId,
    inputUnit: head.inputUnit,
    nutrients,
    resolvedGrams: head.resolvedGrams,
    servingId: head.servingId,
    servingLabel: head.servingLabel,
    sourceCode: head.sourceCode,
    sourceReleaseId: head.sourceReleaseId,
    sourceDisplayName: head.sourceDisplayName,
    licenseExpression: head.licenseExpression,
    attributionRequired: head.attributionRequired,
    attributionText: head.attributionText,
    customFoodId: head.customFoodId,
    customFoodVersionNumber: head.customFoodVersionNumber,
  };
}

async function loadPinnedRecipeFacts(
  database: Kysely<Database>,
  head: RecipeHeadRecord,
): Promise<Awaited<ReturnType<typeof loadRecipeDiaryFacts>>> {
  return {
    calculationAssumptions: head.calculationAssumptions,
    calculationVersion: head.calculationVersion,
    enteredAmount: head.enteredAmount,
    inputUnit: head.inputUnit,
    nutrients: await loadRevisionNutrients(database, head.revisionId),
    recipeId: head.recipeId,
    recipeName: head.recipeName,
    recipeVersionId: head.recipeVersionId,
    recipeVersionNumber: head.recipeVersionNumber,
    resolvedGrams: head.resolvedGrams,
    retentionPolicyCode: head.retentionPolicyCode,
    retentionPolicyVersion: head.retentionPolicyVersion,
    servingCount: head.servingCount,
    servingLabel: head.servingLabel,
    sources: await loadRevisionSources(database, head.revisionId),
    warnings: head.warnings,
    yieldGrams: head.yieldGrams,
    yieldSource: head.yieldSource,
  };
}

async function insertRevision(
  transaction: Transaction<Database>,
  input: {
    readonly coordinates: Coordinates;
    readonly dayId: string;
    readonly entryId: string;
    readonly facts: FoodFacts;
    readonly mealSlot: DiaryMealSlot;
    readonly note: string | null;
    readonly operation: "create" | "delete" | "move" | "update";
    readonly position: number;
    readonly revisionId: string;
    readonly revisionNumber: string;
    readonly repeatedFromRevisionId?: string | null;
    readonly userId: string;
  },
): Promise<void> {
  await transaction
    .insertInto("diary_entry_revision")
    .values({
      brand_name: input.facts.brandName,
      attribution_required: input.facts.attributionRequired,
      attribution_text: input.facts.attributionText,
      diary_entry_id: input.entryId,
      diary_id: input.dayId,
      custom_food_id: input.facts.customFoodId,
      custom_food_version_number: input.facts.customFoodVersionNumber,
      entry_kind: "food",
      food_name: input.facts.foodName,
      food_serving_id: input.facts.servingId,
      food_version_id: input.facts.foodVersionId,
      license_expression: input.facts.licenseExpression,
      id: input.revisionId,
      input_unit: input.facts.inputUnit,
      local_date: input.coordinates.localDate,
      local_time: input.coordinates.localTime,
      meal_slot: input.mealSlot,
      note: input.note,
      nutrient_component_count: input.facts.nutrients.length,
      occurred_at: input.coordinates.occurredAt,
      operation: input.operation,
      position: input.position,
      quantity: input.facts.enteredAmount,
      recipe_version_id: null,
      resolved_quantity: input.facts.resolvedGrams,
      resolved_unit: "g",
      revision_number: input.revisionNumber,
      repeated_from_revision_id: input.repeatedFromRevisionId ?? null,
      serving_label: input.facts.servingLabel,
      source_code: input.facts.sourceCode,
      source_display_name: input.facts.sourceDisplayName,
      source_release_id: input.facts.sourceReleaseId,
      snapshot_engine_version: SNAPSHOT_ENGINE_VERSION,
      snapshot_status: snapshotStatus(input.facts.nutrients),
      time_zone: input.coordinates.timeZone,
      user_id: input.userId,
    })
    .execute();
  if (input.facts.nutrients.length > 0) {
    await transaction
      .insertInto("diary_entry_revision_nutrient")
      .values(
        input.facts.nutrients.map((nutrient) => ({
          completeness: nutrient.completeness,
          contributor_count: nutrient.contributorCount,
          diary_entry_revision_id: input.revisionId,
          is_exact: nutrient.isExact,
          known_amount: nutrient.knownAmount,
          nutrient_code: nutrient.code,
          nutrient_id: nutrient.nutrientId,
          nutrient_name: nutrient.name,
          quantified_count: nutrient.quantifiedCount,
          trace_count: nutrient.traceCount,
          unit: nutrient.unit,
          unknown_count: nutrient.unknownCount,
          unknown_reasons: nutrient.unknownReasons,
        })),
      )
      .execute();
  }
}

async function insertRecipeDiaryRevision(
  transaction: Transaction<Database>,
  input: {
    readonly coordinates: Coordinates;
    readonly dayId: string;
    readonly entryId: string;
    readonly facts: Awaited<ReturnType<typeof loadRecipeDiaryFacts>>;
    readonly mealSlot: DiaryMealSlot;
    readonly note: string | null;
    readonly operation: "create" | "delete" | "move" | "update";
    readonly position: number;
    readonly revisionId: string;
    readonly revisionNumber: string;
    readonly repeatedFromRevisionId?: string | null;
    readonly userId: string;
  },
): Promise<void> {
  await transaction
    .insertInto("diary_entry_revision")
    .values({
      attribution_required: null,
      attribution_text: null,
      brand_name: null,
      diary_entry_id: input.entryId,
      diary_id: input.dayId,
      entry_kind: "recipe",
      food_name: null,
      food_serving_id: null,
      food_version_id: null,
      id: input.revisionId,
      input_unit: input.facts.inputUnit,
      license_expression: null,
      local_date: input.coordinates.localDate,
      local_time: input.coordinates.localTime,
      meal_slot: input.mealSlot,
      note: input.note,
      nutrient_component_count: input.facts.nutrients.length,
      occurred_at: input.coordinates.occurredAt,
      operation: input.operation,
      position: input.position,
      quantity: input.facts.enteredAmount,
      recipe_calculation_assumptions: input.facts.calculationAssumptions,
      recipe_calculation_version: input.facts.calculationVersion,
      recipe_id: input.facts.recipeId,
      recipe_name: input.facts.recipeName,
      recipe_version_number: input.facts.recipeVersionNumber,
      recipe_retention_policy_code: input.facts.retentionPolicyCode,
      recipe_retention_policy_version: input.facts.retentionPolicyVersion,
      recipe_serving_count: input.facts.servingCount,
      recipe_serving_label: input.facts.servingLabel,
      recipe_version_id: input.facts.recipeVersionId,
      recipe_warnings: sql<JsonArray>`${JSON.stringify(input.facts.warnings)}::jsonb`,
      recipe_yield_grams: input.facts.yieldGrams,
      recipe_yield_source: input.facts.yieldSource,
      resolved_quantity: input.facts.resolvedGrams,
      resolved_unit: "g",
      revision_number: input.revisionNumber,
      repeated_from_revision_id: input.repeatedFromRevisionId ?? null,
      serving_label: input.facts.servingLabel,
      snapshot_engine_version: input.facts.calculationVersion,
      snapshot_status: snapshotStatus(input.facts.nutrients),
      source_code: null,
      source_component_count: input.facts.sources.length,
      source_display_name: null,
      source_release_id: null,
      time_zone: input.coordinates.timeZone,
      user_id: input.userId,
    })
    .execute();
  await transaction
    .insertInto("diary_entry_revision_nutrient")
    .values(
      input.facts.nutrients.map((nutrient) => ({
        completeness: nutrient.completeness,
        contributor_count: nutrient.contributorCount,
        diary_entry_revision_id: input.revisionId,
        is_exact: nutrient.isExact,
        known_amount: nutrient.knownAmount,
        nutrient_code: nutrient.code,
        nutrient_id: nutrient.nutrientId,
        nutrient_name: nutrient.name,
        quantified_count: nutrient.quantifiedCount,
        trace_count: nutrient.traceCount,
        unit: nutrient.unit,
        unknown_count: nutrient.unknownCount,
        unknown_reasons: nutrient.unknownReasons,
      })),
    )
    .execute();
  if (input.facts.sources.length)
    await transaction
      .insertInto("diary_entry_revision_source")
      .values(
        input.facts.sources.map((source) => ({
          attribution_required: source.attributionRequired,
          attribution_text: source.attributionText,
          diary_entry_revision_id: input.revisionId,
          food_source_id: source.foodSourceId,
          license_expression: source.licenseExpression,
          source_code: source.code,
          source_display_name: source.displayName,
          source_release_id: source.releaseId,
        })),
      )
      .execute();
}

async function loadEntryByRevision(
  database: Kysely<Database>,
  userId: string,
  revisionId: string,
): Promise<DiaryEntryRecord> {
  const baseQuery = database
    .selectFrom("diary_entry_revision as revision")
    .innerJoin("diary_entry as entry", "entry.id", "revision.diary_entry_id")
    .select([
      "entry.id",
      "revision.entry_kind",
      "revision.revision_number",
      "revision.operation",
      "revision.food_version_id",
      "revision.food_name",
      "revision.brand_name",
      "revision.source_code",
      "revision.source_release_id",
      "revision.source_display_name",
      "revision.license_expression",
      "revision.attribution_required",
      "revision.attribution_text",
      "revision.food_serving_id",
      "revision.serving_label",
      "revision.recipe_id",
      "revision.recipe_version_id",
      "revision.recipe_name",
      "revision.recipe_version_number",
      "revision.recipe_yield_grams",
      "revision.recipe_yield_source",
      "revision.recipe_serving_count",
      "revision.recipe_serving_label",
      "revision.recipe_calculation_version",
      "revision.recipe_retention_policy_code",
      "revision.recipe_retention_policy_version",
      "revision.recipe_calculation_assumptions",
      "revision.recipe_warnings",
      "revision.quantity",
      "revision.input_unit",
      "revision.resolved_quantity",
      "revision.occurred_at",
      "revision.local_date",
      "revision.local_time",
      "revision.time_zone",
      "revision.meal_slot",
      "revision.position",
      "revision.note",
      "revision.snapshot_status",
      "revision.snapshot_engine_version",
      "revision.created_at",
    ]);
  const query = (await hasRetentionDiaryColumns(database))
    ? baseQuery.select([
        "revision.custom_food_id",
        "revision.custom_food_version_number",
        "revision.repeated_from_revision_id",
      ])
    : baseQuery.select([
        sql<string | null>`null`.as("custom_food_id"),
        sql<number | null>`null`.as("custom_food_version_number"),
        sql<string | null>`null`.as("repeated_from_revision_id"),
      ]);
  const row = await query
    .where("revision.id", "=", revisionId)
    .where("revision.user_id", "=", userId)
    .executeTakeFirst();
  if (
    row?.entry_kind === "recipe" &&
    row.recipe_id &&
    row.recipe_version_id &&
    row.recipe_name &&
    row.recipe_version_number !== null &&
    row.recipe_yield_grams &&
    row.recipe_yield_source &&
    row.recipe_calculation_version &&
    row.recipe_retention_policy_code &&
    row.recipe_retention_policy_version &&
    row.recipe_calculation_assumptions &&
    row.recipe_warnings &&
    row.quantity &&
    row.input_unit &&
    row.resolved_quantity
  ) {
    return {
      createdAt: row.created_at.toISOString(),
      currentRevision: row.revision_number,
      id: row.id,
      kind: "recipe",
      localDate: normalizeDateOnly(row.local_date),
      localTime: row.local_time,
      mealSlot: row.meal_slot as DiaryMealSlot,
      note: row.note,
      nutrients: await loadRevisionNutrients(database, revisionId),
      occurredAt: row.occurred_at.toISOString(),
      operation: row.operation,
      portion: {
        amount: canonicalPositiveDecimal(row.quantity, "snapshot portion amount"),
        inputUnit: row.input_unit as "g" | "serving",
        resolvedGrams: canonicalPositiveDecimal(row.resolved_quantity, "snapshot resolved grams"),
      },
      position: row.position,
      repeatedFromRevisionId: row.repeated_from_revision_id,
      recipe: {
        calculationAssumptions: row.recipe_calculation_assumptions,
        calculationVersion: row.recipe_calculation_version,
        name: row.recipe_name,
        recipeId: row.recipe_id,
        recipeVersionId: row.recipe_version_id,
        versionNumber: row.recipe_version_number,
        retentionPolicy: {
          code: row.recipe_retention_policy_code,
          version: row.recipe_retention_policy_version,
        },
        servingCount:
          row.recipe_serving_count === null
            ? null
            : canonicalPositiveDecimal(row.recipe_serving_count, "recipe serving count"),
        servingLabel: row.recipe_serving_label,
        sources: await loadRevisionSources(database, revisionId),
        warnings: parseRecipeWarnings(row.recipe_warnings),
        yieldGrams: canonicalPositiveDecimal(row.recipe_yield_grams, "recipe yield grams"),
        yieldSource: row.recipe_yield_source,
      },
      snapshotEngineVersion: row.snapshot_engine_version,
      snapshotStatus: row.snapshot_status,
      timeZone: row.time_zone,
    };
  }
  if (
    row?.entry_kind !== "food" ||
    !row.food_version_id ||
    !row.food_name ||
    !row.quantity ||
    !row.input_unit ||
    !row.resolved_quantity ||
    !(
      (row.custom_food_id !== null && row.custom_food_version_number !== null) ||
      (row.source_code &&
        row.source_release_id &&
        row.source_display_name &&
        row.license_expression &&
        row.attribution_required !== null &&
        row.attribution_text)
    )
  ) {
    throw new DiaryNotFoundError();
  }
  return {
    createdAt: row.created_at.toISOString(),
    currentRevision: row.revision_number,
    food: {
      brandName: row.brand_name,
      customFoodId: row.custom_food_id,
      customFoodVersionNumber: row.custom_food_version_number,
      foodVersionId: row.food_version_id,
      name: row.food_name,
    },
    foodProvenance:
      row.custom_food_id && row.custom_food_version_number
        ? {
            customFoodId: row.custom_food_id,
            kind: "private_custom",
            statement: "Entered by the owner; not independently verified.",
            versionNumber: row.custom_food_version_number,
          }
        : { kind: "public" },
    id: row.id,
    kind: "food",
    localDate: normalizeDateOnly(row.local_date),
    localTime: row.local_time,
    mealSlot: row.meal_slot as DiaryMealSlot,
    note: row.note,
    nutrients: await loadRevisionNutrients(database, revisionId),
    occurredAt: row.occurred_at.toISOString(),
    operation: row.operation,
    portion: {
      amount: canonicalPositiveDecimal(row.quantity, "snapshot portion amount"),
      inputUnit: row.input_unit,
      resolvedGrams: canonicalPositiveDecimal(row.resolved_quantity, "snapshot resolved grams"),
      servingId: row.food_serving_id,
      servingLabel: row.serving_label,
    },
    position: row.position,
    repeatedFromRevisionId: row.repeated_from_revision_id,
    snapshotEngineVersion: row.snapshot_engine_version,
    snapshotStatus: row.snapshot_status,
    source:
      row.source_code &&
      row.source_release_id &&
      row.source_display_name &&
      row.license_expression &&
      row.attribution_required !== null &&
      row.attribution_text
        ? {
            attributionRequired: row.attribution_required,
            attributionText: row.attribution_text,
            code: row.source_code,
            displayName: row.source_display_name,
            licenseExpression: row.license_expression,
            releaseId: row.source_release_id,
          }
        : null,
    timeZone: row.time_zone,
  };
}

async function hasRetentionDiaryColumns(
  database: Kysely<Database> | Transaction<Database>,
): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    select exists (
      select 1 from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'diary_entry_revision'
        and column_name = 'custom_food_id'
    ) present
  `.execute(database);
  return result.rows[0]?.present === true;
}

async function loadRevisionNutrients(
  database: Kysely<Database>,
  revisionId: string,
): Promise<readonly DiaryNutrientAggregateRecord[]> {
  const rows = await database
    .selectFrom("diary_entry_revision_nutrient")
    .selectAll()
    .where("diary_entry_revision_id", "=", revisionId)
    .orderBy("nutrient_code")
    .limit(MAX_NUTRIENT_VECTOR_SIZE + 1)
    .execute();
  if (rows.length > MAX_NUTRIENT_VECTOR_SIZE) {
    throw new DiaryValidationError("Nutrient snapshot exceeds the supported vector size");
  }
  return rows.map((row) => ({
    code: row.nutrient_code,
    completeness: row.completeness,
    contributorCount: row.contributor_count,
    isExact: row.is_exact,
    knownAmount: boundedKnownAmount(row.known_amount),
    name: boundedNutrientName(row.nutrient_name),
    nutrientId: row.nutrient_id,
    quantifiedCount: row.quantified_count,
    traceCount: row.trace_count,
    unit: supportedNutrientUnit(row.unit),
    unknownCount: row.unknown_count,
    unknownReasons: closedUnknownReasons(row.unknown_reasons),
  }));
}

async function loadRevisionSources(
  database: Kysely<Database>,
  revisionId: string,
): Promise<readonly RecipeSourceRecord[]> {
  const rows = await database
    .selectFrom("diary_entry_revision_source")
    .selectAll()
    .where("diary_entry_revision_id", "=", revisionId)
    .orderBy("source_code")
    .orderBy("source_release_id")
    .limit(MAX_NUTRIENT_VECTOR_SIZE + 1)
    .execute();
  if (rows.length > MAX_NUTRIENT_VECTOR_SIZE) {
    throw new DiaryValidationError("Recipe source snapshot is invalid");
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

function parseRecipeWarnings(value: JsonArray): readonly RecipeWarningRecord[] {
  return value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof (candidate as JsonObject).code !== "string" ||
      typeof (candidate as JsonObject).message !== "string" ||
      !Array.isArray((candidate as JsonObject).nutrientIds) ||
      ((candidate as JsonObject).nutrientIds as JsonArray).some(
        (id: unknown) => typeof id !== "string",
      )
    ) {
      throw new DiaryValidationError("Recipe warning snapshot is invalid");
    }
    return {
      code: (candidate as JsonObject).code as string,
      message: (candidate as JsonObject).message as string,
      nutrientIds: (candidate as JsonObject).nutrientIds as string[],
    };
  });
}

async function loadOwnedHeadForUpdate(
  transaction: Transaction<Database>,
  userId: string,
  entryId: string,
): Promise<HeadRecord | null> {
  const baseQuery = transaction
    .selectFrom("diary_entry as entry")
    .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
    .select([
      "entry.diary_id",
      "revision.entry_kind",
      "revision.id as revision_id",
      "revision.revision_number",
      "revision.operation",
      "revision.food_version_id",
      "revision.food_name",
      "revision.brand_name",
      "revision.source_code",
      "revision.source_release_id",
      "revision.source_display_name",
      "revision.license_expression",
      "revision.attribution_required",
      "revision.attribution_text",
      "revision.food_serving_id",
      "revision.serving_label",
      "revision.recipe_id",
      "revision.recipe_version_id",
      "revision.recipe_name",
      "revision.recipe_version_number",
      "revision.recipe_yield_grams",
      "revision.recipe_yield_source",
      "revision.recipe_serving_count",
      "revision.recipe_serving_label",
      "revision.recipe_calculation_version",
      "revision.recipe_retention_policy_code",
      "revision.recipe_retention_policy_version",
      "revision.recipe_calculation_assumptions",
      "revision.recipe_warnings",
      "revision.quantity",
      "revision.input_unit",
      "revision.resolved_quantity",
      "revision.occurred_at",
      "revision.local_date",
      "revision.local_time",
      "revision.time_zone",
      "revision.meal_slot",
      "revision.position",
      "revision.note",
    ]);
  const query = (await hasRetentionDiaryColumns(transaction))
    ? baseQuery.select(["revision.custom_food_id", "revision.custom_food_version_number"])
    : baseQuery.select([
        sql<string | null>`null`.as("custom_food_id"),
        sql<number | null>`null`.as("custom_food_version_number"),
      ]);
  const row = await query
    .where("entry.id", "=", entryId)
    .where("entry.user_id", "=", userId)
    .forUpdate("entry")
    .executeTakeFirst();
  if (
    row?.entry_kind === "recipe" &&
    row.recipe_id &&
    row.recipe_version_id &&
    row.recipe_name &&
    row.recipe_version_number !== null &&
    row.recipe_yield_grams &&
    row.recipe_yield_source &&
    row.recipe_calculation_version &&
    row.recipe_retention_policy_code &&
    row.recipe_retention_policy_version &&
    row.recipe_calculation_assumptions &&
    row.recipe_warnings &&
    row.quantity &&
    row.input_unit &&
    row.resolved_quantity
  ) {
    return {
      calculationAssumptions: row.recipe_calculation_assumptions,
      calculationVersion: row.recipe_calculation_version,
      diaryId: row.diary_id,
      enteredAmount: canonicalPositiveDecimal(row.quantity, "snapshot portion amount"),
      inputUnit: row.input_unit as "g" | "serving",
      kind: "recipe",
      localDate: normalizeDateOnly(row.local_date),
      localTime: row.local_time,
      mealSlot: row.meal_slot as DiaryMealSlot,
      note: row.note,
      occurredAt: row.occurred_at.toISOString(),
      operation: row.operation,
      position: row.position,
      recipeId: row.recipe_id,
      recipeName: row.recipe_name,
      recipeVersionId: row.recipe_version_id,
      recipeVersionNumber: row.recipe_version_number,
      resolvedGrams: canonicalPositiveDecimal(row.resolved_quantity, "snapshot resolved grams"),
      retentionPolicyCode: row.recipe_retention_policy_code,
      retentionPolicyVersion: row.recipe_retention_policy_version,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      servingCount:
        row.recipe_serving_count === null
          ? null
          : canonicalPositiveDecimal(row.recipe_serving_count, "recipe serving count"),
      servingLabel: row.recipe_serving_label,
      timeZone: row.time_zone,
      warnings: parseRecipeWarnings(row.recipe_warnings),
      yieldGrams: canonicalPositiveDecimal(row.recipe_yield_grams, "recipe yield grams"),
      yieldSource: row.recipe_yield_source,
    };
  }
  if (
    row?.entry_kind !== "food" ||
    !row.food_version_id ||
    !row.food_name ||
    !row.quantity ||
    !row.input_unit ||
    !row.resolved_quantity ||
    !(
      (row.custom_food_id !== null && row.custom_food_version_number !== null) ||
      (row.source_code &&
        row.source_release_id &&
        row.source_display_name &&
        row.license_expression &&
        row.attribution_required !== null &&
        row.attribution_text)
    )
  )
    return null;
  return {
    brandName: row.brand_name,
    diaryId: row.diary_id,
    enteredAmount: canonicalPositiveDecimal(row.quantity, "snapshot portion amount"),
    foodName: row.food_name,
    foodVersionId: row.food_version_id,
    inputUnit: row.input_unit,
    kind: "food",
    customFoodId: row.custom_food_id,
    customFoodVersionNumber: row.custom_food_version_number,
    localDate: normalizeDateOnly(row.local_date),
    localTime: row.local_time,
    mealSlot: row.meal_slot as DiaryMealSlot,
    note: row.note,
    occurredAt: row.occurred_at.toISOString(),
    operation: row.operation,
    position: row.position,
    resolvedGrams: canonicalPositiveDecimal(row.resolved_quantity, "snapshot resolved grams"),
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    servingId: row.food_serving_id,
    servingLabel: row.serving_label,
    sourceCode: row.source_code,
    sourceReleaseId: row.source_release_id,
    timeZone: row.time_zone,
    sourceDisplayName: row.source_display_name,
    licenseExpression: row.license_expression,
    attributionRequired: row.attribution_required,
    attributionText: row.attribution_text,
  };
}

function preservePinnedProvenance(facts: FoodFacts, head: FoodHeadRecord): FoodFacts {
  return {
    ...facts,
    attributionRequired: head.attributionRequired,
    attributionText: head.attributionText,
    brandName: head.brandName,
    foodName: head.foodName,
    licenseExpression: head.licenseExpression,
    sourceCode: head.sourceCode,
    sourceDisplayName: head.sourceDisplayName,
    sourceReleaseId: head.sourceReleaseId,
  };
}

function aggregateDayTotals(
  entries: readonly DiaryEntryRecord[],
): readonly DiaryNutrientAggregateRecord[] {
  if (entries.length === 0) return [];
  const metadata = new Map<string, DiaryNutrientAggregateRecord>();
  for (const entry of entries)
    for (const nutrient of entry.nutrients) metadata.set(nutrient.code, nutrient);
  if (metadata.size > MAX_NUTRIENT_VECTOR_SIZE) {
    throw new DiaryValidationError("Diary totals exceed the supported nutrient vector size");
  }
  return [...metadata.values()]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((meta) => {
      const definition = defineNutrient({
        canonicalUnit: meta.unit as NutrientUnit,
        category: "other",
        id: meta.code,
        name: meta.name,
      });
      const contributions = entries.map((entry) => {
        const value = entry.nutrients.find((candidate) => candidate.code === meta.code);
        return value ? toDomainAggregate(value) : missingAggregate(definition);
      });
      const total = combineNutrientAggregates(definition, contributions);
      return {
        code: meta.code,
        completeness: total.completeness,
        contributorCount: total.contributorCount,
        isExact: total.isExact,
        knownAmount: boundedKnownAmount(total.knownAmount),
        name: meta.name,
        nutrientId: meta.nutrientId,
        quantifiedCount: total.quantifiedCount,
        traceCount: total.traceCount,
        unit: total.unit,
        unknownCount: total.unknownCount,
        unknownReasons: closedUnknownReasons(total.unknownReasons),
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

function missingAggregate(definition: NutrientDefinition): NutrientAggregate {
  return {
    completeness: "unknown",
    contributorCount: 1,
    isExact: false,
    knownAmount: "0",
    nutrientId: definition.id,
    quantifiedCount: 0,
    traceCount: 0,
    unit: definition.canonicalUnit,
    unknownCount: 1,
    unknownReasons: { not_reported: 1 },
  };
}

async function loadNutrientDefinitions(database: Kysely<Database>): Promise<{
  readonly byCode: Map<string, NutrientDefinition>;
  readonly list: readonly NutrientDefinition[];
  readonly rows: readonly { readonly id: string; readonly code: string; readonly name: string }[];
}> {
  const rows = await database
    .selectFrom("nutrient")
    .select(["id", "code", "name", "canonical_unit"])
    .where("active", "=", true)
    .orderBy("display_order")
    .orderBy("id")
    .execute();
  if (rows.length === 0) {
    throw new DiaryValidationError("No active nutrient definitions are available");
  }
  if (rows.length > MAX_NUTRIENT_VECTOR_SIZE) {
    throw new DiaryValidationError("Active nutrient registry exceeds the supported vector size");
  }
  const list = rows.map((row) =>
    defineNutrient({
      canonicalUnit: supportedNutrientUnit(row.canonical_unit) as NutrientUnit,
      category: "other",
      id: row.code,
      name: boundedNutrientName(row.name),
    }),
  );
  return { byCode: new Map(list.map((definition) => [definition.id, definition])), list, rows };
}

async function requireProfile(
  database: Kysely<Database>,
  userId: string,
): Promise<{ timeZone: string }> {
  const row = await database
    .selectFrom("user_profile as profile")
    .innerJoin("app_user as user", "user.id", "profile.user_id")
    .select("profile.time_zone")
    .where("profile.user_id", "=", userId)
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new DiaryNotFoundError();
  return { timeZone: row.time_zone };
}

async function requireWritableProfile(
  transaction: Transaction<Database>,
  userId: string,
): Promise<{ timeZone: string }> {
  await lockActiveDiaryUser(transaction, userId);
  return requireLockedProfile(transaction, userId);
}

async function lockActiveDiaryUser(
  transaction: Transaction<Database>,
  userId: string,
): Promise<void> {
  const row = await transaction
    .selectFrom("app_user")
    .select("id")
    .where("id", "=", userId)
    .where("status", "=", "active")
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new DiaryNotFoundError();
}

async function requireLockedProfile(
  transaction: Transaction<Database>,
  userId: string,
): Promise<{ timeZone: string }> {
  const row = await transaction
    .selectFrom("user_profile")
    .select("time_zone")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new DiaryNotFoundError();
  return { timeZone: row.time_zone };
}

function deriveLocalCoordinates(occurredAt: string, timeZone: string): Coordinates {
  try {
    const coordinates = deriveDiaryLocalCoordinates(occurredAt, timeZone);
    return {
      localDate: coordinates.localDate,
      localTime: coordinates.localTime,
      occurredAt: coordinates.occurredAt,
      timeZone: coordinates.timeZone,
    };
  } catch {
    throw new DiaryValidationError("occurredAt must be a valid RFC 3339 instant");
  }
}

async function ensureDiaryDay(
  transaction: Transaction<Database>,
  userId: string,
  coordinates: Coordinates,
  timeZone: string,
): Promise<{ id: string }> {
  await transaction
    .insertInto("diary")
    .values({ local_date: coordinates.localDate, time_zone: timeZone, user_id: userId })
    .onConflict((conflict) => conflict.columns(["user_id", "local_date"]).doNothing())
    .execute();
  const day = await transaction
    .selectFrom("diary")
    .select("id")
    .where("user_id", "=", userId)
    .where("local_date", "=", coordinates.localDate)
    .executeTakeFirstOrThrow();
  return day;
}

async function lockDiaryDays(
  transaction: Transaction<Database>,
  userId: string,
  diaryIds: readonly string[],
): Promise<readonly { readonly id: string; readonly status: "locked" | "open" }[]> {
  const uniqueIds = [...new Set(diaryIds)].sort();
  const days = await transaction
    .selectFrom("diary")
    .select(["id", "status"])
    .where("user_id", "=", userId)
    .where("id", "in", uniqueIds)
    .orderBy("id")
    .forUpdate()
    .execute();
  if (days.length !== uniqueIds.length) throw new DiaryNotFoundError();
  return days;
}

async function assertDayHasCapacity(
  transaction: Transaction<Database>,
  userId: string,
  diaryId: string,
): Promise<void> {
  const row = await transaction
    .selectFrom("diary_entry as entry")
    .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("entry.user_id", "=", userId)
    .where("entry.diary_id", "=", diaryId)
    .where("revision.operation", "!=", "delete")
    .executeTakeFirstOrThrow();
  if (BigInt(row.count) >= BigInt(MAX_DAY_ENTRIES)) {
    throw new DiaryValidationError("Diary day has reached the supported entry limit");
  }
}

async function assertDayNutrientUnion(
  transaction: Transaction<Database>,
  userId: string,
  diaryId: string,
  nextVector: readonly DiaryNutrientAggregateRecord[],
  replacedEntryId?: string,
): Promise<void> {
  let query = transaction
    .selectFrom("diary_entry as entry")
    .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
    .innerJoin(
      "diary_entry_revision_nutrient as snapshot",
      "snapshot.diary_entry_revision_id",
      "revision.id",
    )
    .select("snapshot.nutrient_id")
    .distinct()
    .where("entry.user_id", "=", userId)
    .where("entry.diary_id", "=", diaryId)
    .where("revision.operation", "!=", "delete");
  if (replacedEntryId !== undefined) query = query.where("entry.id", "!=", replacedEntryId);
  const existing = await query.limit(MAX_NUTRIENT_VECTOR_SIZE + 1).execute();
  const union = new Set(existing.map((row) => row.nutrient_id));
  for (const nutrient of nextVector) union.add(nutrient.nutrientId);
  if (union.size > MAX_NUTRIENT_VECTOR_SIZE) {
    throw new DiaryValidationError("Diary day exceeds the supported nutrient vector size");
  }
}

async function incrementDay(
  transaction: Transaction<Database>,
  diaryId: string,
  userId: string,
): Promise<string> {
  const row = await transaction
    .updateTable("diary")
    .set({ revision: sql<string>`revision + 1` })
    .where("id", "=", diaryId)
    .where("user_id", "=", userId)
    .returning("revision")
    .executeTakeFirst();
  if (!row) throw new DiaryNotFoundError();
  return row.revision;
}

async function lockUserDiary(transaction: Transaction<Database>, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:diary:${userId}`}, 0))`.execute(
    transaction,
  );
}

async function readOperationReplay(
  transaction: Transaction<Database>,
  userId: string,
  clientOperationId: string,
  requestDigest: string,
  operation: "create" | "delete" | "update",
): Promise<DiaryMutationResult | null> {
  const existing = await transaction
    .selectFrom("diary_operation")
    .select(["request_digest", "operation", "result_payload"])
    .where("user_id", "=", userId)
    .where("client_operation_id", "=", clientOperationId)
    .executeTakeFirst();
  if (!existing) {
    // 0001 stored the client operation key on the logical entry but did not
    // retain a request digest or response payload. Exact replay cannot be
    // reconstructed after upgrading, so reserve every legacy key and return a
    // stable typed conflict instead of leaking a PostgreSQL unique violation.
    const legacyReservation = await transaction
      .selectFrom("diary_entry")
      .select("id")
      .where("user_id", "=", userId)
      .where("client_operation_id", "=", clientOperationId)
      .executeTakeFirst();
    if (legacyReservation) throw new DiaryIdempotencyConflictError();
    return null;
  }
  if (existing.request_digest !== requestDigest || existing.operation !== operation) {
    throw new DiaryIdempotencyConflictError();
  }
  return { ...(existing.result_payload as unknown as DiaryMutationResult), replayed: true };
}

async function recordOperation(
  transaction: Transaction<Database>,
  input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
  },
  operation: "create" | "delete" | "update",
  entryId: string,
  result: DiaryMutationResult,
): Promise<void> {
  await transaction
    .insertInto("diary_operation")
    .values({
      client_operation_id: input.clientOperationId,
      diary_entry_id: entryId,
      operation,
      request_digest: input.requestDigest,
      result_payload: JSON.parse(JSON.stringify(result)) as JsonObject,
      user_id: input.userId,
    })
    .execute();
}

function normalizeQuality(value: string): "calculated" | "estimated" | "label" | "measured" {
  return value === "calculated" ||
    value === "estimated" ||
    value === "label" ||
    value === "measured"
    ? value
    : "estimated";
}

function canonicalRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) throw new DiaryValidationError("Revision must be positive");
  return text;
}

function canonicalPosition(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    throw new DiaryValidationError("position is invalid");
  return value;
}

function boundedNutrientName(value: string): string {
  if (value.trim().length === 0 || [...value].length > 200) {
    throw new DiaryValidationError("Nutrient name exceeds the supported boundary");
  }
  return value;
}

function supportedNutrientUnit(value: string): NutrientUnit {
  if ([...value].length > 32 || !NUTRIENT_UNITS.includes(value as NutrientUnit)) {
    throw new DiaryValidationError("Nutrient unit is unsupported");
  }
  return value as NutrientUnit;
}

function validateOperationIdentity(clientOperationId: string, requestDigest: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      clientOperationId,
    )
  ) {
    throw new DiaryValidationError("clientOperationId must be a UUID");
  }
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) {
    throw new DiaryValidationError("requestDigest must be a lowercase SHA-256 hex");
  }
}

function optionalExpectedProfileTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return canonicalIanaTimeZone(value);
  } catch {
    throw new DiaryValidationError(
      "expectedProfileTimeZone must be a supported IANA time-zone identifier",
    );
  }
}

function validateMealSlot(value: string): asserts value is DiaryMealSlot {
  if (!(["breakfast", "lunch", "dinner", "snacks"] as const).includes(value as DiaryMealSlot)) {
    throw new DiaryValidationError("mealSlot is invalid");
  }
}

function containsOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateMutableDiaryNote(value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    !containsOnlyUnicodeScalarValues(value) ||
    [...value].length > MAX_MUTABLE_DIARY_NOTE_CODE_POINTS
  ) {
    throw new DiaryValidationError("note is invalid");
  }
}

function toFoodPortion(value: NonNullable<UpdateDiaryEntryInput["portion"]>): DiaryPortionInput {
  if (value.kind === "grams") return value;
  if (!("servingId" in value) || typeof value.servingId !== "string") {
    throw new DiaryValidationError("Food serving portion requires servingId");
  }
  return { amount: value.amount, kind: "serving", servingId: value.servingId };
}

function toRecipePortion(
  value: NonNullable<UpdateDiaryEntryInput["portion"]>,
): CreateRecipeDiaryEntryInput["portion"] {
  if (value.kind === "grams") return value;
  if ("servingId" in value) {
    throw new DiaryValidationError("Recipe serving portion must not include a food servingId");
  }
  return { amount: value.amount, kind: "serving" };
}

function validateLocalDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new DiaryValidationError("localDate is invalid");
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const year = Number(match[1]);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new DiaryValidationError("localDate is invalid");
  }
}

function normalizeDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function boundedPositiveDecimal(value: string, field: string): string {
  try {
    if (!/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value)) {
      throw new Error("non-canonical decimal");
    }
    const canonical = canonicalPositiveDecimal(value, field);
    if (decimal(canonical).gte("1000000000000")) {
      throw new Error("out of range");
    }
    return canonical;
  } catch {
    throw new DiaryValidationError(`${field} is invalid or out of range`);
  }
}

function boundedResolvedDecimal(value: string): string {
  try {
    const canonical = canonicalPositiveDecimal(value, "resolved grams");
    if (decimal(canonical).gte("1000000000000000000") || canonical.length > 160) {
      throw new Error("out of range");
    }
    return canonical;
  } catch {
    throw new DiaryValidationError("resolved grams is invalid or out of range");
  }
}

function boundedKnownAmount(value: string): string {
  try {
    const canonical = canonicalNonNegativeDecimal(value, "snapshot nutrient amount");
    if (canonical.length > 160) throw new Error("out of range");
    return canonical;
  } catch {
    throw new DiaryValidationError("snapshot nutrient amount is invalid or out of range");
  }
}

function closedUnknownReasons(reasons: Readonly<Record<string, unknown>>): JsonObject {
  return {
    not_analyzed: numericReason(reasons.not_analyzed),
    not_applicable: numericReason(reasons.not_applicable),
    not_reported: numericReason(reasons.not_reported),
    withheld: numericReason(reasons.withheld),
  };
}

function numericReason(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function snapshotStatus(
  nutrients: readonly DiaryNutrientAggregateRecord[],
): "complete" | "partial" {
  return nutrients.some((nutrient) => nutrient.unknownCount > 0) ? "partial" : "complete";
}
