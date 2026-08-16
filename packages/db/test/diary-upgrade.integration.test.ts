import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  createDatabase,
  createFoodDiaryEntry,
  DiaryIdempotencyConflictError,
  getDiaryDay,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("0004 existing-schema diary upgrade", () => {
  it("rejects ambiguous legacy units and backfills remediated rows without losing missingness", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_upgrade_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    try {
      for (const migrationName of [
        "0001_initial_domain_schema.sql",
        "0002_catalogue_ingestion.sql",
        "0003_promoted_food_search.sql",
      ]) {
        const migration = await readFile(
          resolve(import.meta.dirname, "../migrations", migrationName),
          "utf8",
        );
        await sql.raw(migration).execute(database);
      }

      const legacyEmail = `legacy-${randomUUID()}@example.invalid`;
      const user = await database
        .insertInto("app_user")
        .values({
          auth_subject: `legacy:${randomUUID()}`,
          email: legacyEmail,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("user_profile")
        .values({ time_zone: "America/Chicago", user_id: user.id })
        .execute();
      const energy = await database
        .insertInto("nutrient")
        .values({ canonical_unit: "kcal", code: "energy", dimension: "energy", name: "Energy" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const fiber = await database
        .insertInto("nutrient")
        .values({ canonical_unit: "g", code: "fiber", dimension: "mass", name: "Fiber" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const sodium = await database
        .insertInto("nutrient")
        .values({ canonical_unit: "mg", code: "sodium", dimension: "mass", name: "Sodium" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const source = await database
        .insertInto("food_source")
        .values({
          active: false,
          attribution_required: true,
          attribution_text: "Legacy upgrade fixture",
          code: `LG${randomBytes(4).toString("hex").toUpperCase()}`,
          commercial_use_allowed: true,
          display_name: "Legacy upgrade source",
          homepage_url: "https://example.invalid/legacy-upgrade",
          kind: "government",
          license_expression: "CC0-1.0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
          redistribution_allowed: true,
          rights_review_status: "approved",
          rights_reviewed_at: "2026-08-01T00:00:00Z",
          rights_reviewed_by: "principal:legacy-upgrade",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const release = await database
        .insertInto("food_source_release")
        .values({
          acquired_at: "2026-08-01T00:00:00Z",
          artifact_bytes: 1,
          artifact_sha256: "a".repeat(64),
          artifact_uri: "s3://legacy-upgrade/catalogue.json",
          food_source_id: source.id,
          media_type: "application/json",
          parser_version: "legacy-upgrade@1",
          record_counts: { records: 1 },
          release_key: "legacy-release",
          rights_manifest_sha256: "b".repeat(64),
          rights_manifest_uri: "repo://legacy-rights.json",
          status: "imported",
          validation_summary: { valid: true },
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const food = await database
        .insertInto("food")
        .values({
          food_source_id: source.id,
          kind: "generic",
          owner_user_id: null,
          source_food_key: `legacy-food-${randomUUID()}`,
          visibility: "public",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const version = await database
        .insertInto("food_version")
        .values({
          basis_quantity: "100",
          basis_unit: "g",
          data_quality: "verified",
          food_id: food.id,
          name: "Legacy Partial Food",
          normalized_name: "legacy partial food",
          source_release_id: release.id,
          version_number: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .updateTable("food")
        .set({ current_version_id: version.id })
        .where("id", "=", food.id)
        .execute();
      const legacyServing = await database
        .insertInto("food_serving")
        .values({
          food_version_id: version.id,
          gram_weight: "50",
          is_default: true,
          label: "2 crackers",
          quantity: "2",
          source_serving_key: "legacy-two-crackers",
          unit: "cracker",
          unit_kind: "count",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const day = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-15", time_zone: "America/Chicago", user_id: user.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      const legacyEntryId = randomUUID();
      // The pre-0004 Kysely type includes the forward columns, so raw SQL is
      // intentional here: this fixture represents the actual old table shape.
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${legacyEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'note',
          '2026-08-15T12:00:00Z', '07:00:00', 'breakfast', 0, 'legacy deleted note',
          'pending', null, '2026-08-15T13:00:00Z'
        )
      `.execute(database);
      const partialEntryId = randomUUID();
      const partialClientOperationId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${partialEntryId}, ${day.id}, ${user.id}, ${partialClientOperationId}, 'food',
          ${version.id}, null, null,
          100, 'g', 100,
          '2026-08-15T17:00:00Z', '12:00:00', 'lunch', 1, null,
          'partial', 'legacy-engine@1', null
        )
      `.execute(database);
      const oversizedNoteId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${oversizedNoteId}, ${day.id}, ${user.id}, ${randomUUID()}, 'note',
          '2026-08-15T23:40:00Z', '18:40:00', 'snacks', 6, 'oversized deleted note',
          'complete', 'legacy-engine@1', '2026-08-15T23:41:00Z'
        )
      `.execute(database);
      await database
        .insertInto("diary_entry_nutrient_snapshot")
        .values({
          amount: "100",
          calculation_version: "legacy-engine@1",
          diary_entry_id: partialEntryId,
          nutrient_id: energy.id,
          provenance: { valueStatus: "measured" },
          unit: "kcal",
        })
        .execute();
      await database
        .insertInto("diary_entry_nutrient_snapshot")
        .values({
          amount: "0",
          calculation_version: "legacy-engine@1",
          diary_entry_id: partialEntryId,
          nutrient_id: fiber.id,
          provenance: { valueStatus: "trace" },
          unit: "g",
        })
        .execute();

      const ambiguousPortionEntryId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${ambiguousPortionEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'food',
          ${version.id}, null, null,
          1, 'oz', 28.3495,
          '2026-08-15T20:00:00Z', '15:00:00', 'snacks', 2, null,
          'pending', null, null
        )
      `.execute(database);

      const diaryMigration = await readFile(
        resolve(import.meta.dirname, "../migrations/0004_diary_accounts_and_revisions.sql"),
        "utf8",
      );
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary upgrade blocked: 1 active legacy diary entries/u);
      const ddlState = await sql<{ relation_name: string | null }>`
        select to_regclass(${`${schemaName}.user_password_credential`})::text as relation_name
      `.execute(database);
      expect(ddlState.rows[0]?.relation_name).toBeNull();
      await database
        .updateTable("diary_entry")
        .set({ deleted_at: "2026-08-15T21:00:00Z" })
        .where("id", "=", ambiguousPortionEntryId)
        .execute();

      const validServingEntryId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${validServingEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'food',
          ${version.id}, ${legacyServing.id}, null,
          2, 'serving', 100,
          '2026-08-15T22:00:00Z', '17:00:00', 'dinner', 3, null,
          'pending', null, null
        )
      `.execute(database);
      const invalidServingEntryId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${invalidServingEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'food',
          ${version.id}, ${legacyServing.id}, null,
          2, 'cracker', 100,
          '2026-08-15T23:00:00Z', '18:00:00', 'dinner', 4, null,
          'pending', null, null
        )
      `.execute(database);
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary upgrade blocked: 1 active legacy diary entries/u);
      await database
        .updateTable("diary_entry")
        .set({ input_unit: "serving", resolved_grams: "90" })
        .where("id", "=", invalidServingEntryId)
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary upgrade blocked: 1 active legacy diary entries/u);
      await database
        .updateTable("diary_entry")
        .set({ deleted_at: "2026-08-15T23:30:00Z" })
        .where("id", "=", invalidServingEntryId)
        .execute();

      await database
        .updateTable("diary_entry")
        .set({ position: 1_000_001 })
        .where("id", "=", invalidServingEntryId)
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary structural upgrade blocked/u);
      await database
        .updateTable("diary_entry")
        .set({ position: 4 })
        .where("id", "=", invalidServingEntryId)
        .execute();

      const unitMismatchEntryId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${unitMismatchEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'food',
          ${version.id}, null, null,
          1, 'g', 1,
          '2026-08-15T23:15:00Z', '18:15:00', 'dinner', 5, null,
          'complete', 'legacy-engine@1', '2026-08-15T23:20:00Z'
        )
      `.execute(database);
      await database
        .insertInto("diary_entry_nutrient_snapshot")
        .values({
          amount: "1",
          calculation_version: "legacy-engine@1",
          diary_entry_id: unitMismatchEntryId,
          nutrient_id: energy.id,
          provenance: { valueStatus: "measured" },
          unit: "mg",
        })
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary snapshot upgrade blocked/u);
      await database.deleteFrom("diary_entry").where("id", "=", unitMismatchEntryId).execute();

      const nonFiniteEntryId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${nonFiniteEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'note',
          '2026-08-15T23:25:00Z', '18:25:00', 'snacks', 8, 'non-finite tombstone',
          'complete', 'legacy-engine@1', '2026-08-15T23:26:00Z'
        )
      `.execute(database);
      await database
        .insertInto("diary_entry_nutrient_snapshot")
        .values({
          amount: "NaN",
          calculation_version: "legacy-engine@1",
          diary_entry_id: nonFiniteEntryId,
          nutrient_id: energy.id,
          provenance: { valueStatus: "measured" },
          unit: "kcal",
        })
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 numeric upgrade blocked/u);
      await database.deleteFrom("diary_entry").where("id", "=", nonFiniteEntryId).execute();

      await database
        .updateTable("app_user")
        .set({ email: `${"a".repeat(243)}@example.com` })
        .where("id", "=", user.id)
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 account upgrade blocked/u);
      await database
        .updateTable("app_user")
        .set({ email: legacyEmail })
        .where("id", "=", user.id)
        .execute();
      await database
        .updateTable("app_user")
        .set({ email: "legacy@@example.invalid" })
        .where("id", "=", user.id)
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 account upgrade blocked/u);
      await database
        .updateTable("app_user")
        .set({ email: legacyEmail })
        .where("id", "=", user.id)
        .execute();

      const invalidEmptyDay = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-16", time_zone: "Not/A_Zone", user_id: user.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary-day upgrade blocked/u);
      await database.deleteFrom("diary").where("id", "=", invalidEmptyDay.id).execute();

      await database
        .updateTable("diary")
        .set({ local_date: "infinity", updated_at: "infinity" })
        .where("id", "=", day.id)
        .execute();
      await database
        .updateTable("diary_entry")
        .set({ occurred_at: "infinity" })
        .where("id", "=", invalidServingEntryId)
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary-day upgrade blocked/u);
      await database
        .updateTable("diary")
        .set({ local_date: "2026-08-15", updated_at: "2026-08-15T23:45:00Z" })
        .where("id", "=", day.id)
        .execute();
      await database
        .updateTable("diary_entry")
        .set({ occurred_at: "2026-08-15T23:00:00Z" })
        .where("id", "=", invalidServingEntryId)
        .execute();

      await database
        .updateTable("user_profile")
        .set({ birth_date: "-infinity", display_name: "x".repeat(101) })
        .where("user_id", "=", user.id)
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 profile upgrade blocked/u);
      await database
        .updateTable("user_profile")
        .set({ birth_date: null, display_name: "Legacy User" })
        .where("user_id", "=", user.id)
        .execute();

      const extraNutrients = await database
        .insertInto("nutrient")
        .values(
          Array.from({ length: 254 }, (_, index) => ({
            canonical_unit: "g",
            code: `extra_${index.toString().padStart(3, "0")}`,
            dimension: "mass" as const,
            name: index === 0 ? "n".repeat(201) : `Extra nutrient ${index}`,
          })),
        )
        .returning("id")
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 nutrient registry upgrade blocked: 1 nutrient definitions/u);
      await database
        .deleteFrom("nutrient")
        .where("id", "=", extraNutrients[0]?.id ?? "missing")
        .execute();
      extraNutrients[0] = await database
        .insertInto("nutrient")
        .values({
          canonical_unit: "g",
          code: "extra_replacement",
          dimension: "mass",
          name: "Extra nutrient replacement",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/257 active nutrients exceed the 256-element diary vector limit/u);
      const inactiveExtraA = extraNutrients.at(-1)?.id ?? "missing";
      const inactiveExtraB = extraNutrients.at(-2)?.id ?? "missing";
      await database
        .updateTable("nutrient")
        .set({ active: false })
        .where("id", "in", [inactiveExtraA, inactiveExtraB])
        .execute();
      const mixedVectorEntryId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${mixedVectorEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'food',
          ${version.id}, null, null,
          1, 'g', 1,
          '2026-08-15T23:35:00Z', '18:35:00', 'snacks', 7, null,
          'complete', 'legacy-engine@1', null
        )
      `.execute(database);
      await database
        .insertInto("diary_entry_nutrient_snapshot")
        .values([
          {
            amount: "0",
            calculation_version: "legacy-engine@1",
            diary_entry_id: partialEntryId,
            nutrient_id: inactiveExtraA,
            provenance: { valueStatus: "measured" },
            unit: "g",
          },
          {
            amount: "0",
            calculation_version: "legacy-engine@1",
            diary_entry_id: mixedVectorEntryId,
            nutrient_id: inactiveExtraB,
            provenance: { valueStatus: "measured" },
            unit: "g",
          },
        ])
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/active legacy days exceed the 256-nutrient union limit/u);
      await database
        .updateTable("diary_entry")
        .set({ deleted_at: "2026-08-15T23:36:00Z" })
        .where("id", "=", mixedVectorEntryId)
        .execute();

      await database
        .insertInto("diary_entry_nutrient_snapshot")
        .values(
          [
            { id: energy.id, unit: "kcal" },
            { id: fiber.id, unit: "g" },
            { id: sodium.id, unit: "mg" },
            ...extraNutrients.map((nutrient) => ({ id: nutrient.id, unit: "g" })),
          ].map((nutrient) => ({
            amount: "0",
            calculation_version: "legacy-engine@1",
            diary_entry_id: oversizedNoteId,
            nutrient_id: nutrient.id,
            provenance: { valueStatus: "measured" },
            unit: nutrient.unit,
          })),
        )
        .execute();
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary structural upgrade blocked/u);
      await database.deleteFrom("diary_entry").where("id", "=", oversizedNoteId).execute();
      await sql.raw(diaryMigration).execute(database);

      const head = await database
        .selectFrom("diary_entry as entry")
        .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
        .select(["revision.operation", "revision.note", "revision.revision_number"])
        .where("entry.id", "=", legacyEntryId)
        .executeTakeFirstOrThrow();
      expect(head).toEqual({
        note: "legacy deleted note",
        operation: "delete",
        revision_number: "1",
      });
      expect(
        await database
          .selectFrom("diary_entry as entry")
          .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
          .select("revision.operation")
          .where("entry.id", "=", ambiguousPortionEntryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ operation: "delete" });
      expect(
        await database
          .selectFrom("diary_entry as entry")
          .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
          .select("revision.operation")
          .where("entry.id", "=", invalidServingEntryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ operation: "delete" });
      expect(
        await getDiaryDay(database, { localDate: "2026-08-15", userId: user.id }),
      ).toMatchObject({ revision: "0", totalEntries: 2 });
      const upgradedDay = await getDiaryDay(database, {
        localDate: "2026-08-15",
        userId: user.id,
      });
      expect(new Set(upgradedDay.entries.map((entry) => entry.id))).toEqual(
        new Set([partialEntryId, validServingEntryId]),
      );
      const upgradedPartialEntry = upgradedDay.entries.find((entry) => entry.id === partialEntryId);
      const upgradedServingEntry = upgradedDay.entries.find(
        (entry) => entry.id === validServingEntryId,
      );
      expect(upgradedPartialEntry).toMatchObject({
        portion: { amount: "100", resolvedGrams: "100" },
        snapshotStatus: "partial",
      });
      expect(upgradedServingEntry).toMatchObject({
        portion: {
          amount: "2",
          inputUnit: "serving",
          resolvedGrams: "100",
          servingId: legacyServing.id,
        },
        snapshotStatus: "partial",
      });
      expect(
        upgradedPartialEntry?.nutrients.find((value) => value.code === "energy"),
      ).toMatchObject({
        completeness: "complete",
        isExact: true,
        knownAmount: "100",
        quantifiedCount: 1,
        unknownCount: 0,
      });
      expect(
        upgradedPartialEntry?.nutrients.find((value) => value.code === "sodium"),
      ).toMatchObject({
        completeness: "unknown",
        isExact: false,
        knownAmount: "0",
        quantifiedCount: 0,
        unknownCount: 1,
        unknownReasons: { not_reported: 1 },
      });
      expect(upgradedPartialEntry?.nutrients.find((value) => value.code === "fiber")).toMatchObject(
        {
          completeness: "complete",
          isExact: false,
          knownAmount: "0",
          quantifiedCount: 0,
          traceCount: 1,
          unknownCount: 0,
        },
      );
      expect(upgradedDay.totals.find((value) => value.code === "sodium")).toMatchObject({
        completeness: "unknown",
        knownAmount: "0",
        unknownCount: 2,
      });
      expect(
        await database
          .selectFrom("diary_entry as entry")
          .innerJoin("diary_entry_revision as revision", "revision.id", "entry.current_revision_id")
          .select(["revision.nutrient_component_count", "revision.snapshot_status"])
          .where("entry.id", "=", partialEntryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ nutrient_component_count: 256, snapshot_status: "partial" });

      await expect(
        createFoodDiaryEntry(database, {
          clientOperationId: partialClientOperationId,
          foodVersionId: version.id,
          mealSlot: "lunch",
          occurredAt: "2026-08-15T17:00:00Z",
          portion: { grams: "100", kind: "grams" },
          requestDigest: "c".repeat(64),
          userId: user.id,
        }),
      ).rejects.toBeInstanceOf(DiaryIdempotencyConflictError);
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("aborts before DDL when active legacy rows cannot satisfy the public diary contract", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_upgrade_blocked_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    try {
      for (const migrationName of [
        "0001_initial_domain_schema.sql",
        "0002_catalogue_ingestion.sql",
        "0003_promoted_food_search.sql",
      ]) {
        const migration = await readFile(
          resolve(import.meta.dirname, "../migrations", migrationName),
          "utf8",
        );
        await sql.raw(migration).execute(database);
      }

      const user = await database
        .insertInto("app_user")
        .values({
          auth_subject: `legacy-blocked:${randomUUID()}`,
          email: `legacy-blocked-${randomUUID()}@example.invalid`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("user_profile")
        .values({ time_zone: "America/Chicago", user_id: user.id })
        .execute();
      const day = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-15", time_zone: "America/Chicago", user_id: user.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      const noteId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${noteId}, ${day.id}, ${user.id}, ${randomUUID()}, 'note',
          '2026-08-15T12:00:00Z', '07:00:00', 'breakfast', 0, 'active legacy note',
          'pending', null, null
        )
      `.execute(database);

      const customFood = await database
        .insertInto("food")
        .values({
          food_source_id: null,
          kind: "custom",
          owner_user_id: user.id,
          source_food_key: null,
          visibility: "private",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const customVersion = await database
        .insertInto("food_version")
        .values({
          basis_quantity: "100",
          basis_unit: "g",
          created_by_user_id: user.id,
          data_quality: "verified",
          food_id: customFood.id,
          name: "Legacy Custom Food",
          normalized_name: "legacy custom food",
          source_release_id: null,
          version_number: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .updateTable("food")
        .set({ current_version_id: customVersion.id })
        .where("id", "=", customFood.id)
        .execute();
      const customEntryId = randomUUID();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version, deleted_at
        ) values (
          ${customEntryId}, ${day.id}, ${user.id}, ${randomUUID()}, 'food',
          ${customVersion.id}, null, null,
          100, 'g', 100,
          '2026-08-15T17:00:00Z', '12:00:00', 'lunch', 1, null,
          'complete', 'legacy-engine@1', null
        )
      `.execute(database);

      const diaryMigration = await readFile(
        resolve(import.meta.dirname, "../migrations/0004_diary_accounts_and_revisions.sql"),
        "utf8",
      );
      await expect(
        database
          .transaction()
          .execute((transaction) => sql.raw(diaryMigration).execute(transaction)),
      ).rejects.toThrow(/0004 diary upgrade blocked: 2 active legacy diary entries/u);

      const ddlState = await sql<{ relation_name: string | null }>`
        select to_regclass(${`${schemaName}.user_password_credential`})::text as relation_name
      `.execute(database);
      expect(ddlState.rows[0]?.relation_name).toBeNull();
      expect(
        await database
          .selectFrom("diary_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "2" });
      const forwardColumn = await sql<{ count: string }>`
        select count(*)::text as count
        from information_schema.columns
        where table_schema = ${schemaName}
          and table_name = 'diary_entry'
          and column_name = 'current_revision_id'
      `.execute(database);
      expect(forwardColumn.rows[0]).toEqual({ count: "0" });
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("evaluates public timestamp bounds in UTC regardless of the database session zone", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_upgrade_utc_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set(
      "options",
      `-csearch_path=${schemaName},public -cTimeZone=Pacific/Kiritimati`,
    );
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 1 });
    try {
      for (const migrationName of [
        "0001_initial_domain_schema.sql",
        "0002_catalogue_ingestion.sql",
        "0003_promoted_food_search.sql",
      ]) {
        const migration = await readFile(
          resolve(import.meta.dirname, "../migrations", migrationName),
          "utf8",
        );
        await sql.raw(migration).execute(database);
      }
      const user = await database
        .insertInto("app_user")
        .values({
          auth_subject: `legacy-utc-boundary:${randomUUID()}`,
          email: `legacy-utc-boundary-${randomUUID()}@example.invalid`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("user_profile")
        .values({ time_zone: "UTC", user_id: user.id })
        .execute();
      const day = await database
        .insertInto("diary")
        .values({ local_date: "9999-12-31", time_zone: "UTC", user_id: user.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .updateTable("diary")
        .set({ updated_at: "9999-12-31T12:00:00Z" })
        .where("id", "=", day.id)
        .execute();

      const diaryMigration = await readFile(
        resolve(import.meta.dirname, "../migrations/0004_diary_accounts_and_revisions.sql"),
        "utf8",
      );
      await expect(sql.raw(diaryMigration).execute(database)).resolves.toBeDefined();
      await expect(
        database
          .insertInto("diary")
          .values({ local_date: "2026-08-15", time_zone: "Not/A_Zone", user_id: user.id })
          .execute(),
      ).rejects.toMatchObject({ code: "22023" });
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("rejects legacy days above the 50-entry non-paginated beta limit", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_upgrade_capacity_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 1 });
    try {
      for (const migrationName of [
        "0001_initial_domain_schema.sql",
        "0002_catalogue_ingestion.sql",
        "0003_promoted_food_search.sql",
      ]) {
        const migration = await readFile(
          resolve(import.meta.dirname, "../migrations", migrationName),
          "utf8",
        );
        await sql.raw(migration).execute(database);
      }
      const user = await database
        .insertInto("app_user")
        .values({
          auth_subject: `legacy-capacity:${randomUUID()}`,
          email: `legacy-capacity-${randomUUID()}@example.invalid`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("user_profile")
        .values({ time_zone: "UTC", user_id: user.id })
        .execute();
      const day = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-15", time_zone: "UTC", user_id: user.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      await sql`
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version
        )
        select
          gen_random_uuid(), ${day.id}, ${user.id}, gen_random_uuid(), 'note',
          '2026-08-15T12:00:00Z', '12:00:00', 'snacks', ordinal,
          'legacy over-cap note', 'pending', null
        from generate_series(0, 50) ordinal
      `.execute(database);

      const diaryMigration = await readFile(
        resolve(import.meta.dirname, "../migrations/0004_diary_accounts_and_revisions.sql"),
        "utf8",
      );
      await expect(sql.raw(diaryMigration).execute(database)).rejects.toThrow(
        /50-entry beta response limit/u,
      );
      const ddlState = await sql<{ relation_name: string | null }>`
        select to_regclass(${`${schemaName}.user_password_credential`})::text as relation_name
      `.execute(database);
      expect(ddlState.rows[0]?.relation_name).toBeNull();
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);
});
