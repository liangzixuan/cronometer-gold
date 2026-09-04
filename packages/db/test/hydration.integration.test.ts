import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  createDatabase,
  createHydrationEntry,
  deleteHydrationEntry,
  getHydrationDay,
  HydrationEntryRevisionConflictError,
  HydrationIdempotencyConflictError,
  HydrationNotFoundError,
  HydrationTimeZoneChangedError,
  HydrationValidationError,
  registerPasswordAccount,
  replayExternalErasureLedgerEntry,
  runMigrations,
  updateHydrationEntry,
  updateUserProfile,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const digest = () => randomBytes(32).toString("hex");

describeDatabase("owner-scoped immutable hydration ledger", { timeout: 30_000 }, () => {
  it("enforces replay, revisions, time zones, bounds, raw invariants, and erasure cascades", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `hydration_${randomBytes(6).toString("hex")}`;
    const applicationName = `nutrition-${schemaName}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    scopedUrl.searchParams.set("application_name", applicationName);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 8 });
    try {
      await runMigrations(database);
      const owner = await registerPasswordAccount(database, {
        email: `hydration-owner-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$hydration-owner-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "hydration-owner-fixture-salt",
        timeZone: "America/Chicago",
      });
      const other = await registerPasswordAccount(database, {
        email: `hydration-other-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$hydration-other-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "hydration-other-fixture-salt",
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

      const createOperationId = randomUUID();
      const createInput = {
        amountMilliliters: 500,
        clientOperationId: createOperationId,
        expectedProfileTimeZone: "America/Chicago",
        occurredAt: "2026-08-15T01:30:00Z",
        requestDigest: digest(),
        userId: owner.userId,
      };
      const watermarkBeforeCreate = await ownerWatermark();
      const created = await createHydrationEntry(database, createInput);
      expect(created).toMatchObject({
        days: [{ localDate: "2026-08-14", revision: "1" }],
        entry: {
          amountMilliliters: 500,
          localDate: "2026-08-14",
          localTime: "20:30:00",
          revision: "1",
          timeZone: "America/Chicago",
        },
        replayed: false,
      });
      const watermarkAfterCreate = await ownerWatermark();
      expect(watermarkAfterCreate).toBe(watermarkBeforeCreate + 1n);
      expect(await createHydrationEntry(database, createInput)).toMatchObject({
        entry: { id: created.entry?.id },
        replayed: true,
      });
      expect(await ownerWatermark()).toBe(watermarkAfterCreate);
      await expect(
        createHydrationEntry(database, { ...createInput, requestDigest: digest() }),
      ).rejects.toBeInstanceOf(HydrationIdempotencyConflictError);

      const concurrentInput = {
        amountMilliliters: 250,
        clientOperationId: randomUUID(),
        occurredAt: "2026-08-14T18:00:00Z",
        requestDigest: digest(),
        userId: owner.userId,
      };
      const watermarkBeforeConcurrentCreate = await ownerWatermark();
      const concurrent = await Promise.all([
        createHydrationEntry(database, concurrentInput),
        createHydrationEntry(database, concurrentInput),
      ]);
      expect(concurrent.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(new Set(concurrent.map((result) => result.entry?.id)).size).toBe(1);
      expect(await ownerWatermark()).toBe(watermarkBeforeConcurrentCreate + 1n);

      await expect(
        createHydrationEntry(database, {
          ...createInput,
          clientOperationId: randomUUID(),
          expectedProfileTimeZone: "Asia/Tokyo",
          requestDigest: digest(),
        }),
      ).rejects.toBeInstanceOf(HydrationTimeZoneChangedError);
      await expect(
        updateHydrationEntry(database, {
          amountMilliliters: 999,
          clientOperationId: randomUUID(),
          entryId: created.entry?.id ?? "missing",
          expectedEntryRevision: "1",
          requestDigest: digest(),
          userId: other.userId,
        }),
      ).rejects.toBeInstanceOf(HydrationNotFoundError);
      expect(
        await getHydrationDay(database, { localDate: "2026-08-14", userId: other.userId }),
      ).toMatchObject({ entries: [], revision: "0", totalMilliliters: 0 });

      await updateUserProfile(database, {
        expectedRevision: "0",
        patch: { timeZone: "Asia/Tokyo" },
        userId: owner.userId,
      });
      const oldDayAfterZoneChange = await getHydrationDay(database, {
        localDate: "2026-08-14",
        userId: owner.userId,
      });
      expect(oldDayAfterZoneChange.timeZone).toBe("Asia/Tokyo");
      expect(oldDayAfterZoneChange.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: created.entry?.id,
            localDate: "2026-08-14",
            timeZone: "America/Chicago",
          }),
        ]),
      );

      const updateInput = {
        amountMilliliters: 750,
        clientOperationId: randomUUID(),
        entryId: created.entry?.id ?? "missing",
        expectedEntryRevision: "1",
        requestDigest: digest(),
        userId: owner.userId,
      };
      const watermarkBeforeUpdate = await ownerWatermark();
      const updated = await updateHydrationEntry(database, updateInput);
      expect(updated).toMatchObject({
        days: [{ localDate: "2026-08-14", revision: "3" }],
        entry: {
          amountMilliliters: 750,
          localDate: "2026-08-14",
          localTime: "20:30:00",
          revision: "2",
          timeZone: "America/Chicago",
        },
      });
      const watermarkAfterUpdate = await ownerWatermark();
      expect(watermarkAfterUpdate).toBe(watermarkBeforeUpdate + 1n);
      expect(await updateHydrationEntry(database, updateInput)).toMatchObject({ replayed: true });
      expect(await ownerWatermark()).toBe(watermarkAfterUpdate);
      await expect(
        updateHydrationEntry(database, {
          ...updateInput,
          clientOperationId: randomUUID(),
          expectedEntryRevision: "1",
          requestDigest: digest(),
        }),
      ).rejects.toBeInstanceOf(HydrationEntryRevisionConflictError);
      expect(
        await getHydrationDay(database, { localDate: "2026-08-14", userId: owner.userId }),
      ).toMatchObject({ revision: "3", timeZone: "Asia/Tokyo", totalMilliliters: 1_000 });

      const moveInput = {
        clientOperationId: randomUUID(),
        entryId: created.entry?.id ?? "missing",
        expectedEntryRevision: "2",
        occurredAt: "2026-08-15T01:30:00Z",
        requestDigest: digest(),
        userId: owner.userId,
      };
      const watermarkBeforeMove = await ownerWatermark();
      const moved = await updateHydrationEntry(database, moveInput);
      expect(moved).toMatchObject({
        days: [
          { localDate: "2026-08-14", revision: "4" },
          { localDate: "2026-08-15", revision: "1" },
        ],
        entry: {
          amountMilliliters: 750,
          localDate: "2026-08-15",
          localTime: "10:30:00",
          revision: "3",
          timeZone: "Asia/Tokyo",
        },
      });
      const watermarkAfterMove = await ownerWatermark();
      expect(watermarkAfterMove).toBe(watermarkBeforeMove + 1n);
      expect(await updateHydrationEntry(database, moveInput)).toMatchObject({ replayed: true });
      expect(await ownerWatermark()).toBe(watermarkAfterMove);
      expect(
        await getHydrationDay(database, { localDate: "2026-08-15", userId: owner.userId }),
      ).toMatchObject({ revision: "1", timeZone: "Asia/Tokyo", totalMilliliters: 750 });

      const deleteInput = {
        clientOperationId: randomUUID(),
        entryId: created.entry?.id ?? "missing",
        expectedEntryRevision: "3",
        requestDigest: digest(),
        userId: owner.userId,
      };
      const watermarkBeforeDelete = await ownerWatermark();
      expect(await deleteHydrationEntry(database, deleteInput)).toMatchObject({
        entry: null,
        replayed: false,
      });
      const watermarkAfterDelete = await ownerWatermark();
      expect(watermarkAfterDelete).toBe(watermarkBeforeDelete + 1n);
      expect(await deleteHydrationEntry(database, deleteInput)).toMatchObject({
        entry: null,
        replayed: true,
      });
      expect(await ownerWatermark()).toBe(watermarkAfterDelete);
      expect(
        await database
          .selectFrom("hydration_entry_revision")
          .select(["operation", "revision_number", "time_zone"])
          .where("hydration_entry_id", "=", deleteInput.entryId)
          .orderBy("revision_number")
          .execute(),
      ).toEqual([
        { operation: "create", revision_number: "1", time_zone: "America/Chicago" },
        { operation: "update", revision_number: "2", time_zone: "America/Chicago" },
        { operation: "update", revision_number: "3", time_zone: "Asia/Tokyo" },
        { operation: "delete", revision_number: "4", time_zone: "Asia/Tokyo" },
      ]);
      await expect(
        database
          .updateTable("hydration_entry_revision")
          .set({ amount_milliliters: 1 })
          .where("hydration_entry_id", "=", deleteInput.entryId)
          .where("revision_number", "=", "1")
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });

      const rawEntry = concurrent[0]?.entry;
      if (!rawEntry) throw new Error("Concurrent hydration fixture was not created");
      const rawHead = await database
        .selectFrom("hydration_entry")
        .select(["current_revision_id", "current_revision_number", "hydration_day_id"])
        .where("id", "=", rawEntry.id)
        .executeTakeFirstOrThrow();
      const wrongDay = await database
        .insertInto("hydration_day")
        .values({ local_date: "2026-08-16", time_zone: "Asia/Tokyo", user_id: owner.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      await expect(
        database
          .insertInto("hydration_entry_revision")
          .values({
            amount_milliliters: rawEntry.amountMilliliters,
            hydration_day_id: wrongDay.id,
            hydration_entry_id: rawEntry.id,
            id: randomUUID(),
            local_date: rawEntry.localDate,
            local_time: rawEntry.localTime,
            occurred_at: rawEntry.occurredAt,
            operation: "update",
            revision_number: (BigInt(rawHead.current_revision_number) + 1n).toString(),
            supersedes_revision_id: rawHead.current_revision_id,
            time_zone: rawEntry.timeZone,
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("hydration_entry_revision")
          .values({
            amount_milliliters: rawEntry.amountMilliliters,
            hydration_day_id: rawHead.hydration_day_id,
            hydration_entry_id: rawEntry.id,
            id: randomUUID(),
            local_date: rawEntry.localDate,
            local_time: rawEntry.localTime,
            occurred_at: rawEntry.occurredAt,
            operation: "update",
            revision_number: (BigInt(rawHead.current_revision_number) + 1n).toString(),
            supersedes_revision_id: rawHead.current_revision_id,
            time_zone: rawEntry.timeZone,
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("hydration_day")
          .values({
            local_date: "2026-08-17",
            time_zone: "Not/A_Zone",
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        database
          .insertInto("hydration_day")
          .values({
            local_date: sql<string>`'infinity'::date`,
            time_zone: "Asia/Tokyo",
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("hydration_entry_revision")
          .values({
            amount_milliliters: rawEntry.amountMilliliters,
            hydration_day_id: rawHead.hydration_day_id,
            hydration_entry_id: rawEntry.id,
            id: randomUUID(),
            local_date: rawEntry.localDate,
            local_time: rawEntry.localTime,
            occurred_at: rawEntry.occurredAt,
            operation: "update",
            revision_number: (BigInt(rawHead.current_revision_number) + 1n).toString(),
            supersedes_revision_id: rawHead.current_revision_id,
            time_zone: "Not/A_Zone",
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        database
          .insertInto("hydration_entry")
          .values({
            amount_milliliters: 1,
            current_revision_id: randomUUID(),
            current_revision_number: "1",
            hydration_day_id: wrongDay.id,
            id: randomUUID(),
            local_time: "00:00:00",
            occurred_at: sql<Date>`'infinity'::timestamptz`,
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("hydration_entry")
          .values({
            amount_milliliters: 1,
            current_revision_id: randomUUID(),
            current_revision_number: "1",
            deleted_at: sql<Date>`'infinity'::timestamptz`,
            hydration_day_id: wrongDay.id,
            id: randomUUID(),
            local_time: "00:00:00",
            occurred_at: "2026-08-16T00:00:00Z",
            user_id: owner.userId,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });

      const boundedOwner = await registerPasswordAccount(database, {
        email: `hydration-bounds-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$hydration-bounds-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "hydration-bounds-fixture-salt",
        timeZone: "UTC",
      });
      for (let index = 0; index < 64; index += 1) {
        await createHydrationEntry(database, {
          amountMilliliters: 1,
          clientOperationId: randomUUID(),
          occurredAt: "2026-09-01T12:00:00Z",
          requestDigest: digest(),
          userId: boundedOwner.userId,
        });
      }
      await expect(
        createHydrationEntry(database, {
          amountMilliliters: 1,
          clientOperationId: randomUUID(),
          occurredAt: "2026-09-01T12:00:00Z",
          requestDigest: digest(),
          userId: boundedOwner.userId,
        }),
      ).rejects.toBeInstanceOf(HydrationValidationError);
      for (let index = 0; index < 5; index += 1) {
        await createHydrationEntry(database, {
          amountMilliliters: 20_000,
          clientOperationId: randomUUID(),
          occurredAt: "2026-09-02T12:00:00Z",
          requestDigest: digest(),
          userId: boundedOwner.userId,
        });
      }
      await expect(
        createHydrationEntry(database, {
          amountMilliliters: 1,
          clientOperationId: randomUUID(),
          occurredAt: "2026-09-02T12:00:00Z",
          requestDigest: digest(),
          userId: boundedOwner.userId,
        }),
      ).rejects.toBeInstanceOf(HydrationValidationError);

      await database.deleteFrom("app_user").where("id", "=", boundedOwner.userId).execute();
      for (const table of [
        "hydration_day",
        "hydration_entry",
        "hydration_entry_revision",
        "hydration_operation",
      ] as const) {
        expect(
          await database
            .selectFrom(table)
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", boundedOwner.userId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ count: "0" });
      }

      const fencedHydration = await createHydrationEntry(database, {
        amountMilliliters: 333,
        clientOperationId: randomUUID(),
        occurredAt: "2026-09-03T12:00:00Z",
        requestDigest: digest(),
        userId: other.userId,
      });
      expect(fencedHydration.entry).not.toBeNull();
      let signalLockReady: (() => void) | undefined;
      let releaseHydrationLock: (() => void) | undefined;
      const lockReady = new Promise<void>((resolve) => {
        signalLockReady = resolve;
      });
      const lockRelease = new Promise<void>((resolve) => {
        releaseHydrationLock = resolve;
      });
      const heldHydrationWriter = database.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:hydration:${other.userId}`},0))`.execute(
          transaction,
        );
        signalLockReady?.();
        await lockRelease;
      });
      await lockReady;
      const replay = replayExternalErasureLedgerEntry(database, {
        ackDigest: digest(),
        ledgerEntryId: `hydration-fence-${randomUUID()}`,
        recordedAt: "2026-09-03T12:01:00Z",
        subjectUserId: other.userId,
      });
      let observedHydrationWait = false;
      try {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const waiting = await sql<{ present: boolean }>`
            select exists (
              select 1
              from pg_locks locks
              join pg_stat_activity activity on activity.pid=locks.pid
              where activity.application_name=${applicationName}
                and locks.locktype='advisory'
                and not locks.granted
            ) present
          `.execute(bootstrap);
          observedHydrationWait = waiting.rows[0]?.present === true;
          if (observedHydrationWait) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(observedHydrationWait).toBe(true);
      } finally {
        releaseHydrationLock?.();
        await heldHydrationWriter;
      }
      await expect(replay).resolves.toMatchObject({ reconciled: true, userId: other.userId });
      expect(
        await database
          .selectFrom("hydration_entry")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", other.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });
});
