import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  MIFFLIN_ST_JEOR_SOURCE,
  NUTRITION_ENGINE_VERSION,
  PRODUCT_PAL_POLICY,
} from "@nutrition-tracker/domain";
import { sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";

import {
  assertDatabaseMigrationLedgerReady,
  canonicalJson,
  createDatabase,
  createFoodDiaryEntry,
  createNutritionGoal,
  createRecipe,
  createRecipeDiaryEntry,
  type Database,
  DiaryIdempotencyConflictError,
  DiaryTimeZoneChangedError,
  deleteDiaryEntry,
  getCurrentNutritionGoal,
  getDiaryDay,
  getNutritionGoal,
  getNutritionGoalProgress,
  getRecipe,
  type JsonObject,
  listRecipes,
  listReferenceTargetSets,
  listTargetableNutrients,
  NutritionGoalPeriodConflictError,
  NutritionGoalPersistedIntegrityError,
  NutritionGoalProfileRevisionConflictError,
  NutritionGoalReferenceUnavailableError,
  NutritionGoalRevisionConflictError,
  NutritionGoalUnsupportedProfileError,
  NutritionGoalValidationError,
  REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
  REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
  REFERENCE_TARGET_TEMPLATE_CODE,
  REFERENCE_TARGET_TEMPLATE_VERSION,
  RecipeCursorError,
  type RecipeDraft,
  RecipeIdempotencyConflictError,
  RecipeNotFoundError,
  RecipeRevisionConflictError,
  RecipeValidationError,
  registerPasswordAccount,
  repeatDiaryEntry,
  reviseNutritionGoal,
  reviseRecipe,
  runMigrations,
  sha256CanonicalJson,
  updateDiaryEntry,
  updateUserProfile,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const FIXTURE_EVIDENCE_VALID_UNTIL = new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("versioned recipes, recipe diary entries, and nutrition goals", () => {
  it("persists exact food and recipe notes across revisions, replay, clear, and repeat", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "diary_notes");
    try {
      const recipe = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        recipe: foodRecipeDraft(fixture.catalogue.foodVersionId, fixture.catalogue.servingId, {
          servingCount: "1",
          servingLabel: "bowl",
          yieldGrams: "50",
        }),
        requestDigest: randomBytes(32).toString("hex"),
        userId: fixture.owner.userId,
      });
      const food = await createFoodDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        foodVersionId: fixture.catalogue.foodVersionId,
        mealSlot: "lunch",
        occurredAt: "2026-08-20T17:00:00Z",
        portion: {
          amount: "1",
          kind: "serving",
          servingId: fixture.catalogue.servingId,
        },
        requestDigest: randomBytes(32).toString("hex"),
        userId: fixture.owner.userId,
      });
      const recipeLog = await createRecipeDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        mealSlot: "dinner",
        occurredAt: "2026-08-20T23:00:00Z",
        portion: { amount: "1", kind: "serving" },
        recipeId: recipe.recipe.id,
        recipeVersionId: recipe.recipe.currentVersion.id,
        requestDigest: randomBytes(32).toString("hex"),
        userId: fixture.owner.userId,
      });

      expect(food.entry.note).toBeNull();
      expect(recipeLog.entry.note).toBeNull();
      const cases = [
        {
          entryId: food.entry.id,
          note: "  food 😀 note\r\nkeep exact spacing  ",
          repeatClearedAt: "2026-08-22T17:00:00Z",
          repeatSetAt: "2026-08-21T17:00:00Z",
        },
        {
          entryId: recipeLog.entry.id,
          note: "\tRecipe 🍲 note\nsecond line\t",
          repeatClearedAt: "2026-08-24T17:00:00Z",
          repeatSetAt: "2026-08-23T17:00:00Z",
        },
      ] as const;

      for (const testCase of cases) {
        const setInput = {
          clientOperationId: randomUUID(),
          entryId: testCase.entryId,
          expectedEntryRevision: "1",
          note: testCase.note,
          requestDigest: randomBytes(32).toString("hex"),
          userId: fixture.owner.userId,
        };
        const set = await updateDiaryEntry(fixture.database, setInput);
        expect(set).toMatchObject({
          entry: { currentRevision: "2", note: testCase.note },
          replayed: false,
        });
        expect(
          (
            await getDiaryDay(fixture.database, {
              localDate: set.entry.localDate,
              userId: fixture.owner.userId,
            })
          ).entries.find((entry) => entry.id === testCase.entryId),
        ).toMatchObject({ note: testCase.note });

        expect(await updateDiaryEntry(fixture.database, setInput)).toMatchObject({
          entry: { currentRevision: "2", note: testCase.note },
          replayed: true,
        });
        await expect(
          updateDiaryEntry(fixture.database, {
            ...setInput,
            requestDigest: randomBytes(32).toString("hex"),
          }),
        ).rejects.toBeInstanceOf(DiaryIdempotencyConflictError);

        const cleared = await updateDiaryEntry(fixture.database, {
          clientOperationId: randomUUID(),
          entryId: testCase.entryId,
          expectedEntryRevision: "2",
          note: null,
          requestDigest: randomBytes(32).toString("hex"),
          userId: fixture.owner.userId,
        });
        expect(cleared).toMatchObject({
          entry: { currentRevision: "3", note: null },
          replayed: false,
        });
        expect(
          (
            await getDiaryDay(fixture.database, {
              localDate: cleared.entry.localDate,
              userId: fixture.owner.userId,
            })
          ).entries.find((entry) => entry.id === testCase.entryId),
        ).toMatchObject({ note: null });
        expect(
          await fixture.database
            .selectFrom("diary_entry_revision")
            .select(["revision_number", "note"])
            .where("diary_entry_id", "=", testCase.entryId)
            .orderBy("revision_number", "asc")
            .execute(),
        ).toEqual([
          { note: null, revision_number: "1" },
          { note: testCase.note, revision_number: "2" },
          { note: null, revision_number: "3" },
        ]);

        for (const source of [
          { expectedNote: testCase.note, occurredAt: testCase.repeatSetAt, revision: "2" },
          { expectedNote: null, occurredAt: testCase.repeatClearedAt, revision: "3" },
        ] as const) {
          const repeated = await repeatDiaryEntry(fixture.database, {
            clientOperationId: randomUUID(),
            occurredAt: source.occurredAt,
            requestDigest: randomBytes(32).toString("hex"),
            sourceEntryId: testCase.entryId,
            sourceRevision: source.revision,
            userId: fixture.owner.userId,
          });
          expect(repeated.entry).toMatchObject({
            currentRevision: "1",
            note: source.expectedNote,
            repeatedFromRevisionId: expect.any(String),
          });
        }
      }
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("guards recipe logging against profile-zone drift and replays exact commits first", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "recipe_zone_guard");
    try {
      const recipe = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        recipe: foodRecipeDraft(fixture.catalogue.foodVersionId, fixture.catalogue.servingId, {
          servingCount: "1",
          servingLabel: "bowl",
          yieldGrams: "50",
        }),
        requestDigest: "1".repeat(64),
        userId: fixture.owner.userId,
      });
      const guardedInput = {
        clientOperationId: randomUUID(),
        expectedProfileTimeZone: "America/Chicago",
        mealSlot: "breakfast" as const,
        occurredAt: "2026-08-15T05:30:00Z",
        portion: { amount: "1", kind: "serving" as const },
        recipeId: recipe.recipe.id,
        recipeVersionId: recipe.recipe.currentVersion.id,
        requestDigest: "2".repeat(64),
        userId: fixture.owner.userId,
      };
      const mismatchedOperationId = randomUUID();
      await expect(
        createRecipeDiaryEntry(fixture.database, {
          ...guardedInput,
          clientOperationId: mismatchedOperationId,
          expectedProfileTimeZone: "Asia/Tokyo",
          requestDigest: "3".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryTimeZoneChangedError);
      for (const table of ["diary_entry", "diary_operation"] as const) {
        expect(
          await fixture.database
            .selectFrom(table)
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", fixture.owner.userId)
            .where("client_operation_id", "=", mismatchedOperationId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ count: "0" });
      }

      const created = await createRecipeDiaryEntry(fixture.database, guardedInput);
      expect(created).toMatchObject({
        entry: { localDate: "2026-08-15", timeZone: "America/Chicago" },
        replayed: false,
      });
      await updateUserProfile(fixture.database, {
        expectedRevision: "0",
        patch: { timeZone: "Asia/Tokyo" },
        userId: fixture.owner.userId,
      });
      await expect(createRecipeDiaryEntry(fixture.database, guardedInput)).resolves.toMatchObject({
        entry: {
          id: created.entry.id,
          localDate: "2026-08-15",
          timeZone: "America/Chicago",
        },
        replayed: true,
      });
      await expect(
        createRecipeDiaryEntry(fixture.database, {
          ...guardedInput,
          expectedProfileTimeZone: "Asia/Tokyo",
          requestDigest: "4".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryIdempotencyConflictError);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("persists explainable recipe history and logs a pinned recipe version", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "recipes");
    try {
      const draft = foodRecipeDraft(fixture.catalogue.foodVersionId, fixture.catalogue.servingId, {
        servingCount: "3",
        servingLabel: "bowl",
        yieldGrams: "100",
      });
      const operationId = randomUUID();
      const createInput = {
        clientOperationId: operationId,
        recipe: draft,
        requestDigest: "1".repeat(64),
        userId: fixture.owner.userId,
      };
      const created = await createRecipe(fixture.database, createInput);
      expect(created).toMatchObject({
        recipe: {
          currentRevision: "1",
          currentVersion: {
            calculationVersion: NUTRITION_ENGINE_VERSION,
            inputMassGrams: "50",
            retentionPolicy: { code: "identity-retention-default", version: "1" },
            servingCount: "3",
            servingLabel: "bowl",
            yield: { grams: "100", ratioToInputMass: "2", source: "measured" },
          },
        },
        replayed: false,
      });
      expect(created.recipe.currentVersion.calculationAssumptions).toMatchObject({
        retentionPolicy: {
          assumption:
            "No cooking-retention dataset was applied; omitted factors remain exactly one.",
          defaultFactor: "1",
        },
      });
      expect(created.recipe.currentVersion.ingredients[0]).toMatchObject({
        kind: "food",
        portion: {
          amount: "1",
          inputUnit: "serving",
          resolvedGrams: "50",
          servingLabel: "2 crackers",
        },
      });
      expect(
        created.recipe.currentVersion.nutrients.find((row) => row.code === "energy"),
      ).toMatchObject({ knownAmount: "100", quantifiedCount: 1, unknownCount: 0 });
      expect(
        created.recipe.currentVersion.nutrients.find((row) => row.code === "sodium"),
      ).toMatchObject({ completeness: "unknown", knownAmount: "0", unknownCount: 1 });
      expect(created.recipe.currentVersion.sources).toHaveLength(1);
      for (const invalidClone of [
        { versionNumber: 99 },
        { recipeStatus: "archived" as const },
        { inputMassGrams: "49" },
        { corruptFoodName: true },
        { corruptUnknownReasons: true },
        { totalYieldQuantity: null },
        { servingPair: { count: "1", label: null } },
      ]) {
        await expect(
          fixture.database.transaction().execute((transaction) =>
            cloneRecipeVersionForInvariantTest(transaction, {
              ...invalidClone,
              sourceVersionId: created.recipe.currentVersion.id,
              userId: fixture.owner.userId,
            }),
          ),
        ).rejects.toMatchObject({ code: expect.stringMatching(/^(23502|23514)$/u) });
      }
      await expect(
        fixture.database.transaction().execute(async (transaction) => {
          const rootId = randomUUID();
          const versionId = randomUUID();
          await transaction
            .insertInto("recipe")
            .values({
              current_version_id: versionId,
              id: rootId,
              owner_user_id: fixture.owner.userId,
            })
            .execute();
          await transaction
            .insertInto("recipe_version")
            .values({
              calculation_assumptions: {
                retentionPolicy: {
                  assumption:
                    "No cooking-retention dataset was applied; omitted factors remain exactly one.",
                  code: "identity-retention-default",
                  defaultFactor: "1",
                  version: "1",
                },
              },
              calculation_version: NUTRITION_ENGINE_VERSION,
              created_by_user_id: fixture.owner.userId,
              description: null,
              final_yield_source: "measured",
              id: versionId,
              input_mass_grams: "1",
              ingredient_count: 1,
              instructions: null,
              metadata: {},
              name: "Incomplete parent",
              nutrient_component_count: 1,
              owner_user_id: fixture.owner.userId,
              recipe_id: rootId,
              recipe_status: "active",
              retention_policy_code: "identity-retention-default",
              retention_policy_version: "1",
              serving_count: null,
              serving_label: null,
              source_component_count: 1,
              total_weight_grams: "1",
              total_yield_quantity: "1",
              total_yield_unit: "g",
              version_number: 1,
              warnings: sql`'[]'::jsonb`,
            })
            .execute();
        }),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await createRecipe(fixture.database, createInput)).toMatchObject({ replayed: true });
      const concurrentInput = {
        ...createInput,
        clientOperationId: randomUUID(),
        recipe: {
          ...draft,
          ingredients: draft.ingredients.map((ingredient) => ({ ...ingredient, position: 49 })),
          name: "Position boundary",
        },
        requestDigest: "a".repeat(64),
      };
      const concurrentResults = await Promise.all([
        createRecipe(fixture.database, concurrentInput),
        createRecipe(fixture.database, concurrentInput),
      ]);
      expect(concurrentResults.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(new Set(concurrentResults.map((result) => result.recipe.id)).size).toBe(1);
      expect(concurrentResults[0]?.recipe.currentVersion.ingredients[0]?.position).toBe(49);
      await expect(
        createRecipe(fixture.database, {
          ...createInput,
          clientOperationId: randomUUID(),
          recipe: {
            ...draft,
            ingredients: draft.ingredients.map((ingredient) => ({ ...ingredient, position: 50 })),
          },
          requestDigest: "b".repeat(64),
        }),
      ).rejects.toBeInstanceOf(RecipeValidationError);
      await expect(
        createRecipe(fixture.database, { ...createInput, requestDigest: "2".repeat(64) }),
      ).rejects.toBeInstanceOf(RecipeIdempotencyConflictError);
      await expect(
        getRecipe(fixture.database, {
          recipeId: created.recipe.id,
          userId: fixture.other.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeNotFoundError);

      const revised = await reviseRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        expectedRevision: "1",
        recipe: { ...draft, name: "Revised bowl", yield: { grams: "100", source: "estimated" } },
        recipeId: created.recipe.id,
        requestDigest: "3".repeat(64),
        userId: fixture.owner.userId,
      });
      expect(revised.recipe).toMatchObject({
        currentRevision: "2",
        currentVersion: { name: "Revised bowl", versionNumber: "2" },
      });
      await expect(
        reviseRecipe(fixture.database, {
          clientOperationId: randomUUID(),
          expectedRevision: "1",
          recipe: draft,
          recipeId: created.recipe.id,
          requestDigest: "4".repeat(64),
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeRevisionConflictError);

      const noServingChild = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        recipe: foodRecipeDraft(fixture.catalogue.foodVersionId, fixture.catalogue.servingId, {
          name: "No-serving child",
          servingCount: null,
          servingLabel: null,
          yieldGrams: "50",
        }),
        requestDigest: "5".repeat(64),
        userId: fixture.owner.userId,
      });
      const nested = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        recipe: {
          description: null,
          ingredients: [
            {
              grams: "25",
              kind: "recipe",
              recipeVersionId: noServingChild.recipe.currentVersion.id,
            },
          ],
          instructions: null,
          name: "Nested bowl",
          servingCount: null,
          servingLabel: null,
          yield: { grams: "25", source: "estimated" },
        },
        requestDigest: "6".repeat(64),
        userId: fixture.owner.userId,
      });
      expect(nested.recipe.currentVersion.ingredients[0]).toMatchObject({
        kind: "recipe",
        recipe: { servingCount: null, servingLabel: null, versionNumber: "1" },
      });
      await expect(
        fixture.database.transaction().execute((transaction) =>
          cloneRecipeVersionForInvariantTest(transaction, {
            corruptNestedName: true,
            sourceVersionId: nested.recipe.currentVersion.id,
            userId: fixture.owner.userId,
          }),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      let fanOutVersionId = noServingChild.recipe.currentVersion.id;
      for (let level = 1; level <= 5; level += 1) {
        const fanOut = await createRecipe(fixture.database, {
          clientOperationId: randomUUID(),
          recipe: {
            description: null,
            ingredients: Array.from({ length: 50 }, (_, position) => ({
              grams: "1",
              kind: "recipe" as const,
              position,
              recipeVersionId: fanOutVersionId,
            })),
            instructions: null,
            name: `Coverage fan-out ${level}`,
            servingCount: null,
            servingLabel: null,
            yield: { grams: "50", source: "estimated" },
          },
          requestDigest: (20 + level).toString(16).padStart(64, "0"),
          userId: fixture.owner.userId,
        });
        fanOutVersionId = fanOut.recipe.currentVersion.id;
      }
      await expect(
        createRecipe(fixture.database, {
          clientOperationId: randomUUID(),
          recipe: {
            description: null,
            ingredients: Array.from({ length: 50 }, (_, position) => ({
              grams: "1",
              kind: "recipe" as const,
              position,
              recipeVersionId: fanOutVersionId,
            })),
            instructions: null,
            name: "Coverage overflow",
            servingCount: null,
            servingLabel: null,
            yield: { grams: "50", source: "estimated" },
          },
          requestDigest: "1f".padStart(64, "0"),
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeValidationError);
      await expect(
        reviseRecipe(fixture.database, {
          clientOperationId: randomUUID(),
          expectedRevision: "1",
          recipe: {
            description: null,
            ingredients: [
              {
                grams: "10",
                kind: "recipe",
                recipeVersionId: nested.recipe.currentVersion.id,
              },
            ],
            instructions: null,
            name: "Cycle",
            servingCount: null,
            servingLabel: null,
            yield: { grams: "10", source: "estimated" },
          },
          recipeId: noServingChild.recipe.id,
          requestDigest: "7".repeat(64),
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeValidationError);

      let chainVersionId = nested.recipe.currentVersion.id;
      let unreferencedRootId = nested.recipe.id;
      for (let depth = 3; depth <= 10; depth += 1) {
        const wrapper = await createRecipe(fixture.database, {
          clientOperationId: randomUUID(),
          recipe: nestedRecipeDraft(chainVersionId, `Depth ${depth}`),
          requestDigest: depth.toString(16).padStart(64, "0"),
          userId: fixture.owner.userId,
        });
        chainVersionId = wrapper.recipe.currentVersion.id;
        unreferencedRootId = wrapper.recipe.id;
      }
      await expect(
        createRecipe(fixture.database, {
          clientOperationId: randomUUID(),
          recipe: nestedRecipeDraft(chainVersionId, "Depth 11"),
          requestDigest: "f".repeat(64),
          userId: fixture.owner.userId,
        }),
      ).rejects.toThrow(/depth exceeds 10/u);

      const cascadeOwner = await registerPasswordAccount(
        fixture.database,
        accountInput("recipe-cascade"),
      );
      const cascadeRecipe = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        recipe: draft,
        requestDigest: "4".repeat(64),
        userId: cascadeOwner.userId,
      });

      const activatedAfterRecipe = await fixture.database
        .insertInto("nutrient")
        .values({
          canonical_unit: "mg",
          code: "zinc",
          dimension: "mass",
          name: "Zinc",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await reviseRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        expectedRevision: "2",
        recipe: {
          ...draft,
          name: "Newest bowl",
          yield: { grams: "200", source: "measured" },
        },
        recipeId: created.recipe.id,
        requestDigest: "0".repeat(64),
        userId: fixture.owner.userId,
      });

      const logged = await createRecipeDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        mealSlot: "dinner",
        occurredAt: "2026-08-15T22:00:00Z",
        portion: { amount: "1", kind: "serving" },
        recipeId: revised.recipe.id,
        recipeVersionId: revised.recipe.currentVersion.id,
        requestDigest: "8".repeat(64),
        userId: fixture.owner.userId,
      });
      expect(logged.entry).toMatchObject({
        kind: "recipe",
        portion: { amount: "1", inputUnit: "serving" },
        recipe: {
          name: "Revised bowl",
          versionNumber: 2,
          yieldGrams: "100",
        },
      });
      expect(logged.entry.portion.resolvedGrams.length).toBeGreaterThan(12);
      expect(logged.entry.portion.resolvedGrams).toMatch(/^33\.3+$/u);
      expect(
        logged.entry.nutrients.find((nutrient) => nutrient.nutrientId === activatedAfterRecipe.id),
      ).toMatchObject({
        completeness: "unknown",
        knownAmount: "0",
        unknownCount: 1,
        unknownReasons: { not_reported: 1 },
      });
      for (const corruptRevision of [
        { corruptRecipeName: true },
        { corruptEngineVersion: true },
        { clearResolvedQuantity: true },
      ]) {
        await expect(
          fixture.database.transaction().execute((transaction) =>
            cloneRecipeDiaryRevisionForInvariantTest(transaction, {
              ...corruptRevision,
              entryId: logged.entry.id,
            }),
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }

      const moved = await updateDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        entryId: logged.entry.id,
        expectedEntryRevision: "1",
        occurredAt: "2026-08-17T06:00:00Z",
        portion: { grams: "30", kind: "grams" },
        requestDigest: "9".repeat(64),
        userId: fixture.owner.userId,
      });
      expect(moved.entry).toMatchObject({
        currentRevision: "2",
        kind: "recipe",
        recipe: { recipeVersionId: revised.recipe.currentVersion.id, versionNumber: 2 },
      });
      expect(
        (
          await getDiaryDay(fixture.database, {
            localDate: moved.entry.localDate,
            userId: fixture.owner.userId,
          })
        ).entries,
      ).toHaveLength(1);

      const listed = await listRecipes(fixture.database, {
        limit: 2,
        userId: fixture.owner.userId,
      });
      expect(listed.items).toHaveLength(2);
      expect(listed.nextCursor).not.toBeNull();
      if (listed.nextCursor) {
        expect(
          (
            await listRecipes(fixture.database, {
              cursor: listed.nextCursor,
              limit: 2,
              userId: fixture.owner.userId,
            })
          ).items.length,
        ).toBeGreaterThan(0);
      }
      const malformedCursor = Buffer.from(
        JSON.stringify({ id: "not-a-uuid", updatedAt: "2026-08-15T00:00:00.000000Z" }),
      ).toString("base64url");
      await expect(
        listRecipes(fixture.database, {
          cursor: malformedCursor,
          limit: 1,
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeCursorError);
      const yearZeroCursor = Buffer.from(
        JSON.stringify({ id: randomUUID(), updatedAt: "0000-01-01T00:00:00.000000Z" }),
      ).toString("base64url");
      await expect(
        listRecipes(fixture.database, {
          cursor: yearZeroCursor,
          limit: 1,
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeCursorError);

      await expect(
        fixture.database
          .updateTable("recipe_version")
          .set({ name: "Tampered" })
          .where("id", "=", revised.recipe.currentVersion.id)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        fixture.database
          .updateTable("recipe_operation")
          .set({ request_digest: "f".repeat(64) })
          .where("user_id", "=", fixture.owner.userId)
          .where("client_operation_id", "=", operationId)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        fixture.database
          .deleteFrom("recipe_operation")
          .where("user_id", "=", fixture.owner.userId)
          .where("client_operation_id", "=", operationId)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        fixture.database
          .deleteFrom("recipe_ingredient")
          .where("recipe_version_id", "=", revised.recipe.currentVersion.id)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });

      let markRevocationLocked: (() => void) | undefined;
      const revocationLocked = new Promise<void>((resolve) => {
        markRevocationLocked = resolve;
      });
      let commitRevocation: (() => void) | undefined;
      const revocationMayCommit = new Promise<void>((resolve) => {
        commitRevocation = resolve;
      });
      const revocation = fixture.database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("food_source")
          .set({ active: false })
          .where("id", "=", fixture.catalogue.sourceId)
          .executeTakeFirstOrThrow();
        markRevocationLocked?.();
        await revocationMayCommit;
      });
      await revocationLocked;
      let blockedCreateSettled = false;
      const blockedCreate = createRecipe(fixture.database, {
        ...createInput,
        clientOperationId: randomUUID(),
        requestDigest: "e".repeat(64),
      }).then(
        (value) => {
          blockedCreateSettled = true;
          return { error: null, value };
        },
        (error: unknown) => {
          blockedCreateSettled = true;
          return { error, value: null };
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(blockedCreateSettled).toBe(false);
      commitRevocation?.();
      await revocation;
      const blockedOutcome = await blockedCreate;
      expect(blockedOutcome.value).toBeNull();
      expect(blockedOutcome.error).toBeInstanceOf(RecipeValidationError);
      await expect(
        fixture.database.transaction().execute((transaction) =>
          cloneRecipeVersionForInvariantTest(transaction, {
            sourceVersionId: created.recipe.currentVersion.id,
            userId: fixture.owner.userId,
          }),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        fixture.database.transaction().execute((transaction) =>
          cloneRecipeDiaryRevisionForInvariantTest(transaction, {
            changePortion: true,
            entryId: logged.entry.id,
          }),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        createRecipeDiaryEntry(fixture.database, {
          clientOperationId: randomUUID(),
          mealSlot: "dinner",
          occurredAt: "2026-08-18T12:00:00Z",
          portion: { grams: "10", kind: "grams" },
          recipeId: revised.recipe.id,
          recipeVersionId: revised.recipe.currentVersion.id,
          requestDigest: "d".repeat(64),
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeValidationError);
      const editableAfterRevocation = await updateDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        entryId: logged.entry.id,
        expectedEntryRevision: moved.entry.currentRevision,
        mealSlot: "breakfast",
        occurredAt: "2026-08-20T12:00:00Z",
        requestDigest: "a".repeat(64),
        userId: fixture.owner.userId,
      });
      expect(editableAfterRevocation.entry.currentRevision).toBe("3");
      const deletedAfterRevocation = await deleteDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        entryId: logged.entry.id,
        expectedEntryRevision: editableAfterRevocation.entry.currentRevision,
        requestDigest: "b".repeat(64),
        userId: fixture.owner.userId,
      });
      expect(deletedAfterRevocation.entry.currentRevision).toBe("4");
      await fixture.database
        .updateTable("food_source")
        .set({ active: true })
        .where("id", "=", fixture.catalogue.sourceId)
        .executeTakeFirstOrThrow();

      let markActivationLocked: (() => void) | undefined;
      const activationLocked = new Promise<void>((resolve) => {
        markActivationLocked = resolve;
      });
      let commitActivation: (() => void) | undefined;
      const activationMayCommit = new Promise<void>((resolve) => {
        commitActivation = resolve;
      });
      let magnesiumId: string | null = null;
      const activation = fixture.database.transaction().execute(async (transaction) => {
        magnesiumId = (
          await transaction
            .insertInto("nutrient")
            .values({
              canonical_unit: "mg",
              code: "magnesium",
              dimension: "mass",
              name: "Magnesium",
            })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;
        markActivationLocked?.();
        await activationMayCommit;
      });
      await activationLocked;
      let activationCreateSettled = false;
      const createDuringActivation = createRecipe(fixture.database, {
        ...createInput,
        clientOperationId: randomUUID(),
        requestDigest: "c".repeat(64),
      }).then((value) => {
        activationCreateSettled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(activationCreateSettled).toBe(false);
      commitActivation?.();
      await activation;
      const postActivation = await createDuringActivation;
      expect(
        postActivation.recipe.currentVersion.nutrients.find(
          (nutrient) => nutrient.nutrientId === magnesiumId,
        ),
      ).toMatchObject({ completeness: "unknown", unknownCount: 1 });

      let markDeactivationLocked: (() => void) | undefined;
      const deactivationLocked = new Promise<void>((resolve) => {
        markDeactivationLocked = resolve;
      });
      let commitDeactivation: (() => void) | undefined;
      const deactivationMayCommit = new Promise<void>((resolve) => {
        commitDeactivation = resolve;
      });
      const deactivation = fixture.database.transaction().execute(async (transaction) => {
        if (magnesiumId === null) throw new Error("Activation did not return a nutrient id");
        await transaction
          .updateTable("nutrient")
          .set({ active: false })
          .where("id", "=", magnesiumId)
          .executeTakeFirstOrThrow();
        markDeactivationLocked?.();
        await deactivationMayCommit;
      });
      await deactivationLocked;
      let deactivationCreateSettled = false;
      const createDuringDeactivation = createRecipe(fixture.database, {
        ...createInput,
        clientOperationId: randomUUID(),
        requestDigest: "b".repeat(64),
      }).then((value) => {
        deactivationCreateSettled = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(deactivationCreateSettled).toBe(false);
      commitDeactivation?.();
      await deactivation;
      const postDeactivation = await createDuringDeactivation;
      expect(
        postDeactivation.recipe.currentVersion.nutrients.some(
          (nutrient) => nutrient.nutrientId === magnesiumId,
        ),
      ).toBe(false);

      const successorRelease = await fixture.database
        .insertInto("food_source_release")
        .values({
          acquired_at: "2026-08-16T00:00:00Z",
          artifact_bytes: 101,
          artifact_sha256: "7".repeat(64),
          artifact_uri: "s3://recipes-test/catalogue-2.json",
          evidence_bundle_sha256: "9".repeat(64),
          evidence_bundle_uri: `s3://recipes-test/sha256/${"9".repeat(64)}/bundle.json`,
          evidence_decision_sha256: "a".repeat(64),
          evidence_object_version_id: "recipes-test-evidence-2-v1",
          evidence_valid_until: FIXTURE_EVIDENCE_VALID_UNTIL,
          food_source_id: fixture.catalogue.sourceId,
          media_type: "application/json",
          parser_version: "recipes-test@2",
          record_counts: { records: 0 },
          release_class: "live-reviewed",
          release_key: "recipes-release-2",
          rights_manifest_sha256: "8".repeat(64),
          rights_manifest_uri: "repo://recipes-rights-2.json",
          status: "imported",
          validation_summary: { valid: true },
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await fixture.database
        .updateTable("food_source_release")
        .set({ promoted_at: "2026-08-16T01:00:00Z", status: "promoted" })
        .where("id", "=", successorRelease.id)
        .executeTakeFirstOrThrow();
      await fixture.database
        .updateTable("food_source")
        .set({ active_release_id: successorRelease.id })
        .where("id", "=", fixture.catalogue.sourceId)
        .executeTakeFirstOrThrow();
      expect(
        (
          await createRecipeDiaryEntry(fixture.database, {
            clientOperationId: randomUUID(),
            mealSlot: "dinner",
            occurredAt: "2026-08-19T12:00:00Z",
            portion: { grams: "10", kind: "grams" },
            recipeId: revised.recipe.id,
            recipeVersionId: revised.recipe.currentVersion.id,
            requestDigest: "6".repeat(64),
            userId: fixture.owner.userId,
          })
        ).entry.recipe.recipeVersionId,
      ).toBe(revised.recipe.currentVersion.id);

      await expect(
        fixture.database
          .deleteFrom("recipe")
          .where("id", "=", created.recipe.id)
          .where("owner_user_id", "=", fixture.owner.userId)
          .executeTakeFirstOrThrow(),
      ).rejects.toMatchObject({ code: "23503" });

      expect(
        (
          await fixture.database
            .deleteFrom("recipe")
            .where("id", "=", unreferencedRootId)
            .where("owner_user_id", "=", fixture.owner.userId)
            .executeTakeFirst()
        ).numDeletedRows,
      ).toBe(1n);
      await expect(
        fixture.database
          .deleteFrom("recipe_version")
          .where("id", "=", cascadeRecipe.recipe.currentVersion.id)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await fixture.database
        .deleteFrom("app_user")
        .where("id", "=", cascadeOwner.userId)
        .executeTakeFirstOrThrow();
      expect(
        await fixture.database
          .selectFrom("recipe_version")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("recipe_id", "=", cascadeRecipe.recipe.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    } finally {
      await fixture.close();
    }
  });

  it("versions goal periods and computes coherent exact progress", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "goals");
    try {
      await updateUserProfile(fixture.database, {
        expectedRevision: "0",
        patch: {
          baselineWeightKg: "70",
          birthDate: "1990-01-01",
          heightCm: "175",
          sexAtBirth: "male",
        },
        userId: fixture.owner.userId,
      });
      const targetable = await listTargetableNutrients(fixture.database, {
        userId: fixture.owner.userId,
      });
      expect(targetable).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "other", code: "protein" }),
          expect.objectContaining({ category: "other", code: "sodium" }),
        ]),
      );
      expect(targetable.some((row) => row.code === "energy")).toBe(false);

      const rawGoalOwner = await registerPasswordAccount(
        fixture.database,
        accountInput("raw-goal-parent"),
      );
      await expect(
        fixture.database.transaction().execute(async (transaction) => {
          const goalId = randomUUID();
          const versionId = randomUUID();
          await transaction
            .insertInto("nutrition_goal")
            .values({
              current_version_id: versionId,
              effective_from: "2026-01-01",
              effective_to: null,
              id: goalId,
              status: "active",
              user_id: rawGoalOwner.userId,
            })
            .execute();
          await transaction
            .insertInto("nutrition_goal_version")
            .values({
              activity_factor: null,
              activity_level_code: null,
              activity_policy_code: null,
              activity_policy_url: null,
              activity_policy_version: null,
              age_years: null,
              assumptions: {},
              bmr_equation_code: null,
              bmr_equation_version: null,
              bmr_kcal: null,
              calculation_version: NUTRITION_ENGINE_VERSION,
              created_by_user_id: rawGoalOwner.userId,
              dri_reference_group_code: null,
              dri_reference_version: null,
              effective_from: "2026-01-01",
              effective_to: null,
              energy_adjustment_kcal: null,
              energy_mode: "fixed",
              energy_source_code: "user-fixed",
              energy_source_url: null,
              energy_source_version: "1",
              energy_target_kcal: "2000",
              exercise_budget_kcal: null,
              goal_status: "active",
              id: versionId,
              nutrition_goal_id: goalId,
              profile_height_cm: null,
              profile_revision: null,
              profile_sex_at_birth: null,
              profile_weight_kg: null,
              rationale: "Incomplete target parent",
              target_count: 1,
              thermic_effect_kcal: null,
              user_id: rawGoalOwner.userId,
              version_number: 1,
            })
            .execute();
        }),
      ).rejects.toMatchObject({ code: "23514" });

      const concurrentGoalInput = {
        clientOperationId: randomUUID(),
        effectiveFrom: "2026-01-01",
        energy: { mode: "fixed" as const, rationale: "Concurrent", targetKcal: "2000" },
        requestDigest: "0".repeat(64),
        targets: [],
        userId: fixture.other.userId,
      };
      const concurrentGoals = await Promise.all([
        createNutritionGoal(fixture.database, concurrentGoalInput),
        createNutritionGoal(fixture.database, concurrentGoalInput),
      ]);
      expect(concurrentGoals.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(new Set(concurrentGoals.map((result) => result.goal.id)).size).toBe(1);
      const goalCascadeOwner = await registerPasswordAccount(
        fixture.database,
        accountInput("goal-cascade"),
      );
      const cascadeGoal = await createNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        effectiveFrom: "2026-01-01",
        energy: { mode: "fixed", rationale: "Privacy cascade", targetKcal: "2000" },
        requestDigest: "3".repeat(64),
        targets: [],
        userId: goalCascadeOwner.userId,
      });
      const competingStarts = await Promise.allSettled([
        createNutritionGoal(fixture.database, {
          ...concurrentGoalInput,
          clientOperationId: randomUUID(),
          effectiveFrom: "2026-02-01",
          requestDigest: "1".repeat(64),
        }),
        createNutritionGoal(fixture.database, {
          ...concurrentGoalInput,
          clientOperationId: randomUUID(),
          effectiveFrom: "2026-02-01",
          requestDigest: "2".repeat(64),
        }),
      ]);
      expect(competingStarts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        competingStarts
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      ).toEqual([expect.any(NutritionGoalPeriodConflictError)]);

      const firstGoalOperationId = randomUUID();
      const first = await createNutritionGoal(fixture.database, {
        clientOperationId: firstGoalOperationId,
        effectiveFrom: "2026-08-01",
        energy: { mode: "fixed", rationale: "Training block", targetKcal: "2200" },
        requestDigest: "a".repeat(64),
        targets: [
          {
            maximumAmount: "999999999999999999.999999999999",
            minimumAmount: "1500",
            nutrientId: fixture.catalogue.sodiumId,
            rationale: null,
            source: { label: "Personal target", version: "1" },
            targetAmount: "2000",
          },
        ],
        userId: fixture.owner.userId,
      });
      expect(first.goal.currentVersion.energy).toMatchObject({ mode: "fixed", targetKcal: "2200" });
      expect(first.goal.currentVersion.targets[0]?.maximumAmount).toBe(
        "999999999999999999.999999999999",
      );

      const secondInput = {
        clientOperationId: randomUUID(),
        effectiveFrom: "2026-09-01",
        energy: {
          activityFactor: "1.700001",
          activityLevelCode: "active_or_moderate" as const,
          adjustmentKcal: "12.345678",
          mode: "derived" as const,
          rationale: "Reviewed adult estimate",
        },
        requestDigest: "b".repeat(64),
        targets: [],
        userId: fixture.owner.userId,
      };
      const second = await createNutritionGoal(fixture.database, secondInput);
      expect(second.goal.currentVersion.energy).toMatchObject({
        activityFactor: "1.700001",
        adjustmentKcal: "12.345678",
        mode: "derived",
        profileRevision: "1",
        source: {
          activityPolicy: { sourceUrl: PRODUCT_PAL_POLICY.sourceUrl },
          equation: { url: MIFFLIN_ST_JEOR_SOURCE.url },
        },
      });
      expect((second.goal.currentVersion.energy as { targetKcal: string }).targetKcal).toContain(
        ".",
      );
      for (const invalidGoalClone of [
        { versionNumber: 99 },
        { effectiveFrom: "2026-10-01" },
        { clearDerivedBmr: true },
      ]) {
        await expect(
          fixture.database.transaction().execute((transaction) =>
            cloneGoalVersionForInvariantTest(transaction, {
              ...invalidGoalClone,
              sourceVersionId: second.goal.currentVersion.id,
              userId: rawGoalOwner.userId,
            }),
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
      expect(
        (
          await getCurrentNutritionGoal(fixture.database, {
            localDate: "2026-08-31",
            userId: fixture.owner.userId,
          })
        )?.id,
      ).toBe(first.goal.id);
      expect(
        (
          await getCurrentNutritionGoal(fixture.database, {
            localDate: "2026-09-01",
            userId: fixture.owner.userId,
          })
        )?.id,
      ).toBe(second.goal.id);
      expect(
        await getNutritionGoalProgress(fixture.database, {
          localDate: "2026-09-01",
          userId: fixture.owner.userId,
        }),
      ).toMatchObject({
        diaryRevision: "0",
        energy: { code: "energy", knownAmount: "0", unit: "kcal" },
        goalVersionId: second.goal.currentVersion.id,
        timeZone: "America/Chicago",
      });
      const closedFirst = await getNutritionGoal(fixture.database, {
        goalId: first.goal.id,
        userId: fixture.owner.userId,
      });
      expect(closedFirst).toMatchObject({ currentRevision: "2", effectiveTo: "2026-09-01" });
      await expect(
        reviseNutritionGoal(fixture.database, {
          clientOperationId: randomUUID(),
          energy: { mode: "fixed", rationale: "Retroactive", targetKcal: "2050" },
          expectedRevision: closedFirst.currentRevision,
          goalId: closedFirst.id,
          requestDigest: "7".repeat(64),
          targets: [],
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalPeriodConflictError);

      await createFoodDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        foodVersionId: fixture.catalogue.foodVersionId,
        mealSlot: "lunch",
        occurredAt: "2026-08-15T18:00:00Z",
        portion: { grams: "100", kind: "grams" },
        requestDigest: "9".repeat(64),
        userId: fixture.owner.userId,
      });
      expect(
        await getNutritionGoalProgress(fixture.database, {
          localDate: "2026-08-15",
          userId: fixture.owner.userId,
        }),
      ).toMatchObject({
        diaryRevision: "1",
        energy: {
          code: "energy",
          completeness: "complete",
          knownAmount: "200",
          percentIsExact: true,
        },
        targets: [
          {
            code: "sodium",
            completeness: "unknown",
            knownAmount: "0",
            maximum: { state: "indeterminate" },
            minimum: { state: "indeterminate" },
            target: { lowerBoundPercent: "0", percentIsExact: false },
          },
        ],
        timeZone: "America/Chicago",
      });

      for (const invalidAmount of ["1000000000000000000", "0.0000000000001"]) {
        await expect(
          reviseNutritionGoal(fixture.database, {
            clientOperationId: randomUUID(),
            energy: { mode: "fixed", rationale: "Invalid boundary", targetKcal: "2100" },
            expectedRevision: second.goal.currentRevision,
            goalId: second.goal.id,
            requestDigest: randomBytes(32).toString("hex"),
            targets: [
              {
                maximumAmount: invalidAmount,
                minimumAmount: null,
                nutrientId: fixture.catalogue.sodiumId,
                rationale: null,
                source: { label: "Boundary", version: null },
                targetAmount: null,
              },
            ],
            userId: fixture.owner.userId,
          }),
        ).rejects.toBeInstanceOf(NutritionGoalValidationError);
      }
      await expect(
        reviseNutritionGoal(fixture.database, {
          clientOperationId: randomUUID(),
          energy: { mode: "fixed", rationale: "Duplicate energy", targetKcal: "2100" },
          expectedRevision: second.goal.currentRevision,
          goalId: second.goal.id,
          requestDigest: "8".repeat(64),
          targets: [
            {
              maximumAmount: null,
              minimumAmount: null,
              nutrientId: fixture.catalogue.energyId,
              rationale: null,
              source: { label: "Duplicate", version: null },
              targetAmount: "2000",
            },
          ],
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalValidationError);

      const revised = await reviseNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        energy: { mode: "fixed", rationale: "Adjustment", targetKcal: "2100" },
        expectedRevision: second.goal.currentRevision,
        goalId: second.goal.id,
        requestDigest: "c".repeat(64),
        targets: [],
        userId: fixture.owner.userId,
      });
      expect(revised.goal).toMatchObject({
        currentRevision: "2",
        effectiveFrom: "2026-09-01",
        effectiveTo: null,
      });
      await expect(
        reviseNutritionGoal(fixture.database, {
          clientOperationId: randomUUID(),
          energy: { mode: "fixed", rationale: "Stale", targetKcal: "2000" },
          expectedRevision: "1",
          goalId: second.goal.id,
          requestDigest: "d".repeat(64),
          targets: [],
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalRevisionConflictError);
      await expect(
        createNutritionGoal(fixture.database, {
          ...secondInput,
          clientOperationId: randomUUID(),
          effectiveFrom: "2026-09-01",
          requestDigest: "e".repeat(64),
        }),
      ).rejects.toBeInstanceOf(NutritionGoalPeriodConflictError);

      const unsupported = await registerPasswordAccount(
        fixture.database,
        accountInput("unsupported"),
      );
      await expect(
        createNutritionGoal(fixture.database, {
          clientOperationId: randomUUID(),
          effectiveFrom: "2026-08-01",
          energy: {
            activityFactor: "1.5",
            activityLevelCode: "sedentary_or_light",
            mode: "derived",
            rationale: "Missing profile",
          },
          requestDigest: "f".repeat(64),
          targets: [],
          userId: unsupported.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalUnsupportedProfileError);

      await expect(
        fixture.database
          .deleteFrom("nutrition_goal_target")
          .where("nutrition_goal_version_id", "=", first.goal.currentVersion.id)
          .where("nutrient_id", "=", fixture.catalogue.sodiumId)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        fixture.database
          .updateTable("nutrition_goal_operation")
          .set({ request_digest: "e".repeat(64) })
          .where("user_id", "=", fixture.owner.userId)
          .where("client_operation_id", "=", firstGoalOperationId)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        fixture.database
          .deleteFrom("nutrition_goal_operation")
          .where("user_id", "=", fixture.owner.userId)
          .where("client_operation_id", "=", firstGoalOperationId)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await assertDatabaseMigrationLedgerReady(fixture.database);
      const removedLedger = await sql<{ checksum: string }>`
        delete from app_schema_migration
        where name = '0005_recipes_and_goals.sql'
        returning checksum
      `.execute(fixture.database);
      expect(removedLedger.rows).toHaveLength(1);
      await expect(assertDatabaseMigrationLedgerReady(fixture.database)).rejects.toThrow(
        "Database schema migration ledger is not current",
      );
      const checksum = removedLedger.rows[0]?.checksum;
      if (!checksum) throw new Error("Expected the 0005 migration checksum");
      await sql`
        insert into app_schema_migration (name, checksum)
        values ('0005_recipes_and_goals.sql', ${checksum})
      `.execute(fixture.database);
      await sql`
        update app_schema_migration
        set checksum = ${"0".repeat(64)}
        where name = '0005_recipes_and_goals.sql'
      `.execute(fixture.database);
      await expect(assertDatabaseMigrationLedgerReady(fixture.database)).rejects.toThrow(
        "Database schema migration ledger is not current",
      );
      await sql`
        update app_schema_migration
        set checksum = ${checksum}
        where name = '0005_recipes_and_goals.sql'
      `.execute(fixture.database);
      await assertDatabaseMigrationLedgerReady(fixture.database);
      expect(
        (
          await fixture.database
            .deleteFrom("nutrition_goal")
            .where("id", "=", first.goal.id)
            .where("user_id", "=", fixture.owner.userId)
            .executeTakeFirst()
        ).numDeletedRows,
      ).toBe(1n);
      await expect(
        fixture.database
          .deleteFrom("nutrition_goal_version")
          .where("id", "=", cascadeGoal.goal.currentVersion.id)
          .executeTakeFirst(),
      ).rejects.toMatchObject({ code: "55000" });
      await fixture.database
        .deleteFrom("app_user")
        .where("id", "=", goalCascadeOwner.userId)
        .executeTakeFirstOrThrow();
      expect(
        await fixture.database
          .selectFrom("nutrition_goal_version")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("nutrition_goal_id", "=", cascadeGoal.goal.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    } finally {
      await fixture.close();
    }
  });

  it("materializes, replays, expires, and attests reviewed reference targets", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "reference_goals");
    try {
      const dates = (
        await sql<{
          birth_date: string;
          today: string;
          tomorrow: string;
          yesterday: string;
        }>`
          with local_day as (
            select (transaction_timestamp() at time zone 'America/Chicago')::date as day
          )
          select
            to_char(day - interval '51 years', 'YYYY-MM-DD') as birth_date,
            to_char(day, 'YYYY-MM-DD') as today,
            to_char(day + 1, 'YYYY-MM-DD') as tomorrow,
            to_char(day - 1, 'YYYY-MM-DD') as yesterday
          from local_day
        `.execute(fixture.database)
      ).rows[0];
      if (!dates) throw new Error("Expected server-local reference test dates");

      const selection = {
        eligibilityAcknowledgement: {
          accepted: true as const,
          policyCode: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
          policyVersion: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
        },
        groupCode: "male-19-50" as const,
        templateCode: REFERENCE_TARGET_TEMPLATE_CODE,
        templateVersion: REFERENCE_TARGET_TEMPLATE_VERSION,
      };

      const revisionZeroOwner = await registerPasswordAccount(
        fixture.database,
        accountInput("reference-revision-zero"),
      );
      await fixture.database
        .updateTable("user_profile")
        .set({ birth_date: "1990-01-01", sex_at_birth: "male" })
        .where("user_id", "=", revisionZeroOwner.userId)
        .executeTakeFirstOrThrow();
      const revisionZeroList = await listReferenceTargetSets(fixture.database, {
        localDate: dates.today,
        userId: revisionZeroOwner.userId,
      });
      expect(revisionZeroList).toMatchObject({
        availability: { available: true, reasonCodes: [] },
        profileRevision: "0",
        sets: [{ groupCode: "male-19-50", targets: expect.any(Array) }],
      });
      expect(revisionZeroList.sets[0]?.targets).toHaveLength(12);
      await expect(
        createNutritionGoal(fixture.database, {
          clientOperationId: randomUUID(),
          effectiveFrom: dates.today,
          energy: { mode: "fixed", rationale: "Revision zero reference", targetKcal: "2000" },
          referenceTargetSet: { expectedProfileRevision: "0", selection },
          requestDigest: randomBytes(32).toString("hex"),
          targets: [],
          userId: revisionZeroOwner.userId,
        }),
      ).resolves.toMatchObject({ replayed: false });

      const firstProfile = await updateUserProfile(fixture.database, {
        expectedRevision: "0",
        patch: {
          birthDate: "1990-01-01",
          sexAtBirth: "male",
        },
        userId: fixture.owner.userId,
      });
      expect(firstProfile.revision).toBe("1");

      await fixture.database
        .updateTable("nutrient")
        .set({ is_targetable: false })
        .where("code", "=", "vitamin-a-rae")
        .executeTakeFirstOrThrow();
      try {
        expect(
          await listReferenceTargetSets(fixture.database, {
            localDate: dates.today,
            userId: fixture.owner.userId,
          }),
        ).toMatchObject({
          availability: {
            available: false,
            reasonCodes: ["nutrient_registry_unavailable"],
          },
          sets: [],
        });
        await expect(
          createNutritionGoal(fixture.database, {
            clientOperationId: randomUUID(),
            effectiveFrom: dates.today,
            energy: { mode: "fixed", rationale: "Unavailable registry", targetKcal: "2000" },
            referenceTargetSet: { expectedProfileRevision: firstProfile.revision, selection },
            requestDigest: randomBytes(32).toString("hex"),
            targets: [],
            userId: fixture.owner.userId,
          }),
        ).rejects.toBeInstanceOf(NutritionGoalReferenceUnavailableError);
      } finally {
        await fixture.database
          .updateTable("nutrient")
          .set({ is_targetable: true })
          .where("code", "=", "vitamin-a-rae")
          .executeTakeFirstOrThrow();
      }

      const available = await listReferenceTargetSets(fixture.database, {
        localDate: dates.today,
        userId: fixture.owner.userId,
      });
      expect(available).toMatchObject({
        applied: null,
        availability: { available: true, reasonCodes: [] },
        profileRevision: firstProfile.revision,
        sets: [
          {
            groupCode: "male-19-50",
            templateCode: REFERENCE_TARGET_TEMPLATE_CODE,
            templateVersion: REFERENCE_TARGET_TEMPLATE_VERSION,
          },
        ],
      });
      expect(available.sets[0]?.targets).toHaveLength(12);
      expect(
        available.sets[0]?.targets.find((target) => target.definition.code === "protein"),
      ).toMatchObject({
        basis: { referenceType: "rda" },
        targetAmount: "56",
      });
      expect(
        available.sets[0]?.targets.find((target) => target.definition.code === "potassium"),
      ).toMatchObject({
        basis: { referenceType: "ai" },
        targetAmount: "3400",
      });
      expect(
        available.sets[0]?.targets.find((target) => target.definition.code === "calcium"),
      ).toMatchObject({
        basis: { maximumReferenceType: "ul" },
        maximumAmount: "2500",
        targetAmount: "1000",
      });

      const createInput = {
        clientOperationId: randomUUID(),
        effectiveFrom: dates.today,
        energy: {
          mode: "fixed" as const,
          rationale: "Source-verified reference",
          targetKcal: "2100",
        },
        referenceTargetSet: { expectedProfileRevision: firstProfile.revision, selection },
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: fixture.owner.userId,
      };
      const created = await createNutritionGoal(fixture.database, createInput);
      expect(created).toMatchObject({
        replayed: false,
        goal: {
          currentRevision: "1",
          currentVersion: {
            referenceTargetSet: {
              acknowledgement: {
                accepted: true,
                policyCode: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
                policyVersion: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
              },
              appliedProfileRevision: firstProfile.revision,
              groupCode: "male-19-50",
            },
          },
        },
      });
      expect(created.goal.currentVersion.targets).toHaveLength(12);
      const storedVersion = await fixture.database
        .selectFrom("nutrition_goal_version")
        .select(["assumptions", "dri_reference_group_code", "dri_reference_version"])
        .where("id", "=", created.goal.currentVersion.id)
        .executeTakeFirstOrThrow();
      expect(storedVersion).toMatchObject({
        dri_reference_group_code: "male-19-50",
        dri_reference_version: "1",
        assumptions: {
          referenceTargetSet: {
            sourceCode: "health-canada-dri-tables",
            sourceReviewedOn: "2026-09-07",
            sourceVersion: "2025-11-19",
          },
        },
      });
      const storedTargetRows = await fixture.database
        .selectFrom("nutrition_goal_target")
        .select(["metadata", "minimum_amount"])
        .where("nutrition_goal_version_id", "=", created.goal.currentVersion.id)
        .execute();
      expect(storedTargetRows).toHaveLength(12);
      expect(storedTargetRows.every((row) => row.minimum_amount === null)).toBe(true);
      expect(storedTargetRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({
              sourceUrl: expect.stringMatching(/^https:\/\//u),
              timeBasis: "usual-average-daily-intake",
            }),
          }),
        ]),
      );

      const secondProfile = await updateUserProfile(fixture.database, {
        expectedRevision: firstProfile.revision,
        patch: { displayName: "Reference owner" },
        userId: fixture.owner.userId,
      });
      expect(await createNutritionGoal(fixture.database, createInput)).toMatchObject({
        replayed: true,
        goal: { id: created.goal.id },
      });
      await expect(
        createNutritionGoal(fixture.database, {
          ...createInput,
          clientOperationId: randomUUID(),
          effectiveFrom: dates.tomorrow,
          requestDigest: randomBytes(32).toString("hex"),
        }),
      ).rejects.toBeInstanceOf(NutritionGoalProfileRevisionConflictError);

      const reviseInput = {
        clientOperationId: randomUUID(),
        energy: { mode: "fixed" as const, rationale: "Reference revision", targetKcal: "2150" },
        expectedRevision: created.goal.currentRevision,
        goalId: created.goal.id,
        referenceTargetSet: { expectedProfileRevision: secondProfile.revision, selection },
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: fixture.owner.userId,
      };
      const revised = await reviseNutritionGoal(fixture.database, reviseInput);
      expect(revised).toMatchObject({
        replayed: false,
        goal: {
          currentRevision: "2",
          currentVersion: {
            referenceTargetSet: { appliedProfileRevision: secondProfile.revision },
          },
        },
      });
      const thirdProfile = await updateUserProfile(fixture.database, {
        expectedRevision: secondProfile.revision,
        patch: { displayName: "Reference owner updated" },
        userId: fixture.owner.userId,
      });
      expect(await reviseNutritionGoal(fixture.database, reviseInput)).toMatchObject({
        replayed: true,
        goal: { currentRevision: "2", id: created.goal.id },
      });
      await expect(
        reviseNutritionGoal(fixture.database, {
          ...reviseInput,
          clientOperationId: randomUUID(),
          expectedRevision: revised.goal.currentRevision,
          requestDigest: randomBytes(32).toString("hex"),
        }),
      ).rejects.toBeInstanceOf(NutritionGoalProfileRevisionConflictError);

      const applied = await listReferenceTargetSets(fixture.database, {
        localDate: dates.today,
        userId: fixture.owner.userId,
      });
      expect(applied.applied).toMatchObject({
        acknowledgement: {
          accepted: true,
          acceptedAt: expect.stringMatching(/Z$/u),
          policyCode: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_CODE,
          policyVersion: REFERENCE_TARGET_ACKNOWLEDGEMENT_POLICY_VERSION,
        },
        appliedProfileRevision: secondProfile.revision,
        goalId: created.goal.id,
        goalRevision: "2",
        set: {
          groupCode: "male-19-50",
          policyDigest: revised.goal.currentVersion.referenceTargetSet?.policyDigest,
          targets: expect.any(Array),
        },
      });
      expect(applied.applied?.set.targets).toHaveLength(12);

      const unsupportedProfile = await updateUserProfile(fixture.database, {
        expectedRevision: thirdProfile.revision,
        patch: { sexAtBirth: "not_specified" },
        userId: fixture.owner.userId,
      });
      const appliedDuringProfileDrift = await listReferenceTargetSets(fixture.database, {
        localDate: dates.today,
        userId: fixture.owner.userId,
      });
      expect(appliedDuringProfileDrift).toMatchObject({
        applied: { goalId: created.goal.id, set: { targets: expect.any(Array) } },
        availability: { available: false, reasonCodes: ["profile_sex_unsupported"] },
        profileRevision: unsupportedProfile.revision,
        sets: [],
      });
      expect(appliedDuringProfileDrift.applied?.set.targets).toHaveLength(12);

      const malformedOwner = await registerPasswordAccount(
        fixture.database,
        accountInput("reference-malformed"),
      );
      for (const nullReferencePath of [
        "referenceTargetSet.policyDigest",
        "referenceTargetSet.sourceCode",
        "referenceTargetSet.appliedProfileRevision",
        "referenceTargetSet.eligibleThroughExclusive",
        "referenceTargetSet.acknowledgement",
        "referenceTargetSet.acknowledgement.acceptedAt",
        "referenceTargetSet.ageYears",
      ]) {
        await expect(
          fixture.database.transaction().execute((transaction) =>
            cloneGoalVersionForInvariantTest(transaction, {
              nullReferencePath,
              sourceVersionId: revised.goal.currentVersion.id,
              userId: malformedOwner.userId,
            }),
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
      for (const referenceJsonReplacement of [
        { path: "referenceTargetSet.ageYears", value: "36" },
        {
          path: "referenceTargetSet.acknowledgement.acceptedAt",
          value: "2026-99-99T99:99:99.999Z",
        },
        { path: "referenceTargetSet.eligibleThroughExclusive", value: "2026-99-99" },
      ]) {
        await expect(
          fixture.database.transaction().execute((transaction) =>
            cloneGoalVersionForInvariantTest(transaction, {
              referenceJsonReplacement,
              sourceVersionId: revised.goal.currentVersion.id,
              userId: malformedOwner.userId,
            }),
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await expect(
        fixture.database.transaction().execute((transaction) =>
          cloneGoalVersionForInvariantTest(transaction, {
            nullTargetMetadataField: "sourceUrl",
            sourceVersionId: revised.goal.currentVersion.id,
            userId: malformedOwner.userId,
          }),
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const hostileSchema = `reference_hostile_${randomBytes(6).toString("hex")}`;
      await sql`create schema ${sql.id(hostileSchema)}`.execute(fixture.bootstrap);
      try {
        await sql`
          create view ${sql.id(hostileSchema, "nutrition_goal_version")} as
          select null::uuid as id
        `.execute(fixture.bootstrap);
        await sql`
          create view ${sql.id(hostileSchema, "nutrition_goal_target")} as
          select null::uuid as nutrition_goal_version_id
        `.execute(fixture.bootstrap);
        await sql`
          create view ${sql.id(hostileSchema, "nutrient")} as
          select null::uuid as id
        `.execute(fixture.bootstrap);
        await sql`alter table nutrition_goal disable trigger user`.execute(fixture.database);
        await sql`alter table nutrition_goal_version disable trigger user`.execute(
          fixture.database,
        );
        await sql`alter table nutrition_goal_target disable trigger user`.execute(fixture.database);
        await sql`
          alter table nutrition_goal_version
          enable trigger nutrition_goal_reference_vector_from_version_v1
        `.execute(fixture.database);
        await sql`
          alter table nutrition_goal_target
          enable trigger nutrition_goal_reference_vector_from_target_v1
        `.execute(fixture.database);
        await fixture.database.transaction().execute(async (transaction) => {
          await sql`select pg_catalog.set_config(
            'search_path',
            ${`${hostileSchema},${fixture.schemaName},pg_catalog`},
            true
          )`.execute(transaction);
          await cloneGoalVersionForInvariantTest(transaction.withSchema(fixture.schemaName), {
            sourceVersionId: revised.goal.currentVersion.id,
            userId: malformedOwner.userId,
          });
        });
      } finally {
        await sql`alter table nutrition_goal enable trigger user`.execute(fixture.database);
        await sql`alter table nutrition_goal_version enable trigger user`.execute(fixture.database);
        await sql`alter table nutrition_goal_target enable trigger user`.execute(fixture.database);
        await sql`drop schema ${sql.id(hostileSchema)} cascade`.execute(fixture.bootstrap);
      }

      const functionConfig = await sql<{ proconfig: string[] | null }>`
        select p.proconfig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = ${fixture.schemaName}
          and p.proname = 'reconcile_goal_reference_vector_v1'
      `.execute(fixture.database);
      expect(functionConfig.rows).toEqual([
        { proconfig: [`search_path=pg_catalog, ${fixture.schemaName}, pg_temp`] },
      ]);
      const referenceConstraints = await sql<{
        conname: string;
        convalidated: boolean;
      }>`
        select c.conname, c.convalidated
        from pg_catalog.pg_constraint c
        join pg_catalog.pg_namespace n on n.oid = c.connamespace
        where n.nspname = ${fixture.schemaName}
          and c.conname in (
            'nutrition_goal_version_reference_identity_v1',
            'nutrition_goal_target_reference_metadata_v1'
          )
        order by c.conname
      `.execute(fixture.database);
      expect(referenceConstraints.rows).toEqual([
        { conname: "nutrition_goal_target_reference_metadata_v1", convalidated: true },
        { conname: "nutrition_goal_version_reference_identity_v1", convalidated: true },
      ]);
      const referenceTriggers = await sql<{
        tgdeferrable: boolean;
        tgenabled: string;
        tginitdeferred: boolean;
        tgname: string;
      }>`
        select t.tgdeferrable, t.tgenabled, t.tginitdeferred, t.tgname
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_class r on r.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = r.relnamespace
        where n.nspname = ${fixture.schemaName}
          and t.tgname like 'nutrition_goal_reference_vector_%'
        order by t.tgname
      `.execute(fixture.database);
      expect(referenceTriggers.rows).toEqual([
        {
          tgdeferrable: true,
          tgenabled: "O",
          tginitdeferred: true,
          tgname: "nutrition_goal_reference_vector_from_target_v1",
        },
        {
          tgdeferrable: true,
          tgenabled: "O",
          tginitdeferred: true,
          tgname: "nutrition_goal_reference_vector_from_version_v1",
        },
      ]);

      const expiryOwner = await registerPasswordAccount(
        fixture.database,
        accountInput("reference-expiry"),
      );
      const expiryProfile = await updateUserProfile(fixture.database, {
        expectedRevision: "0",
        patch: { birthDate: dates.birth_date, sexAtBirth: "male" },
        userId: expiryOwner.userId,
      });
      const expiring = await createNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        effectiveFrom: dates.yesterday,
        energy: { mode: "fixed", rationale: "Expires at 51", targetKcal: "2000" },
        referenceTargetSet: { expectedProfileRevision: expiryProfile.revision, selection },
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: expiryOwner.userId,
      });
      expect(
        (
          await getCurrentNutritionGoal(fixture.database, {
            localDate: dates.yesterday,
            userId: expiryOwner.userId,
          })
        )?.id,
      ).toBe(expiring.goal.id);
      expect(
        await getCurrentNutritionGoal(fixture.database, {
          localDate: dates.today,
          userId: expiryOwner.userId,
        }),
      ).toBeNull();
      await expect(
        reviseNutritionGoal(fixture.database, {
          clientOperationId: randomUUID(),
          energy: { mode: "fixed", rationale: "Expired revision", targetKcal: "2000" },
          expectedRevision: expiring.goal.currentRevision,
          goalId: expiring.goal.id,
          referenceTargetSet: { expectedProfileRevision: expiryProfile.revision, selection },
          requestDigest: randomBytes(32).toString("hex"),
          targets: [],
          userId: expiryOwner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalValidationError);
      const customAfterExpiry = await reviseNutritionGoal(fixture.database, {
        clientOperationId: randomUUID(),
        energy: { mode: "fixed", rationale: "Custom after expiry", targetKcal: "2000" },
        expectedRevision: expiring.goal.currentRevision,
        goalId: expiring.goal.id,
        requestDigest: randomBytes(32).toString("hex"),
        targets: [],
        userId: expiryOwner.userId,
      });
      expect(customAfterExpiry.goal.currentVersion.referenceTargetSet).toBeNull();
      expect(
        (
          await getCurrentNutritionGoal(fixture.database, {
            localDate: dates.today,
            userId: expiryOwner.userId,
          })
        )?.id,
      ).toBe(expiring.goal.id);

      await sql`
        alter table nutrition_goal_target
        disable trigger nutrition_goal_target_reject_update
      `.execute(fixture.database);
      await sql`
        alter table nutrition_goal_target
        drop constraint nutrition_goal_target_reference_metadata_v1
      `.execute(fixture.database);
      await sql`
        update nutrition_goal_target target
        set target_amount = 999
        from nutrient definition
        where target.nutrient_id = definition.id
          and target.nutrition_goal_version_id = ${revised.goal.currentVersion.id}
          and definition.code = 'vitamin-b12'
      `.execute(fixture.database);
      await expect(
        getNutritionGoal(fixture.database, {
          goalId: revised.goal.id,
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalPersistedIntegrityError);
      await expect(
        listReferenceTargetSets(fixture.database, {
          localDate: dates.today,
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalPersistedIntegrityError);
      await sql`
        update nutrition_goal_target target
        set target_amount = 2.4
        from nutrient definition
        where target.nutrient_id = definition.id
          and target.nutrition_goal_version_id = ${revised.goal.currentVersion.id}
          and definition.code = 'vitamin-b12'
      `.execute(fixture.database);
      await sql`
        alter table nutrition_goal_target
        enable trigger nutrition_goal_target_reject_update
      `.execute(fixture.database);
      await sql`
        alter table nutrition_goal_version
        disable trigger nutrition_goal_version_reject_update
      `.execute(fixture.database);
      await sql`
        alter table nutrition_goal_version
        drop constraint nutrition_goal_version_reference_identity_v1
      `.execute(fixture.database);
      await sql`
        update nutrition_goal_version
        set assumptions = pg_catalog.jsonb_set(
          assumptions,
          '{referenceTargetSet,policyDigest}',
          to_jsonb(${"0".repeat(64)}::text)
        )
        where id = ${revised.goal.currentVersion.id}
      `.execute(fixture.database);
      await expect(
        getNutritionGoal(fixture.database, {
          goalId: revised.goal.id,
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalPersistedIntegrityError);
      await expect(
        listReferenceTargetSets(fixture.database, {
          localDate: dates.today,
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(NutritionGoalPersistedIntegrityError);
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("fails the 0005 upgrade transaction before DDL when experimental roots exist", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `recipes_upgrade_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    try {
      for (const migrationName of [
        "0001_initial_domain_schema.sql",
        "0002_catalogue_ingestion.sql",
        "0003_promoted_food_search.sql",
        "0004_diary_accounts_and_revisions.sql",
      ]) {
        await sql
          .raw(await readFile(resolve(import.meta.dirname, "../migrations", migrationName), "utf8"))
          .execute(database);
      }
      const user = await database
        .insertInto("app_user")
        .values({
          auth_subject: `legacy:${randomUUID()}`,
          email: `legacy-${randomUUID()}@example.invalid`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("recipe")
        .values({ current_version_id: null, owner_user_id: user.id })
        .execute();
      const migration = await readFile(
        resolve(import.meta.dirname, "../migrations/0005_recipes_and_goals.sql"),
        "utf8",
      );
      await expect(
        database.transaction().execute((transaction) => sql.raw(migration).execute(transaction)),
      ).rejects.toThrow(/0005 requires empty legacy recipe and nutrition_goal roots/u);
      const ddl = await sql<{ relation: string | null }>`
        select to_regclass(${`${schemaName}.recipe_version_nutrient`})::text as relation
      `.execute(database);
      expect(ddl.rows[0]?.relation).toBeNull();
      await database.deleteFrom("recipe").where("owner_user_id", "=", user.id).execute();
      const legacyGoal = await database
        .insertInto("nutrition_goal")
        .values({
          current_version_id: null,
          effective_from: "2026-01-01",
          effective_to: null,
          status: "draft",
          user_id: user.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await expect(
        database.transaction().execute((transaction) => sql.raw(migration).execute(transaction)),
      ).rejects.toThrow(/0005 requires empty legacy recipe and nutrition_goal roots/u);
      expect(
        (
          await sql<{ relation: string | null }>`
            select to_regclass(${`${schemaName}.recipe_version_nutrient`})::text as relation
          `.execute(database)
        ).rows[0]?.relation,
      ).toBeNull();
      await database.deleteFrom("nutrition_goal").where("id", "=", legacyGoal.id).execute();
      await sql.raw(migration).execute(database);
      expect(
        (
          await sql<{ relation: string | null }>`
            select to_regclass(${`${schemaName}.recipe_version_nutrient`})::text as relation
          `.execute(database)
        ).rows[0]?.relation,
      ).not.toBeNull();
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });
});

function accountInput(label: string) {
  return {
    email: `${label}-${randomUUID()}@example.invalid`,
    passwordHash: `$argon2id$${label}-hash`,
    passwordParameters: { algorithm: "argon2id" },
    passwordSalt: `${label}-salt-value`,
    timeZone: "America/Chicago",
  };
}

function foodRecipeDraft(
  foodVersionId: string,
  servingId: string,
  options: {
    readonly name?: string;
    readonly servingCount: string | null;
    readonly servingLabel: string | null;
    readonly yieldGrams: string;
  },
): RecipeDraft {
  return {
    description: "Synthetic fixture",
    ingredients: [
      {
        foodVersionId,
        kind: "food",
        portion: { amount: "1", kind: "serving", servingId },
      },
    ],
    instructions: "Mix.",
    name: options.name ?? "Fixture bowl",
    servingCount: options.servingCount,
    servingLabel: options.servingLabel,
    yield: { grams: options.yieldGrams, source: "measured" },
  };
}

function nestedRecipeDraft(recipeVersionId: string, name: string): RecipeDraft {
  return {
    description: null,
    ingredients: [{ grams: "1", kind: "recipe", recipeVersionId }],
    instructions: null,
    name,
    servingCount: null,
    servingLabel: null,
    yield: { grams: "1", source: "estimated" },
  };
}

async function cloneRecipeVersionForInvariantTest(
  transaction: Transaction<Database>,
  input: {
    readonly corruptFoodName?: boolean;
    readonly corruptNestedName?: boolean;
    readonly corruptUnknownReasons?: boolean;
    readonly inputMassGrams?: string;
    readonly recipeStatus?: "active" | "archived";
    readonly servingPair?: { readonly count: string | null; readonly label: string | null };
    readonly sourceVersionId: string;
    readonly totalYieldQuantity?: string | null;
    readonly userId: string;
    readonly versionNumber?: number;
  },
): Promise<void> {
  const sourceVersion = await transaction
    .selectFrom("recipe_version")
    .selectAll()
    .where("id", "=", input.sourceVersionId)
    .executeTakeFirstOrThrow();
  const recipeId = randomUUID();
  const versionId = randomUUID();
  await transaction
    .insertInto("recipe")
    .values({
      current_version_id: versionId,
      id: recipeId,
      owner_user_id: input.userId,
      status: "active",
    })
    .execute();
  await transaction
    .insertInto("recipe_version")
    .values({
      ...sourceVersion,
      created_by_user_id: input.userId,
      id: versionId,
      input_mass_grams: input.inputMassGrams ?? sourceVersion.input_mass_grams,
      owner_user_id: input.userId,
      recipe_id: recipeId,
      recipe_status: input.recipeStatus ?? "active",
      serving_count: input.servingPair?.count ?? sourceVersion.serving_count,
      serving_label:
        input.servingPair === undefined ? sourceVersion.serving_label : input.servingPair.label,
      total_yield_quantity:
        input.totalYieldQuantity === null
          ? sql<string>`null`
          : (input.totalYieldQuantity ?? sourceVersion.total_yield_quantity),
      version_number: input.versionNumber ?? 1,
      warnings: sql`${JSON.stringify(sourceVersion.warnings)}::jsonb`,
    })
    .execute();
  for (const row of await transaction
    .selectFrom("recipe_ingredient")
    .selectAll()
    .where("recipe_version_id", "=", input.sourceVersionId)
    .execute()) {
    const { id: _id, ...copy } = row;
    await transaction
      .insertInto("recipe_ingredient")
      .values({
        ...copy,
        food_name:
          input.corruptFoodName && row.ingredient_kind === "food" ? "False food" : row.food_name,
        nested_recipe_name:
          input.corruptNestedName && row.ingredient_kind === "recipe"
            ? "False nested recipe"
            : row.nested_recipe_name,
        recipe_version_id: versionId,
      })
      .execute();
  }
  for (const row of await transaction
    .selectFrom("recipe_version_nutrient")
    .selectAll()
    .where("recipe_version_id", "=", input.sourceVersionId)
    .execute()) {
    await transaction
      .insertInto("recipe_version_nutrient")
      .values({
        ...row,
        recipe_version_id: versionId,
        unknown_reasons:
          input.corruptUnknownReasons && row.unknown_count === 1
            ? { not_reported: 2, withheld: -1 }
            : row.unknown_reasons,
      })
      .execute();
  }
  for (const row of await transaction
    .selectFrom("recipe_version_source")
    .selectAll()
    .where("recipe_version_id", "=", input.sourceVersionId)
    .execute()) {
    await transaction
      .insertInto("recipe_version_source")
      .values({ ...row, recipe_version_id: versionId })
      .execute();
  }
}

async function cloneGoalVersionForInvariantTest(
  transaction: Transaction<Database>,
  input: {
    readonly clearDerivedBmr?: boolean;
    readonly effectiveFrom?: string;
    readonly nullReferencePath?: string;
    readonly nullTargetMetadataField?: string;
    readonly referenceJsonReplacement?: {
      readonly path: string;
      readonly value: unknown;
    };
    readonly sourceVersionId: string;
    readonly userId: string;
    readonly versionNumber?: number;
  },
): Promise<void> {
  const sourceVersion = await transaction
    .selectFrom("nutrition_goal_version")
    .selectAll()
    .where("id", "=", input.sourceVersionId)
    .executeTakeFirstOrThrow();
  const goalId = randomUUID();
  const versionId = randomUUID();
  const assumptions = input.nullReferencePath
    ? sql<JsonObject>`pg_catalog.jsonb_set(
        ${JSON.stringify(sourceVersion.assumptions)}::jsonb,
        pg_catalog.string_to_array(${input.nullReferencePath}, '.'),
        'null'::jsonb
      )`
    : input.referenceJsonReplacement
      ? sql<JsonObject>`pg_catalog.jsonb_set(
          ${JSON.stringify(sourceVersion.assumptions)}::jsonb,
          pg_catalog.string_to_array(${input.referenceJsonReplacement.path}, '.'),
          ${JSON.stringify(input.referenceJsonReplacement.value)}::jsonb
        )`
      : sourceVersion.assumptions;
  await transaction
    .insertInto("nutrition_goal")
    .values({
      current_version_id: versionId,
      effective_from: sourceVersion.effective_from,
      effective_to: sourceVersion.effective_to,
      id: goalId,
      status: sourceVersion.goal_status,
      user_id: input.userId,
    })
    .execute();
  await transaction
    .insertInto("nutrition_goal_version")
    .values({
      ...sourceVersion,
      assumptions,
      bmr_kcal: input.clearDerivedBmr ? sql<string>`null` : sourceVersion.bmr_kcal,
      created_by_user_id: input.userId,
      effective_from: input.effectiveFrom ?? sourceVersion.effective_from,
      id: versionId,
      nutrition_goal_id: goalId,
      user_id: input.userId,
      version_number: input.versionNumber ?? 1,
    })
    .execute();
  for (const row of await transaction
    .selectFrom("nutrition_goal_target")
    .selectAll()
    .where("nutrition_goal_version_id", "=", input.sourceVersionId)
    .execute()) {
    await transaction
      .insertInto("nutrition_goal_target")
      .values({
        ...row,
        metadata: input.nullTargetMetadataField
          ? sql<JsonObject>`pg_catalog.jsonb_set(
              ${JSON.stringify(row.metadata)}::jsonb,
              array[${input.nullTargetMetadataField}]::text[],
              'null'::jsonb
            )`
          : row.metadata,
        nutrition_goal_version_id: versionId,
      })
      .execute();
  }
}

async function cloneRecipeDiaryRevisionForInvariantTest(
  transaction: Transaction<Database>,
  input: {
    readonly changePortion?: boolean;
    readonly clearResolvedQuantity?: boolean;
    readonly corruptEngineVersion?: boolean;
    readonly corruptRecipeName?: boolean;
    readonly entryId: string;
  },
): Promise<void> {
  const head = await transaction
    .selectFrom("diary_entry")
    .select("current_revision_id")
    .where("id", "=", input.entryId)
    .executeTakeFirstOrThrow();
  const sourceRevision = await transaction
    .selectFrom("diary_entry_revision")
    .selectAll()
    .where("id", "=", head.current_revision_id)
    .executeTakeFirstOrThrow();
  const revisionId = randomUUID();
  await transaction
    .insertInto("diary_entry_revision")
    .values({
      ...sourceRevision,
      id: revisionId,
      operation: "update",
      recipe_name: input.corruptRecipeName ? "False recipe" : sourceRevision.recipe_name,
      recipe_warnings: sql`${JSON.stringify(sourceRevision.recipe_warnings)}::jsonb`,
      resolved_quantity: input.clearResolvedQuantity
        ? sql<string>`null`
        : input.changePortion
          ? "31"
          : sourceRevision.resolved_quantity,
      revision_number: (BigInt(sourceRevision.revision_number) + 100n).toString(),
      snapshot_engine_version: input.corruptEngineVersion
        ? "forged-engine@1"
        : sourceRevision.snapshot_engine_version,
      input_unit: input.changePortion ? "g" : sourceRevision.input_unit,
      quantity: input.changePortion ? "31" : sourceRevision.quantity,
    })
    .execute();
  for (const row of await transaction
    .selectFrom("diary_entry_revision_nutrient")
    .selectAll()
    .where("diary_entry_revision_id", "=", sourceRevision.id)
    .execute()) {
    await transaction
      .insertInto("diary_entry_revision_nutrient")
      .values({ ...row, diary_entry_revision_id: revisionId })
      .execute();
  }
  for (const row of await transaction
    .selectFrom("diary_entry_revision_source")
    .selectAll()
    .where("diary_entry_revision_id", "=", sourceRevision.id)
    .execute()) {
    await transaction
      .insertInto("diary_entry_revision_source")
      .values({ ...row, diary_entry_revision_id: revisionId })
      .execute();
  }
}

async function createFixture(databaseUrl: string, label: string) {
  const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  const schemaName = `${label}_${randomBytes(6).toString("hex")}`;
  await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
  const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 8 });
  await runMigrations(database);
  const catalogue = await seedCatalogue(database);
  const owner = await registerPasswordAccount(database, accountInput(`${label}-owner`));
  const other = await registerPasswordAccount(database, accountInput(`${label}-other`));
  return {
    bootstrap,
    catalogue,
    close: async () => {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    },
    database,
    other,
    owner,
    schemaName,
  };
}

async function seedCatalogue(database: ReturnType<typeof createDatabase>): Promise<{
  readonly energyId: string;
  readonly foodVersionId: string;
  readonly proteinId: string;
  readonly servingId: string;
  readonly sodiumId: string;
  readonly sourceId: string;
}> {
  return database.transaction().execute(async (transaction) => {
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    const nutrients = new Map<string, string>();
    for (const nutrient of [
      { code: "energy", dimension: "energy" as const, name: "Energy", unit: "kcal" },
      { code: "carbohydrate", dimension: "mass" as const, name: "Carbohydrate", unit: "g" },
      { code: "protein", dimension: "mass" as const, name: "Protein", unit: "g" },
      { code: "fiber", dimension: "mass" as const, name: "Fiber", unit: "g" },
      { code: "sodium", dimension: "mass" as const, name: "Sodium", unit: "mg" },
      { code: "potassium", dimension: "mass" as const, name: "Potassium", unit: "mg" },
      { code: "calcium", dimension: "mass" as const, name: "Calcium", unit: "mg" },
      { code: "iron", dimension: "mass" as const, name: "Iron", unit: "mg" },
      { code: "vitamin-c", dimension: "mass" as const, name: "Vitamin C", unit: "mg" },
      { code: "vitamin-d", dimension: "mass" as const, name: "Vitamin D", unit: "ug" },
      { code: "vitamin-b12", dimension: "mass" as const, name: "Vitamin B12", unit: "ug" },
      { code: "folate-dfe", dimension: "mass" as const, name: "Folate DFE", unit: "ug_DFE" },
      { code: "vitamin-a-rae", dimension: "mass" as const, name: "Vitamin A RAE", unit: "ug_RAE" },
    ]) {
      const row = await transaction
        .insertInto("nutrient")
        .values({
          canonical_unit: nutrient.unit,
          code: nutrient.code,
          dimension: nutrient.dimension,
          is_targetable: true,
          name: nutrient.name,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      nutrients.set(nutrient.code, row.id);
    }
    const source = await transaction
      .insertInto("food_source")
      .values({
        active: true,
        attribution_required: true,
        attribution_text: "Recipes/goals synthetic fixture",
        code: `RG${suffix}`,
        commercial_use_allowed: true,
        display_name: `Recipes source ${suffix}`,
        homepage_url: "https://example.invalid/recipes",
        kind: "government",
        license_expression: "CC0-1.0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistribution_allowed: true,
        rights_review_status: "approved",
        rights_reviewed_at: "2026-08-15T00:00:00Z",
        rights_reviewed_by: "principal:recipes-test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const release = await insertRelease(transaction, source.id);
    const batch = await insertBatch(transaction, source.id, release);
    const food = await transaction
      .insertInto("food")
      .values({
        food_source_id: source.id,
        kind: "generic",
        owner_user_id: null,
        source_food_key: `recipe-food-${suffix}`,
        visibility: "public",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await transaction
      .insertInto("food_version")
      .values({
        basis_quantity: "100",
        basis_unit: "g",
        data_quality: "verified",
        food_id: food.id,
        language_tag: "en-US",
        market_code: "US",
        name: "Recipe Crackers",
        normalized_name: "recipe crackers",
        source_release_id: release,
        version_number: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const validatedFood = {
      attributes: {
        idempotencyKey: `recipe-food-${suffix}:1`,
        sourcePayloadSha256: "4".repeat(64),
        unlistedNutrientPolicy: "unknown_not_reported",
      },
      basisQuantity: "100",
      brandName: null,
      description: null,
      gtin: null,
      kind: "generic" as const,
      languageTag: "en-US",
      marketCode: "US",
      name: "Recipe Crackers",
      normalizedName: "recipe crackers",
      nutrients: [],
      servings: [],
      sourceDataType: "fixture",
      sourceFoodKey: `recipe-food-${suffix}`,
      sourceModifiedAt: null,
    };
    const validatedFoodDocument = canonicalJson(validatedFood);
    const record = await transaction
      .insertInto("food_import_record")
      .values({
        batch_id: batch,
        canonical_payload: { fixture: true },
        canonical_payload_sha256: "3".repeat(64),
        sequence_number: 1,
        source_payload_sha256: "4".repeat(64),
        source_record_key: `recipe-food-${suffix}:1`,
        source_record_type: "fixture",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("food_import_record")
      .set({
        validated_at: "2026-08-15T00:30:00Z",
        validated_food_contract_version: 1,
        validated_food_document: validatedFoodDocument,
        validated_food_sha256: sha256CanonicalJson(validatedFood),
        validation_issues: sql`'[]'::jsonb`,
        validation_status: "valid",
      })
      .where("id", "=", record.id)
      .execute();
    await transaction
      .updateTable("food_import_record")
      .set({
        food_version_id: version.id,
        materialized_at: "2026-08-15T01:00:00Z",
        validation_status: "materialized",
      })
      .where("id", "=", record.id)
      .execute();
    await transaction
      .updateTable("food")
      .set({ current_version_id: version.id })
      .where("id", "=", food.id)
      .execute();
    const serving = await transaction
      .insertInto("food_serving")
      .values({
        food_version_id: version.id,
        gram_weight: "50",
        is_default: true,
        label: "2 crackers",
        metadata: { fixture: true },
        quantity: "2",
        source_serving_key: "two-crackers",
        unit: "cracker",
        unit_kind: "count",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const value of [
      { amount: "200", code: "energy", unit: "kcal" },
      { amount: "10", code: "protein", unit: "g" },
    ]) {
      await transaction
        .insertInto("food_nutrient_value")
        .values({
          amount: value.amount,
          basis_quantity: "100",
          basis_unit: "g",
          food_version_id: version.id,
          nutrient_id: nutrients.get(value.code) ?? "missing",
          unit: value.unit,
          value_status: "measured",
        })
        .execute();
    }
    await transaction
      .updateTable("food_import_batch")
      .set({
        completed_at: "2026-08-15T01:00:00Z",
        materialized_count: 1,
        status: "completed",
      })
      .where("id", "=", batch)
      .execute();
    await transaction
      .updateTable("food_source_release")
      .set({ promoted_at: "2026-08-15T02:00:00Z", status: "promoted" })
      .where("id", "=", release)
      .execute();
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: release })
      .where("id", "=", source.id)
      .execute();
    const energyId = nutrients.get("energy");
    const proteinId = nutrients.get("protein");
    const sodiumId = nutrients.get("sodium");
    if (!energyId || !proteinId || !sodiumId) throw new Error("Nutrient fixture is incomplete");
    return {
      energyId,
      foodVersionId: version.id,
      proteinId,
      servingId: serving.id,
      sodiumId,
      sourceId: source.id,
    };
  });
}

async function insertRelease(
  transaction: Transaction<Database>,
  sourceId: string,
): Promise<string> {
  return (
    await transaction
      .insertInto("food_source_release")
      .values({
        acquired_at: "2026-08-15T00:00:00Z",
        artifact_bytes: 100,
        artifact_sha256: "5".repeat(64),
        artifact_uri: "s3://recipes-test/catalogue.json",
        evidence_bundle_sha256: "7".repeat(64),
        evidence_bundle_uri: `s3://recipes-test/sha256/${"7".repeat(64)}/bundle.json`,
        evidence_decision_sha256: "8".repeat(64),
        evidence_object_version_id: "recipes-test-evidence-v1",
        evidence_valid_until: FIXTURE_EVIDENCE_VALID_UNTIL,
        food_source_id: sourceId,
        media_type: "application/json",
        parser_version: "recipes-test@1",
        record_counts: { records: 1 },
        release_class: "live-reviewed",
        release_key: "recipes-release-1",
        rights_manifest_sha256: "6".repeat(64),
        rights_manifest_uri: "repo://recipes-rights.json",
        status: "imported",
        validation_summary: { valid: true },
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function insertBatch(
  transaction: Transaction<Database>,
  sourceId: string,
  releaseId: string,
): Promise<string> {
  const batch = await transaction
    .insertInto("food_import_batch")
    .values({
      acquired_at: "2026-08-15T00:00:00Z",
      artifact_bytes: 100,
      artifact_sha256: "5".repeat(64),
      artifact_uri: "s3://recipes-test/catalogue.json",
      evidence_bundle_sha256: "7".repeat(64),
      evidence_bundle_uri: `s3://recipes-test/sha256/${"7".repeat(64)}/bundle.json`,
      evidence_decision_sha256: "8".repeat(64),
      evidence_object_version_id: "recipes-test-evidence-v1",
      evidence_valid_until: FIXTURE_EVIDENCE_VALID_UNTIL,
      food_source_id: sourceId,
      media_type: "application/json",
      parser_version: "recipes-test@1",
      release_class: "live-reviewed",
      release_key: "recipes-release-1",
      rights_manifest_sha256: "6".repeat(64),
      rights_manifest_uri: "repo://recipes-rights.json",
      staged_count: 1,
      valid_count: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("food_import_batch")
    .set({
      nutrient_mapping_digest: sha256CanonicalJson([]),
      nutrient_mapping_revision_ids: sql`'[]'::jsonb`,
      status: "ready",
      validated_at: "2026-08-15T00:30:00Z",
      validated_food_contract_version: 1,
      validation_digest: "d".repeat(64),
    })
    .where("id", "=", batch.id)
    .execute();
  await transaction
    .updateTable("food_import_batch")
    .set({ release_id: releaseId, status: "promoting" })
    .where("id", "=", batch.id)
    .execute();
  return batch.id;
}
