import { randomBytes, randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createDatabase,
  type Database,
  discoverMigrations,
  getDayNote,
  type PutDayNoteInput,
  putDayNote,
  registerPasswordAccount,
  runMigrations,
  updateUserProfile,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const digest = () => randomBytes(32).toString("hex");
async function withDatabase(run: (database: Kysely<Database>) => Promise<void>, legacy = false) {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  const schema = `day_notes_${randomBytes(6).toString("hex")}`;
  await sql`create schema ${sql.id(schema)}`.execute(bootstrap);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  const database = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
  try {
    if (legacy) {
      for (const migration of await discoverMigrations()) {
        if (migration.name.startsWith("0026_")) break;
        await sql.raw(migration.sql).execute(database);
      }
    } else await runMigrations(database);
    await run(database);
  } finally {
    await database.destroy();
    await sql`drop schema ${sql.id(schema)} cascade`.execute(bootstrap);
    await bootstrap.destroy();
  }
}
async function account(database: Kysely<Database>) {
  return registerPasswordAccount(database, {
    email: `day-note-${randomUUID()}@example.invalid`,
    passwordHash: "$argon2id$day-note-test-hash",
    passwordParameters: { algorithm: "test" },
    passwordSalt: "day-note-test-salt",
    timeZone: "America/Chicago",
  });
}
function input(userId: string, overrides: Partial<PutDayNoteInput> = {}): PutDayNoteInput {
  return {
    userId,
    localDate: "2026-11-01",
    expectedRevision: "0",
    expectedProfileTimeZone: "America/Chicago",
    clientOperationId: randomUUID(),
    requestDigest: digest(),
    note: "first",
    ...overrides,
  };
}
async function count(
  database: Kysely<Database>,
  table:
    | "diary_day_note"
    | "diary_day_note_revision"
    | "diary_day_note_operation"
    | "diary"
    | "diary_entry"
    | "privacy_export_artifact"
    | "privacy_export_record",
) {
  return Number(
    (
      await database
        .selectFrom(table)
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow()
    ).count,
  );
}
async function watermark(database: Kysely<Database>, userId: string) {
  return BigInt(
    (
      await database
        .selectFrom("user_data_watermark")
        .select("revision")
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow()
    ).revision,
  );
}

describeDatabase("standalone private day-note ledger", { timeout: 30_000 }, () => {
  it("keeps virgin reads allocation-free, preserves exact text through clear/rewrite, and replays the historical result after a zone change", async () =>
    withDatabase(async (database) => {
      const owner = await account(database),
        other = await account(database);
      const base = await watermark(database, owner.userId);
      const initial = await getDayNote(database, { userId: owner.userId, localDate: "2026-11-01" });
      expect(initial).toEqual({
        ownerUserId: owner.userId,
        localDate: "2026-11-01",
        id: null,
        revision: "0",
        note: null,
        recordedTimeZone: null,
        createdAt: null,
        updatedAt: null,
      });
      expect(await count(database, "diary_day_note")).toBe(0);
      expect(await watermark(database, owner.userId)).toBe(base);
      await expect(putDayNote(database, input(owner.userId, { note: null }))).rejects.toMatchObject(
        { code: "DAY_NOTE_VALIDATION" },
      );
      const raw = "  Cafe\u0301\r\n🫐\t  ";
      const firstInput = input(owner.userId, { note: raw });
      const first = await putDayNote(database, firstInput);
      expect(first.data.note).toMatchObject({
        note: raw,
        revision: "1",
        localDate: "2026-11-01",
        recordedTimeZone: "America/Chicago",
      });
      expect(await watermark(database, owner.userId)).toBe(base + 1n);
      const clearInput = input(owner.userId, { expectedRevision: "1", note: null });
      const cleared = await putDayNote(database, clearInput);
      expect(cleared.data.note).toMatchObject({
        id: first.data.note.id,
        revision: "2",
        note: null,
      });
      const rewritten = await putDayNote(
        database,
        input(owner.userId, { expectedRevision: "2", note: " \n " }),
      );
      expect(rewritten.data.note).toMatchObject({
        id: first.data.note.id,
        revision: "3",
        note: " \n ",
        createdAt: first.data.note.createdAt,
      });
      const equal = await putDayNote(
        database,
        input(owner.userId, { expectedRevision: "3", note: " \n " }),
      );
      expect(equal.data.note.revision).toBe("4");
      await expect(
        putDayNote(database, input(owner.userId, { note: "stale virgin" })),
      ).rejects.toMatchObject({ code: "DAY_NOTE_REVISION_CONFLICT" });
      await updateUserProfile(database, {
        userId: owner.userId,
        expectedRevision: "0",
        patch: { timeZone: "Asia/Tokyo" },
      });
      const beforeReplay = await watermark(database, owner.userId);
      expect(await putDayNote(database, firstInput)).toEqual({
        data: { ...first.data, replayed: true },
      });
      expect(await putDayNote(database, clearInput)).toEqual({
        data: { ...cleared.data, replayed: true },
      });
      expect(await watermark(database, owner.userId)).toBe(beforeReplay);
      expect(await getDayNote(database, { userId: owner.userId, localDate: "2026-11-01" })).toEqual(
        equal.data.note,
      );
      await expect(
        putDayNote(database, input(owner.userId, { expectedRevision: "4" })),
      ).rejects.toMatchObject({ code: "DAY_NOTE_TIME_ZONE_CHANGED" });
      await expect(
        putDayNote(database, { ...firstInput, localDate: "2026-11-02", requestDigest: digest() }),
      ).rejects.toMatchObject({ code: "DAY_NOTE_IDEMPOTENCY_CONFLICT" });
      const independent = await putDayNote(database, {
        ...firstInput,
        userId: other.userId,
        requestDigest: digest(),
        note: "other private note",
      });
      expect(independent.data.note.id).not.toBe(first.data.note.id);
      expect(
        (await getDayNote(database, { userId: other.userId, localDate: "2026-11-02" })).revision,
      ).toBe("0");
      expect(await count(database, "diary")).toBe(0);
      expect(await count(database, "diary_entry")).toBe(0);
      expect(await count(database, "diary_day_note_revision")).toBe(5);
      expect(await count(database, "diary_day_note_operation")).toBe(5);
      expect(
        (
          await database
            .selectFrom("diary_day_note_revision")
            .select("note")
            .where("user_id", "=", owner.userId)
            .orderBy("revision_number")
            .execute()
        ).map((row) => row.note),
      ).toEqual([raw, null, " \n ", " \n "]);
    }));
  it("serializes competing creation and updates while identical concurrent keys create exactly one immutable revision", async () =>
    withDatabase(async (database) => {
      const owner = await account(database);
      const same = input(owner.userId);
      const identical = await Promise.all([putDayNote(database, same), putDayNote(database, same)]);
      expect(identical.map((result) => result.data.replayed).sort()).toEqual([false, true]);
      expect(identical[0]?.data.note).toEqual(identical[1]?.data.note);
      const compete = await Promise.allSettled([
        putDayNote(database, input(owner.userId, { expectedRevision: "1", note: "A" })),
        putDayNote(database, input(owner.userId, { expectedRevision: "1", note: "B" })),
      ]);
      expect(compete.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(compete.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "DAY_NOTE_REVISION_CONFLICT" },
      });
      const virgin = await Promise.allSettled([
        putDayNote(database, input(owner.userId, { localDate: "2026-11-02" })),
        putDayNote(database, input(owner.userId, { localDate: "2026-11-02" })),
      ]);
      expect(virgin.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(virgin.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "DAY_NOTE_REVISION_CONFLICT" },
      });
      expect(await count(database, "diary_day_note")).toBe(2);
      expect(await count(database, "diary_day_note_revision")).toBe(3);
      expect(await count(database, "diary_day_note_operation")).toBe(3);
      const conflict = input(owner.userId, { expectedRevision: "1" });
      await expect(putDayNote(database, conflict)).rejects.toMatchObject({
        code: "DAY_NOTE_REVISION_CONFLICT",
      });
      const corrected = await putDayNote(database, {
        ...conflict,
        expectedRevision: "2",
        requestDigest: digest(),
      });
      expect(corrected.data.replayed).toBe(false);
      expect(corrected.data.note.revision).toBe("3");
      const zoneConflict = input(owner.userId, {
        expectedRevision: "3",
        expectedProfileTimeZone: "Asia/Tokyo",
      });
      await expect(putDayNote(database, zoneConflict)).rejects.toMatchObject({
        code: "DAY_NOTE_TIME_ZONE_CHANGED",
      });
      expect(
        (
          await putDayNote(database, {
            ...zoneConflict,
            expectedProfileTimeZone: "America/Chicago",
            requestDigest: digest(),
          })
        ).data.note.revision,
      ).toBe("4");
      await database
        .updateTable("app_user")
        .set({ status: "pending_deletion" })
        .where("id", "=", owner.userId)
        .execute();
      await expect(putDayNote(database, same)).rejects.toMatchObject({
        code: "DAY_NOTE_NOT_FOUND",
      });
      await expect(
        getDayNote(database, { userId: owner.userId, localDate: same.localDate }),
      ).rejects.toMatchObject({ code: "DAY_NOTE_NOT_FOUND" });
      await database
        .updateTable("app_user")
        .set({ status: "disabled", deletion_requested_at: new Date(), deleted_at: new Date() })
        .where("id", "=", owner.userId)
        .execute();
      await expect(putDayNote(database, same)).rejects.toMatchObject({
        code: "DAY_NOTE_NOT_FOUND",
      });
    }));
  it("rejects malformed content and direct SQL history/ownership corruption while owner erasure retains the other account", async () =>
    withDatabase(async (database) => {
      const owner = await account(database),
        other = await account(database);
      for (const note of ["", "\u0000", "\ud800", "a".repeat(2001)])
        await expect(putDayNote(database, input(owner.userId, { note }))).rejects.toMatchObject({
          code: "DAY_NOTE_VALIDATION",
        });
      for (const localDate of ["0000-01-01", "2026-02-30"])
        await expect(
          putDayNote(database, input(owner.userId, { localDate })),
        ).rejects.toMatchObject({ code: "DAY_NOTE_VALIDATION" });
      const accepted = await putDayNote(database, input(owner.userId, { note: "🫐".repeat(2000) }));
      const survivor = await putDayNote(database, input(other.userId, { note: "survives" }));
      const root = await database
        .selectFrom("diary_day_note")
        .selectAll()
        .where("id", "=", accepted.data.note.id as string)
        .executeTakeFirstOrThrow();
      const revision = await database
        .selectFrom("diary_day_note_revision")
        .selectAll()
        .where("id", "=", root.current_revision_id)
        .executeTakeFirstOrThrow();
      const operation = await database
        .selectFrom("diary_day_note_operation")
        .selectAll()
        .where("day_note_id", "=", root.id)
        .executeTakeFirstOrThrow();
      await expect(
        sql`update diary_day_note_revision set note='changed' where id=${revision.id}`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        sql`update diary_day_note_operation set request_digest=${digest()} where day_note_id=${root.id}`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: "55000" });
      for (const table of [
        "diary_day_note",
        "diary_day_note_revision",
        "diary_day_note_operation",
      ] as const)
        await expect(
          sql`delete from ${sql.table(table)} where user_id=${owner.userId}`.execute(database),
        ).rejects.toMatchObject({ code: "55000" });
      await expect(
        database
          .updateTable("diary_day_note")
          .set({ local_date: "2026-11-03" })
          .where("id", "=", root.id)
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        database
          .updateTable("diary_day_note")
          .set({ current_revision_number: "2" })
          .where("id", "=", root.id)
          .execute(),
      ).rejects.toMatchObject({ code: "23503" });
      for (const patch of [
        { revision_number: "3" },
        { user_id: other.userId },
        { local_date: "2026-11-03" },
        { recorded_time_zone: "Invalid/Zone" },
        { note: "a".repeat(2001) },
        { note: null, operation: "set" },
      ] as const) {
        await expect(
          database.transaction().execute(async (transaction) => {
            await transaction
              .insertInto("diary_day_note_revision")
              .values({
                ...revision,
                id: randomUUID(),
                revision_number: "2",
                supersedes_revision_id: revision.id,
                ...patch,
              })
              .execute();
          }),
        ).rejects.toThrow();
      }
      await expect(
        database.transaction().execute(async (transaction) => {
          await transaction
            .insertInto("diary_day_note_revision")
            .values({
              ...revision,
              id: randomUUID(),
              revision_number: "2",
              supersedes_revision_id: revision.id,
            })
            .execute();
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database
          .insertInto("diary_day_note_operation")
          .values({ ...operation, user_id: other.userId, client_operation_id: randomUUID() })
          .execute(),
      ).rejects.toThrow();
      await database.deleteFrom("app_user").where("id", "=", owner.userId).execute();
      for (const table of [
        "diary_day_note",
        "diary_day_note_revision",
        "diary_day_note_operation",
      ] as const)
        expect(await count(database, table)).toBe(1);
      expect(await getDayNote(database, { userId: other.userId, localDate: "2026-11-01" })).toEqual(
        survivor.data.note,
      );
      await expect(
        getDayNote(database, { userId: owner.userId, localDate: "2026-11-01" }),
      ).rejects.toMatchObject({ code: "DAY_NOTE_NOT_FOUND" });
    }));
  it("preserves completed historical exports and rolls back legacy or malformed completion including promotion and spool deletion", async () =>
    withDatabase(async (database) => {
      const owner = await account(database);
      const expiry = "2500-01-01T00:00:00.000Z";
      async function createJob() {
        const jobId = randomUUID();
        await sql`insert into privacy_export_job(id,user_id,client_operation_id,request_digest,status,requested_formats) values(${jobId},${owner.userId},${randomUUID()},${digest()},'running',array['json'])`.execute(
          database,
        );
        return jobId;
      }
      async function artifact(transaction: Kysely<Database>, jobId: string) {
        await sql`insert into privacy_export_artifact(job_id,format,file_name,media_type,object_key,plaintext_bytes,plaintext_sha256,ciphertext_bytes,encryption_key_id,expires_at) values(${jobId},'json','account.json','application/json',${`exports/${jobId}`},10,${digest()},30,'test-key',${expiry})`.execute(
          transaction,
        );
      }
      const oldJob = await createJob();
      await artifact(database, oldJob);
      const legacy = {
        formatVersion: "nutrition-account-export-v1",
        entities: [{ entity: "account" }],
      };
      await sql`update privacy_export_job set status='completed',expires_at=${expiry},reconciliation=${JSON.stringify(legacy)}::jsonb where id=${oldJob}`.execute(
        database,
      );
      const oldArtifact = await database
        .selectFrom("privacy_export_artifact")
        .selectAll()
        .where("job_id", "=", oldJob)
        .executeTakeFirstOrThrow();
      const pending = await createJob();
      const uploadId = randomUUID();
      await sql`insert into privacy_export_upload_artifact(id,job_id,snapshot_id,format,object_key,worker_id,status,uploaded_at) values(${uploadId},${pending},'old-snapshot','json',${`pending/${pending}`},'old-worker','uploaded',clock_timestamp())`.execute(
        database,
      );
      await sql`insert into privacy_export_record(job_id,ordinal,entity_type,entity_id,revision,deleted,watermark_revision,payload,payload_sha256) values(${pending},1,'account',${owner.userId},null,false,1,'{}',${digest()})`.execute(
        database,
      );
      const migration = (await discoverMigrations()).find((item) => item.name.startsWith("0026_"));
      if (!migration) throw new Error("Day-note migration missing");
      await sql.raw(migration.sql).execute(database);
      await sql`update privacy_export_job set status='completed',expires_at=${expiry} where id=${oldJob}`.execute(
        database,
      );
      expect(
        (
          await database
            .selectFrom("privacy_export_job")
            .select("reconciliation")
            .where("id", "=", oldJob)
            .executeTakeFirstOrThrow()
        ).reconciliation,
      ).toEqual(legacy);
      expect(
        await database
          .selectFrom("privacy_export_artifact")
          .selectAll()
          .where("job_id", "=", oldJob)
          .executeTakeFirstOrThrow(),
      ).toEqual(oldArtifact);
      const families = [
        "account",
        "activity_day",
        "activity_entry",
        "activity_entry_revision",
        "activity_operation",
        "audit_event",
        "biometric_definition",
        "biometric_definition_operation",
        "biometric_definition_version",
        "biometric_event",
        "biometric_event_operation",
        "biometric_event_revision",
        "custom_food",
        "custom_food_catalogue_barcode",
        "custom_food_catalogue_food",
        "custom_food_catalogue_nutrient",
        "custom_food_catalogue_serving",
        "custom_food_catalogue_version",
        "custom_food_nutrient",
        "custom_food_operation",
        "custom_food_version",
        "device",
        "diary_day",
        "diary_day_note",
        "diary_day_note_operation",
        "diary_day_note_revision",
        "diary_entry",
        "diary_entry_legacy_nutrient",
        "diary_entry_nutrient",
        "diary_entry_revision",
        "diary_entry_source",
        "diary_operation",
        "hydration_day",
        "hydration_entry",
        "hydration_entry_revision",
        "hydration_operation",
        "nutrition_goal",
        "nutrition_goal_operation",
        "nutrition_goal_target",
        "nutrition_goal_version",
        "platform_health_import",
        "platform_health_import_conflict",
        "platform_health_import_revision",
        "platform_import_batch",
        "platform_integration",
        "platform_integration_version",
        "privacy_export_artifact",
        "privacy_export_artifact_deletion",
        "privacy_export_artifact_tombstone",
        "privacy_export_download_audit",
        "privacy_export_job",
        "profile",
        "reauthentication_proof",
        "recipe",
        "recipe_ingredient",
        "recipe_nutrient",
        "recipe_operation",
        "recipe_source",
        "recipe_version",
        "reminder_consent",
        "reminder_consent_version",
        "reminder_delivery",
        "reminder_schedule",
        "reminder_schedule_version",
        "retention_operation",
        "security_challenge",
        "session",
        "user_watermark",
      ];
      const entities = families.map((entity) => ({ entity }));
      const current = { formatVersion: "nutrition-account-export-v2", entities };
      for (const reconciliation of [
        null,
        {},
        legacy,
        { ...current, formatVersion: null },
        { ...current, formatVersion: "unknown" },
        { ...current, entities: null },
        { ...current, entities: [null] },
        { ...current, entities: [{ entity: 1 }] },
        { ...current, entities: entities.slice(1) },
        { ...current, entities: [...entities, entities[0]] },
        { ...current, entities: [...entities.slice(1), entities[1]] },
        { ...current, entities: [...entities.slice(1), { entity: "substituted" }] },
      ]) {
        await expect(
          database.transaction().execute(async (transaction) => {
            await artifact(transaction, pending);
            await transaction
              .updateTable("privacy_export_upload_artifact")
              .set({ status: "promoted" })
              .where("id", "=", uploadId)
              .execute();
            await transaction
              .deleteFrom("privacy_export_record")
              .where("job_id", "=", pending)
              .execute();
            await sql`update privacy_export_job set status='completed',expires_at=${expiry},reconciliation=${reconciliation === null ? null : JSON.stringify(reconciliation)}::jsonb where id=${pending}`.execute(
              transaction,
            );
          }),
        ).rejects.toMatchObject({ code: "23514" });
        expect(
          (
            await database
              .selectFrom("privacy_export_job")
              .select("status")
              .where("id", "=", pending)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe("running");
        expect(
          (
            await database
              .selectFrom("privacy_export_upload_artifact")
              .select("status")
              .where("id", "=", uploadId)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe("uploaded");
        expect(await count(database, "privacy_export_artifact")).toBe(1);
        expect(await count(database, "privacy_export_record")).toBe(1);
      }
      await database.transaction().execute(async (transaction) => {
        await artifact(transaction, pending);
        await transaction
          .updateTable("privacy_export_upload_artifact")
          .set({ status: "promoted" })
          .where("id", "=", uploadId)
          .execute();
        await transaction
          .deleteFrom("privacy_export_record")
          .where("job_id", "=", pending)
          .execute();
        await sql`update privacy_export_job set status='completed',expires_at=${expiry},reconciliation=${JSON.stringify(current)}::jsonb where id=${pending}`.execute(
          transaction,
        );
      });
      expect(await count(database, "privacy_export_artifact")).toBe(2);
      expect(await count(database, "privacy_export_record")).toBe(0);
      await expect(
        sql`update privacy_export_job set expires_at='2500-01-02' where id=${pending}`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }, true));
});
