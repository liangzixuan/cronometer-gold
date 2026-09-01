import { randomBytes, randomUUID } from "node:crypto";
import { NUTRITION_ENGINE_VERSION } from "@nutrition-tracker/domain";
import { sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";

import {
  AccountConflictError,
  AccountNotFoundError,
  createDatabase,
  createFoodDiaryEntry,
  createSession,
  type Database,
  DiaryEntryRevisionConflictError,
  DiaryIdempotencyConflictError,
  DiaryLockedError,
  DiaryNotFoundError,
  DiaryPageStaleError,
  DiaryTimeZoneChangedError,
  DiaryValidationError,
  deleteDiaryEntry,
  findActiveSessionByTokenHash,
  findPasswordCredentialByEmail,
  getDiaryDay,
  getDiaryDayPage,
  getUserProfile,
  ProfileRevisionConflictError,
  registerPasswordAccount,
  registerSourceNutrientMappings,
  revokeSession,
  runMigrations,
  updateFoodDiaryEntry,
  updateUserProfile,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const STABLE_FUTURE_SESSION_EXPIRY = "2500-09-01T00:00:00Z";

describeDatabase("account and append-only diary persistence", () => {
  it("enforces ownership, idempotency, immutable nutrition revisions, and exact day totals", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const owner = await registerPasswordAccount(database, {
        displayName: "Diary Owner",
        email: "OWNER@Example.Invalid ",
        passwordHash: "$argon2id$fixture-hash-value",
        passwordParameters: { algorithm: "argon2id", memoryKiB: 19456 },
        passwordSalt: "fixture-salt-value-123456",
        timeZone: "America/Chicago",
      });
      const dateBoundaryOwner = await registerPasswordAccount(database, {
        email: "date-boundary@example.invalid",
        passwordHash: "$argon2id$date-boundary-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "date-boundary-fixture-salt",
        timeZone: "Pacific/Kiritimati",
      });
      expect(owner).toMatchObject({
        displayName: "Diary Owner",
        email: "owner@example.invalid",
        emailVerified: false,
        revision: "0",
        timeZone: "America/Chicago",
      });
      await expect(
        registerPasswordAccount(database, {
          email: "owner@example.invalid",
          passwordHash: "$argon2id$another-fixture-hash",
          passwordParameters: { algorithm: "argon2id" },
          passwordSalt: "another-fixture-salt-value",
          timeZone: "UTC",
        }),
      ).rejects.toBeInstanceOf(AccountConflictError);
      await expect(
        registerPasswordAccount(database, {
          email: "invalid@@example.invalid",
          passwordHash: "$argon2id$invalid-email-fixture-hash",
          passwordParameters: { algorithm: "argon2id" },
          passwordSalt: "invalid-email-fixture-salt",
          timeZone: "UTC",
        }),
      ).rejects.toThrow(/email/u);
      await expect(
        registerPasswordAccount(database, {
          displayName: "x".repeat(101),
          email: "overlong-display@example.invalid",
          passwordHash: "$argon2id$overlong-display-hash",
          passwordParameters: { algorithm: "argon2id" },
          passwordSalt: "overlong-display-salt",
          timeZone: "UTC",
        }),
      ).rejects.toThrow(/displayName/u);
      expect(await findPasswordCredentialByEmail(database, " OWNER@example.invalid")).toMatchObject(
        {
          passwordHash: "$argon2id$fixture-hash-value",
          userId: owner.userId,
        },
      );

      const tokenHash = "d".repeat(64);
      const session = await createSession(database, {
        expiresAt: STABLE_FUTURE_SESSION_EXPIRY,
        tokenHash,
        userId: owner.userId,
      });
      expect(
        await findActiveSessionByTokenHash(database, tokenHash, "2026-08-16T00:00:00Z"),
      ).toMatchObject({ id: session.id, userId: owner.userId });
      expect(await revokeSession(database, { tokenHash, userId: owner.userId })).toBe(true);
      expect(
        await findActiveSessionByTokenHash(database, tokenHash, "2026-08-16T02:00:00Z"),
      ).toBeNull();

      const updatedProfile = await updateUserProfile(database, {
        expectedRevision: "0",
        patch: { displayName: "Owner Updated" },
        userId: owner.userId,
      });
      expect(updatedProfile).toMatchObject({ displayName: "Owner Updated", revision: "1" });
      await expect(
        updateUserProfile(database, {
          expectedRevision: "0",
          patch: { displayName: "Stale" },
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(ProfileRevisionConflictError);
      await expect(
        updateUserProfile(database, {
          expectedRevision: "1",
          patch: { timeZone: "Not/A_Real_Zone" },
          userId: owner.userId,
        }),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        updateUserProfile(database, {
          expectedRevision: "1",
          patch: { displayName: "😀".repeat(100) },
          userId: owner.userId,
        }),
      ).rejects.toThrow(/displayName/u);
      await expect(
        updateUserProfile(database, {
          expectedRevision: "1",
          patch: { birthDate: "0000-01-01" },
          userId: owner.userId,
        }),
      ).rejects.toThrow(/birthDate/u);

      const createOperationId = randomUUID();
      const createInput = {
        clientOperationId: createOperationId,
        expectedProfileTimeZone: "America/Chicago",
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "breakfast" as const,
        occurredAt: "2026-08-15T05:30:00Z",
        portion: { amount: "2", kind: "serving" as const, servingId: catalogue.servingId },
        requestDigest: "a".repeat(64),
        userId: owner.userId,
      };
      const mismatchedOperationId = randomUUID();
      await expect(
        createFoodDiaryEntry(database, {
          ...createInput,
          clientOperationId: mismatchedOperationId,
          expectedProfileTimeZone: "Asia/Tokyo",
          requestDigest: "9".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryTimeZoneChangedError);
      expect(
        await database
          .selectFrom("diary_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .where("client_operation_id", "=", mismatchedOperationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      expect(
        await database
          .selectFrom("diary_operation")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .where("client_operation_id", "=", mismatchedOperationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      const created = await createFoodDiaryEntry(database, createInput);
      expect(created).toMatchObject({
        days: [{ localDate: "2026-08-15", revision: "1" }],
        entry: {
          currentRevision: "1",
          localDate: "2026-08-15",
          portion: {
            amount: "2",
            inputUnit: "serving",
            resolvedGrams: "100",
            servingLabel: "2 crackers",
          },
          snapshotStatus: "partial",
        },
        replayed: false,
      });
      expect(created.entry.nutrients.find((value) => value.code === "energy")).toMatchObject({
        knownAmount: "200",
        quantifiedCount: 1,
        unknownCount: 0,
      });
      expect(created.entry.snapshotEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
      expect(created.entry.source).toMatchObject({
        attributionText: "Diary integration fixture",
        code: expect.stringMatching(/^DY/),
        licenseExpression: "CC0-1.0",
        releaseId: expect.any(String),
      });
      expect(created.entry.nutrients.find((value) => value.code === "fiber")).toMatchObject({
        completeness: "complete",
        knownAmount: "0",
        traceCount: 1,
      });
      expect(created.entry.nutrients.find((value) => value.code === "sodium")).toMatchObject({
        completeness: "unknown",
        knownAmount: "0",
        unknownCount: 1,
        unknownReasons: { not_reported: 1 },
      });
      expect(await createFoodDiaryEntry(database, createInput)).toMatchObject({ replayed: true });
      await expect(
        createFoodDiaryEntry(database, {
          ...createInput,
          expectedProfileTimeZone: "Asia/Tokyo",
          requestDigest: "b".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryIdempotencyConflictError);

      const concurrentOperationId = randomUUID();
      const concurrentInput = {
        clientOperationId: concurrentOperationId,
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "snacks" as const,
        occurredAt: "2026-08-13T12:00:00Z",
        portion: { grams: "10", kind: "grams" as const },
        requestDigest: "0".repeat(64),
        userId: owner.userId,
      };
      const concurrentResults = await Promise.all([
        createFoodDiaryEntry(database, concurrentInput),
        createFoodDiaryEntry(database, concurrentInput),
      ]);
      expect(concurrentResults.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(new Set(concurrentResults.map((result) => result.entry.id)).size).toBe(1);
      expect(
        await database
          .selectFrom("diary_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .where("client_operation_id", "=", concurrentOperationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "1" });
      expect(
        await database
          .selectFrom("diary_operation")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .where("client_operation_id", "=", concurrentOperationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "1" });
      await expect(
        createFoodDiaryEntry(database, {
          ...createInput,
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.supersededVersionId,
          requestDigest: "c".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);

      const precisionEntry = await createFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "snacks",
        occurredAt: "2026-08-14T12:00:00Z",
        portion: {
          amount: "0.123456",
          kind: "serving",
          servingId: catalogue.precisionServingId,
        },
        requestDigest: "7".repeat(64),
        userId: owner.userId,
      });
      expect(precisionEntry.entry.portion.resolvedGrams).toBe("0.015241383936");
      const longSubnormalEntry = await createFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.longSubnormalVersionId,
        mealSlot: "snacks",
        occurredAt: "2026-08-14T13:00:00Z",
        portion: {
          amount: "0.000001",
          kind: "serving",
          servingId: catalogue.longSubnormalServingId,
        },
        requestDigest: "6".repeat(64),
        userId: owner.userId,
      });
      const longKnownAmount = longSubnormalEntry.entry.nutrients.find(
        (nutrient) => nutrient.code === "protein",
      )?.knownAmount;
      expect(longKnownAmount).toMatch(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
      expect(longKnownAmount?.length).toBeGreaterThan(64);
      expect(longKnownAmount?.length).toBeLessThanOrEqual(160);
      await expect(
        createFoodDiaryEntry(database, {
          ...createInput,
          clientOperationId: randomUUID(),
          occurredAt: "2026-02-30T12:00:00Z",
          requestDigest: "e".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      await expect(
        createFoodDiaryEntry(database, {
          ...createInput,
          clientOperationId: randomUUID(),
          position: 1_000_001,
          requestDigest: "9".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      await expect(
        createFoodDiaryEntry(database, {
          ...createInput,
          clientOperationId: randomUUID(),
          occurredAt: "0001-01-01T00:00:00Z",
          requestDigest: "d".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      const dateBoundaryInput = {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "breakfast" as const,
        occurredAt: "9999-12-31T23:59:59Z",
        portion: { grams: "10", kind: "grams" as const },
        requestDigest: "b".repeat(64),
        userId: dateBoundaryOwner.userId,
      };
      await expect(
        createFoodDiaryEntry(database, {
          ...dateBoundaryInput,
          expectedProfileTimeZone: "America/Chicago",
        }),
      ).rejects.toBeInstanceOf(DiaryTimeZoneChangedError);
      await expect(
        createFoodDiaryEntry(database, {
          ...dateBoundaryInput,
          clientOperationId: randomUUID(),
          expectedProfileTimeZone: "Pacific/Kiritimati",
          requestDigest: "2".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      await expect(
        createFoodDiaryEntry(database, {
          ...dateBoundaryInput,
          clientOperationId: randomUUID(),
          requestDigest: "3".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      await expect(
        getDiaryDay(database, { localDate: "0000-01-01", userId: owner.userId }),
      ).rejects.toBeInstanceOf(DiaryValidationError);

      const movableForCapacity = await createFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "lunch",
        occurredAt: "2026-08-10T17:00:00Z",
        portion: { grams: "10", kind: "grams" },
        requestDigest: "c".repeat(64),
        userId: owner.userId,
      });
      const almostFullDay = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-11", time_zone: "America/Chicago", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      await seedDiaryDayAtCapacity(
        database,
        owner.userId,
        almostFullDay.id,
        catalogue.currentVersionId,
        49,
      );
      const capacityRace = await Promise.allSettled([
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.currentVersionId,
          mealSlot: "lunch",
          occurredAt: "2026-08-11T17:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "a".repeat(64),
          userId: owner.userId,
        }),
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.currentVersionId,
          mealSlot: "lunch",
          occurredAt: "2026-08-11T18:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "b".repeat(64),
          userId: owner.userId,
        }),
      ]);
      expect(capacityRace.map((outcome) => outcome.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejectedCapacityWrite = capacityRace.find((outcome) => outcome.status === "rejected");
      if (rejectedCapacityWrite?.status === "rejected") {
        expect(rejectedCapacityWrite.reason).toBeInstanceOf(DiaryValidationError);
      }
      expect(
        await database
          .selectFrom("diary_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("diary_id", "=", almostFullDay.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "50" });
      const fullDay = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-12", time_zone: "America/Chicago", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      await seedDiaryDayAtCapacity(database, owner.userId, fullDay.id, catalogue.currentVersionId);
      await expect(
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.currentVersionId,
          mealSlot: "lunch",
          occurredAt: "2026-08-12T17:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "d".repeat(64),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      await expect(
        updateFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          entryId: movableForCapacity.entry.id,
          expectedEntryRevision: "1",
          occurredAt: "2026-08-12T17:00:00Z",
          requestDigest: "e".repeat(64),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      expect(
        await database
          .selectFrom("diary_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("diary_id", "=", fullDay.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "50" });

      const legacyCreateInput = {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "lunch",
        occurredAt: "2026-08-15T17:00:00Z",
        portion: { grams: "50", kind: "grams" },
        requestDigest: "f".repeat(64),
        userId: owner.userId,
      } as const;
      const second = await createFoodDiaryEntry(database, legacyCreateInput);
      const day = await getDiaryDay(database, { localDate: "2026-08-15", userId: owner.userId });
      expect(day).toMatchObject({ id: expect.any(String), revision: "2", totalEntries: 2 });
      expect(day.totals.find((value) => value.code === "energy")).toMatchObject({
        contributorCount: 2,
        knownAmount: "300",
        quantifiedCount: 2,
      });
      expect(day.totals.find((value) => value.code === "sodium")).toMatchObject({
        completeness: "unknown",
        contributorCount: 2,
        knownAmount: "0",
        unknownCount: 2,
      });

      await database
        .updateTable("food_source")
        .set({ attribution_text: "Changed after log", license_expression: "LicenseRef-Changed" })
        .where("id", "=", catalogue.sourceId)
        .execute();

      await updateUserProfile(database, {
        expectedRevision: "1",
        patch: { timeZone: "Asia/Tokyo" },
        userId: owner.userId,
      });
      const guardedReplayAfterZoneChange = await createFoodDiaryEntry(database, createInput);
      expect(guardedReplayAfterZoneChange).toMatchObject({
        entry: { id: created.entry.id, localDate: "2026-08-15", timeZone: "America/Chicago" },
        replayed: true,
      });
      const legacyReplayAfterZoneChange = await createFoodDiaryEntry(database, legacyCreateInput);
      expect(legacyReplayAfterZoneChange).toMatchObject({
        entry: { id: second.entry.id },
        replayed: true,
      });
      const quantityEdit = await updateFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        entryId: created.entry.id,
        expectedEntryRevision: "1",
        portion: { grams: "25", kind: "grams" },
        requestDigest: "1".repeat(64),
        userId: owner.userId,
      });
      expect(quantityEdit.entry).toMatchObject({
        currentRevision: "2",
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
      });
      expect(quantityEdit.entry.source).toMatchObject({
        attributionText: "Diary integration fixture",
        licenseExpression: "CC0-1.0",
      });
      const tokyoEntry = await createFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "snacks",
        occurredAt: "2026-08-15T03:00:00Z",
        portion: { grams: "10", kind: "grams" },
        requestDigest: "8".repeat(64),
        userId: owner.userId,
      });
      const sameDateAfterZoneChange = await getDiaryDay(database, {
        localDate: "2026-08-15",
        userId: owner.userId,
      });
      expect(sameDateAfterZoneChange.timeZone).toBe("Asia/Tokyo");
      expect(
        sameDateAfterZoneChange.entries.find((entry) => entry.id === created.entry.id)?.timeZone,
      ).toBe("America/Chicago");
      expect(
        sameDateAfterZoneChange.entries.find((entry) => entry.id === tokyoEntry.entry.id)?.timeZone,
      ).toBe("Asia/Tokyo");
      await expect(
        updateFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          entryId: created.entry.id,
          expectedEntryRevision: "1",
          mealSlot: "dinner",
          requestDigest: "2".repeat(64),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryEntryRevisionConflictError);

      const moved = await updateFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        entryId: created.entry.id,
        expectedEntryRevision: "2",
        occurredAt: "2026-08-16T16:00:00Z",
        requestDigest: "3".repeat(64),
        userId: owner.userId,
      });
      expect(moved).toMatchObject({
        days: [
          { localDate: "2026-08-15", revision: "5" },
          { localDate: "2026-08-17", revision: "1" },
        ],
        entry: { currentRevision: "3", operation: "move", timeZone: "Asia/Tokyo" },
      });

      const stranger = await registerPasswordAccount(database, {
        email: "stranger@example.invalid",
        passwordHash: "$argon2id$stranger-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "stranger-fixture-salt-value",
        timeZone: "UTC",
      });
      await expect(
        deleteDiaryEntry(database, {
          clientOperationId: randomUUID(),
          entryId: created.entry.id,
          expectedEntryRevision: "3",
          requestDigest: "4".repeat(64),
          userId: stranger.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryNotFoundError);
      expect(
        await getDiaryDay(database, { localDate: "2026-08-17", userId: stranger.userId }),
      ).toMatchObject({
        entries: [],
        id: null,
        revision: "0",
      });

      const deleted = await deleteDiaryEntry(database, {
        clientOperationId: randomUUID(),
        entryId: created.entry.id,
        expectedEntryRevision: "3",
        requestDigest: "5".repeat(64),
        userId: owner.userId,
      });
      expect(deleted.entry).toMatchObject({ currentRevision: "4", operation: "delete" });
      expect(
        await getDiaryDay(database, { localDate: "2026-08-17", userId: owner.userId }),
      ).toMatchObject({
        entries: [],
        revision: "2",
      });
      const revisionCount = await database
        .selectFrom("diary_entry_revision")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("diary_entry_id", "=", created.entry.id)
        .executeTakeFirstOrThrow();
      expect(revisionCount.count).toBe("4");
      await expect(
        database
          .updateTable("diary_entry_revision")
          .set({ note: "forbidden rewrite" })
          .where("diary_entry_id", "=", created.entry.id)
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        database
          .deleteFrom("diary_entry_revision_nutrient")
          .where(
            "diary_entry_revision_id",
            "=",
            database
              .selectFrom("diary_entry")
              .select("current_revision_id")
              .where("id", "=", deleted.entry.id),
          )
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });

      await expect(
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.unitMismatchVersionId,
          mealSlot: "snacks",
          occurredAt: "2026-08-18T12:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "0".repeat(64),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      await expect(
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.basisMismatchVersionId,
          mealSlot: "snacks",
          occurredAt: "2026-08-18T12:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "1".repeat(64),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);

      const proteinDefinition = await database
        .selectFrom("nutrient")
        .select("id")
        .where("code", "=", "protein")
        .executeTakeFirstOrThrow();
      await expect(
        database
          .insertInto("food_nutrient_value")
          .values({
            amount: "1",
            basis_quantity: "100",
            basis_unit: "g",
            food_version_id: catalogue.currentVersionId,
            nutrient_id: proteinDefinition.id,
            unit: "g",
            value_status: "measured",
          })
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        database
          .insertInto("food_serving")
          .values({
            food_version_id: catalogue.currentVersionId,
            gram_weight: "1",
            is_default: false,
            label: "late imported serving",
            metadata: { fixture: true },
            quantity: "1",
            source_serving_key: "late-imported-serving",
            unit: "portion",
            unit_kind: "count",
          })
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });

      const customFood = await database
        .insertInto("food")
        .values({
          food_source_id: null,
          kind: "custom",
          owner_user_id: owner.userId,
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
          data_quality: "provisional",
          food_id: customFood.id,
          language_tag: "en-US",
          market_code: "US",
          name: "Owner custom food",
          normalized_name: "owner custom food",
          source_release_id: null,
          version_number: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("food_nutrient_value")
        .values({
          amount: "1",
          basis_quantity: "100",
          basis_unit: "g",
          food_version_id: customVersion.id,
          nutrient_id: proteinDefinition.id,
          unit: "g",
          value_status: "estimated",
        })
        .execute();
      await database
        .insertInto("food_serving")
        .values({
          food_version_id: customVersion.id,
          gram_weight: "20",
          is_default: true,
          label: "custom portion",
          metadata: { fixture: true },
          quantity: "1",
          source_serving_key: null,
          unit: "portion",
          unit_kind: "count",
        })
        .execute();
      await expect(
        database
          .insertInto("food_nutrient_value")
          .values({
            amount: "NaN",
            basis_quantity: "100",
            basis_unit: "g",
            food_version_id: customVersion.id,
            nutrient_id: (
              await database
                .selectFrom("nutrient")
                .select("id")
                .where("code", "=", "sodium")
                .executeTakeFirstOrThrow()
            ).id,
            unit: "mg",
            value_status: "estimated",
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("diary")
          .values({
            local_date: "2026-08-31",
            time_zone: "Not/A_Zone",
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "22023" });

      await database
        .insertInto("nutrient")
        .values(
          Array.from({ length: 252 }, (_, index) => ({
            canonical_unit: "g",
            code: `churn_${index.toString().padStart(3, "0")}`,
            dimension: "mass" as const,
            name: `Churn nutrient ${index}`,
          })),
        )
        .execute();
      const churnEntry = await createFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "snacks",
        occurredAt: "2026-08-19T12:00:00Z",
        portion: { grams: "10", kind: "grams" },
        requestDigest: "2".repeat(64),
        userId: owner.userId,
      });
      expect(churnEntry.entry.nutrients).toHaveLength(256);
      await database
        .updateTable("nutrient")
        .set({ active: false })
        .where("code", "=", "fiber")
        .execute();
      await database
        .insertInto("nutrient")
        .values({
          canonical_unit: "g",
          code: "churn_replacement",
          dimension: "mass",
          name: "Churn replacement",
        })
        .execute();
      await expect(
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.currentVersionId,
          mealSlot: "snacks",
          occurredAt: "2026-08-19T13:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "3".repeat(64),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      await expect(
        database
          .insertInto("nutrient")
          .values({
            canonical_unit: "g",
            code: "churn_overflow",
            dimension: "mass",
            name: "Churn overflow",
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });

      await database.updateTable("nutrient").set({ active: false }).execute();
      await expect(
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.currentVersionId,
          mealSlot: "snacks",
          occurredAt: "2026-08-18T12:00:00Z",
          portion: { grams: "10", kind: "grams" },
          requestDigest: "6".repeat(64),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(DiaryValidationError);
      expect(await getUserProfile(database, owner.userId)).toMatchObject({
        timeZone: "Asia/Tokyo",
      });
      expect(second.entry.currentRevision).toBe("1");
      const disabledTokenHash = "9".repeat(64);
      await createSession(database, {
        expiresAt: STABLE_FUTURE_SESSION_EXPIRY,
        tokenHash: disabledTokenHash,
        userId: owner.userId,
      });
      const profileBeforeDisable = await database
        .selectFrom("user_profile")
        .select(["display_name", "revision"])
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      await database
        .updateTable("app_user")
        .set({ status: "disabled" })
        .where("id", "=", owner.userId)
        .execute();
      expect(
        await findActiveSessionByTokenHash(database, disabledTokenHash, "2026-08-16T00:00:00Z"),
      ).toBeNull();
      await expect(createFoodDiaryEntry(database, createInput)).rejects.toBeInstanceOf(
        DiaryNotFoundError,
      );
      await expect(
        updateUserProfile(database, {
          expectedRevision: profileBeforeDisable.revision,
          patch: { displayName: "Forbidden disabled write" },
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(AccountNotFoundError);
      expect(
        await database
          .selectFrom("user_profile")
          .select(["display_name", "revision"])
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(profileBeforeDisable);
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("reads the guarded create zone after a waiting active-account lock", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_zone_race_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const writerApplicationName = `diary-zone-writer-${randomBytes(6).toString("hex")}`;
    const writerUrl = new URL(scopedUrl);
    writerUrl.searchParams.set("application_name", writerApplicationName);
    const writerDatabase = createDatabase({
      connectionString: writerUrl.toString(),
      maxConnections: 1,
    });
    const commitProfileUpdate = deferred<void>();
    const profileUpdateReady = deferred<void>();
    let profileUpdate: Promise<void> | undefined;
    let writerOutcome:
      | Promise<
          | { readonly status: "fulfilled" }
          | { readonly error: unknown; readonly status: "rejected" }
        >
      | undefined;
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const owner = await registerPasswordAccount(database, {
        email: `zone-race-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$zone-race-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "zone-race-fixture-salt",
        timeZone: "America/Chicago",
      });

      profileUpdate = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("app_user")
          .select("id")
          .where("id", "=", owner.userId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("user_profile")
          .set({ revision: "1", time_zone: "Asia/Tokyo" })
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow();
        profileUpdateReady.resolve();
        await commitProfileUpdate.promise;
      });
      await profileUpdateReady.promise;

      const clientOperationId = randomUUID();
      writerOutcome = createFoodDiaryEntry(writerDatabase, {
        clientOperationId,
        expectedProfileTimeZone: "America/Chicago",
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "breakfast",
        occurredAt: "2026-08-15T05:30:00Z",
        portion: { grams: "10", kind: "grams" },
        requestDigest: "a".repeat(64),
        userId: owner.userId,
      }).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      await waitForApplicationLock(database, writerApplicationName);

      commitProfileUpdate.resolve();
      await profileUpdate;
      const outcome = await settleWithin(writerOutcome, 2_000);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toBeInstanceOf(DiaryTimeZoneChangedError);
      }
      expect(
        await database
          .selectFrom("diary_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .where("client_operation_id", "=", clientOperationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      expect(
        await database
          .selectFrom("diary_operation")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .where("client_operation_id", "=", clientOperationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    } finally {
      commitProfileUpdate.resolve();
      const pending: Promise<unknown>[] = [];
      if (profileUpdate) pending.push(profileUpdate);
      if (writerOutcome) pending.push(writerOutcome);
      await Promise.allSettled(pending);
      await writerDatabase.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("pages one coherent 45-entry day in canonical order and rejects stale day or profile state", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_page_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 6 });
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const owner = await registerPasswordAccount(database, {
        email: `page-owner-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$page-owner-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "page-owner-fixture-salt",
        timeZone: "America/Chicago",
      });
      const targetDay = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-28", time_zone: "America/Chicago", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      await seedDiaryDayAtCapacity(
        database,
        owner.userId,
        targetDay.id,
        catalogue.currentVersionId,
        45,
        true,
        true,
      );
      await database
        .updateTable("diary")
        .set({ revision: "45" })
        .where("id", "=", targetDay.id)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      const legacy = await getDiaryDay(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
      });
      const first = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
      });
      if (!first.page.next) throw new Error("First diary page requires a continuation");
      const second = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
        continuation: first.page.next,
      });
      if (!second.page.next) throw new Error("Second diary page requires a continuation");
      const third = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
        continuation: second.page.next,
      });
      const pagedEntries = [...first.day.entries, ...second.day.entries, ...third.day.entries];
      const mealRank = new Map([
        ["breakfast", 0],
        ["lunch", 1],
        ["dinner", 2],
        ["snacks", 3],
      ]);
      const compareText = (left: string, right: string): number =>
        left < right ? -1 : left > right ? 1 : 0;
      const independentlySortedIds = [...legacy.entries]
        .sort(
          (left, right) =>
            (mealRank.get(left.mealSlot) ?? 99) - (mealRank.get(right.mealSlot) ?? 99) ||
            left.position - right.position ||
            compareText(left.occurredAt, right.occurredAt) ||
            compareText(left.id, right.id),
        )
        .map((entry) => entry.id);

      expect([
        first.day.entries.length,
        second.day.entries.length,
        third.day.entries.length,
      ]).toEqual([20, 20, 5]);
      expect(first.page.totalEntries).toBe(45);
      expect(second.page.totalEntries).toBe(45);
      expect(third.page).toEqual({ next: null, totalEntries: 45 });
      expect(new Set(pagedEntries.map((entry) => entry.id)).size).toBe(45);
      expect(pagedEntries.map((entry) => entry.id)).toEqual(
        legacy.entries.map((entry) => entry.id),
      );
      expect(pagedEntries.map((entry) => entry.id)).toEqual(independentlySortedIds);
      expect(first.day.totals).toEqual(legacy.totals);
      expect(second.day.totals).toEqual(legacy.totals);
      expect(third.day.totals).toEqual(legacy.totals);
      expect(legacy.totals.every((total) => total.contributorCount === 45)).toBe(true);

      const beforeLock = first.page.next;
      await database
        .updateTable("diary")
        .set({ status: "locked" })
        .where("id", "=", targetDay.id)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(
        await database
          .selectFrom("diary")
          .select(["revision", "status"])
          .where("id", "=", targetDay.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revision: "45", status: "locked" });
      await expect(
        getDiaryDayPage(database, {
          localDate: "2026-08-28",
          userId: owner.userId,
          limit: 20,
          continuation: beforeLock,
        }),
      ).rejects.toBeInstanceOf(DiaryPageStaleError);

      await sql`
        create function diary_page_force_updated_at_for_test()
        returns trigger
        language plpgsql
        as $$
        declare
          forced_updated_at text;
        begin
          forced_updated_at := current_setting(
            'nutrition_tracker.test_diary_updated_at',
            true
          );
          if forced_updated_at is not null and forced_updated_at <> '' then
            new.updated_at := forced_updated_at::timestamptz;
          end if;
          return new;
        end;
        $$
      `.execute(database);
      await sql`
        create trigger zz_diary_page_force_updated_at_for_test
        before update on diary
        for each row execute function diary_page_force_updated_at_for_test()
      `.execute(database);
      const updateDiaryMetadataAt = async (updatedAt: string): Promise<void> => {
        await database.transaction().execute(async (transaction) => {
          await sql`
            select set_config(
              'nutrition_tracker.test_diary_updated_at',
              ${updatedAt},
              true
            )
          `.execute(transaction);
          await transaction
            .updateTable("diary")
            .set({ note: null })
            .where("id", "=", targetDay.id)
            .where("user_id", "=", owner.userId)
            .executeTakeFirstOrThrow();
        });
      };
      await updateDiaryMetadataAt("2035-01-02T03:04:05.123456Z");
      const whileLocked = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
      });
      if (!whileLocked.page.next) throw new Error("Locked diary page requires a continuation");
      const lockedUpdatedAt = whileLocked.day.updatedAt;
      await updateDiaryMetadataAt("2035-01-02T03:04:05.123789Z");
      const metadataChangedDay = await database
        .selectFrom("diary")
        .select(["revision", "status", "updated_at"])
        .where("id", "=", targetDay.id)
        .executeTakeFirstOrThrow();
      expect(metadataChangedDay).toMatchObject({ revision: "45", status: "locked" });
      expect(metadataChangedDay.updated_at.toISOString()).toBe(lockedUpdatedAt);
      await expect(
        getDiaryDayPage(database, {
          localDate: "2026-08-28",
          userId: owner.userId,
          limit: 20,
          continuation: whileLocked.page.next,
        }),
      ).rejects.toBeInstanceOf(DiaryPageStaleError);

      const beforeUnlock = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
      });
      if (!beforeUnlock.page.next) throw new Error("Diary page requires a continuation");
      await database
        .updateTable("diary")
        .set({ status: "open" })
        .where("id", "=", targetDay.id)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(
        await database
          .selectFrom("diary")
          .select(["revision", "status"])
          .where("id", "=", targetDay.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revision: "45", status: "open" });
      await expect(
        getDiaryDayPage(database, {
          localDate: "2026-08-28",
          userId: owner.userId,
          limit: 20,
          continuation: beforeUnlock.page.next,
        }),
      ).rejects.toBeInstanceOf(DiaryPageStaleError);

      const beforeHeadDrift = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
      });
      const beforeHeadDriftContinuation = beforeHeadDrift.page.next;
      if (!beforeHeadDriftContinuation) throw new Error("Diary page requires a continuation");
      await updateFoodDiaryEntry(database, {
        clientOperationId: randomUUID(),
        entryId: pagedEntries[40]?.id ?? "missing",
        expectedEntryRevision: "1",
        note: "snapshot digest drift",
        requestDigest: "a".repeat(64),
        userId: owner.userId,
      });
      await database.transaction().execute(async (transaction) => {
        await sql`
          select set_config(
            'nutrition_tracker.test_diary_updated_at',
            ${beforeHeadDriftContinuation.updatedAtMicroseconds},
            true
          )
        `.execute(transaction);
        await transaction
          .updateTable("diary")
          .set({ note: null, revision: beforeHeadDrift.day.revision })
          .where("id", "=", targetDay.id)
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow();
      });
      const afterHeadDrift = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
      });
      const afterHeadDriftContinuation = afterHeadDrift.page.next;
      if (!afterHeadDriftContinuation)
        throw new Error("Mutated diary page requires a continuation");
      expect(afterHeadDrift.day).toMatchObject({
        revision: beforeHeadDrift.day.revision,
        status: beforeHeadDrift.day.status,
        timeZone: beforeHeadDrift.day.timeZone,
        updatedAt: beforeHeadDrift.day.updatedAt,
      });
      expect(afterHeadDrift.day.entries.map((entry) => entry.id)).toEqual(
        beforeHeadDrift.day.entries.map((entry) => entry.id),
      );
      expect(afterHeadDriftContinuation.updatedAtMicroseconds).toBe(
        beforeHeadDriftContinuation.updatedAtMicroseconds,
      );
      expect(afterHeadDriftContinuation.snapshotDigest).not.toBe(
        beforeHeadDriftContinuation.snapshotDigest,
      );
      await expect(
        getDiaryDayPage(database, {
          localDate: "2026-08-28",
          userId: owner.userId,
          limit: 20,
          continuation: beforeHeadDriftContinuation,
        }),
      ).rejects.toBeInstanceOf(DiaryPageStaleError);

      await updateUserProfile(database, {
        expectedRevision: "0",
        patch: { timeZone: "Asia/Tokyo" },
        userId: owner.userId,
      });
      await expect(
        getDiaryDayPage(database, {
          localDate: "2026-08-28",
          userId: owner.userId,
          limit: 20,
          continuation: afterHeadDriftContinuation,
        }),
      ).rejects.toBeInstanceOf(DiaryPageStaleError);

      const beforeDayDeletion = await getDiaryDayPage(database, {
        localDate: "2026-08-28",
        userId: owner.userId,
        limit: 20,
      });
      if (!beforeDayDeletion.page.next) throw new Error("Diary page requires a continuation");
      await database
        .deleteFrom("diary")
        .where("id", "=", targetDay.id)
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      await expect(
        getDiaryDayPage(database, {
          localDate: "2026-08-28",
          userId: owner.userId,
          limit: 20,
          continuation: beforeDayDeletion.page.next,
        }),
      ).rejects.toBeInstanceOf(DiaryPageStaleError);
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("bounds the non-paginated maximum day payload to the beta memory budget", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_payload_bound_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 6 });
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const owner = await registerPasswordAccount(database, {
        email: `payload-bound-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$payload-bound-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "payload-bound-fixture-salt",
        timeZone: "America/Chicago",
      });
      await database
        .insertInto("nutrient")
        .values(
          Array.from({ length: 252 }, (_, index) => ({
            canonical_unit: "g",
            code: `payload_${index.toString().padStart(3, "0")}`,
            dimension: "mass" as const,
            name: `Payload nutrient ${index}`,
          })),
        )
        .execute();
      const day = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-12", time_zone: "America/Chicago", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      await seedDiaryDayAtCapacity(
        database,
        owner.userId,
        day.id,
        catalogue.currentVersionId,
        50,
        true,
      );

      const maximumDay = await getDiaryDay(database, {
        localDate: "2026-08-12",
        userId: owner.userId,
      });
      const maximumPage = await getDiaryDayPage(database, {
        localDate: "2026-08-12",
        userId: owner.userId,
        limit: 20,
      });
      const payloadBytes = Buffer.byteLength(JSON.stringify(maximumDay), "utf8");
      const pageBytes = Buffer.byteLength(JSON.stringify(maximumPage), "utf8");
      expect(maximumDay.entries).toHaveLength(50);
      expect(maximumPage.day.entries).toHaveLength(20);
      expect(maximumDay.totals).toHaveLength(256);
      expect(maximumDay.entries.every((entry) => entry.nutrients.length === 256)).toBe(true);
      expect(maximumPage.day.entries.every((entry) => entry.nutrients.length === 256)).toBe(true);
      expect(payloadBytes).toBeGreaterThan(1_000_000);
      expect(payloadBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(
        pageBytes,
        `20-entry diary page measured ${pageBytes} bytes against ${payloadBytes} full-day bytes`,
      ).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(
        pageBytes * 2,
        `20-entry diary page measured ${pageBytes} bytes against ${payloadBytes} full-day bytes`,
      ).toBeLessThan(payloadBytes);
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("serializes account disablement ahead of a blocked diary write", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_disable_race_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const writerApplicationName = `diary-disable-writer-${randomBytes(6).toString("hex")}`;
    const writerUrl = new URL(scopedUrl);
    writerUrl.searchParams.set("application_name", writerApplicationName);
    const writerDatabase = createDatabase({
      connectionString: writerUrl.toString(),
      maxConnections: 1,
    });
    const releaseDayLock = deferred<void>();
    const dayLockReady = deferred<void>();
    const commitDisable = deferred<void>();
    const disableReady = deferred<void>();
    let dayBlocker: Promise<void> | undefined;
    let disabler: Promise<void> | undefined;
    let writerOutcome:
      | Promise<
          | { readonly status: "fulfilled" }
          | { readonly error: unknown; readonly status: "rejected" }
        >
      | undefined;
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const owner = await registerPasswordAccount(database, {
        email: `disable-race-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$disable-race-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "disable-race-fixture-salt",
        timeZone: "America/Chicago",
      });
      const targetDay = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-20", time_zone: "America/Chicago", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();

      dayBlocker = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("diary")
          .select("id")
          .where("id", "=", targetDay.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        dayLockReady.resolve();
        await releaseDayLock.promise;
      });
      await dayLockReady.promise;

      disabler = database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("app_user")
          .set({ status: "disabled" })
          .where("id", "=", owner.userId)
          .executeTakeFirstOrThrow();
        disableReady.resolve();
        await commitDisable.promise;
      });
      await disableReady.promise;

      const writeInput = {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "lunch" as const,
        occurredAt: "2026-08-20T17:00:00Z",
        portion: { grams: "10", kind: "grams" as const },
        requestDigest: "a".repeat(64),
        userId: owner.userId,
      };
      writerOutcome = createFoodDiaryEntry(writerDatabase, writeInput).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      await waitForApplicationLock(database, writerApplicationName);

      commitDisable.resolve();
      await disabler;
      const outcome = await settleWithin(writerOutcome, 2_000);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toBeInstanceOf(DiaryNotFoundError);
      }
      expect(
        await database
          .selectFrom("diary_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      expect(
        await database
          .selectFrom("diary_operation")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });

      releaseDayLock.resolve();
      await dayBlocker;
      await expect(
        createFoodDiaryEntry(database, {
          ...writeInput,
          clientOperationId: randomUUID(),
          requestDigest: "b".repeat(64),
        }),
      ).rejects.toBeInstanceOf(DiaryNotFoundError);
      expect(
        await database
          .selectFrom("diary")
          .select("revision")
          .where("id", "=", targetDay.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revision: "0" });
    } finally {
      commitDisable.resolve();
      releaseDayLock.resolve();
      const pending: Promise<unknown>[] = [];
      if (dayBlocker) pending.push(dayBlocker);
      if (disabler) pending.push(disabler);
      if (writerOutcome) pending.push(writerOutcome);
      await Promise.allSettled(pending);
      await writerDatabase.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("serializes session issuance with account disablement", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `session_disable_race_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 3 });
    const writerApplicationName = `session-disable-writer-${randomBytes(6).toString("hex")}`;
    const writerUrl = new URL(scopedUrl);
    writerUrl.searchParams.set("application_name", writerApplicationName);
    const writerDatabase = createDatabase({
      connectionString: writerUrl.toString(),
      maxConnections: 1,
    });
    const commitDisable = deferred<void>();
    const disableReady = deferred<void>();
    let disabler: Promise<void> | undefined;
    let sessionOutcome:
      | Promise<
          | { readonly status: "fulfilled" }
          | { readonly error: unknown; readonly status: "rejected" }
        >
      | undefined;
    try {
      await runMigrations(database);
      const owner = await registerPasswordAccount(database, {
        email: `session-disable-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$session-disable-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "session-disable-fixture-salt",
        timeZone: "UTC",
      });
      disabler = database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("app_user")
          .set({ status: "disabled" })
          .where("id", "=", owner.userId)
          .executeTakeFirstOrThrow();
        disableReady.resolve();
        await commitDisable.promise;
      });
      await disableReady.promise;

      sessionOutcome = createSession(writerDatabase, {
        expiresAt: STABLE_FUTURE_SESSION_EXPIRY,
        tokenHash: "8".repeat(64),
        userId: owner.userId,
      }).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      await waitForApplicationLock(database, writerApplicationName);
      commitDisable.resolve();
      await disabler;
      const outcome = await settleWithin(sessionOutcome, 2_000);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.error).toBeInstanceOf(AccountNotFoundError);
      }
      expect(
        await database
          .selectFrom("user_session")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    } finally {
      commitDisable.resolve();
      const pending: Promise<unknown>[] = [];
      if (disabler) pending.push(disabler);
      if (sessionOutcome) pending.push(sessionOutcome);
      await Promise.allSettled(pending);
      await writerDatabase.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("serializes eligibility and nutrient-registry changes ahead of diary creates", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_catalogue_race_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const writerApplicationName = `diary-catalogue-writer-${randomBytes(6).toString("hex")}`;
    const writerUrl = new URL(scopedUrl);
    writerUrl.searchParams.set("application_name", writerApplicationName);
    const writerDatabase = createDatabase({
      connectionString: writerUrl.toString(),
      maxConnections: 1,
    });
    const releaseRights = deferred<void>();
    const rightsReady = deferred<void>();
    const releaseDeactivation = deferred<void>();
    const deactivationReady = deferred<void>();
    const releaseActivation = deferred<void>();
    const activationReady = deferred<void>();
    let rightsWriter: Promise<void> | undefined;
    let nutrientWriter: Promise<void> | undefined;
    let diaryOutcome: Promise<unknown> | undefined;
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const owner = await registerPasswordAccount(database, {
        email: `catalogue-race-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$catalogue-race-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "catalogue-race-fixture-salt",
        timeZone: "America/Chicago",
      });
      const createInput = (occurredAt: string, digestCharacter: string) => ({
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "lunch" as const,
        occurredAt,
        portion: { grams: "10", kind: "grams" as const },
        requestDigest: digestCharacter.repeat(64),
        userId: owner.userId,
      });

      rightsWriter = database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("food_source")
          .set({ active: false })
          .where("id", "=", catalogue.sourceId)
          .executeTakeFirstOrThrow();
        rightsReady.resolve();
        await releaseRights.promise;
      });
      await rightsReady.promise;
      const rightsDiaryOutcome = createFoodDiaryEntry(
        writerDatabase,
        createInput("2026-08-21T17:00:00Z", "1"),
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      diaryOutcome = rightsDiaryOutcome;
      await waitForApplicationLock(database, writerApplicationName);
      releaseRights.resolve();
      await rightsWriter;
      const rightsOutcome = await settleWithin(rightsDiaryOutcome, 2_000);
      expect(rightsOutcome).toMatchObject({ status: "rejected" });
      if (typeof rightsOutcome === "object" && rightsOutcome !== null && "error" in rightsOutcome) {
        expect(rightsOutcome.error).toBeInstanceOf(DiaryValidationError);
      }
      await database
        .updateTable("food_source")
        .set({ active: true })
        .where("id", "=", catalogue.sourceId)
        .execute();

      nutrientWriter = database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("nutrient")
          .set({ active: false })
          .where("code", "=", "sodium")
          .executeTakeFirstOrThrow();
        deactivationReady.resolve();
        await releaseDeactivation.promise;
      });
      await deactivationReady.promise;
      const deactivationDiaryOutcome = createFoodDiaryEntry(
        writerDatabase,
        createInput("2026-08-22T17:00:00Z", "2"),
      );
      diaryOutcome = deactivationDiaryOutcome;
      await waitForApplicationLock(database, writerApplicationName);
      releaseDeactivation.resolve();
      await nutrientWriter;
      const withoutSodium = await settleWithin(deactivationDiaryOutcome, 2_000);
      expect(withoutSodium.entry.nutrients.map((nutrient) => nutrient.code)).not.toContain(
        "sodium",
      );

      nutrientWriter = database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("nutrient")
          .set({ active: true })
          .where("code", "=", "sodium")
          .executeTakeFirstOrThrow();
        activationReady.resolve();
        await releaseActivation.promise;
      });
      await activationReady.promise;
      const activationDiaryOutcome = createFoodDiaryEntry(
        writerDatabase,
        createInput("2026-08-23T17:00:00Z", "3"),
      );
      diaryOutcome = activationDiaryOutcome;
      await waitForApplicationLock(database, writerApplicationName);
      releaseActivation.resolve();
      await nutrientWriter;
      const withSodium = await settleWithin(activationDiaryOutcome, 2_000);
      expect(
        withSodium.entry.nutrients.find((nutrient) => nutrient.code === "sodium"),
      ).toMatchObject({
        completeness: "unknown",
        unknownCount: 1,
      });
    } finally {
      releaseRights.resolve();
      releaseDeactivation.resolve();
      releaseActivation.resolve();
      const pending = [rightsWriter, nutrientWriter, diaryOutcome].filter(
        (value): value is Promise<unknown> => value !== undefined,
      );
      await Promise.allSettled(pending);
      await writerDatabase.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("linearizes edit, delete, and move mutations against diary locking", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_day_lock_race_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const writerApplicationName = `diary-day-lock-writer-${randomBytes(6).toString("hex")}`;
    const writerUrl = new URL(scopedUrl);
    writerUrl.searchParams.set("application_name", writerApplicationName);
    const writerDatabase = createDatabase({
      connectionString: writerUrl.toString(),
      maxConnections: 1,
    });
    const pending: Promise<unknown>[] = [];
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const owner = await registerPasswordAccount(database, {
        email: `day-lock-race-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$day-lock-race-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "day-lock-race-fixture-salt",
        timeZone: "America/Chicago",
      });
      const seedEntry = async (occurredAt: string, digestCharacter: string) =>
        createFoodDiaryEntry(database, {
          clientOperationId: randomUUID(),
          foodVersionId: catalogue.currentVersionId,
          mealSlot: "lunch",
          occurredAt,
          portion: { grams: "10", kind: "grams" },
          requestDigest: digestCharacter.repeat(64),
          userId: owner.userId,
        });
      const editEntry = await seedEntry("2026-08-24T17:00:00Z", "4");
      const deleteEntry = await seedEntry("2026-08-25T17:00:00Z", "5");
      const moveEntry = await seedEntry("2026-08-26T17:00:00Z", "6");
      const targetDay = await database
        .insertInto("diary")
        .values({ local_date: "2026-08-27", time_zone: "America/Chicago", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();

      const assertBlockedByDayLock = async (
        diaryId: string,
        mutation: () => Promise<unknown>,
      ): Promise<void> => {
        const releaseLock = deferred<void>();
        const lockReady = deferred<void>();
        const locker = database.transaction().execute(async (transaction) => {
          await transaction
            .updateTable("diary")
            .set({ status: "locked" })
            .where("id", "=", diaryId)
            .executeTakeFirstOrThrow();
          lockReady.resolve();
          await releaseLock.promise;
        });
        pending.push(locker);
        try {
          await lockReady.promise;
          const outcome = mutation().then(
            () => ({ status: "fulfilled" as const }),
            (error: unknown) => ({ error, status: "rejected" as const }),
          );
          pending.push(outcome);
          await waitForApplicationLock(database, writerApplicationName);
          releaseLock.resolve();
          await locker;
          const settled = await settleWithin(outcome, 2_000);
          expect(settled.status).toBe("rejected");
          if (settled.status === "rejected") {
            expect(settled.error).toBeInstanceOf(DiaryLockedError);
          }
        } finally {
          releaseLock.resolve();
        }
        await database
          .updateTable("diary")
          .set({ status: "open" })
          .where("id", "=", diaryId)
          .execute();
      };

      const editDayId = (
        await database
          .selectFrom("diary_entry")
          .select("diary_id")
          .where("id", "=", editEntry.entry.id)
          .executeTakeFirstOrThrow()
      ).diary_id;
      await assertBlockedByDayLock(editDayId, () =>
        updateFoodDiaryEntry(writerDatabase, {
          clientOperationId: randomUUID(),
          entryId: editEntry.entry.id,
          expectedEntryRevision: "1",
          mealSlot: "dinner",
          requestDigest: "7".repeat(64),
          userId: owner.userId,
        }),
      );

      const deleteDayId = (
        await database
          .selectFrom("diary_entry")
          .select("diary_id")
          .where("id", "=", deleteEntry.entry.id)
          .executeTakeFirstOrThrow()
      ).diary_id;
      await assertBlockedByDayLock(deleteDayId, () =>
        deleteDiaryEntry(writerDatabase, {
          clientOperationId: randomUUID(),
          entryId: deleteEntry.entry.id,
          expectedEntryRevision: "1",
          requestDigest: "8".repeat(64),
          userId: owner.userId,
        }),
      );

      await assertBlockedByDayLock(targetDay.id, () =>
        updateFoodDiaryEntry(writerDatabase, {
          clientOperationId: randomUUID(),
          entryId: moveEntry.entry.id,
          expectedEntryRevision: "1",
          occurredAt: "2026-08-27T17:00:00Z",
          requestDigest: "9".repeat(64),
          userId: owner.userId,
        }),
      );

      for (const entryId of [editEntry.entry.id, deleteEntry.entry.id, moveEntry.entry.id]) {
        expect(
          await database
            .selectFrom("diary_entry")
            .select("current_revision_number")
            .where("id", "=", entryId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ current_revision_number: "1" });
      }
    } finally {
      await Promise.allSettled(pending);
      await writerDatabase.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("seals imported child rows atomically with release promotion", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_child_promotion_race_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 3 });
    const writerApplicationName = `child-promotion-writer-${randomBytes(6).toString("hex")}`;
    const writerUrl = new URL(scopedUrl);
    writerUrl.searchParams.set("application_name", writerApplicationName);
    const writerDatabase = createDatabase({
      connectionString: writerUrl.toString(),
      maxConnections: 1,
    });
    const commitPromotion = deferred<void>();
    const promotionReady = deferred<void>();
    let promoter: Promise<void> | undefined;
    let childOutcome: Promise<unknown> | undefined;
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const suffix = randomBytes(4).toString("hex");
      const release = await database
        .insertInto("food_source_release")
        .values({
          acquired_at: "2026-08-16T00:00:00Z",
          artifact_bytes: 1,
          artifact_sha256: "e".repeat(64),
          artifact_uri: `s3://child-race/${suffix}.json`,
          food_source_id: catalogue.sourceId,
          media_type: "application/json",
          parser_version: "child-race@1",
          record_counts: { records: 1 },
          release_key: `child-race-${suffix}`,
          rights_manifest_sha256: "f".repeat(64),
          rights_manifest_uri: "repo://child-race-rights.json",
          status: "imported",
          validation_summary: { valid: true },
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const food = await database
        .insertInto("food")
        .values({
          food_source_id: catalogue.sourceId,
          kind: "generic",
          owner_user_id: null,
          source_food_key: `child-race-${suffix}`,
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
          name: "Promotion race food",
          normalized_name: "promotion race food",
          source_release_id: release.id,
          version_number: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      promoter = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("food_source")
          .select("id")
          .where("id", "=", catalogue.sourceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("food_source_release")
          .set({ promoted_at: "2026-08-16T01:00:00Z", status: "promoted" })
          .where("id", "=", release.id)
          .executeTakeFirstOrThrow();
        promotionReady.resolve();
        await commitPromotion.promise;
      });
      await promotionReady.promise;
      childOutcome = writerDatabase
        .insertInto("food_serving")
        .values({
          food_version_id: version.id,
          gram_weight: "20",
          is_default: true,
          label: "promotion-race portion",
          metadata: { fixture: true },
          quantity: "1",
          source_serving_key: "promotion-race-portion",
          unit: "portion",
          unit_kind: "count",
        })
        .execute()
        .then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ error, status: "rejected" as const }),
        );
      await waitForApplicationLock(database, writerApplicationName);
      commitPromotion.resolve();
      await promoter;
      const outcome = await settleWithin(childOutcome, 2_000);
      expect(outcome).toMatchObject({ error: { code: "55000" }, status: "rejected" });
      expect(
        await database
          .selectFrom("food_serving")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("food_version_id", "=", version.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    } finally {
      commitPromotion.resolve();
      const pending = [promoter, childOutcome].filter(
        (value): value is Promise<unknown> => value !== undefined,
      );
      await Promise.allSettled(pending);
      await writerDatabase.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);

  it("orders mapping writers and diary snapshots through the nutrient registry lock", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `diary_mapping_race_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 5 });
    const firstApplicationName = `mapping-first-${randomBytes(6).toString("hex")}`;
    const secondApplicationName = `mapping-second-${randomBytes(6).toString("hex")}`;
    const diaryApplicationName = `mapping-diary-${randomBytes(6).toString("hex")}`;
    const namedDatabase = (applicationName: string) => {
      const url = new URL(scopedUrl);
      url.searchParams.set("application_name", applicationName);
      return createDatabase({ connectionString: url.toString(), maxConnections: 1 });
    };
    const firstWriter = namedDatabase(firstApplicationName);
    const secondWriter = namedDatabase(secondApplicationName);
    const diaryWriter = namedDatabase(diaryApplicationName);
    const releaseRegistry = deferred<void>();
    const registryReady = deferred<void>();
    const continueMapping = deferred<void>();
    const mappingSourceReady = deferred<void>();
    let registryBlocker: Promise<void> | undefined;
    let mappingTransaction: Promise<void> | undefined;
    let diaryOutcome: Promise<unknown> | undefined;
    try {
      await runMigrations(database);
      const catalogue = await seedCatalogue(database);
      const secondSourceCode = `MP${randomBytes(4).toString("hex").toUpperCase()}`;
      await database
        .insertInto("food_source")
        .values({
          active: false,
          attribution_required: true,
          attribution_text: "Mapping race fixture",
          code: secondSourceCode,
          commercial_use_allowed: true,
          display_name: "Mapping race second source",
          homepage_url: "https://example.invalid/mapping-race",
          kind: "government",
          license_expression: "CC0-1.0",
          license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
          redistribution_allowed: true,
          rights_review_status: "approved",
          rights_reviewed_at: "2026-08-15T00:00:00Z",
          rights_reviewed_by: "principal:mapping-race-rights",
        })
        .execute();
      const sourceCode = (
        await database
          .selectFrom("food_source")
          .select("code")
          .where("id", "=", catalogue.sourceId)
          .executeTakeFirstOrThrow()
      ).code;
      const mapping = (code: string, name: string) => ({
        canonicalNutrient: { code, dimension: "mass" as const, name, unit: "g" },
        sourceName: name,
        sourceNutrientKey: code,
        sourceUnit: "g",
      });
      registryBlocker = database.transaction().execute(async (transaction) => {
        await sql`
          select pg_advisory_xact_lock(
            hashtext('nutrition-tracker:active-nutrient-registry:v1')
          )
        `.execute(transaction);
        registryReady.resolve();
        await releaseRegistry.promise;
      });
      await registryReady.promise;
      const firstMappings = registerSourceNutrientMappings(firstWriter, {
        mappings: [mapping("map_beta", "Map Beta"), mapping("map_alpha", "Map Alpha")],
        reviewedAt: "2026-08-15T12:00:00Z",
        reviewedBy: "principal:mapping-race-first",
        sourceCode,
      });
      const secondMappings = registerSourceNutrientMappings(secondWriter, {
        mappings: [mapping("map_alpha", "Map Alpha"), mapping("map_beta", "Map Beta")],
        reviewedAt: "2026-08-15T12:00:00Z",
        reviewedBy: "principal:mapping-race-second",
        sourceCode: secondSourceCode,
      });
      await Promise.all([
        waitForApplicationLock(database, firstApplicationName),
        waitForApplicationLock(database, secondApplicationName),
      ]);
      expect(
        await database
          .selectFrom("nutrient")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("code", "in", ["map_alpha", "map_beta"])
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      releaseRegistry.resolve();
      await settleWithin(Promise.all([firstMappings, secondMappings]), 2_000);
      await registryBlocker;

      const owner = await registerPasswordAccount(database, {
        email: `mapping-diary-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$mapping-diary-fixture-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "mapping-diary-fixture-salt",
        timeZone: "America/Chicago",
      });
      mappingTransaction = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("food_source")
          .select("id")
          .where("id", "=", catalogue.sourceId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await sql`
          select pg_advisory_xact_lock(
            hashtext('nutrition-tracker:active-nutrient-registry:v1')
          )
        `.execute(transaction);
        mappingSourceReady.resolve();
        await continueMapping.promise;
        await transaction
          .insertInto("nutrient")
          .values({
            canonical_unit: "g",
            code: "map_gamma",
            dimension: "mass",
            name: "Map Gamma",
          })
          .execute();
      });
      await mappingSourceReady.promise;
      diaryOutcome = createFoodDiaryEntry(diaryWriter, {
        clientOperationId: randomUUID(),
        foodVersionId: catalogue.currentVersionId,
        mealSlot: "lunch",
        occurredAt: "2026-08-28T17:00:00Z",
        portion: { grams: "10", kind: "grams" },
        requestDigest: "a".repeat(64),
        userId: owner.userId,
      });
      await waitForApplicationLock(database, diaryApplicationName);
      continueMapping.resolve();
      await mappingTransaction;
      const diaryResult = await settleWithin(
        diaryOutcome as ReturnType<typeof createFoodDiaryEntry>,
        2_000,
      );
      expect(
        diaryResult.entry.nutrients.find((nutrient) => nutrient.code === "map_gamma"),
      ).toMatchObject({ completeness: "unknown", unknownCount: 1 });
    } finally {
      releaseRegistry.resolve();
      continueMapping.resolve();
      const pending = [registryBlocker, mappingTransaction, diaryOutcome].filter(
        (value): value is Promise<unknown> => value !== undefined,
      );
      await Promise.allSettled(pending);
      await firstWriter.destroy();
      await secondWriter.destroy();
      await diaryWriter.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise?.(value),
  };
}

async function waitForApplicationLock(
  database: ReturnType<typeof createDatabase>,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await sql<{ wait_event_type: string | null }>`
      select wait_event_type
      from pg_stat_activity
      where application_name = ${applicationName}
    `.execute(database);
    if (activity.rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Writer ${applicationName} did not reach a PostgreSQL lock wait`);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function seedDiaryDayAtCapacity(
  database: ReturnType<typeof createDatabase>,
  userId: string,
  diaryId: string,
  foodVersionId: string,
  entryCount = 50,
  withFullNutrientVector = false,
  withCanonicalTies = false,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`set constraints all deferred`.execute(transaction);
    await sql`
      with diary_day as materialized (
        select local_date, time_zone from diary where id = ${diaryId} and user_id = ${userId}
      ), catalogue as materialized (
        select *
        from promoted_food_search_catalogue_v1
        where food_version_id = ${foodVersionId}
      ), generated as materialized (
        select
          gen_random_uuid() as entry_id,
          gen_random_uuid() as revision_id,
          ordinal::integer,
          case
            when ${withCanonicalTies} then
              case (ordinal - 1) % 4
                when 0 then 'snacks'
                when 1 then 'dinner'
                when 2 then 'lunch'
                else 'breakfast'
              end
            else 'lunch'
          end as meal_slot,
          case when ${withCanonicalTies} then ((ordinal - 1) % 3)::integer else ordinal::integer end as position
        from generate_series(1, ${entryCount}) ordinal
      ), inserted as (
        insert into diary_entry (
          id, diary_id, user_id, client_operation_id, entry_kind,
          food_version_id, food_serving_id, recipe_version_id,
          quantity, input_unit, resolved_grams,
          occurred_at, local_time, meal_slot, position, note,
          snapshot_status, snapshot_engine_version,
          current_revision_id, current_revision_number
        )
        select
          generated.entry_id, ${diaryId}, ${userId}, gen_random_uuid(), 'food',
          catalogue.food_version_id, null, null,
          1, 'g', 1,
          (diary_day.local_date + time '12:00:00') at time zone diary_day.time_zone,
          '12:00:00', generated.meal_slot, generated.position, null,
          'partial', ${NUTRITION_ENGINE_VERSION},
          generated.revision_id, 1
        from generated cross join catalogue cross join diary_day
        returning id, current_revision_id, meal_slot, position
      )
      insert into diary_entry_revision (
        id, diary_entry_id, diary_id, user_id, revision_number, operation, entry_kind,
        food_version_id, recipe_version_id, food_serving_id, meal_slot,
        quantity, input_unit, resolved_quantity, resolved_unit,
        occurred_at, local_date, local_time, time_zone, position, note,
        food_name, brand_name, source_code, source_release_id, source_display_name,
        license_expression, attribution_required, attribution_text, serving_label,
        snapshot_status, snapshot_engine_version, nutrient_component_count
      )
      select
        inserted.current_revision_id, inserted.id, ${diaryId}, ${userId}, 1, 'create', 'food',
        catalogue.food_version_id, null, null, inserted.meal_slot,
        1, 'g', 1, 'g',
        (diary_day.local_date + time '12:00:00') at time zone diary_day.time_zone,
        diary_day.local_date, '12:00:00', diary_day.time_zone,
        inserted.position, null,
        catalogue.name, catalogue.brand_name, catalogue.source_code,
        catalogue.source_release_id, catalogue.source_display_name,
        catalogue.license_expression, catalogue.attribution_required,
        catalogue.attribution_text, null,
        'partial', ${NUTRITION_ENGINE_VERSION},
        case
          when ${withFullNutrientVector} then (select count(*)::integer from nutrient where active)
          else 0
        end
      from inserted cross join catalogue cross join diary_day
    `.execute(transaction);
    if (withFullNutrientVector) {
      await sql`
        insert into diary_entry_revision_nutrient (
          diary_entry_revision_id, nutrient_id, nutrient_code, nutrient_name, unit,
          known_amount, completeness, is_exact, contributor_count, quantified_count,
          unknown_count, trace_count, unknown_reasons
        )
        select
          entry.current_revision_id, nutrient.id, nutrient.code, nutrient.name,
          nutrient.canonical_unit, 0, 'unknown', false, 1, 0, 1, 0,
          '{"not_reported": 1}'::jsonb
        from diary_entry entry
        cross join nutrient
        where entry.diary_id = ${diaryId}
          and entry.user_id = ${userId}
          and nutrient.active
      `.execute(transaction);
    }
  });
}

async function seedCatalogue(database: ReturnType<typeof createDatabase>): Promise<{
  basisMismatchVersionId: string;
  currentVersionId: string;
  longSubnormalServingId: string;
  longSubnormalVersionId: string;
  precisionServingId: string;
  servingId: string;
  sourceId: string;
  supersededVersionId: string;
  unitMismatchVersionId: string;
}> {
  return database.transaction().execute(async (transaction) => {
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    const nutrientIds = new Map<string, string>();
    for (const nutrient of [
      { code: "energy", name: "Energy", unit: "kcal" },
      { code: "protein", name: "Protein", unit: "g" },
      { code: "fiber", name: "Fiber", unit: "g" },
      { code: "sodium", name: "Sodium", unit: "mg" },
    ]) {
      const row = await transaction
        .insertInto("nutrient")
        .values({
          canonical_unit: nutrient.unit,
          code: nutrient.code,
          dimension: nutrient.unit === "kcal" ? "energy" : "mass",
          name: nutrient.name,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      nutrientIds.set(nutrient.code, row.id);
    }
    const source = await transaction
      .insertInto("food_source")
      .values({
        active: true,
        attribution_required: true,
        attribution_text: "Diary integration fixture",
        code: `DY${suffix}`,
        commercial_use_allowed: true,
        display_name: `Diary source ${suffix}`,
        homepage_url: "https://example.invalid/diary",
        kind: "government",
        license_expression: "CC0-1.0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistribution_allowed: true,
        rights_review_status: "approved",
        rights_reviewed_at: "2026-08-15T00:00:00Z",
        rights_reviewed_by: "principal:diary-test",
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
        source_food_key: `diary-food-${suffix}`,
        visibility: "public",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const supersededVersionId = await insertVersion(
      transaction,
      food.id,
      release,
      batch,
      1,
      `diary-food-${suffix}:1`,
    );
    const currentVersionId = await insertVersion(
      transaction,
      food.id,
      release,
      batch,
      2,
      `diary-food-${suffix}:2`,
    );
    await transaction
      .updateTable("food")
      .set({ current_version_id: currentVersionId })
      .where("id", "=", food.id)
      .execute();
    const serving = await transaction
      .insertInto("food_serving")
      .values({
        food_version_id: currentVersionId,
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
    const precisionServing = await transaction
      .insertInto("food_serving")
      .values({
        food_version_id: currentVersionId,
        gram_weight: "0.123456",
        is_default: false,
        label: "precision portion",
        metadata: { fixture: true },
        quantity: "1",
        source_serving_key: "precision-serving",
        unit: "portion",
        unit_kind: "count",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const value of [
      { amount: "200", code: "energy", status: "measured" as const, unit: "kcal" },
      { amount: "10", code: "protein", status: "measured" as const, unit: "g" },
      { amount: "0", code: "fiber", status: "trace" as const, unit: "g" },
    ]) {
      await transaction
        .insertInto("food_nutrient_value")
        .values({
          amount: value.amount,
          basis_quantity: "100",
          basis_unit: "g",
          food_version_id: currentVersionId,
          nutrient_id: nutrientIds.get(value.code) ?? "missing",
          unit: value.unit,
          value_status: value.status,
        })
        .execute();
    }
    const longSubnormalFood = await transaction
      .insertInto("food")
      .values({
        food_source_id: source.id,
        kind: "generic",
        owner_user_id: null,
        source_food_key: `diary-long-subnormal-${suffix}`,
        visibility: "public",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const longSubnormalVersionId = await insertVersion(
      transaction,
      longSubnormalFood.id,
      release,
      batch,
      5,
      `diary-long-subnormal-${suffix}:1`,
      "999999999999",
    );
    await transaction
      .updateTable("food")
      .set({ current_version_id: longSubnormalVersionId })
      .where("id", "=", longSubnormalFood.id)
      .execute();
    const longSubnormalServing = await transaction
      .insertInto("food_serving")
      .values({
        food_version_id: longSubnormalVersionId,
        gram_weight: "0.000001",
        is_default: true,
        label: "subnormal micro portion",
        metadata: { fixture: true },
        quantity: "1",
        source_serving_key: "subnormal-micro-portion",
        unit: "portion",
        unit_kind: "count",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("food_nutrient_value")
      .values({
        amount: "0.000000000001",
        basis_quantity: "999999999999",
        basis_unit: "g",
        food_version_id: longSubnormalVersionId,
        nutrient_id: nutrientIds.get("protein") ?? "missing",
        unit: "g",
        value_status: "measured",
      })
      .execute();
    const corruptVersions: Array<{
      readonly basisQuantity: string;
      readonly sourceKey: string;
      readonly unit: string;
      readonly versionNumber: number;
    }> = [
      {
        basisQuantity: "100",
        sourceKey: `diary-unit-mismatch-${suffix}`,
        unit: "mg",
        versionNumber: 3,
      },
      {
        basisQuantity: "50",
        sourceKey: `diary-basis-mismatch-${suffix}`,
        unit: "g",
        versionNumber: 4,
      },
    ];
    const corruptVersionIds: string[] = [];
    for (const corrupt of corruptVersions) {
      const corruptFood = await transaction
        .insertInto("food")
        .values({
          food_source_id: source.id,
          kind: "generic",
          owner_user_id: null,
          source_food_key: corrupt.sourceKey,
          visibility: "public",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const corruptVersionId = await insertVersion(
        transaction,
        corruptFood.id,
        release,
        batch,
        corrupt.versionNumber,
        `${corrupt.sourceKey}:1`,
      );
      await transaction
        .updateTable("food")
        .set({ current_version_id: corruptVersionId })
        .where("id", "=", corruptFood.id)
        .execute();
      await transaction
        .insertInto("food_nutrient_value")
        .values({
          amount: "10",
          basis_quantity: corrupt.basisQuantity,
          basis_unit: "g",
          food_version_id: corruptVersionId,
          nutrient_id: nutrientIds.get("protein") ?? "missing",
          unit: corrupt.unit,
          value_status: "measured",
        })
        .execute();
      corruptVersionIds.push(corruptVersionId);
    }
    const [unitMismatchVersionId, basisMismatchVersionId] = corruptVersionIds;
    if (!unitMismatchVersionId || !basisMismatchVersionId) {
      throw new Error("Corrupt catalogue fixtures were not materialized");
    }
    await transaction
      .updateTable("food_source_release")
      .set({ promoted_at: "2026-08-15T01:00:00Z", status: "promoted" })
      .where("id", "=", release)
      .execute();
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: release })
      .where("id", "=", source.id)
      .execute();
    return {
      basisMismatchVersionId,
      currentVersionId,
      longSubnormalServingId: longSubnormalServing.id,
      longSubnormalVersionId,
      precisionServingId: precisionServing.id,
      servingId: serving.id,
      sourceId: source.id,
      supersededVersionId,
      unitMismatchVersionId,
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
        artifact_sha256: "7".repeat(64),
        artifact_uri: "s3://diary-test/catalogue.json",
        food_source_id: sourceId,
        media_type: "application/json",
        parser_version: "diary-test@1",
        record_counts: { records: 2 },
        release_key: "diary-release-1",
        rights_manifest_sha256: "8".repeat(64),
        rights_manifest_uri: "repo://diary-rights.json",
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
  return (
    await transaction
      .insertInto("food_import_batch")
      .values({
        acquired_at: "2026-08-15T00:00:00Z",
        artifact_bytes: 100,
        artifact_sha256: "7".repeat(64),
        artifact_uri: "s3://diary-test/catalogue.json",
        completed_at: "2026-08-15T01:00:00Z",
        food_source_id: sourceId,
        materialized_count: 2,
        media_type: "application/json",
        parser_version: "diary-test@1",
        release_id: releaseId,
        release_key: "diary-release-1",
        rights_manifest_sha256: "8".repeat(64),
        rights_manifest_uri: "repo://diary-rights.json",
        staged_count: 2,
        status: "completed",
        valid_count: 2,
        validated_at: "2026-08-15T00:30:00Z",
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function insertVersion(
  transaction: Transaction<Database>,
  foodId: string,
  releaseId: string,
  batchId: string,
  versionNumber: number,
  sourceRecordKey: string,
  basisQuantity = "100",
): Promise<string> {
  const version = await transaction
    .insertInto("food_version")
    .values({
      basis_quantity: basisQuantity,
      basis_unit: "g",
      data_quality: "verified",
      food_id: foodId,
      language_tag: "en-US",
      market_code: "US",
      name: versionNumber === 1 ? "Old Diary Crackers" : "Current Diary Crackers",
      normalized_name: versionNumber === 1 ? "old diary crackers" : "current diary crackers",
      source_release_id: versionNumber === 1 ? null : releaseId,
      version_number: versionNumber,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (versionNumber !== 1)
    await transaction
      .insertInto("food_import_record")
      .values({
        batch_id: batchId,
        canonical_payload: { versionNumber },
        canonical_payload_sha256: String(versionNumber).repeat(64),
        food_version_id: version.id,
        materialized_at: "2026-08-15T01:00:00Z",
        sequence_number: versionNumber,
        source_payload_sha256: String(versionNumber + 2).repeat(64),
        source_record_key: sourceRecordKey,
        source_record_type: "fixture",
        validated_at: "2026-08-15T00:30:00Z",
        validation_issues: sql`'[]'::jsonb`,
        validation_status: "materialized",
      })
      .execute();
  return version.id;
}
