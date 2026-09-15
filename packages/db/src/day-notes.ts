import { randomUUID } from "node:crypto";
import { canonicalIanaTimeZone } from "@nutrition-tracker/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Database, JsonObject } from "./types.js";

export type DayNotePersistenceErrorCode =
  | "DAY_NOTE_NOT_FOUND"
  | "DAY_NOTE_REVISION_CONFLICT"
  | "DAY_NOTE_TIME_ZONE_CHANGED"
  | "DAY_NOTE_IDEMPOTENCY_CONFLICT"
  | "DAY_NOTE_VALIDATION";
export class DayNotePersistenceError extends Error {
  override readonly name = "DayNotePersistenceError";
  constructor(readonly code: DayNotePersistenceErrorCode) {
    super(code);
  }
}
export interface DayNoteRecord {
  readonly ownerUserId: string;
  readonly localDate: string;
  readonly id: string | null;
  readonly revision: string;
  readonly note: string | null;
  readonly recordedTimeZone: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}
export interface DayNoteMutationRecord {
  readonly data: {
    readonly replayed: boolean;
    readonly note: DayNoteRecord;
    readonly receipt: {
      readonly protocol: "diary-day-note-v1";
      readonly operationId: string;
      readonly ownerUserId: string;
      readonly localDate: string;
      readonly expectedRevision: string;
      readonly expectedProfileTimeZone: string;
      readonly resultRevision: string;
    };
  };
}
export interface PutDayNoteInput {
  readonly userId: string;
  readonly localDate: string;
  readonly expectedRevision: string;
  readonly expectedProfileTimeZone: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly note: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function reject(code: DayNotePersistenceErrorCode): never {
  throw new DayNotePersistenceError(code);
}
function validateOwnerDate(userId: string, date: string): void {
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (
    !uuid.test(userId) ||
    !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) ||
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== date
  )
    reject("DAY_NOTE_VALIDATION");
}
function validateInput(input: PutDayNoteInput): void {
  validateOwnerDate(input.userId, input.localDate);
  if (
    !uuid.test(input.clientOperationId) ||
    !/^[0-9a-f]{64}$/.test(input.requestDigest) ||
    !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedRevision) ||
    BigInt(input.expectedRevision) > 9_223_372_036_854_775_807n
  )
    reject("DAY_NOTE_VALIDATION");
  try {
    if (canonicalIanaTimeZone(input.expectedProfileTimeZone) !== input.expectedProfileTimeZone)
      reject("DAY_NOTE_VALIDATION");
  } catch {
    reject("DAY_NOTE_VALIDATION");
  }
  if (input.note !== null) {
    if (typeof input.note !== "string" || input.note.length === 0 || input.note.includes("\u0000"))
      reject("DAY_NOTE_VALIDATION");
    let count = 0;
    for (const scalar of input.note) {
      const code = scalar.codePointAt(0) ?? 0;
      if ((code >= 0xd800 && code <= 0xdfff) || ++count > 2000) reject("DAY_NOTE_VALIDATION");
    }
  }
}
async function activeProfile(database: Kysely<Database> | Transaction<Database>, userId: string) {
  const profile = await database
    .selectFrom("app_user as user")
    .innerJoin("user_profile as profile", "profile.user_id", "user.id")
    .select("profile.time_zone")
    .where("user.id", "=", userId)
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null)
    .executeTakeFirst();
  if (!profile) return reject("DAY_NOTE_NOT_FOUND");
  return profile;
}
async function readNote(
  database: Kysely<Database> | Transaction<Database>,
  userId: string,
  localDate: string,
): Promise<DayNoteRecord> {
  const row = await database
    .selectFrom("diary_day_note as root")
    .innerJoin("diary_day_note_revision as revision", (join) =>
      join
        .onRef("revision.id", "=", "root.current_revision_id")
        .onRef("revision.day_note_id", "=", "root.id")
        .onRef("revision.user_id", "=", "root.user_id"),
    )
    .select([
      "root.id",
      "root.user_id",
      "root.current_revision_number",
      "root.created_at",
      "root.updated_at",
      "revision.note",
      "revision.recorded_time_zone",
    ])
    .where("root.user_id", "=", userId)
    .where("root.local_date", "=", localDate)
    .executeTakeFirst();
  if (!row)
    return {
      ownerUserId: userId,
      localDate,
      id: null,
      revision: "0",
      note: null,
      recordedTimeZone: null,
      createdAt: null,
      updatedAt: null,
    };
  return {
    ownerUserId: row.user_id,
    localDate,
    id: row.id,
    revision: String(row.current_revision_number),
    note: row.note,
    recordedTimeZone: row.recorded_time_zone,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
export async function getDayNote(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly localDate: string },
): Promise<DayNoteRecord> {
  validateOwnerDate(input.userId, input.localDate);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (transaction) => {
      await activeProfile(transaction, input.userId);
      return readNote(transaction, input.userId, input.localDate);
    });
}
export async function putDayNote(
  database: Kysely<Database>,
  input: PutDayNoteInput,
): Promise<DayNoteMutationRecord> {
  validateInput(input);
  return database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:diary:${input.userId}`},0))`.execute(
      transaction,
    );
    const user = await transaction
      .selectFrom("app_user")
      .select("id")
      .where("id", "=", input.userId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!user) return reject("DAY_NOTE_NOT_FOUND");
    const previous = await transaction
      .selectFrom("diary_day_note_operation")
      .select(["request_digest", "result_payload"])
      .where("user_id", "=", input.userId)
      .where("client_operation_id", "=", input.clientOperationId)
      .executeTakeFirst();
    if (previous) {
      if (previous.request_digest !== input.requestDigest)
        return reject("DAY_NOTE_IDEMPOTENCY_CONFLICT");
      const result = previous.result_payload as unknown as DayNoteMutationRecord;
      return { data: { ...result.data, replayed: true } };
    }
    const profile = await activeProfile(transaction, input.userId);
    if (profile.time_zone !== input.expectedProfileTimeZone)
      return reject("DAY_NOTE_TIME_ZONE_CHANGED");
    const root = await transaction
      .selectFrom("diary_day_note")
      .selectAll()
      .where("user_id", "=", input.userId)
      .where("local_date", "=", input.localDate)
      .forUpdate()
      .executeTakeFirst();
    if ((root ? String(root.current_revision_number) : "0") !== input.expectedRevision)
      return reject("DAY_NOTE_REVISION_CONFLICT");
    if (
      (!root && input.note === null) ||
      BigInt(input.expectedRevision) === 9_223_372_036_854_775_807n
    )
      return reject("DAY_NOTE_VALIDATION");
    const dayNoteId = root?.id ?? randomUUID();
    const revisionId = randomUUID();
    const nextRevision = (BigInt(input.expectedRevision) + 1n).toString();
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(transaction))
      .rows[0]?.now;
    if (!now) throw new Error("Day note clock unavailable");
    const timestamp = new Date(now).toISOString();
    if (!root)
      await transaction
        .insertInto("diary_day_note")
        .values({
          id: dayNoteId,
          user_id: input.userId,
          local_date: input.localDate,
          current_revision_id: revisionId,
          current_revision_number: nextRevision,
          state: "active",
          created_at: timestamp,
          updated_at: timestamp,
        })
        .execute();
    await transaction
      .insertInto("diary_day_note_revision")
      .values({
        id: revisionId,
        day_note_id: dayNoteId,
        user_id: input.userId,
        local_date: input.localDate,
        revision_number: nextRevision,
        supersedes_revision_id: root?.current_revision_id ?? null,
        operation: input.note === null ? "clear" : "set",
        note: input.note,
        recorded_time_zone: input.expectedProfileTimeZone,
        created_at: timestamp,
      })
      .execute();
    if (root)
      await transaction
        .updateTable("diary_day_note")
        .set({
          current_revision_id: revisionId,
          current_revision_number: nextRevision,
          state: input.note === null ? "cleared" : "active",
          updated_at: timestamp,
        })
        .where("id", "=", dayNoteId)
        .where("user_id", "=", input.userId)
        .execute();
    const result: DayNoteMutationRecord = {
      data: {
        replayed: false,
        note: await readNote(transaction, input.userId, input.localDate),
        receipt: {
          protocol: "diary-day-note-v1",
          operationId: input.clientOperationId,
          ownerUserId: input.userId,
          localDate: input.localDate,
          expectedRevision: input.expectedRevision,
          expectedProfileTimeZone: input.expectedProfileTimeZone,
          resultRevision: nextRevision,
        },
      },
    };
    await transaction
      .insertInto("diary_day_note_operation")
      .values({
        user_id: input.userId,
        client_operation_id: input.clientOperationId,
        request_digest: input.requestDigest,
        day_note_id: dayNoteId,
        result_payload: JSON.parse(JSON.stringify(result)) as JsonObject,
        created_at: timestamp,
      })
      .execute();
    return result;
  });
}
