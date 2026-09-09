import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  ActivityEntryRevisionConflictError,
  ActivityIdempotencyConflictError,
  ActivityNotFoundError,
  ActivityTimeZoneChangedError,
  ActivityValidationError,
  createActivityEntry,
  createDatabase,
  deleteActivityEntry,
  getActivityDay,
  registerPasswordAccount,
  runMigrations,
  updateActivityEntry,
  updateUserProfile,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const digest = () => randomBytes(32).toString("hex");

describeDatabase("owner-scoped immutable manual activity ledger", { timeout: 30_000 }, () => {
  it("enforces replay, revisions, owner privacy, local-day moves, bounds, and erasure", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `activity_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 8 });

    try {
      await runMigrations(database);
      const owner = await registerPasswordAccount(database, {
        email: `activity-owner-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$activity-owner-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "activity-owner-fixture-salt",
        timeZone: "America/Chicago",
      });
      const other = await registerPasswordAccount(database, {
        email: `activity-other-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$activity-other-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "activity-other-fixture-salt",
        timeZone: "America/Chicago",
      });
      const ownerWatermark = async (): Promise<bigint> =>
        BigInt(
          (
            await database
              .selectFrom("user_data_watermark")
              .select("revision")
              .where("user_id", "=", owner.userId)
              .executeTakeFirstOrThrow()
          ).revision,
        );
      const goalCounts = async () =>
        Promise.all(
          (
            [
              "nutrition_goal",
              "nutrition_goal_version",
              "nutrition_goal_target",
              "nutrition_goal_operation",
            ] as const
          ).map(async (table) => {
            const row = await database
              .selectFrom(table)
              .select(({ fn }) => fn.countAll<string>().as("count"))
              .executeTakeFirstOrThrow();
            return [table, row.count] as const;
          }),
        );
      const activityPolicyBefore = await database
        .selectFrom("user_profile")
        .select("activity_level_code")
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      const goalsBefore = await goalCounts();

      const createOperationId = randomUUID();
      const createInput = {
        clientOperationId: createOperationId,
        durationMinutes: 45,
        expectedProfileTimeZone: "America/Chicago",
        name: "  Cafe\u0301   walk  ",
        occurredAt: "2026-08-15T01:30:00Z",
        requestDigest: digest(),
        selfReportedEnergyKilocalories: "123.125",
        userId: owner.userId,
      };
      const watermarkBeforeCreate = await ownerWatermark();
      const created = await createActivityEntry(database, createInput);
      expect(created).toMatchObject({
        days: [{ localDate: "2026-08-14", revision: "1" }],
        entry: {
          durationMinutes: 45,
          localDate: "2026-08-14",
          localTime: "20:30:00",
          name: "Café walk",
          revision: "1",
          selfReportedEnergyKilocalories: "123.125",
          timeZone: "America/Chicago",
        },
        replayed: false,
      });
      const watermarkAfterCreate = await ownerWatermark();
      expect(watermarkAfterCreate).toBe(watermarkBeforeCreate + 1n);
      expect(await createActivityEntry(database, createInput)).toMatchObject({
        entry: { id: created.entry?.id },
        replayed: true,
      });
      expect(await ownerWatermark()).toBe(watermarkAfterCreate);
      await expect(
        createActivityEntry(database, { ...createInput, requestDigest: digest() }),
      ).rejects.toBeInstanceOf(ActivityIdempotencyConflictError);
      await expect(
        createActivityEntry(database, {
          ...createInput,
          clientOperationId: randomUUID(),
          expectedProfileTimeZone: "Asia/Tokyo",
          requestDigest: digest(),
        }),
      ).rejects.toBeInstanceOf(ActivityTimeZoneChangedError);

      const entryId = created.entry?.id;
      if (!entryId) throw new Error("Activity fixture was not created");
      await expect(
        updateActivityEntry(database, {
          clientOperationId: randomUUID(),
          durationMinutes: 60,
          entryId,
          expectedEntryRevision: "1",
          requestDigest: digest(),
          userId: other.userId,
        }),
      ).rejects.toBeInstanceOf(ActivityNotFoundError);
      expect(
        await getActivityDay(database, { localDate: "2026-08-14", userId: other.userId }),
      ).toMatchObject({ entries: [], revision: "0", totalDurationMinutes: 0 });

      const updateInput = {
        clientOperationId: randomUUID(),
        durationMinutes: 60,
        entryId,
        expectedEntryRevision: "1",
        name: "Brisk walk",
        requestDigest: digest(),
        selfReportedEnergyKilocalories: null,
        userId: owner.userId,
      };
      const updated = await updateActivityEntry(database, updateInput);
      expect(updated).toMatchObject({
        days: [{ localDate: "2026-08-14", revision: "2" }],
        entry: {
          durationMinutes: 60,
          name: "Brisk walk",
          revision: "2",
          selfReportedEnergyKilocalories: null,
          timeZone: "America/Chicago",
        },
        replayed: false,
      });
      expect(await updateActivityEntry(database, updateInput)).toMatchObject({ replayed: true });
      await expect(
        updateActivityEntry(database, {
          ...updateInput,
          clientOperationId: randomUUID(),
          expectedEntryRevision: "1",
          requestDigest: digest(),
        }),
      ).rejects.toBeInstanceOf(ActivityEntryRevisionConflictError);
      const oldDay = await getActivityDay(database, {
        localDate: "2026-08-14",
        userId: owner.userId,
      });
      expect(oldDay).toMatchObject({ revision: "2", totalDurationMinutes: 60 });
      expect(oldDay).not.toHaveProperty("totalEnergyKilocalories");

      await expect(
        updateActivityEntry(database, {
          clientOperationId: randomUUID(),
          durationMinutes: 61,
          entryId,
          expectedEntryRevision: "2",
          expectedProfileTimeZone: "America/Chicago",
          requestDigest: digest(),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(ActivityValidationError);
      await updateUserProfile(database, {
        expectedRevision: "0",
        patch: { timeZone: "Asia/Tokyo" },
        userId: owner.userId,
      });
      const operationsBeforeGuard = await database
        .selectFrom("activity_operation")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      const revisionsBeforeGuard = await database
        .selectFrom("activity_entry_revision")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      const watermarkBeforeGuard = await ownerWatermark();
      await expect(
        updateActivityEntry(database, {
          clientOperationId: randomUUID(),
          entryId,
          expectedEntryRevision: "2",
          expectedProfileTimeZone: "America/Chicago",
          occurredAt: "2026-08-15T01:30:00Z",
          requestDigest: digest(),
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(ActivityTimeZoneChangedError);
      expect(await ownerWatermark()).toBe(watermarkBeforeGuard);
      expect(
        await database
          .selectFrom("activity_operation")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(operationsBeforeGuard);
      expect(
        await database
          .selectFrom("activity_entry_revision")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(revisionsBeforeGuard);

      const moveInput = {
        clientOperationId: randomUUID(),
        entryId,
        expectedEntryRevision: "2",
        expectedProfileTimeZone: "Asia/Tokyo",
        occurredAt: "2026-08-15T01:30:00Z",
        requestDigest: digest(),
        userId: owner.userId,
      };
      const moved = await updateActivityEntry(database, moveInput);
      expect(moved).toMatchObject({
        days: [
          { localDate: "2026-08-14", revision: "3" },
          { localDate: "2026-08-15", revision: "1" },
        ],
        entry: {
          localDate: "2026-08-15",
          localTime: "10:30:00",
          revision: "3",
          timeZone: "Asia/Tokyo",
        },
      });
      expect(
        await getActivityDay(database, { localDate: "2026-08-15", userId: owner.userId }),
      ).toMatchObject({ revision: "1", totalDurationMinutes: 60 });

      const deleteInput = {
        clientOperationId: randomUUID(),
        entryId,
        expectedEntryRevision: "3",
        requestDigest: digest(),
        userId: owner.userId,
      };
      expect(await deleteActivityEntry(database, deleteInput)).toMatchObject({
        days: [{ localDate: "2026-08-15", revision: "2" }],
        entry: null,
        replayed: false,
      });
      expect(await deleteActivityEntry(database, deleteInput)).toMatchObject({
        entry: null,
        replayed: true,
      });
      expect(
        await database
          .selectFrom("activity_entry_revision")
          .select([
            "operation",
            "revision_number",
            "self_reported_energy_kilocalories",
            "time_zone",
          ])
          .where("activity_entry_id", "=", entryId)
          .orderBy("revision_number")
          .execute(),
      ).toEqual([
        {
          operation: "create",
          revision_number: "1",
          self_reported_energy_kilocalories: "123.125",
          time_zone: "America/Chicago",
        },
        {
          operation: "update",
          revision_number: "2",
          self_reported_energy_kilocalories: null,
          time_zone: "America/Chicago",
        },
        {
          operation: "update",
          revision_number: "3",
          self_reported_energy_kilocalories: null,
          time_zone: "Asia/Tokyo",
        },
        {
          operation: "delete",
          revision_number: "4",
          self_reported_energy_kilocalories: null,
          time_zone: "Asia/Tokyo",
        },
      ]);
      await expect(
        database
          .updateTable("activity_entry_revision")
          .set({ duration_minutes: 1 })
          .where("activity_entry_id", "=", entryId)
          .where("revision_number", "=", "1")
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });

      const rawDay = await database
        .insertInto("activity_day")
        .values({ local_date: "2026-08-20", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      const rawEntry = (overrides: Record<string, unknown>) => ({
        activity_day_id: rawDay.id,
        current_revision_id: randomUUID(),
        current_revision_number: "1",
        duration_minutes: 1,
        id: randomUUID(),
        local_time: "00:00:00",
        name: "Valid name",
        occurred_at: "2026-08-20T00:00:00Z",
        self_reported_energy_kilocalories: null,
        user_id: owner.userId,
        ...overrides,
      });
      await expect(
        database
          .insertInto("activity_entry")
          .values(rawEntry({ self_reported_energy_kilocalories: sql`'1.200'::numeric` }) as never)
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("activity_entry")
          .values(rawEntry({ name: "Cafe\u0301 walk" }) as never)
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("activity_entry")
          .values(rawEntry({ duration_minutes: 0 }) as never)
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });

      const boundedOwner = await registerPasswordAccount(database, {
        email: `activity-bounds-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$activity-bounds-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "activity-bounds-fixture-salt",
        timeZone: "UTC",
      });
      for (let index = 0; index < 64; index += 1) {
        await createActivityEntry(database, {
          clientOperationId: randomUUID(),
          durationMinutes: 1,
          name: `Bounded activity ${index + 1}`,
          occurredAt: "2026-09-01T12:00:00Z",
          requestDigest: digest(),
          selfReportedEnergyKilocalories: null,
          userId: boundedOwner.userId,
        });
      }
      await expect(
        createActivityEntry(database, {
          clientOperationId: randomUUID(),
          durationMinutes: 1,
          name: "One too many",
          occurredAt: "2026-09-01T12:00:00Z",
          requestDigest: digest(),
          selfReportedEnergyKilocalories: null,
          userId: boundedOwner.userId,
        }),
      ).rejects.toBeInstanceOf(ActivityValidationError);
      await database.deleteFrom("app_user").where("id", "=", boundedOwner.userId).execute();
      for (const table of [
        "activity_day",
        "activity_entry",
        "activity_entry_revision",
        "activity_operation",
      ] as const) {
        expect(
          await database
            .selectFrom(table)
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", boundedOwner.userId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ count: "0" });
      }

      expect(await goalCounts()).toEqual(goalsBefore);
      expect(
        await database
          .selectFrom("user_profile")
          .select("activity_level_code")
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(activityPolicyBefore);
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });

  it("pins every activity helper to the attested schema under a hostile ambient search path", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `activity_path_${token}`;
    const hostileSchemaName = `activity_hostile_${token}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    await sql`create schema ${sql.id(hostileSchemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    let hostileDatabase: ReturnType<typeof createDatabase> | undefined;

    try {
      await runMigrations(database);
      const functionNames = [
        "enforce_activity_day_bounds",
        "guard_activity_day_delete",
        "guard_activity_day_update",
        "guard_activity_entry_delete",
        "guard_activity_entry_revision_delete",
        "guard_activity_entry_update",
        "guard_activity_operation_delete",
        "is_bounded_activity_energy_v1",
        "is_canonical_activity_name_v1",
        "validate_activity_entry_head",
        "validate_activity_revision_becomes_head",
        "validate_activity_revision_insert",
      ];
      const functionConfigurations = (
        await sql<{ name: string; proconfig: string[] | null }>`
          select procedure_row.proname as name, procedure_row.proconfig
          from pg_catalog.pg_proc as procedure_row
          join pg_catalog.pg_namespace as namespace_row
            on namespace_row.oid = procedure_row.pronamespace
          where namespace_row.nspname = ${schemaName}
            and procedure_row.proname in (
              'enforce_activity_day_bounds',
              'guard_activity_day_delete',
              'guard_activity_day_update',
              'guard_activity_entry_delete',
              'guard_activity_entry_revision_delete',
              'guard_activity_entry_update',
              'guard_activity_operation_delete',
              'is_bounded_activity_energy_v1',
              'is_canonical_activity_name_v1',
              'validate_activity_entry_head',
              'validate_activity_revision_becomes_head',
              'validate_activity_revision_insert'
            )
          order by procedure_row.proname
        `.execute(database)
      ).rows;
      expect(functionConfigurations.map((row) => row.name)).toEqual(functionNames);
      expect(
        functionConfigurations.every(
          (row) =>
            row.proconfig?.length === 1 &&
            row.proconfig[0] === `search_path=pg_catalog, ${schemaName}, pg_temp`,
        ),
      ).toBe(true);

      await sql`
        create table ${sql.id(hostileSchemaName, "activity_day")} (
          id uuid, user_id uuid, local_date date
        )
      `.execute(bootstrap);
      await sql`
        create table ${sql.id(hostileSchemaName, "activity_entry")} (
          id uuid, user_id uuid, activity_day_id uuid, deleted_at timestamptz
        )
      `.execute(bootstrap);
      await sql`
        create table ${sql.id(hostileSchemaName, "activity_entry_revision")} (
          id uuid, activity_entry_id uuid, revision_number bigint
        )
      `.execute(bootstrap);

      const owner = await registerPasswordAccount(database, {
        email: `activity-path-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$activity-path-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "activity-path-fixture-salt",
        timeZone: "UTC",
      });
      const hostileUrl = new URL(databaseUrl);
      hostileUrl.searchParams.set(
        "options",
        `-csearch_path=${hostileSchemaName},${schemaName},public`,
      );
      hostileDatabase = createDatabase({
        connectionString: hostileUrl.toString(),
        maxConnections: 1,
      });
      const ambientPath = await sql<{ search_path: string }>`
        select pg_catalog.current_setting('search_path') as search_path
      `.execute(hostileDatabase);
      expect(ambientPath.rows).toEqual([
        { search_path: `${hostileSchemaName},${schemaName},public` },
      ]);

      const hostileScopedDatabase = hostileDatabase.withSchema(schemaName);
      const created = await createActivityEntry(hostileScopedDatabase, {
        clientOperationId: randomUUID(),
        durationMinutes: 30,
        expectedProfileTimeZone: "UTC",
        name: "Hostile path walk",
        occurredAt: "2026-09-08T12:00:00Z",
        requestDigest: digest(),
        selfReportedEnergyKilocalories: "100.125",
        userId: owner.userId,
      });
      if (!created.entry) throw new Error("Hostile-path activity fixture was not created");
      const updated = await updateActivityEntry(hostileScopedDatabase, {
        clientOperationId: randomUUID(),
        durationMinutes: 45,
        entryId: created.entry.id,
        expectedEntryRevision: created.entry.revision,
        requestDigest: digest(),
        userId: owner.userId,
      });
      if (!updated.entry) throw new Error("Hostile-path activity fixture was not updated");
      await deleteActivityEntry(hostileScopedDatabase, {
        clientOperationId: randomUUID(),
        entryId: updated.entry.id,
        expectedEntryRevision: updated.entry.revision,
        requestDigest: digest(),
        userId: owner.userId,
      });
      await hostileScopedDatabase.deleteFrom("app_user").where("id", "=", owner.userId).execute();

      for (const table of [
        "activity_day",
        "activity_entry",
        "activity_entry_revision",
        "activity_operation",
      ] as const) {
        expect(
          await database
            .selectFrom(table)
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", owner.userId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ count: "0" });
      }
    } finally {
      await hostileDatabase?.destroy();
      await database.destroy();
      await sql`drop schema ${sql.id(hostileSchemaName)} cascade`.execute(bootstrap);
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });
});
