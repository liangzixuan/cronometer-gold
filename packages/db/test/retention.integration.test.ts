import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  acknowledgeRetentionDeadLetterEvent,
  applyPlatformHealthImportBatch,
  archiveCustomFood,
  assertDatabaseReady,
  assertDatabaseRestoreReplayReady,
  beginPrivacyExportStagedArtifactUpload,
  claimAccountErasureJobs,
  claimCancelledPrivacyExportStagedArtifacts,
  claimExpiredPrivacyExportArtifacts,
  claimPrivacyExportJobs,
  claimRetentionDeadLetterEvents,
  completeDatabaseRestoreReplayAttestation,
  completePrivacyExportArtifactDeletion,
  completePrivacyExportJob,
  completePrivacyExportStagedArtifactDeletion,
  consentPlatformIntegration,
  createBiometricDefinition,
  createCustomFood,
  createDatabase,
  createDeviceChallenge,
  createFoodDiaryEntry,
  createPrivacyExportJob,
  createReauthenticationProof,
  createRecipe,
  createRecipeDiaryEntry,
  createReminderSchedule,
  createSession,
  discoverMigrations,
  executeAccountErasureJob,
  failAccountErasureJob,
  failPrivacyExportJob,
  findPendingErasureRecoverySessionByTokenHash,
  getBiometricTrends,
  getNutrientTrend,
  getPrivacyExportJob,
  issueEmailVerificationToken,
  listAccountPrivacyExportArtifactsForErasure,
  listBiometricEvents,
  listReminderSchedules,
  markPrivacyExportStagedArtifactUploaded,
  type PrivacyExportEntitySnapshotRecord,
  type PrivacyExportRecord,
  RecipeValidationError,
  rebindPlatformIntegration,
  recordBiometricEvent,
  recordPrivacyExportArtifactDownloadAudit,
  registerDevice,
  registerPasswordAccount,
  renewPrivacyExportStagedArtifactUploadLease,
  renewRetentionWorkLease,
  repeatDiaryEntry,
  replayExternalErasureLedgerEntry,
  requestAccountErasure,
  requeueDeadLetteredAccountErasureJob,
  requeueDeadLetteredPrivacyExportArtifactDeletion,
  requeueDeadLetteredPrivacyExportJob,
  requeueDeadLetteredPrivacyExportStagedArtifactDeletion,
  reviseCustomFood,
  reviseReminderSchedule,
  revokeDevice,
  revokeReminderSchedule,
  runMigrations,
  stagePrivacyExportArtifacts,
  updateUserProfile,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const digest = (character: string) => character.repeat(64);
const TEST_EXPORT_SNAPSHOT_BYTES = 32 * 1_024 * 1_024;
const RETENTION_FIXTURE_YEAR = 2500;

/**
 * Keep authorization and asynchronous-work fixtures deterministic and safely
 * ahead of PostgreSQL's real clock. Diary, DST, biometric, reminder, and
 * imported-health dates intentionally remain on their domain-specific timeline.
 */
function retentionInstant(monthDayAndTime: string, yearOffset = 0): string {
  return `${RETENTION_FIXTURE_YEAR + yearOffset}-${monthDayAndTime}`;
}

describeDatabase("retention persistence", { timeout: 15_000 }, () => {
  it("fails 0006 before DDL for legacy custom roots, then upgrades cleanly after remediation", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `retention_upgrade_${randomBytes(6).toString("hex")}`;
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
        "0005_recipes_and_goals.sql",
      ]) {
        const migration = await readFile(
          resolve(import.meta.dirname, "../migrations", migrationName),
          "utf8",
        );
        await sql.raw(migration).execute(database);
      }
      const owner = await database
        .insertInto("app_user")
        .values({
          auth_subject: `legacy-retention:${randomUUID()}`,
          email: `legacy-retention-${randomUUID()}@example.invalid`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("food")
        .values({ kind: "custom", owner_user_id: owner.id, visibility: "private" })
        .execute();
      const migration = await readFile(
        resolve(import.meta.dirname, "../migrations/0006_retention_features.sql"),
        "utf8",
      );
      await expect(sql.raw(migration).execute(database)).rejects.toThrow(
        /requires empty legacy custom-food roots/u,
      );
      const blocked = await sql<{ table_name: string | null }>`
        select to_regclass(${`${schemaName}.custom_food`})::text table_name
      `.execute(database);
      expect(blocked.rows[0]?.table_name).toBeNull();
      await database.deleteFrom("food").where("owner_user_id", "=", owner.id).execute();
      await sql.raw(migration).execute(database);
      await sql`
        create table app_schema_migration (
          name text primary key,
          checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz not null default clock_timestamp()
        )
      `.execute(database);
      for (const applied of await discoverMigrations())
        await sql`
          insert into app_schema_migration (name, checksum)
          values (${applied.name}, ${applied.checksum})
        `.execute(database);
      const validations = await sql<{ conname: string; convalidated: boolean }>`
        select conname,convalidated
        from pg_constraint
        where conrelid in (
          ${`${schemaName}.source_nutrient_map`}::regclass,
          ${`${schemaName}.food_source`}::regclass
        ) and conname in (
          'source_nutrient_map_reviewer_principal_check',
          'food_source_rights_reviewer_principal_check'
        )
        order by conname
      `.execute(database);
      expect(validations.rows).toEqual([
        { conname: "food_source_rights_reviewer_principal_check", convalidated: true },
        { conname: "source_nutrient_map_reviewer_principal_check", convalidated: true },
      ]);
      const initialEpoch = "initial-deployment-restore-epoch-0001";
      await expect(
        assertDatabaseRestoreReplayReady(database, { restoreEpoch: initialEpoch }),
      ).rejects.toThrow("Database restore replay attestation is not current");
      await expect(
        assertDatabaseReady(database, {
          requireRestoreAttestation: true,
          restoreEpoch: initialEpoch,
        }),
      ).rejects.toThrow("Database restore replay attestation is not current");
      await expect(
        completeDatabaseRestoreReplayAttestation(database, {
          completedAt: retentionInstant("08-16T00:00:00Z"),
          reconciliationDigest: digest("0"),
          replayedSubjectCount: 0,
          restoreEpoch: initialEpoch,
        }),
      ).resolves.toMatchObject({ replayedSubjectCount: "0" });
      await expect(
        assertDatabaseRestoreReplayReady(database, { restoreEpoch: initialEpoch }),
      ).resolves.toBeUndefined();
      await expect(
        assertDatabaseReady(database, {
          requireRestoreAttestation: true,
          restoreEpoch: initialEpoch,
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertDatabaseRestoreReplayReady(database, {
          restoreEpoch: "restored-backup-needs-new-epoch-0002",
        }),
      ).rejects.toThrow("Database restore replay attestation is not current");
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });

  it("pins private custom-food history through recipes, repeat logging, and active-zone trends", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "retention_custom");
    try {
      const created = await createCustomFood(fixture.database, {
        clientOperationId: randomUUID(),
        food: customDraft(fixture.nutrients.energyId, fixture.nutrients.proteinId, "Original"),
        requestDigest: digest("1"),
        userId: fixture.owner.userId,
      });
      expect(created.food.currentVersion).toMatchObject({
        brandName: "Owner brand",
        notes: "Original notes",
        versionNumber: "1",
      });
      expect(created.food.currentVersion.nutrients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "quantified", amountPer100Grams: "200" }),
          expect.objectContaining({ state: "unknown", reason: "not_analyzed" }),
        ]),
      );

      const recipe = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        recipe: {
          description: null,
          ingredients: [
            {
              foodVersionId: created.food.currentVersion.id,
              kind: "food",
              portion: { grams: "100", kind: "grams" },
            },
          ],
          instructions: null,
          name: "Private bowl",
          servingCount: "2",
          servingLabel: "bowl",
          yield: { grams: "100", source: "measured" },
        },
        requestDigest: digest("2"),
        userId: fixture.owner.userId,
      });
      expect(recipe.recipe.currentVersion.sources).toEqual([]);
      expect(recipe.recipe.currentVersion.ingredients[0]).toMatchObject({
        foodProvenance: {
          customFoodId: created.food.id,
          customFoodVersionNumber: "1",
          kind: "private_custom",
        },
        source: null,
      });

      const firstLog = await createFoodDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        expectedCustomFoodId: created.food.id,
        foodVersionId: created.food.currentVersion.id,
        mealSlot: "breakfast",
        note: "  exact source note\nkeep spacing  ",
        occurredAt: "2026-01-01T02:00:00Z",
        portion: { grams: "100", kind: "grams" },
        requestDigest: digest("3"),
        userId: fixture.owner.userId,
      });
      expect(firstLog.entry.foodProvenance).toMatchObject({
        customFoodId: created.food.id,
        kind: "private_custom",
        versionNumber: 1,
      });

      const revised = await reviseCustomFood(fixture.database, {
        clientOperationId: randomUUID(),
        customFoodId: created.food.id,
        expectedRevision: "1",
        food: customDraft(fixture.nutrients.energyId, fixture.nutrients.proteinId, "Revised"),
        requestDigest: digest("4"),
        userId: fixture.owner.userId,
      });
      expect(revised.food.currentVersion.id).not.toBe(created.food.currentVersion.id);
      const repeated = await repeatDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        occurredAt: "2026-01-02T02:00:00Z",
        requestDigest: digest("5"),
        sourceEntryId: firstLog.entry.id,
        sourceRevision: "1",
        userId: fixture.owner.userId,
      });
      expect(repeated.entry.kind).toBe("food");
      if (repeated.entry.kind !== "food") throw new Error("Expected a repeated food entry");
      expect(repeated.entry.food.foodVersionId).toBe(created.food.currentVersion.id);
      expect(repeated.entry.note).toBe(firstLog.entry.note);
      expect(repeated.entry.repeatedFromRevisionId).not.toBeNull();

      await archiveCustomFood(fixture.database, {
        clientOperationId: randomUUID(),
        customFoodId: created.food.id,
        expectedRevision: "2",
        requestDigest: digest("6"),
        userId: fixture.owner.userId,
      });
      await expect(
        createRecipe(fixture.database, {
          clientOperationId: randomUUID(),
          recipe: {
            description: null,
            ingredients: [
              {
                foodVersionId: revised.food.currentVersion.id,
                kind: "food",
                portion: { grams: "10", kind: "grams" },
              },
            ],
            instructions: null,
            name: "New archived dependency",
            servingCount: null,
            servingLabel: null,
            yield: { grams: "10", source: "measured" },
          },
          requestDigest: digest("7"),
          userId: fixture.owner.userId,
        }),
      ).rejects.toBeInstanceOf(RecipeValidationError);
      const historicalRecipeLog = await createRecipeDiaryEntry(fixture.database, {
        clientOperationId: randomUUID(),
        mealSlot: "dinner",
        occurredAt: "2026-01-03T02:00:00Z",
        portion: { amount: "1", kind: "serving" },
        recipeId: recipe.recipe.id,
        recipeVersionId: recipe.recipe.currentVersion.id,
        requestDigest: digest("8"),
        userId: fixture.owner.userId,
      });
      expect(historicalRecipeLog.entry.recipe.versionNumber).toBe(1);
      expect(historicalRecipeLog.entry.recipe.sources).toEqual([]);

      const fallBack = await getNutrientTrend(fixture.database, {
        fromLocalDate: "2026-11-01",
        nutrientId: fixture.nutrients.energyId,
        toLocalDate: "2026-11-01",
        userId: fixture.owner.userId,
      });
      expect(fallBack.points[0]).toMatchObject({
        aggregate: null,
        endsAt: "2026-11-02T06:00:00.000Z",
        startsAt: "2026-11-01T05:00:00.000Z",
      });

      const profile = await updateUserProfile(fixture.database, {
        expectedRevision: fixture.owner.revision,
        patch: { timeZone: "Asia/Tokyo" },
        userId: fixture.owner.userId,
      });
      expect(profile.timeZone).toBe("Asia/Tokyo");
      const trend = await getNutrientTrend(fixture.database, {
        fromLocalDate: "2026-01-01",
        nutrientId: fixture.nutrients.energyId,
        toLocalDate: "2026-01-01",
        userId: fixture.owner.userId,
      });
      expect(trend.timeZone).toBe("Asia/Tokyo");
      expect(trend.points[0]).toMatchObject({
        aggregate: expect.objectContaining({ knownAmount: "200" }),
        endsAt: "2026-01-01T15:00:00.000Z",
        startsAt: "2025-12-31T15:00:00.000Z",
      });
    } finally {
      await fixture.close();
    }
  });

  it("versions local reminder consent and preserves exact biometric values across pages", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "retention_daily");
    try {
      const definition = await createBiometricDefinition(fixture.database, {
        clientOperationId: randomUUID(),
        definition: {
          canonicalUnit: "kg",
          dimension: "mass",
          name: "Scale weight",
          notes: "Owner-entered scale reading",
        },
        requestDigest: digest("a"),
        userId: fixture.owner.userId,
      });
      for (const [index, value] of ["9007199254740993.000001", "0.000000000001"].entries())
        await recordBiometricEvent(fixture.database, {
          clientOperationId: randomUUID(),
          definitionId: definition.definition.id,
          measuredAt: `2026-03-0${index + 7}T12:00:00Z`,
          requestDigest: digest(index === 0 ? "b" : "c"),
          userId: fixture.owner.userId,
          value,
        });
      const firstPage = await listBiometricEvents(fixture.database, {
        definitionId: definition.definition.id,
        limit: 1,
        userId: fixture.owner.userId,
      });
      expect(firstPage.records).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await listBiometricEvents(fixture.database, {
        cursor: firstPage.nextCursor,
        definitionId: definition.definition.id,
        limit: 1,
        userId: fixture.owner.userId,
      });
      expect(secondPage.records).toHaveLength(1);
      expect(
        new Set([...firstPage.records, ...secondPage.records].map((event) => event.value)),
      ).toEqual(new Set(["9007199254740993.000001", "0.000000000001"]));
      expect(
        [...firstPage.records, ...secondPage.records].every(
          (event) => event.source.deviceId === null,
        ),
      ).toBe(true);
      const biometricTrend = await getBiometricTrends(fixture.database, {
        definitionId: definition.definition.id,
        fromLocalDate: "2026-03-07",
        toLocalDate: "2026-03-08",
        userId: fixture.owner.userId,
      });
      expect(biometricTrend.timeZone).toBe("America/Chicago");
      expect(biometricTrend.points).toHaveLength(2);

      const reminder = await createReminderSchedule(fixture.database, {
        clientOperationId: randomUUID(),
        requestDigest: digest("d"),
        schedule: {
          after: "2026-03-08T07:01:00Z",
          channel: "local",
          consentGranted: true,
          daysOfWeek: [7],
          label: "Weekly check-in",
          localTime: "02:30",
          timeZone: "America/Chicago",
        },
        userId: fixture.owner.userId,
      });
      expect(reminder.schedule).toMatchObject({
        consent: { policyVersion: "local-reminders-v1", revokedAt: null },
        deliveryPolicy: {
          includesHealthDetails: false,
          lockScreenText: "Time to check in.",
          title: "Nutrition Tracker",
        },
        nextDeliveryAt: "2026-03-15T07:30:00.000Z",
      });
      const paused = await reviseReminderSchedule(fixture.database, {
        clientOperationId: randomUUID(),
        expectedRevision: "1",
        requestDigest: digest("e"),
        schedule: {
          channel: "local",
          daysOfWeek: [7],
          label: "Weekly check-in",
          localTime: "02:30",
          status: "paused",
          timeZone: "America/Chicago",
        },
        scheduleId: reminder.schedule.id,
        userId: fixture.owner.userId,
      });
      expect(paused.schedule).toMatchObject({ nextDeliveryAt: null, status: "paused" });
      expect(
        await listReminderSchedules(fixture.database, { userId: fixture.owner.userId }),
      ).toEqual([expect.objectContaining({ id: reminder.schedule.id, status: "paused" })]);
      const resumed = await reviseReminderSchedule(fixture.database, {
        clientOperationId: randomUUID(),
        expectedRevision: "2",
        requestDigest: digest("f"),
        schedule: {
          after: "2026-03-08T07:01:00Z",
          channel: "local",
          daysOfWeek: [7],
          label: "Weekly check-in",
          localTime: "02:30",
          status: "active",
          timeZone: "America/Chicago",
        },
        scheduleId: reminder.schedule.id,
        userId: fixture.owner.userId,
      });
      const revoked = await revokeReminderSchedule(fixture.database, {
        clientOperationId: randomUUID(),
        expectedRevision: resumed.schedule.currentRevision,
        occurredAt: "2026-03-09T00:00:00Z",
        requestDigest: digest("1"),
        scheduleId: reminder.schedule.id,
        userId: fixture.owner.userId,
      });
      expect(revoked.schedule).toMatchObject({
        consent: { revokedAt: "2026-03-09T00:00:00.000Z" },
        status: "revoked",
      });
    } finally {
      await fixture.close();
    }
  });

  it("serializes the 64 active reminder occurrences and reclaims capacity after revoke", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "retention_reminder_capacity");
    const createSchedule = (index: number, daysOfWeek: readonly number[]) =>
      createReminderSchedule(fixture.database, {
        clientOperationId: randomUUID(),
        requestDigest: digest("0123456789abcdef"[index % 16] ?? "0"),
        schedule: {
          after: "2026-08-16T12:00:00Z",
          channel: "local",
          consentGranted: true,
          daysOfWeek,
          label: `Capacity reminder ${index}`,
          localTime: "09:00",
          timeZone: "America/Chicago",
        },
        userId: fixture.owner.userId,
      });
    try {
      const sevenDaySchedules = [];
      for (let index = 0; index < 9; index += 1) {
        sevenDaySchedules.push(await createSchedule(index, [1, 2, 3, 4, 5, 6, 7]));
      }

      const boundary = await Promise.allSettled([createSchedule(9, [1]), createSchedule(10, [2])]);
      expect(boundary.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = boundary.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: { code: "VALIDATION", message: "Active reminder occurrence limit reached" },
        status: "rejected",
      });

      const revoked = await revokeReminderSchedule(fixture.database, {
        clientOperationId: randomUUID(),
        expectedRevision: sevenDaySchedules[0]?.schedule.currentRevision ?? "1",
        occurredAt: "2026-08-16T13:00:00Z",
        requestDigest: digest("b"),
        scheduleId: sevenDaySchedules[0]?.schedule.id ?? "",
        userId: fixture.owner.userId,
      });
      expect(revoked.schedule.status).toBe("revoked");
      await expect(createSchedule(11, [1, 2, 3, 4, 5, 6, 7])).resolves.toMatchObject({
        schedule: { status: "active" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("serializes signed platform imports and preserves exact replay before freshness rejection", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "retention_import");
    try {
      const challenge = await createDeviceChallenge(fixture.database, {
        clientOperationId: randomUUID(),
        expiresAt: retentionInstant("01-01T00:00:00Z", 1),
        nonceHash: digest("a"),
        platform: "apple_healthkit",
        requestDigest: digest("b"),
        userId: fixture.owner.userId,
      });
      const device = await registerDevice(fixture.database, {
        attestationStatus: "unverified",
        challengeId: challenge.challenge.id,
        clientOperationId: randomUUID(),
        displayName: "Owner phone",
        keyFingerprint: digest("c"),
        nonceHash: digest("a"),
        platform: "apple_healthkit",
        proofSignatureDigest: digest("d"),
        publicKeySpkiBase64: "A".repeat(64),
        requestDigest: digest("e"),
        userId: fixture.owner.userId,
      });
      const connected = await consentPlatformIntegration(fixture.database, {
        clientOperationId: randomUUID(),
        consentGranted: true,
        dataTypeCodes: ["body_weight"],
        occurredAt: "2026-08-16T12:00:00Z",
        platform: "apple_healthkit",
        requestDigest: digest("f"),
        userId: fixture.owner.userId,
      });
      expect(connected.integration.cursorEpoch).toBe("1");
      const importedWeight = (index: number) => ({
        definitionCode: "body_weight" as const,
        externalId: `weight-${index}`,
        externalRevision: "1",
        measuredAt: "2026-08-16T08:30:00-05:00",
        operation: "upsert" as const,
        recordedTimeZone: "America/Chicago",
        unit: "kg" as const,
        value: "9007199254740993.000001",
      });
      const input = {
        batchDigest: digest("1"),
        batchId: randomUUID(),
        clientOperationId: randomUUID(),
        cursorEpoch: connected.integration.cursorEpoch,
        deviceId: device.device.id,
        isTimestampFresh: true,
        nextSourceCursor: "cursor-1",
        nonceHash: digest("2"),
        platform: "apple_healthkit" as const,
        records: Array.from({ length: 100 }, (_, index) => importedWeight(index)),
        requestDigest: digest("3"),
        signatureDigest: digest("4"),
        signedAt: "2026-08-16T13:31:00Z",
        sourceCursor: null,
        userId: fixture.owner.userId,
      };
      const firstEpochRebind = await rebindPlatformIntegration(fixture.database, {
        clientOperationId: randomUUID(),
        deviceId: device.device.id,
        expectedRevision: connected.integration.currentRevision,
        occurredAt: "2026-08-16T13:30:00Z",
        platform: "apple_healthkit",
        requestDigest: digest("d"),
        userId: fixture.owner.userId,
      });
      expect(firstEpochRebind.integration).toMatchObject({
        currentRevision: "2",
        cursorEpoch: "2",
        currentSourceCursor: null,
        deviceId: device.device.id,
      });
      await expect(applyPlatformHealthImportBatch(fixture.database, input)).rejects.toMatchObject({
        code: "IMPORT_CONFLICT",
      });
      const epochTwoInput = {
        ...input,
        batchDigest: digest("e"),
        batchId: randomUUID(),
        clientOperationId: randomUUID(),
        cursorEpoch: firstEpochRebind.integration.cursorEpoch,
        nonceHash: digest("f"),
        requestDigest: digest("0"),
        signatureDigest: digest("1"),
      };
      const [one, two] = await Promise.all([
        applyPlatformHealthImportBatch(fixture.database, epochTwoInput),
        applyPlatformHealthImportBatch(fixture.database, epochTwoInput),
      ]);
      expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
      expect(one.accepted + two.accepted).toBe(200);
      const importedEvents = await listBiometricEvents(fixture.database, {
        limit: 100,
        userId: fixture.owner.userId,
      });
      expect(importedEvents.records).toHaveLength(100);
      expect(
        importedEvents.records.every((event) => event.source.deviceId === device.device.id),
      ).toBe(true);
      const secondPageInput = {
        ...epochTwoInput,
        batchDigest: digest("5"),
        batchId: randomUUID(),
        clientOperationId: randomUUID(),
        nextSourceCursor: "cursor-2",
        nonceHash: digest("6"),
        records: [importedWeight(100)],
        requestDigest: digest("7"),
        signatureDigest: digest("8"),
        sourceCursor: "cursor-1",
      };
      const secondPage = await applyPlatformHealthImportBatch(fixture.database, secondPageInput);
      expect(secondPage).toMatchObject({
        accepted: 1,
        conflicts: [],
        deleted: 0,
        duplicates: 0,
      });
      expect(
        await applyPlatformHealthImportBatch(fixture.database, {
          ...epochTwoInput,
          isTimestampFresh: false,
        }),
      ).toMatchObject({ replayed: true });

      const secondEpochRebind = await rebindPlatformIntegration(fixture.database, {
        clientOperationId: randomUUID(),
        deviceId: device.device.id,
        expectedRevision: firstEpochRebind.integration.currentRevision,
        occurredAt: "2026-08-16T13:34:00Z",
        platform: "apple_healthkit",
        requestDigest: digest("2"),
        userId: fixture.owner.userId,
      });
      expect(secondEpochRebind.integration).toMatchObject({
        currentRevision: "3",
        cursorEpoch: "3",
        currentSourceCursor: null,
        deviceId: device.device.id,
      });
      await expect(
        applyPlatformHealthImportBatch(fixture.database, {
          ...epochTwoInput,
          isTimestampFresh: false,
        }),
      ).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });

      await revokeDevice(fixture.database, {
        clientOperationId: randomUUID(),
        deviceId: device.device.id,
        expectedRevision: device.device.revision,
        occurredAt: "2026-08-16T13:35:00Z",
        requestDigest: digest("0"),
        userId: fixture.owner.userId,
      });
      const replacementChallenge = await createDeviceChallenge(fixture.database, {
        clientOperationId: randomUUID(),
        expiresAt: retentionInstant("01-01T00:00:00Z", 1),
        nonceHash: digest("1"),
        platform: "apple_healthkit",
        requestDigest: digest("2"),
        userId: fixture.owner.userId,
      });
      const replacement = await registerDevice(fixture.database, {
        attestationStatus: "unverified",
        challengeId: replacementChallenge.challenge.id,
        clientOperationId: randomUUID(),
        displayName: "Replacement phone",
        keyFingerprint: digest("3"),
        nonceHash: digest("1"),
        platform: "apple_healthkit",
        proofSignatureDigest: digest("4"),
        publicKeySpkiBase64: "B".repeat(64),
        requestDigest: digest("5"),
        userId: fixture.owner.userId,
      });
      const rebound = await rebindPlatformIntegration(fixture.database, {
        clientOperationId: randomUUID(),
        deviceId: replacement.device.id,
        expectedRevision: secondEpochRebind.integration.currentRevision,
        occurredAt: "2026-08-16T13:36:00Z",
        platform: "apple_healthkit",
        requestDigest: digest("6"),
        userId: fixture.owner.userId,
      });
      expect(rebound.integration).toMatchObject({
        cursorEpoch: "4",
        currentSourceCursor: null,
        deviceId: replacement.device.id,
      });
      const repeatedFirstPage = await applyPlatformHealthImportBatch(fixture.database, {
        ...epochTwoInput,
        batchDigest: digest("7"),
        batchId: randomUUID(),
        clientOperationId: randomUUID(),
        cursorEpoch: rebound.integration.cursorEpoch,
        deviceId: replacement.device.id,
        nextSourceCursor: "cursor-1",
        nonceHash: digest("8"),
        requestDigest: digest("9"),
        signatureDigest: digest("a"),
        sourceCursor: null,
      });
      expect(repeatedFirstPage).toMatchObject({ accepted: 0, duplicates: 100 });
      const repeatedSecondPage = await applyPlatformHealthImportBatch(fixture.database, {
        ...secondPageInput,
        batchDigest: digest("b"),
        batchId: randomUUID(),
        clientOperationId: randomUUID(),
        cursorEpoch: rebound.integration.cursorEpoch,
        deviceId: replacement.device.id,
        nonceHash: digest("c"),
        requestDigest: digest("d"),
        signatureDigest: digest("e"),
      });
      expect(repeatedSecondPage).toMatchObject({ accepted: 0, duplicates: 1 });
      const cursorEpochs = await fixture.database
        .selectFrom("platform_import_batch")
        .select(["cursor_epoch", "source_cursor", "next_source_cursor"])
        .where("integration_id", "=", rebound.integration.id)
        .orderBy("applied_at")
        .execute();
      expect(cursorEpochs.map((batch) => batch.cursor_epoch)).toEqual(["2", "2", "4", "4"]);
      expect(cursorEpochs.map((batch) => [batch.source_cursor, batch.next_source_cursor])).toEqual([
        [null, "cursor-1"],
        ["cursor-1", "cursor-2"],
        [null, "cursor-1"],
        ["cursor-1", "cursor-2"],
      ]);
      await expect(
        applyPlatformHealthImportBatch(fixture.database, {
          ...epochTwoInput,
          batchDigest: digest("1"),
          batchId: randomUUID(),
          clientOperationId: randomUUID(),
          cursorEpoch: rebound.integration.cursorEpoch,
          isTimestampFresh: false,
          nextSourceCursor: "cursor-3",
          deviceId: replacement.device.id,
          nonceHash: digest("2"),
          requestDigest: digest("3"),
          signatureDigest: digest("4"),
          sourceCursor: "cursor-2",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(
        await fixture.database
          .selectFrom("biometric_event_revision")
          .select("value")
          .where("user_id", "=", fixture.owner.userId)
          .executeTakeFirst(),
      ).toMatchObject({ value: "9007199254740993.000001" });

      const emailVerificationTokenHash = digest("7");
      await issueEmailVerificationToken(fixture.database, {
        deliver: async () => undefined,
        emailHash: createHash("sha256").update(fixture.owner.email, "utf8").digest("hex"),
        expiresAt: retentionInstant("08-17T13:00:00Z"),
        issuedAt: retentionInstant("08-16T13:00:00Z"),
        tokenHash: emailVerificationTokenHash,
        userId: fixture.owner.userId,
      });
      const exportSessionHash = digest("9");
      const exportProofHash = digest("a");
      await createSession(fixture.database, {
        expiresAt: retentionInstant("01-01T00:00:00Z", 1),
        tokenHash: exportSessionHash,
        userId: fixture.owner.userId,
      });
      await createReauthenticationProof(fixture.database, {
        expectedPasswordHash: fixture.ownerPasswordHash,
        expiresAt: retentionInstant("08-17T00:00:00Z"),
        purpose: "account_export",
        sessionTokenHash: exportSessionHash,
        tokenHash: exportProofHash,
        userId: fixture.owner.userId,
      });
      const exportJob = await createPrivacyExportJob(fixture.database, {
        clientOperationId: randomUUID(),
        proofTokenHash: exportProofHash,
        requestDigest: digest("b"),
        requestedFormats: ["json"],
        sessionTokenHash: exportSessionHash,
        userId: fixture.owner.userId,
      });
      await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-16T14:00:00Z"),
        workerId: "import-export-worker",
      });
      const securityRows: PrivacyExportRecord[] = [];
      let securitySnapshotId = "";
      const { withPrivacyExportSnapshot } = await import("../src/index.js");
      await withPrivacyExportSnapshot(
        fixture.database,
        {
          jobId: exportJob.job.id,
          maximumSnapshotBytes: TEST_EXPORT_SNAPSHOT_BYTES,
          userId: fixture.owner.userId,
          workerId: "import-export-worker",
        },
        async (snapshot) => {
          securitySnapshotId = snapshot.snapshotId;
          expect(snapshot.entities.map((entity) => entity.entity)).not.toContain(
            "auth_action_token",
          );
          for (const entity of [
            "device",
            "platform_import_batch",
            "retention_operation",
          ] as const) {
            const page = await snapshot.page({ entity, limit: 100 });
            securityRows.push(...page.records);
          }
        },
      );
      for (const row of securityRows) {
        if (row.entityType === "device") {
          expect(row.payload).not.toHaveProperty("public_key_spki_base64");
          expect(row.payload).not.toHaveProperty("key_fingerprint");
          expect(row.payload).not.toHaveProperty("proof_signature_digest");
        }
        if (row.entityType === "platform_import_batch") {
          expect(row.payload).not.toHaveProperty("signature_digest");
          expect(row.payload).not.toHaveProperty("nonce_hash");
        }
        if (row.entityType === "retention_operation") {
          expect(row.payload).not.toHaveProperty("result_payload");
        }
      }
      await sql`alter table audit_log add column unclassified_export_secret text`.execute(
        fixture.database,
      );
      await expect(
        withPrivacyExportSnapshot(
          fixture.database,
          {
            jobId: exportJob.job.id,
            maximumSnapshotBytes: TEST_EXPORT_SNAPSHOT_BYTES,
            userId: fixture.owner.userId,
            workerId: "import-export-worker",
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "EXPORT_NOT_READY" });
      await sql`alter table audit_log drop column unclassified_export_secret`.execute(
        fixture.database,
      );
      await sql`create table unclassified_retention_probe (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references app_user(id) on delete cascade
      )`.execute(fixture.database);
      await expect(
        withPrivacyExportSnapshot(
          fixture.database,
          {
            jobId: exportJob.job.id,
            maximumSnapshotBytes: TEST_EXPORT_SNAPSHOT_BYTES,
            userId: fixture.owner.userId,
            workerId: "import-export-worker",
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "EXPORT_NOT_READY" });
      await sql`drop table unclassified_retention_probe`.execute(fixture.database);
      const [abandoned] = await stagePrivacyExportArtifacts(fixture.database, {
        artifacts: [{ format: "json", objectKey: "exports/owner/stale-attempt.json.enc" }],
        jobId: exportJob.job.id,
        snapshotId: securitySnapshotId,
        userId: fixture.owner.userId,
        workerId: "import-export-worker",
      });
      if (!abandoned) throw new Error("Expected abandoned staged artifact");
      await beginPrivacyExportStagedArtifactUpload(fixture.database, {
        artifactId: abandoned.id,
        jobId: exportJob.job.id,
        leaseExpiresAt: retentionInstant("08-16T14:10:00Z"),
        snapshotId: securitySnapshotId,
        startedAt: retentionInstant("08-16T14:01:00Z"),
        userId: fixture.owner.userId,
        workerId: "import-export-worker",
      });
      await markPrivacyExportStagedArtifactUploaded(fixture.database, {
        artifactId: abandoned.id,
        jobId: exportJob.job.id,
        snapshotId: securitySnapshotId,
        uploadedAt: retentionInstant("08-16T14:02:00Z"),
        userId: fixture.owner.userId,
        workerId: "import-export-worker",
      });
      const [reclaimed] = await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-16T14:16:00Z"),
        workerId: "retry-export-worker",
      });
      expect(reclaimed?.id).toBe(exportJob.job.id);
      let retryEntities: readonly PrivacyExportEntitySnapshotRecord[] = [];
      let retrySemanticDigest = "";
      let retrySnapshotId = "";
      await withPrivacyExportSnapshot(
        fixture.database,
        {
          jobId: exportJob.job.id,
          maximumSnapshotBytes: TEST_EXPORT_SNAPSHOT_BYTES,
          userId: fixture.owner.userId,
          workerId: "retry-export-worker",
        },
        async (snapshot) => {
          retryEntities = snapshot.entities;
          retrySemanticDigest = snapshot.semanticEvidence.digest;
          retrySnapshotId = snapshot.snapshotId;
        },
      );
      const [retryArtifact] = await stagePrivacyExportArtifacts(fixture.database, {
        artifacts: [{ format: "json", objectKey: "exports/owner/retry.json.enc" }],
        jobId: exportJob.job.id,
        snapshotId: retrySnapshotId,
        userId: fixture.owner.userId,
        workerId: "retry-export-worker",
      });
      if (!retryArtifact) throw new Error("Expected retry artifact");
      await beginPrivacyExportStagedArtifactUpload(fixture.database, {
        artifactId: retryArtifact.id,
        jobId: exportJob.job.id,
        leaseExpiresAt: retentionInstant("08-16T14:25:00Z"),
        snapshotId: retrySnapshotId,
        startedAt: retentionInstant("08-16T14:16:30Z"),
        userId: fixture.owner.userId,
        workerId: "retry-export-worker",
      });
      await renewPrivacyExportStagedArtifactUploadLease(fixture.database, {
        artifactId: retryArtifact.id,
        jobId: exportJob.job.id,
        leaseExpiresAt: retentionInstant("08-16T14:35:00Z"),
        renewedAt: retentionInstant("08-16T14:20:00Z"),
        snapshotId: retrySnapshotId,
        userId: fixture.owner.userId,
        workerId: "retry-export-worker",
      });
      expect(
        await claimPrivacyExportJobs(fixture.database, {
          now: retentionInstant("08-16T14:28:00Z"),
          workerId: "competing-export-worker",
        }),
      ).toEqual([]);
      await markPrivacyExportStagedArtifactUploaded(fixture.database, {
        artifactId: retryArtifact.id,
        jobId: exportJob.job.id,
        snapshotId: retrySnapshotId,
        uploadedAt: retentionInstant("08-16T14:32:00Z"),
        userId: fixture.owner.userId,
        workerId: "retry-export-worker",
      });
      const retryCompletion = {
        artifacts: [
          exportArtifact(
            "json",
            retentionInstant("08-20T00:00:00Z"),
            "exports/owner/retry.json.enc",
          ),
        ],
        jobId: exportJob.job.id,
        manifestDigest: digest("e"),
        reconciliation: {
          entities: retryEntities.map((snapshot) => ({
            entity: snapshot.entity,
            exportedCount: snapshot.sourceCount,
            exportedRecordSetSha256: snapshot.sourceRecordSetSha256,
            sourceCount: snapshot.sourceCount,
            sourceRecordSetSha256: snapshot.sourceRecordSetSha256,
            watermarkRevision: snapshot.watermarkRevision,
          })),
          exportedSemanticDigest: retrySemanticDigest,
          reconciled: true as const,
          snapshotWatermark: retryEntities[0]?.watermarkRevision ?? "0",
          sourceSemanticDigest: retrySemanticDigest,
        },
        snapshotId: retrySnapshotId,
        userId: fixture.owner.userId,
      } as const;
      await expect(
        completePrivacyExportJob(fixture.database, retryCompletion),
      ).rejects.toMatchObject({ code: "EXPORT_NOT_READY" });
      const [cleanup] = await claimCancelledPrivacyExportStagedArtifacts(fixture.database, {
        now: retentionInstant("08-16T14:33:00Z"),
        workerId: "staged-cleaner",
      });
      expect(cleanup).toMatchObject({
        artifactId: abandoned.id,
        objectKey: "exports/owner/stale-attempt.json.enc",
      });
      await completePrivacyExportStagedArtifactDeletion(fixture.database, {
        artifactId: abandoned.id,
        deletedAt: retentionInstant("08-16T14:33:30Z"),
        deletionEvidenceDigest: digest("f"),
        workerId: "staged-cleaner",
      });
      await expect(
        completePrivacyExportJob(fixture.database, retryCompletion),
      ).resolves.toMatchObject({ id: exportJob.job.id, status: "completed" });
    } finally {
      await fixture.close();
    }
  });

  it("serializes one retryable export and rolls oversized coherent snapshots back", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "retention_export_capacity");
    try {
      const sessionTokenHash = digest("1");
      await createSession(fixture.database, {
        expiresAt: retentionInstant("01-01T00:00:00Z", 1),
        tokenHash: sessionTokenHash,
        userId: fixture.owner.userId,
      });
      const inputs = [
        {
          clientOperationId: randomUUID(),
          proofTokenHash: digest("2"),
          requestDigest: digest("3"),
          requestedFormats: ["json"] as const,
          sessionTokenHash,
          userId: fixture.owner.userId,
        },
        {
          clientOperationId: randomUUID(),
          proofTokenHash: digest("4"),
          requestDigest: digest("5"),
          requestedFormats: ["csv"] as const,
          sessionTokenHash,
          userId: fixture.owner.userId,
        },
      ] as const;
      for (const input of inputs)
        await createReauthenticationProof(fixture.database, {
          expectedPasswordHash: fixture.ownerPasswordHash,
          expiresAt: retentionInstant("08-18T00:00:00Z"),
          purpose: "account_export",
          sessionTokenHash,
          tokenHash: input.proofTokenHash,
          userId: fixture.owner.userId,
        });

      const attempts = await Promise.allSettled(
        inputs.map((input) => createPrivacyExportJob(fixture.database, input)),
      );
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      const winnerIndex = attempts.findIndex((attempt) => attempt.status === "fulfilled");
      const winnerAttempt = attempts[winnerIndex];
      const winnerInput = inputs[winnerIndex];
      if (winnerIndex < 0 || winnerAttempt?.status !== "fulfilled" || !winnerInput)
        throw new Error("Expected one export winner");
      expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
        reason: { code: "EXPORT_IN_PROGRESS" },
      });
      expect(await createPrivacyExportJob(fixture.database, winnerInput)).toEqual({
        job: winnerAttempt.value.job,
        replayed: true,
      });
      await expect(
        fixture.database
          .insertInto("privacy_export_job")
          .values({
            client_operation_id: randomUUID(),
            request_digest: digest("6"),
            requested_formats: ["json"],
            user_id: fixture.owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23505" });

      const [claimed] = await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-16T14:00:00Z"),
        workerId: "capacity-worker",
      });
      expect(claimed?.id).toBe(winnerAttempt.value.job.id);
      const { withPrivacyExportSnapshot } = await import("../src/index.js");
      await expect(
        withPrivacyExportSnapshot(
          fixture.database,
          {
            jobId: winnerAttempt.value.job.id,
            maximumSnapshotBytes: 1,
            userId: fixture.owner.userId,
            workerId: "capacity-worker",
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
      expect(
        await fixture.database
          .selectFrom("privacy_export_record")
          .select((builder) => builder.fn.countAll<string>().as("count"))
          .where("job_id", "=", winnerAttempt.value.job.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      expect(
        await fixture.database
          .selectFrom("privacy_export_job")
          .select(["snapshot_id", "snapshot_bytes"])
          .where("id", "=", winnerAttempt.value.job.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ snapshot_bytes: null, snapshot_id: null });
      expect(
        await failPrivacyExportJob(fixture.database, {
          failureKind: "snapshot_too_large",
          jobId: winnerAttempt.value.job.id,
          retryAt: retentionInstant("08-16T14:05:00Z"),
          workerId: "capacity-worker",
        }),
      ).toEqual({ attemptCount: 20, deadLettered: true, retryScheduled: false });
      await requeueDeadLetteredPrivacyExportJob(fixture.database, {
        approvalDigest: digest("7"),
        jobId: winnerAttempt.value.job.id,
        requeuedAt: retentionInstant("08-16T14:05:30Z"),
      });
      const [retried] = await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-16T14:06:00Z"),
        workerId: "capacity-retry-worker",
      });
      expect(retried?.id).toBe(winnerAttempt.value.job.id);
      await expect(
        withPrivacyExportSnapshot(
          fixture.database,
          {
            jobId: winnerAttempt.value.job.id,
            maximumSnapshotBytes: TEST_EXPORT_SNAPSHOT_BYTES,
            userId: fixture.owner.userId,
            workerId: "capacity-retry-worker",
          },
          async (snapshot) => snapshot.entities.length,
        ),
      ).resolves.toBeGreaterThan(0);
    } finally {
      await fixture.close();
    }
  });

  it("dead-letters exhausted retention jobs and requires immutable operator approval to requeue", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "retention_dead_letter");
    try {
      const sessionTokenHash = digest("1");
      await createSession(fixture.database, {
        expiresAt: retentionInstant("01-01T00:00:00Z", 1),
        tokenHash: sessionTokenHash,
        userId: fixture.owner.userId,
      });
      await createReauthenticationProof(fixture.database, {
        expectedPasswordHash: fixture.ownerPasswordHash,
        expiresAt: retentionInstant("08-18T00:00:00Z"),
        purpose: "account_export",
        sessionTokenHash,
        tokenHash: digest("2"),
        userId: fixture.owner.userId,
      });
      const exportMutation = await createPrivacyExportJob(fixture.database, {
        clientOperationId: randomUUID(),
        proofTokenHash: digest("2"),
        requestDigest: digest("3"),
        requestedFormats: ["json"],
        sessionTokenHash,
        userId: fixture.owner.userId,
      });
      const [exportClaim] = await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-17T01:00:00Z"),
        workerId: "dead-letter-worker",
      });
      expect(exportClaim?.id).toBe(exportMutation.job.id);
      await fixture.database
        .updateTable("privacy_export_job")
        .set({ attempt_count: 20 })
        .where("id", "=", exportMutation.job.id)
        .execute();
      expect(
        await failPrivacyExportJob(fixture.database, {
          failureKind: "retryable",
          jobId: exportMutation.job.id,
          retryAt: retentionInstant("08-17T01:10:00Z"),
          workerId: "dead-letter-worker",
        }),
      ).toEqual({ attemptCount: 20, deadLettered: true, retryScheduled: false });
      await expect(
        requeueDeadLetteredPrivacyExportJob(fixture.database, {
          approvalDigest: digest("4"),
          jobId: exportMutation.job.id,
          requeuedAt: retentionInstant("08-17T01:11:00Z"),
        }),
      ).resolves.toMatchObject({ id: exportMutation.job.id, status: "queued" });

      const [crashClaim] = await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-17T01:12:00Z"),
        workerId: "crashed-export-worker",
      });
      expect(crashClaim?.id).toBe(exportMutation.job.id);
      await fixture.database
        .updateTable("privacy_export_job")
        .set({ attempt_count: 20 })
        .where("id", "=", exportMutation.job.id)
        .execute();
      await renewRetentionWorkLease(fixture.database, {
        kind: "privacy_export",
        renewedAt: retentionInstant("08-17T01:13:00Z"),
        targetId: exportMutation.job.id,
        workerId: "crashed-export-worker",
      });
      expect(
        await claimPrivacyExportJobs(fixture.database, {
          now: retentionInstant("08-17T01:20:00Z"),
          workerId: "replacement-export-worker",
        }),
      ).toEqual([]);
      expect(
        await claimPrivacyExportJobs(fixture.database, {
          now: retentionInstant("08-17T01:30:00Z"),
          workerId: "replacement-export-worker",
        }),
      ).toEqual([]);
      await requeueDeadLetteredPrivacyExportJob(fixture.database, {
        approvalDigest: digest("a"),
        jobId: exportMutation.job.id,
        requeuedAt: retentionInstant("08-17T01:31:00Z"),
      });
      const [artifactJobClaim] = await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-17T01:32:00Z"),
        workerId: "artifact-fixture-worker",
      });
      expect(artifactJobClaim?.id).toBe(exportMutation.job.id);
      const cancelledStage = await fixture.database
        .insertInto("privacy_export_upload_artifact")
        .values({
          attempt_count: 20,
          cancelled_at: retentionInstant("08-17T01:33:00Z"),
          format: "csv_zip",
          job_id: exportMutation.job.id,
          object_key: "exports/dead-letter/abandoned.zip.enc",
          locked_at: retentionInstant("08-17T02:00:00Z"),
          locked_by: "crashed-stage-cleaner",
          snapshot_id: "dead-letter-snapshot",
          status: "cancelled",
          worker_id: "artifact-fixture-worker",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const completedArtifact = await fixture.database
        .insertInto("privacy_export_artifact")
        .values({
          ciphertext_bytes: "1",
          encryption_key_id: "test-key",
          expires_at: retentionInstant("08-17T02:00:00Z"),
          file_name: "export.json.enc",
          format: "json",
          job_id: exportMutation.job.id,
          media_type: "application/json",
          object_key: "exports/dead-letter/export.json.enc",
          plaintext_bytes: "1",
          plaintext_sha256: digest("b"),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await fixture.database
        .insertInto("privacy_export_artifact_deletion")
        .values({
          artifact_id: completedArtifact.id,
          attempt_count: 20,
          available_at: retentionInstant("08-17T02:00:00Z"),
          locked_at: retentionInstant("08-17T02:00:00Z"),
          locked_by: "crashed-artifact-cleaner",
          status: "running",
        })
        .execute();
      await fixture.database
        .updateTable("privacy_export_job")
        .set({
          completed_at: retentionInstant("08-17T01:34:00Z"),
          expires_at: retentionInstant("08-17T02:00:00Z"),
          status: "completed",
        })
        .where("id", "=", exportMutation.job.id)
        .execute();
      expect(
        await claimCancelledPrivacyExportStagedArtifacts(fixture.database, {
          now: retentionInstant("08-17T02:01:00Z"),
          workerId: "replacement-stage-cleaner",
        }),
      ).toEqual([]);
      expect(
        await claimExpiredPrivacyExportArtifacts(fixture.database, {
          now: retentionInstant("08-17T02:01:00Z"),
          workerId: "replacement-artifact-cleaner",
        }),
      ).toEqual([]);
      await renewRetentionWorkLease(fixture.database, {
        kind: "staged_artifact_deletion",
        renewedAt: retentionInstant("08-17T02:01:00Z"),
        targetId: cancelledStage.id,
        workerId: "crashed-stage-cleaner",
      });
      await renewRetentionWorkLease(fixture.database, {
        kind: "artifact_deletion",
        renewedAt: retentionInstant("08-17T02:01:00Z"),
        targetId: completedArtifact.id,
        workerId: "crashed-artifact-cleaner",
      });
      expect(
        await claimCancelledPrivacyExportStagedArtifacts(fixture.database, {
          now: retentionInstant("08-17T02:20:00Z"),
          workerId: "replacement-stage-cleaner",
        }),
      ).toEqual([]);
      expect(
        await claimExpiredPrivacyExportArtifacts(fixture.database, {
          now: retentionInstant("08-17T02:20:00Z"),
          workerId: "replacement-artifact-cleaner",
        }),
      ).toEqual([]);
      await requeueDeadLetteredPrivacyExportStagedArtifactDeletion(fixture.database, {
        approvalDigest: digest("c"),
        artifactId: cancelledStage.id,
        requeuedAt: retentionInstant("08-17T02:21:00Z"),
      });
      await requeueDeadLetteredPrivacyExportArtifactDeletion(fixture.database, {
        approvalDigest: digest("d"),
        artifactId: completedArtifact.id,
        requeuedAt: retentionInstant("08-17T02:21:00Z"),
      });

      await createReauthenticationProof(fixture.database, {
        expectedPasswordHash: fixture.ownerPasswordHash,
        expiresAt: retentionInstant("08-18T00:00:00Z"),
        purpose: "account_erasure",
        sessionTokenHash,
        tokenHash: digest("5"),
        userId: fixture.owner.userId,
      });
      const erasure = await requestAccountErasure(fixture.database, {
        clientOperationId: randomUUID(),
        executeAfter: retentionInstant("08-17T02:22:00Z"),
        proofTokenHash: digest("5"),
        requestDigest: digest("6"),
        requestedAt: retentionInstant("08-17T02:21:30Z"),
        restoreLocator: digest("7"),
        sessionTokenHash,
        statusCapabilityExpiresAt: retentionInstant("09-16T00:00:00Z"),
        statusCapabilityHash: digest("8"),
        userId: fixture.owner.userId,
      });
      const [erasureClaim] = await claimAccountErasureJobs(fixture.database, {
        now: retentionInstant("08-17T02:22:00Z"),
        workerId: "dead-letter-worker",
      });
      expect(erasureClaim?.id).toBe(erasure.job.id);
      await fixture.database
        .updateTable("account_erasure_job")
        .set({ attempt_count: 20 })
        .where("id", "=", erasure.job.id)
        .execute();
      expect(
        await failAccountErasureJob(fixture.database, {
          errorCode: "OBJECT_STORE_UNAVAILABLE",
          jobId: erasure.job.id,
          retryAt: retentionInstant("08-17T02:30:00Z"),
          workerId: "dead-letter-worker",
        }),
      ).toEqual({ attemptCount: 20, deadLettered: true, retryScheduled: false });
      const requeuedErasure = await requeueDeadLetteredAccountErasureJob(fixture.database, {
        approvalDigest: digest("9"),
        jobId: erasure.job.id,
        requeuedAt: retentionInstant("08-17T02:31:00Z"),
      });
      expect(requeuedErasure).toMatchObject({
        id: erasure.job.id,
        startedAt: erasureClaim?.startedAt,
        status: "queued",
      });
      const [crashedErasure] = await claimAccountErasureJobs(fixture.database, {
        now: retentionInstant("08-17T02:32:00Z"),
        workerId: "crashed-erasure-worker",
      });
      expect(crashedErasure?.id).toBe(erasure.job.id);
      await fixture.database
        .updateTable("account_erasure_job")
        .set({ attempt_count: 20 })
        .where("id", "=", erasure.job.id)
        .execute();
      await renewRetentionWorkLease(fixture.database, {
        kind: "account_erasure",
        renewedAt: retentionInstant("08-17T02:33:00Z"),
        targetId: erasure.job.id,
        workerId: "crashed-erasure-worker",
      });
      expect(
        await claimAccountErasureJobs(fixture.database, {
          now: retentionInstant("08-17T02:40:00Z"),
          workerId: "replacement-erasure-worker",
        }),
      ).toEqual([]);
      expect(
        await claimAccountErasureJobs(fixture.database, {
          now: retentionInstant("08-17T02:50:00Z"),
          workerId: "replacement-erasure-worker",
        }),
      ).toEqual([]);
      const requeuedAfterCrash = await requeueDeadLetteredAccountErasureJob(fixture.database, {
        approvalDigest: digest("e"),
        jobId: erasure.job.id,
        requeuedAt: retentionInstant("08-17T02:51:00Z"),
      });
      expect(requeuedAfterCrash.startedAt).toBe(erasureClaim?.startedAt);
      expect(
        await fixture.database
          .selectFrom("retention_job_recovery_audit")
          .select((builder) => builder.fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "6" });
      const deadLetters = await claimRetentionDeadLetterEvents(fixture.database, {
        limit: 10,
        now: retentionInstant("08-17T03:00:00Z"),
        workerId: "retention-alert-worker",
      });
      expect(deadLetters.map((event) => event.recoveryKind).sort()).toEqual([
        "account_erasure",
        "artifact_deletion",
        "privacy_export",
        "staged_artifact_deletion",
      ]);
      for (const event of deadLetters)
        await acknowledgeRetentionDeadLetterEvent(fixture.database, {
          acknowledgedAt: retentionInstant("08-17T03:01:00Z"),
          eventId: event.id,
          workerId: "retention-alert-worker",
        });
      await expect(
        fixture.database.deleteFrom("retention_job_recovery_audit").execute(),
      ).rejects.toThrow(/immutable/u);
    } finally {
      await fixture.close();
    }
  });

  it("streams a reconciled export and erases a populated account only after external evidence", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const fixture = await createFixture(databaseUrl, "retention_privacy");
    try {
      const erasureEmailVerificationTokenHash = digest("7");
      await issueEmailVerificationToken(fixture.database, {
        deliver: async () => undefined,
        emailHash: createHash("sha256").update(fixture.owner.email, "utf8").digest("hex"),
        expiresAt: retentionInstant("08-17T13:00:00Z"),
        issuedAt: retentionInstant("08-16T13:00:00Z"),
        tokenHash: erasureEmailVerificationTokenHash,
        userId: fixture.owner.userId,
      });
      const sessionHash = digest("9");
      await createSession(fixture.database, {
        expiresAt: retentionInstant("01-01T00:00:00Z", 1),
        tokenHash: sessionHash,
        userId: fixture.owner.userId,
      });
      await fixture.database
        .insertInto("audit_log")
        .values([
          {
            action: "cross-user-subject-fixture",
            actor_user_id: fixture.other.userId,
            after_state: { secretHealthPayload: "must-not-export" },
            before_state: null,
            context: { internalRequest: "must-not-export" },
            entity_id: fixture.owner.userId,
            entity_type: "user",
            reason: "synthetic",
            request_id: "internal-request",
            sensitivity: "health",
            source_ip: "192.0.2.10",
            subject_user_id: fixture.owner.userId,
            user_agent: "synthetic-agent",
          },
          {
            action: "cross-user-actor-fixture",
            actor_user_id: fixture.owner.userId,
            after_state: null,
            before_state: { otherSubjectPayload: "must-not-export" },
            context: { internalRequest: "must-not-export" },
            entity_id: fixture.other.userId,
            entity_type: "user",
            reason: "synthetic",
            request_id: "internal-request-two",
            sensitivity: "personal",
            source_ip: "192.0.2.11",
            subject_user_id: fixture.other.userId,
            user_agent: "synthetic-agent-two",
          },
        ])
        .execute();
      const exportProof = digest("a");
      await createReauthenticationProof(fixture.database, {
        expectedPasswordHash: fixture.ownerPasswordHash,
        expiresAt: retentionInstant("08-17T00:00:00Z"),
        purpose: "account_export",
        sessionTokenHash: sessionHash,
        tokenHash: exportProof,
        userId: fixture.owner.userId,
      });
      const exportMutation = await createPrivacyExportJob(fixture.database, {
        clientOperationId: randomUUID(),
        proofTokenHash: exportProof,
        requestDigest: digest("b"),
        requestedFormats: ["json", "csv"],
        sessionTokenHash: sessionHash,
        userId: fixture.owner.userId,
      });
      const [claimedExport] = await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-16T14:00:00Z"),
        workerId: "privacy-worker",
      });
      expect(claimedExport).toMatchObject({
        id: exportMutation.job.id,
        userId: fixture.owner.userId,
      });
      let snapshots: readonly PrivacyExportEntitySnapshotRecord[] = [];
      let semanticDigest = "";
      let snapshotId = "";
      const exported: PrivacyExportRecord[] = [];
      await withSnapshot(
        fixture.database,
        fixture.owner.userId,
        exportMutation.job.id,
        async (value) => {
          snapshots = value.entities;
          semanticDigest = value.semanticEvidence.digest;
          snapshotId = value.snapshotId;
          for (const entity of value.entities) {
            let cursor: string | null = null;
            do {
              const page = await value.page({ cursor, entity: entity.entity, limit: 1 });
              exported.push(...page.records);
              cursor = page.nextCursor;
            } while (cursor);
          }
        },
      );
      const audits = exported.filter((record) => record.entityType === "audit_event");
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        expect(audit.payload).not.toHaveProperty("actor_user_id");
        expect(audit.payload).not.toHaveProperty("subject_user_id");
        expect(audit.payload).not.toHaveProperty("context");
      }
      expect(exported).toHaveLength(
        snapshots.reduce((sum, snapshot) => sum + Number(snapshot.sourceCount), 0),
      );
      const expiry = retentionInstant("08-18T00:00:00Z");
      const completionInput = {
        artifacts: [
          exportArtifact("json", expiry, "exports/owner/export.json.enc"),
          exportArtifact("csv", expiry, "exports/owner/export.zip.enc"),
        ],
        jobId: exportMutation.job.id,
        manifestDigest: digest("c"),
        snapshotId,
        reconciliation: {
          entities: snapshots.map((snapshot) => ({
            entity: snapshot.entity,
            exportedCount: snapshot.sourceCount,
            sourceCount: snapshot.sourceCount,
            exportedRecordSetSha256: snapshot.sourceRecordSetSha256,
            sourceRecordSetSha256: snapshot.sourceRecordSetSha256,
            watermarkRevision: snapshot.watermarkRevision,
          })),
          reconciled: true,
          snapshotWatermark: snapshots[0]?.watermarkRevision ?? "0",
          sourceSemanticDigest: semanticDigest,
          exportedSemanticDigest: semanticDigest,
        },
        userId: fixture.owner.userId,
      } as const;
      const staged = await stagePrivacyExportArtifacts(fixture.database, {
        artifacts: completionInput.artifacts.map((artifact) => ({
          format: artifact.format,
          objectKey: artifact.objectKey,
        })),
        jobId: exportMutation.job.id,
        snapshotId,
        userId: fixture.owner.userId,
        workerId: "privacy-worker",
      });
      for (const artifact of staged) {
        await beginPrivacyExportStagedArtifactUpload(fixture.database, {
          artifactId: artifact.id,
          jobId: exportMutation.job.id,
          leaseExpiresAt: retentionInstant("08-16T14:10:00Z"),
          snapshotId,
          startedAt: retentionInstant("08-16T14:04:00Z"),
          userId: fixture.owner.userId,
          workerId: "privacy-worker",
        });
        await markPrivacyExportStagedArtifactUploaded(fixture.database, {
          artifactId: artifact.id,
          jobId: exportMutation.job.id,
          snapshotId,
          uploadedAt: retentionInstant("08-16T14:05:00Z"),
          userId: fixture.owner.userId,
          workerId: "privacy-worker",
        });
      }
      await expect(
        completePrivacyExportJob(fixture.database, {
          ...completionInput,
          artifacts: [
            completionInput.artifacts[0],
            exportArtifact(
              "csv",
              retentionInstant("09-18T00:00:00Z"),
              "exports/owner/export.zip.enc",
            ),
          ],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        completePrivacyExportJob(fixture.database, {
          ...completionInput,
          reconciliation: {
            ...completionInput.reconciliation,
            exportedSemanticDigest: digest("0"),
          },
        }),
      ).rejects.toMatchObject({ code: "EXPORT_NOT_READY" });
      const completedExport = await completePrivacyExportJob(fixture.database, completionInput);
      expect(completedExport.artifacts.map((artifact) => artifact.format).sort()).toEqual([
        "csv",
        "json",
      ]);
      expect(
        await fixture.database
          .selectFrom("privacy_export_record")
          .select((builder) => builder.fn.countAll<string>().as("count"))
          .where("job_id", "=", completedExport.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      expect(
        await fixture.database
          .selectFrom("privacy_export_entity_snapshot")
          .select((builder) => builder.fn.countAll<string>().as("count"))
          .where("job_id", "=", completedExport.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      await recordPrivacyExportArtifactDownloadAudit(fixture.database, {
        format: "json",
        jobId: completedExport.id,
        occurredAt: retentionInstant("08-16T14:06:00Z"),
        outcome: "opened",
        userId: fixture.owner.userId,
      });
      const expired = await claimExpiredPrivacyExportArtifacts(fixture.database, {
        now: retentionInstant("08-19T00:00:00Z"),
        workerId: "artifact-cleaner",
      });
      expect(expired).toHaveLength(2);
      for (const artifact of expired.filter((candidate) => candidate.format === "json"))
        await completePrivacyExportArtifactDeletion(fixture.database, {
          artifactId: artifact.artifactId,
          deletedAt: retentionInstant("08-19T00:01:00Z"),
          deletionEvidenceDigest: digest("d"),
          workerId: "artifact-cleaner",
        });
      expect(
        (
          await getPrivacyExportJob(fixture.database, {
            jobId: completedExport.id,
            userId: fixture.owner.userId,
          })
        ).artifacts.map((artifact) => artifact.format),
      ).toEqual(["csv"]);
      expect(
        await fixture.database
          .selectFrom("privacy_export_artifact_tombstone")
          .select((builder) => builder.fn.countAll<string>().as("count"))
          .where("job_id", "=", completedExport.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "1" });

      const crashedExportProof = digest("6");
      await createReauthenticationProof(fixture.database, {
        expectedPasswordHash: fixture.ownerPasswordHash,
        expiresAt: retentionInstant("08-17T00:00:00Z"),
        purpose: "account_export",
        sessionTokenHash: sessionHash,
        tokenHash: crashedExportProof,
        userId: fixture.owner.userId,
      });
      const crashedExport = await createPrivacyExportJob(fixture.database, {
        clientOperationId: randomUUID(),
        proofTokenHash: crashedExportProof,
        requestDigest: digest("7"),
        requestedFormats: ["json", "csv"],
        sessionTokenHash: sessionHash,
        userId: fixture.owner.userId,
      });
      await claimPrivacyExportJobs(fixture.database, {
        now: retentionInstant("08-19T00:02:00Z"),
        workerId: "privacy-worker",
      });
      let crashedSnapshotId = "";
      await withSnapshot(
        fixture.database,
        fixture.owner.userId,
        crashedExport.job.id,
        async (snapshot) => {
          crashedSnapshotId = snapshot.snapshotId;
          // The callback runs after the coherent DB spool committed. A normal writer therefore
          // does not wait on external spool/upload work.
          await updateUserProfile(fixture.database, {
            expectedRevision: fixture.owner.revision,
            patch: { displayName: "Writer was not blocked by export upload" },
            userId: fixture.owner.userId,
          });
        },
      );
      const crashedStages = await stagePrivacyExportArtifacts(fixture.database, {
        artifacts: [
          { format: "json", objectKey: "exports/owner/slow-put.json.enc" },
          { format: "csv", objectKey: "exports/owner/crashed-put.zip.enc" },
        ],
        jobId: crashedExport.job.id,
        snapshotId: crashedSnapshotId,
        userId: fixture.owner.userId,
        workerId: "privacy-worker",
      });
      expect(crashedStages).toHaveLength(2);
      for (const artifact of crashedStages)
        await beginPrivacyExportStagedArtifactUpload(fixture.database, {
          artifactId: artifact.id,
          jobId: crashedExport.job.id,
          leaseExpiresAt: retentionInstant("08-19T00:12:30Z"),
          snapshotId: crashedSnapshotId,
          startedAt: retentionInstant("08-19T00:02:30Z"),
          userId: fixture.owner.userId,
          workerId: "privacy-worker",
        });
      const slowPutArtifact = crashedStages.find((artifact) => artifact.format === "json");
      if (!slowPutArtifact) throw new Error("Expected staged slow-PUT artifact");

      const erasureProof = digest("e");
      await createReauthenticationProof(fixture.database, {
        expectedPasswordHash: fixture.ownerPasswordHash,
        expiresAt: retentionInstant("08-20T00:00:00Z"),
        purpose: "account_erasure",
        sessionTokenHash: sessionHash,
        tokenHash: erasureProof,
        userId: fixture.owner.userId,
      });
      const erasureInput = {
        clientOperationId: randomUUID(),
        executeAfter: retentionInstant("08-19T00:02:50Z"),
        proofTokenHash: erasureProof,
        requestDigest: digest("f"),
        requestedAt: retentionInstant("08-19T00:02:40Z"),
        restoreLocator: digest("1"),
        sessionTokenHash: sessionHash,
        statusCapabilityExpiresAt: retentionInstant("09-19T00:00:00Z"),
        statusCapabilityHash: digest("2"),
        userId: fixture.owner.userId,
      } as const;
      const queued = await requestAccountErasure(fixture.database, erasureInput);
      expect(await requestAccountErasure(fixture.database, erasureInput)).toEqual({
        job: queued.job,
        replayed: true,
      });
      expect(
        await findPendingErasureRecoverySessionByTokenHash(fixture.database, {
          now: retentionInstant("08-19T00:02:45Z"),
          tokenHash: sessionHash,
        }),
      ).toMatchObject({ erasureJobId: queued.job.id, userId: fixture.owner.userId });
      const [claimedErasure] = await claimAccountErasureJobs(fixture.database, {
        now: retentionInstant("08-19T00:02:51Z"),
        workerId: "erasure-worker",
      });
      if (!claimedErasure) throw new Error("Expected erasure job claim");
      expect(claimedErasure.restoreLocator).toBe(digest("1"));
      await fixture.database
        .insertInto("retention_job_recovery_audit")
        .values({
          approval_digest: digest("6"),
          attempt_count_before: 20,
          reason_code: "operator_requeue",
          recovery_kind: "account_erasure",
          requeued_at: retentionInstant("08-19T00:02:51Z"),
          target_id: claimedErasure.id,
        })
        .execute();
      await fixture.database
        .insertInto("retention_dead_letter_event")
        .values({
          attempt_count: 20,
          occurred_at: retentionInstant("08-19T00:02:51Z"),
          recovery_kind: "account_erasure",
          target_id: claimedErasure.id,
        })
        .execute();
      const initialErasureArtifacts = await listAccountPrivacyExportArtifactsForErasure(
        fixture.database,
        {
          erasureJobId: claimedErasure.id,
          now: retentionInstant("08-19T00:03:00Z"),
          userId: fixture.owner.userId,
          workerId: "erasure-worker",
        },
      );
      expect(initialErasureArtifacts.map((artifact) => artifact.source).sort()).toEqual([
        "completed",
      ]);
      await expect(
        executeAccountErasureJob(fixture.database, {
          completedAt: retentionInstant("08-19T00:03:20Z"),
          evidence: {
            objectDeletionEvidence: {
              artifacts: initialErasureArtifacts.map((artifact) => ({
                artifactId: artifact.artifactId,
                deletionEvidenceDigest: digest("3"),
                objectKey: artifact.objectKey,
              })),
            },
            restoreLedgerAcknowledgedAt: retentionInstant("08-19T00:03:10Z"),
            restoreLedgerDigest: digest("4"),
            restoreLedgerReference: "external-ledger-entry-1",
          },
          jobId: claimedErasure.id,
          workerId: "erasure-worker",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        markPrivacyExportStagedArtifactUploaded(fixture.database, {
          artifactId: slowPutArtifact.id,
          jobId: crashedExport.job.id,
          snapshotId: crashedSnapshotId,
          uploadedAt: retentionInstant("08-19T00:03:30Z"),
          userId: fixture.owner.userId,
          workerId: "privacy-worker",
        }),
      ).rejects.toMatchObject({ code: "EXPORT_NOT_READY" });
      const erasureArtifacts = await listAccountPrivacyExportArtifactsForErasure(fixture.database, {
        erasureJobId: claimedErasure.id,
        now: retentionInstant("08-19T00:12:31Z"),
        userId: fixture.owner.userId,
        workerId: "erasure-worker",
      });
      expect(erasureArtifacts.map((artifact) => artifact.source).sort()).toEqual([
        "completed",
        "staged",
        "staged",
      ]);
      for (const artifact of erasureArtifacts.filter((artifact) => artifact.source === "staged"))
        await completePrivacyExportStagedArtifactDeletion(fixture.database, {
          artifactId: artifact.artifactId,
          deletedAt: retentionInstant("08-19T00:13:00Z"),
          deletionEvidenceDigest: digest("8"),
          workerId: "erasure-worker",
        });
      const finalErasureInput = {
        completedAt: retentionInstant("08-19T00:14:00Z"),
        evidence: {
          objectDeletionEvidence: {
            artifacts: erasureArtifacts
              .filter((artifact) => artifact.source === "completed")
              .map((artifact) => ({
                artifactId: artifact.artifactId,
                deletionEvidenceDigest: digest("3"),
                objectKey: artifact.objectKey,
              })),
          },
          restoreLedgerAcknowledgedAt: retentionInstant("08-19T00:13:30Z"),
          restoreLedgerDigest: digest("4"),
          restoreLedgerReference: "external-ledger-entry-1",
        },
        jobId: claimedErasure.id,
        workerId: "erasure-worker",
      } as const;
      await sql`
        create table erasure_unclassified_fixture (
          id uuid primary key default gen_random_uuid(),
          user_id uuid references app_user(id) on delete set null,
          payload text not null
        )
      `.execute(fixture.database);
      await sql`
        insert into erasure_unclassified_fixture (user_id, payload)
        values (${fixture.owner.userId}::uuid, 'must not survive erasure')
      `.execute(fixture.database);
      await expect(executeAccountErasureJob(fixture.database, finalErasureInput)).rejects.toThrow(
        "Account-erasure schema inventory is not current",
      );
      expect(
        await fixture.database
          .selectFrom("app_user")
          .select("id")
          .where("id", "=", fixture.owner.userId)
          .executeTakeFirst(),
      ).toEqual({ id: fixture.owner.userId });
      expect(
        await sql<{ payload: string; user_id: string }>`
          select payload, user_id::text
          from erasure_unclassified_fixture
        `.execute(fixture.database),
      ).toMatchObject({
        rows: [{ payload: "must not survive erasure", user_id: fixture.owner.userId }],
      });
      await sql`drop table erasure_unclassified_fixture`.execute(fixture.database);
      // Classification and deletion policy are independent gates. Even a table already in the
      // closed export inventory must fail erasure if its ownership action drifts away from the
      // reviewed cascade/explicit-delete policy. The unrelated nullable cascade deliberately
      // proves that merely finding some CASCADE edge is not sufficient.
      await sql`
        alter table user_profile drop constraint user_profile_user_id_fkey;
        alter table user_profile
          add constraint user_profile_user_id_fkey
          foreign key (user_id) references app_user(id) on delete set null;
        alter table user_profile add column erasure_fixture_device_id uuid;
        alter table user_profile
          add constraint user_profile_erasure_fixture_device_fkey
          foreign key (erasure_fixture_device_id) references device_registration(id) on delete cascade
      `.execute(fixture.database);
      await expect(executeAccountErasureJob(fixture.database, finalErasureInput)).rejects.toThrow(
        "Account-erasure schema inventory is not current",
      );
      expect(
        await fixture.database
          .selectFrom("app_user")
          .select("id")
          .where("id", "=", fixture.owner.userId)
          .executeTakeFirst(),
      ).toEqual({ id: fixture.owner.userId });
      await sql`
        alter table user_profile drop constraint user_profile_erasure_fixture_device_fkey;
        alter table user_profile drop column erasure_fixture_device_id;
        alter table user_profile drop constraint user_profile_user_id_fkey;
        alter table user_profile
          add constraint user_profile_user_id_fkey
          foreign key (user_id) references app_user(id) on delete cascade
      `.execute(fixture.database);
      const receipt = await executeAccountErasureJob(fixture.database, finalErasureInput);
      expect(receipt.deletedCounts).toMatchObject({
        app_user: "1",
        auth_action_token: "1",
        retention_dead_letter_event: "1",
        retention_job_recovery_audit: "1",
      });
      expect(
        await fixture.database
          .selectFrom("auth_action_token")
          .select("id")
          .where("token_hash", "=", erasureEmailVerificationTokenHash)
          .executeTakeFirst(),
      ).toBeUndefined();
      const retained = await fixture.database
        .selectFrom("account_erasure_job")
        .selectAll()
        .where("id", "=", claimedErasure.id)
        .executeTakeFirstOrThrow();
      expect(retained).toMatchObject({
        client_operation_id: null,
        object_deletion_evidence: null,
        recovery_session_token_hash: null,
        request_digest: null,
        restore_ledger_digest: null,
        restore_ledger_reference: null,
        restore_locator: null,
        status: "completed",
        user_id: null,
      });
      expect(
        await fixture.database
          .selectFrom("retention_job_recovery_audit")
          .select("id")
          .where("target_id", "=", claimedErasure.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await fixture.database
          .selectFrom("retention_dead_letter_event")
          .select("id")
          .where("target_id", "=", claimedErasure.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      const restoreSessionHash = digest("b");
      const restoreProofHash = digest("c");
      await createSession(fixture.database, {
        expiresAt: retentionInstant("01-01T00:00:00Z", 1),
        tokenHash: restoreSessionHash,
        userId: fixture.other.userId,
      });
      await createReauthenticationProof(fixture.database, {
        expectedPasswordHash: fixture.otherPasswordHash,
        expiresAt: retentionInstant("08-21T00:00:00Z"),
        purpose: "account_erasure",
        sessionTokenHash: restoreSessionHash,
        tokenHash: restoreProofHash,
        userId: fixture.other.userId,
      });
      const restoreWindowJob = await requestAccountErasure(fixture.database, {
        clientOperationId: randomUUID(),
        executeAfter: retentionInstant("08-20T01:00:00Z"),
        proofTokenHash: restoreProofHash,
        requestDigest: digest("d"),
        requestedAt: retentionInstant("08-20T00:30:00Z"),
        restoreLocator: digest("e"),
        sessionTokenHash: restoreSessionHash,
        statusCapabilityExpiresAt: retentionInstant("09-20T00:00:00Z"),
        statusCapabilityHash: digest("f"),
        userId: fixture.other.userId,
      });
      const reconciliation = await replayExternalErasureLedgerEntry(fixture.database, {
        ackDigest: digest("5"),
        ledgerEntryId: "external-ledger-replay-other",
        recordedAt: retentionInstant("08-20T01:30:00Z"),
        subjectUserId: fixture.other.userId,
      });
      expect(reconciliation.reconciled).toBe(true);
      expect(
        await fixture.database
          .selectFrom("account_erasure_job")
          .select("id")
          .where("id", "=", restoreWindowJob.job.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      const restoreEpoch = "restored-backup-ledger-replay-epoch-0003";
      await expect(
        assertDatabaseRestoreReplayReady(fixture.database, { restoreEpoch }),
      ).rejects.toThrow("Database restore replay attestation is not current");
      await completeDatabaseRestoreReplayAttestation(fixture.database, {
        completedAt: retentionInstant("08-20T02:00:00Z"),
        reconciliationDigest: digest("a"),
        replayedSubjectCount: 1,
        restoreEpoch,
      });
      await expect(
        assertDatabaseRestoreReplayReady(fixture.database, { restoreEpoch }),
      ).resolves.toBeUndefined();
      expect(
        await fixture.database
          .selectFrom("app_user")
          .select("id")
          .where("id", "in", [fixture.owner.userId, fixture.other.userId])
          .execute(),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

async function withSnapshot<T>(
  database: ReturnType<typeof createDatabase>,
  userId: string,
  jobId: string,
  callback: Parameters<typeof import("../src/index.js").withPrivacyExportSnapshot<T>>[2],
): Promise<T> {
  const { withPrivacyExportSnapshot } = await import("../src/index.js");
  return withPrivacyExportSnapshot(
    database,
    {
      jobId,
      maximumSnapshotBytes: TEST_EXPORT_SNAPSHOT_BYTES,
      userId,
      workerId: "privacy-worker",
    },
    callback,
  );
}

function customDraft(energyId: string, proteinId: string, label: string) {
  return {
    brandName: "Owner brand",
    name: `${label} custom food`,
    notes: `${label} notes`,
    nutrients: [
      { amountPer100Grams: "200", nutrientId: energyId, state: "quantified" as const },
      {
        amountPer100Grams: null,
        nutrientId: proteinId,
        reason: "not_analyzed" as const,
        state: "unknown" as const,
      },
    ],
    serving: { grams: "50", label: "owner serving" },
  };
}

function exportArtifact(format: "csv" | "json", expiresAt: string, objectKey: string) {
  return {
    ciphertextBytes: "120",
    encryptionKeyId: "key-1",
    expiresAt,
    fileName: format === "json" ? "nutrition-export.json" : "nutrition-export.zip",
    format,
    mediaType: format === "json" ? ("application/json" as const) : ("application/zip" as const),
    objectKey,
    plaintextBytes: "100",
    plaintextSha256: digest(format === "json" ? "6" : "7"),
  };
}

async function createFixture(databaseUrl: string, label: string) {
  const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  const schemaName = `${label}_${randomBytes(6).toString("hex")}`;
  await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
  const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 12 });
  await runMigrations(database);
  const nutrients = await seedNutrients(database);
  const ownerInput = accountInput(`${label}-owner`);
  const otherInput = accountInput(`${label}-other`);
  const owner = await registerPasswordAccount(database, ownerInput);
  const other = await registerPasswordAccount(database, otherInput);
  return {
    close: async () => {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    },
    database,
    nutrients,
    other,
    otherPasswordHash: otherInput.passwordHash,
    owner,
    ownerPasswordHash: ownerInput.passwordHash,
  };
}

async function seedNutrients(database: ReturnType<typeof createDatabase>) {
  const energy = await database
    .insertInto("nutrient")
    .values({
      canonical_unit: "kcal",
      code: "energy",
      dimension: "energy",
      is_targetable: false,
      name: "Energy",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const protein = await database
    .insertInto("nutrient")
    .values({
      canonical_unit: "g",
      code: "protein",
      dimension: "mass",
      is_targetable: true,
      name: "Protein",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { energyId: energy.id, proteinId: protein.id };
}

function accountInput(label: string) {
  return {
    email: `${label}-${randomUUID()}@example.invalid`,
    passwordHash: `$argon2id$${label}-hash`,
    passwordParameters: { algorithm: "argon2id" },
    passwordSalt: `${label}-salt-value`,
    timeZone: "America/Chicago",
  };
}
