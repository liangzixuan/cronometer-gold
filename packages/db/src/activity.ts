import { randomUUID } from "node:crypto";

import {
  canonicalActivityDurationMinutes,
  canonicalActivityName,
  canonicalActivitySelfReportedEnergyKilocalories,
  canonicalIanaTimeZone,
  deriveDiaryLocalCoordinates,
  MAX_ACTIVITY_ENTRIES_PER_DAY,
  sumActivityDurationMinutes,
} from "@nutrition-tracker/domain";
import { type Kysely, sql, type Transaction } from "kysely";

import type { Database, JsonObject } from "./types.js";

export type ActivityPersistenceErrorCode =
  | "ACTIVITY_ENTRY_REVISION_CONFLICT"
  | "ACTIVITY_IDEMPOTENCY_CONFLICT"
  | "ACTIVITY_NOT_FOUND"
  | "ACTIVITY_TIME_ZONE_CHANGED"
  | "ACTIVITY_VALIDATION";

export class ActivityPersistenceError extends Error {
  override readonly name = "ActivityPersistenceError";
  constructor(
    readonly code: ActivityPersistenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class ActivityNotFoundError extends ActivityPersistenceError {
  constructor() {
    super("ACTIVITY_NOT_FOUND", "Activity entry not found");
  }
}

export class ActivityEntryRevisionConflictError extends ActivityPersistenceError {
  constructor() {
    super("ACTIVITY_ENTRY_REVISION_CONFLICT", "Activity entry revision does not match");
  }
}

export class ActivityIdempotencyConflictError extends ActivityPersistenceError {
  constructor() {
    super(
      "ACTIVITY_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for another activity request",
    );
  }
}

export class ActivityTimeZoneChangedError extends ActivityPersistenceError {
  constructor() {
    super("ACTIVITY_TIME_ZONE_CHANGED", "Profile time zone changed before activity entry creation");
  }
}

export class ActivityValidationError extends ActivityPersistenceError {
  constructor(message: string) {
    super("ACTIVITY_VALIDATION", message);
  }
}

export interface ActivityEntryRecord {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories: string | null;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly createdAt: string;
}

export interface ActivityDayRevisionRecord {
  readonly localDate: string;
  readonly revision: string;
}

export interface ActivityDayRecord {
  readonly localDate: string;
  /** Current profile zone. Each immutable entry also exposes its recording zone. */
  readonly timeZone: string;
  readonly revision: string;
  readonly entries: readonly ActivityEntryRecord[];
  /** Exact sum; overlapping activities are deliberately not deduplicated. */
  readonly totalDurationMinutes: number;
  readonly updatedAt: string | null;
}

export interface ActivityMutationResult {
  readonly replayed: boolean;
  readonly entry: ActivityEntryRecord | null;
  readonly days: readonly ActivityDayRevisionRecord[];
}

export interface CreateActivityEntryInput {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedProfileTimeZone?: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories: string | null;
  readonly occurredAt: string;
}

export interface UpdateActivityEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
  readonly expectedProfileTimeZone?: string;
  readonly name?: string;
  readonly durationMinutes?: number;
  readonly selfReportedEnergyKilocalories?: string | null;
  readonly occurredAt?: string;
}

export interface DeleteActivityEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
}

export interface GetActivityDayInput {
  readonly userId: string;
  readonly localDate: string;
}

interface ActivityCoordinates {
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
}

interface ActivityHead {
  readonly entryId: string;
  readonly dayId: string;
  readonly revisionId: string;
  readonly revisionNumber: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly selfReportedEnergyKilocalories: string | null;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
}

export async function createActivityEntry(
  database: Kysely<Database>,
  input: CreateActivityEntryInput,
): Promise<ActivityMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const name = boundedActivityName(input.name);
  const durationMinutes = boundedActivityDuration(input.durationMinutes);
  const selfReportedEnergyKilocalories = boundedActivityEnergy(
    input.selfReportedEnergyKilocalories,
  );
  const expectedProfileTimeZone = optionalExpectedProfileTimeZone(input.expectedProfileTimeZone);

  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserActivity(transaction, input.userId);
      await lockActiveActivityUser(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "create",
      );
      if (replay) return replay;

      const profile = await requireLockedProfile(transaction, input.userId);
      if (expectedProfileTimeZone !== undefined && profile.timeZone !== expectedProfileTimeZone) {
        throw new ActivityTimeZoneChangedError();
      }
      const coordinates = deriveActivityCoordinates(input.occurredAt, profile.timeZone);
      const day = await ensureActivityDay(transaction, input.userId, coordinates.localDate);
      await lockActivityDays(transaction, input.userId, [day.id]);
      await assertActivityDayBounds(transaction, input.userId, day.id);

      const entryId = randomUUID();
      const revisionId = randomUUID();
      await transaction
        .insertInto("activity_entry")
        .values({
          activity_day_id: day.id,
          current_revision_id: revisionId,
          current_revision_number: "1",
          duration_minutes: durationMinutes,
          id: entryId,
          local_time: coordinates.localTime,
          name,
          occurred_at: coordinates.occurredAt,
          self_reported_energy_kilocalories: selfReportedEnergyKilocalories,
          user_id: input.userId,
        })
        .execute();
      await insertActivityRevision(transaction, {
        coordinates,
        dayId: day.id,
        durationMinutes,
        entryId,
        name,
        operation: "create",
        revisionId,
        revisionNumber: "1",
        selfReportedEnergyKilocalories,
        supersedesRevisionId: null,
        userId: input.userId,
      });
      const dayRevision = await incrementActivityDay(transaction, day.id, input.userId);
      const entry = await loadActivityEntryByRevision(
        transaction,
        input.userId,
        entryId,
        revisionId,
      );
      const result: ActivityMutationResult = {
        days: [{ localDate: coordinates.localDate, revision: dayRevision }],
        entry,
        replayed: false,
      };
      await recordOperation(transaction, input, "create", entryId, result);
      return result;
    });
}

export async function updateActivityEntry(
  database: Kysely<Database>,
  input: UpdateActivityEntryInput,
): Promise<ActivityMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const expectedRevision = canonicalRevision(input.expectedEntryRevision);
  const expectedProfileTimeZone = optionalExpectedProfileTimeZone(input.expectedProfileTimeZone);
  if (
    input.name === undefined &&
    input.durationMinutes === undefined &&
    input.selfReportedEnergyKilocalories === undefined &&
    input.occurredAt === undefined
  ) {
    throw new ActivityValidationError("At least one activity field must be updated");
  }
  if (expectedProfileTimeZone !== undefined && input.occurredAt === undefined) {
    throw new ActivityValidationError(
      "expectedProfileTimeZone is only valid when occurredAt is updated",
    );
  }
  const requestedName = input.name === undefined ? undefined : boundedActivityName(input.name);
  const requestedDuration =
    input.durationMinutes === undefined
      ? undefined
      : boundedActivityDuration(input.durationMinutes);
  const requestedEnergy =
    input.selfReportedEnergyKilocalories === undefined
      ? undefined
      : boundedActivityEnergy(input.selfReportedEnergyKilocalories);

  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserActivity(transaction, input.userId);
      await lockActiveActivityUser(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "update",
      );
      if (replay) return replay;

      const profile = await requireLockedProfile(transaction, input.userId);
      if (expectedProfileTimeZone !== undefined && profile.timeZone !== expectedProfileTimeZone) {
        throw new ActivityTimeZoneChangedError();
      }
      const head = await loadOwnedActivityHeadForUpdate(transaction, input.userId, input.entryId);
      if (!head) throw new ActivityNotFoundError();
      if (head.revisionNumber !== expectedRevision) {
        throw new ActivityEntryRevisionConflictError();
      }

      const name = requestedName ?? head.name;
      const durationMinutes = requestedDuration ?? head.durationMinutes;
      const selfReportedEnergyKilocalories =
        requestedEnergy === undefined ? head.selfReportedEnergyKilocalories : requestedEnergy;
      const coordinates =
        input.occurredAt === undefined
          ? {
              localDate: head.localDate,
              localTime: head.localTime,
              occurredAt: head.occurredAt,
              timeZone: head.timeZone,
            }
          : deriveActivityCoordinates(input.occurredAt, profile.timeZone);
      const destination = await ensureActivityDay(transaction, input.userId, coordinates.localDate);
      await lockActivityDays(transaction, input.userId, [head.dayId, destination.id]);
      await assertActivityDayBounds(transaction, input.userId, destination.id, input.entryId);

      const revisionId = randomUUID();
      const revisionNumber = (BigInt(head.revisionNumber) + 1n).toString();
      await insertActivityRevision(transaction, {
        coordinates,
        dayId: destination.id,
        durationMinutes,
        entryId: input.entryId,
        name,
        operation: "update",
        revisionId,
        revisionNumber,
        selfReportedEnergyKilocalories,
        supersedesRevisionId: head.revisionId,
        userId: input.userId,
      });
      await transaction
        .updateTable("activity_entry")
        .set({
          activity_day_id: destination.id,
          current_revision_id: revisionId,
          current_revision_number: revisionNumber,
          duration_minutes: durationMinutes,
          local_time: coordinates.localTime,
          name,
          occurred_at: coordinates.occurredAt,
          self_reported_energy_kilocalories: selfReportedEnergyKilocalories,
          updated_at: sql`clock_timestamp()`,
        })
        .where("id", "=", input.entryId)
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const days = await incrementAffectedActivityDays(transaction, input.userId, [
        { id: head.dayId, localDate: head.localDate },
        { id: destination.id, localDate: coordinates.localDate },
      ]);
      const entry = await loadActivityEntryByRevision(
        transaction,
        input.userId,
        input.entryId,
        revisionId,
      );
      const result: ActivityMutationResult = { days, entry, replayed: false };
      await recordOperation(transaction, input, "update", input.entryId, result);
      return result;
    });
}

export async function deleteActivityEntry(
  database: Kysely<Database>,
  input: DeleteActivityEntryInput,
): Promise<ActivityMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const expectedRevision = canonicalRevision(input.expectedEntryRevision);

  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserActivity(transaction, input.userId);
      await lockActiveActivityUser(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "delete",
      );
      if (replay) return replay;
      await requireLockedProfile(transaction, input.userId);

      const head = await loadOwnedActivityHeadForUpdate(transaction, input.userId, input.entryId);
      if (!head) throw new ActivityNotFoundError();
      if (head.revisionNumber !== expectedRevision) {
        throw new ActivityEntryRevisionConflictError();
      }
      await lockActivityDays(transaction, input.userId, [head.dayId]);

      const revisionId = randomUUID();
      const revisionNumber = (BigInt(head.revisionNumber) + 1n).toString();
      await insertActivityRevision(transaction, {
        coordinates: {
          localDate: head.localDate,
          localTime: head.localTime,
          occurredAt: head.occurredAt,
          timeZone: head.timeZone,
        },
        dayId: head.dayId,
        durationMinutes: head.durationMinutes,
        entryId: input.entryId,
        name: head.name,
        operation: "delete",
        revisionId,
        revisionNumber,
        selfReportedEnergyKilocalories: head.selfReportedEnergyKilocalories,
        supersedesRevisionId: head.revisionId,
        userId: input.userId,
      });
      await transaction
        .updateTable("activity_entry")
        .set({
          current_revision_id: revisionId,
          current_revision_number: revisionNumber,
          deleted_at: sql`clock_timestamp()`,
          updated_at: sql`clock_timestamp()`,
        })
        .where("id", "=", input.entryId)
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const dayRevision = await incrementActivityDay(transaction, head.dayId, input.userId);
      const result: ActivityMutationResult = {
        days: [{ localDate: head.localDate, revision: dayRevision }],
        entry: null,
        replayed: false,
      };
      await recordOperation(transaction, input, "delete", input.entryId, result);
      return result;
    });
}

export async function getActivityDay(
  database: Kysely<Database>,
  input: GetActivityDayInput,
): Promise<ActivityDayRecord> {
  validateLocalDate(input.localDate);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      const profile = await requireProfile(transaction, input.userId);
      const day = await transaction
        .selectFrom("activity_day")
        .select(["id", "revision", "updated_at"])
        .where("user_id", "=", input.userId)
        .where("local_date", "=", input.localDate)
        .executeTakeFirst();
      if (!day) {
        return {
          entries: [],
          localDate: input.localDate,
          revision: "0",
          timeZone: profile.timeZone,
          totalDurationMinutes: 0,
          updatedAt: null,
        };
      }

      const rows = await transaction
        .selectFrom("activity_entry as entry")
        .innerJoin(
          "activity_entry_revision as revision",
          "revision.id",
          "entry.current_revision_id",
        )
        .select([
          "entry.id",
          "entry.current_revision_number",
          "entry.created_at",
          "revision.name",
          "revision.duration_minutes",
          "revision.self_reported_energy_kilocalories",
          "revision.occurred_at",
          "revision.local_date",
          "revision.local_time",
          "revision.time_zone",
        ])
        .where("entry.user_id", "=", input.userId)
        .where("entry.activity_day_id", "=", day.id)
        .where("entry.deleted_at", "is", null)
        .where("revision.operation", "!=", "delete")
        .orderBy("revision.occurred_at")
        .orderBy("entry.id")
        .execute();
      const entries = rows.map(toActivityEntryRecord);
      return {
        entries,
        localDate: input.localDate,
        revision: day.revision,
        timeZone: profile.timeZone,
        totalDurationMinutes: safeActivityDurationTotal(
          entries.map((entry) => entry.durationMinutes),
        ),
        updatedAt: day.updated_at.toISOString(),
      };
    });
}

async function insertActivityRevision(
  transaction: Transaction<Database>,
  input: {
    readonly coordinates: ActivityCoordinates;
    readonly dayId: string;
    readonly durationMinutes: number;
    readonly entryId: string;
    readonly name: string;
    readonly operation: "create" | "delete" | "update";
    readonly revisionId: string;
    readonly revisionNumber: string;
    readonly selfReportedEnergyKilocalories: string | null;
    readonly supersedesRevisionId: string | null;
    readonly userId: string;
  },
): Promise<void> {
  await transaction
    .insertInto("activity_entry_revision")
    .values({
      activity_day_id: input.dayId,
      activity_entry_id: input.entryId,
      duration_minutes: input.durationMinutes,
      id: input.revisionId,
      local_date: input.coordinates.localDate,
      local_time: input.coordinates.localTime,
      name: input.name,
      occurred_at: input.coordinates.occurredAt,
      operation: input.operation,
      revision_number: input.revisionNumber,
      self_reported_energy_kilocalories: input.selfReportedEnergyKilocalories,
      supersedes_revision_id: input.supersedesRevisionId,
      time_zone: input.coordinates.timeZone,
      user_id: input.userId,
    })
    .execute();
}

async function loadOwnedActivityHeadForUpdate(
  transaction: Transaction<Database>,
  userId: string,
  entryId: string,
): Promise<ActivityHead | null> {
  const row = await transaction
    .selectFrom("activity_entry as entry")
    .innerJoin("activity_entry_revision as revision", "revision.id", "entry.current_revision_id")
    .select([
      "entry.id as entry_id",
      "entry.activity_day_id",
      "revision.id as revision_id",
      "revision.revision_number",
      "revision.name",
      "revision.duration_minutes",
      "revision.self_reported_energy_kilocalories",
      "revision.occurred_at",
      "revision.local_date",
      "revision.local_time",
      "revision.time_zone",
    ])
    .where("entry.id", "=", entryId)
    .where("entry.user_id", "=", userId)
    .where("entry.deleted_at", "is", null)
    .where("revision.operation", "!=", "delete")
    .forUpdate("entry")
    .executeTakeFirst();
  if (!row) return null;
  return {
    dayId: row.activity_day_id,
    durationMinutes: row.duration_minutes,
    entryId: row.entry_id,
    localDate: normalizeDateOnly(row.local_date),
    localTime: row.local_time,
    name: row.name,
    occurredAt: row.occurred_at.toISOString(),
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    selfReportedEnergyKilocalories: row.self_reported_energy_kilocalories,
    timeZone: row.time_zone,
  };
}

async function loadActivityEntryByRevision(
  database: Kysely<Database>,
  userId: string,
  entryId: string,
  revisionId: string,
): Promise<ActivityEntryRecord> {
  const row = await database
    .selectFrom("activity_entry as entry")
    .innerJoin("activity_entry_revision as revision", (join) =>
      join.onRef("revision.activity_entry_id", "=", "entry.id").on("revision.id", "=", revisionId),
    )
    .select([
      "entry.id",
      "entry.created_at",
      "revision.revision_number",
      "revision.name",
      "revision.duration_minutes",
      "revision.self_reported_energy_kilocalories",
      "revision.occurred_at",
      "revision.local_date",
      "revision.local_time",
      "revision.time_zone",
    ])
    .where("entry.id", "=", entryId)
    .where("entry.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new ActivityNotFoundError();
  return toActivityEntryRecord({
    ...row,
    current_revision_number: row.revision_number,
  });
}

function toActivityEntryRecord(row: {
  readonly id: string;
  readonly current_revision_number: string;
  readonly name: string;
  readonly duration_minutes: number;
  readonly self_reported_energy_kilocalories: string | null;
  readonly occurred_at: Date;
  readonly local_date: string | Date;
  readonly local_time: string;
  readonly time_zone: string;
  readonly created_at: Date;
}): ActivityEntryRecord {
  return {
    createdAt: row.created_at.toISOString(),
    durationMinutes: row.duration_minutes,
    id: row.id,
    localDate: normalizeDateOnly(row.local_date),
    localTime: row.local_time,
    name: row.name,
    occurredAt: row.occurred_at.toISOString(),
    revision: row.current_revision_number,
    selfReportedEnergyKilocalories: row.self_reported_energy_kilocalories,
    timeZone: row.time_zone,
  };
}

async function ensureActivityDay(
  transaction: Transaction<Database>,
  userId: string,
  localDate: string,
): Promise<{ readonly id: string }> {
  await transaction
    .insertInto("activity_day")
    .values({ local_date: localDate, user_id: userId })
    .onConflict((conflict) => conflict.columns(["user_id", "local_date"]).doNothing())
    .execute();
  return transaction
    .selectFrom("activity_day")
    .select("id")
    .where("user_id", "=", userId)
    .where("local_date", "=", localDate)
    .executeTakeFirstOrThrow();
}

async function lockActivityDays(
  transaction: Transaction<Database>,
  userId: string,
  dayIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(dayIds)].sort();
  const rows = await transaction
    .selectFrom("activity_day")
    .select("id")
    .where("user_id", "=", userId)
    .where("id", "in", uniqueIds)
    .orderBy("id")
    .forUpdate()
    .execute();
  if (rows.length !== uniqueIds.length) throw new ActivityNotFoundError();
}

async function assertActivityDayBounds(
  transaction: Transaction<Database>,
  userId: string,
  dayId: string,
  replacedEntryId?: string,
): Promise<void> {
  let query = transaction
    .selectFrom("activity_entry")
    .select(({ fn }) => fn.countAll<string>().as("active_count"))
    .where("user_id", "=", userId)
    .where("activity_day_id", "=", dayId)
    .where("deleted_at", "is", null);
  if (replacedEntryId !== undefined) query = query.where("id", "!=", replacedEntryId);
  const row = await query.executeTakeFirstOrThrow();
  if (BigInt(row.active_count) + 1n > BigInt(MAX_ACTIVITY_ENTRIES_PER_DAY)) {
    throw new ActivityValidationError("Activity day has reached the supported entry limit");
  }
}

async function incrementAffectedActivityDays(
  transaction: Transaction<Database>,
  userId: string,
  days: readonly { readonly id: string; readonly localDate: string }[],
): Promise<readonly ActivityDayRevisionRecord[]> {
  const unique = [...new Map(days.map((day) => [day.id, day])).values()].sort((left, right) =>
    left.localDate.localeCompare(right.localDate),
  );
  const revisions: ActivityDayRevisionRecord[] = [];
  for (const day of unique) {
    revisions.push({
      localDate: day.localDate,
      revision: await incrementActivityDay(transaction, day.id, userId),
    });
  }
  return revisions;
}

async function incrementActivityDay(
  transaction: Transaction<Database>,
  dayId: string,
  userId: string,
): Promise<string> {
  const row = await transaction
    .updateTable("activity_day")
    .set({ revision: sql<string>`revision + 1`, updated_at: sql`clock_timestamp()` })
    .where("id", "=", dayId)
    .where("user_id", "=", userId)
    .returning("revision")
    .executeTakeFirst();
  if (!row) throw new ActivityNotFoundError();
  return row.revision;
}

async function lockUserActivity(transaction: Transaction<Database>, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:activity:${userId}`}, 0))`.execute(
    transaction,
  );
}

async function lockActiveActivityUser(
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
  if (!row) throw new ActivityNotFoundError();
}

async function requireLockedProfile(
  transaction: Transaction<Database>,
  userId: string,
): Promise<{ readonly timeZone: string }> {
  const row = await transaction
    .selectFrom("user_profile")
    .select("time_zone")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new ActivityNotFoundError();
  return { timeZone: row.time_zone };
}

async function requireProfile(
  database: Kysely<Database>,
  userId: string,
): Promise<{ readonly timeZone: string }> {
  const row = await database
    .selectFrom("user_profile as profile")
    .innerJoin("app_user as user", "user.id", "profile.user_id")
    .select("profile.time_zone")
    .where("profile.user_id", "=", userId)
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new ActivityNotFoundError();
  return { timeZone: row.time_zone };
}

async function readOperationReplay(
  transaction: Transaction<Database>,
  userId: string,
  clientOperationId: string,
  requestDigest: string,
  operation: "create" | "delete" | "update",
): Promise<ActivityMutationResult | null> {
  const existing = await transaction
    .selectFrom("activity_operation")
    .select(["request_digest", "operation", "result_payload"])
    .where("user_id", "=", userId)
    .where("client_operation_id", "=", clientOperationId)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.request_digest !== requestDigest || existing.operation !== operation) {
    throw new ActivityIdempotencyConflictError();
  }
  return { ...(existing.result_payload as unknown as ActivityMutationResult), replayed: true };
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
  result: ActivityMutationResult,
): Promise<void> {
  await transaction
    .insertInto("activity_operation")
    .values({
      activity_entry_id: entryId,
      client_operation_id: input.clientOperationId,
      operation,
      request_digest: input.requestDigest,
      result_payload: JSON.parse(JSON.stringify(result)) as JsonObject,
      user_id: input.userId,
    })
    .execute();
}

function boundedActivityName(value: string): string {
  try {
    return canonicalActivityName(value);
  } catch {
    throw new ActivityValidationError("name is outside the supported boundary");
  }
}

function boundedActivityDuration(value: number): number {
  try {
    return canonicalActivityDurationMinutes(value);
  } catch {
    throw new ActivityValidationError("durationMinutes is outside the supported boundary");
  }
}

function boundedActivityEnergy(value: string | null): string | null {
  try {
    return canonicalActivitySelfReportedEnergyKilocalories(value);
  } catch {
    throw new ActivityValidationError(
      "selfReportedEnergyKilocalories is outside the supported boundary",
    );
  }
}

function safeActivityDurationTotal(durations: readonly number[]): number {
  try {
    return sumActivityDurationMinutes(durations);
  } catch {
    throw new ActivityValidationError("Persisted activity day violates supported boundaries");
  }
}

function deriveActivityCoordinates(occurredAt: string, timeZone: string): ActivityCoordinates {
  try {
    return deriveDiaryLocalCoordinates(occurredAt, timeZone);
  } catch {
    throw new ActivityValidationError(
      "occurredAt and profile time zone must define valid local coordinates",
    );
  }
}

function optionalExpectedProfileTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return canonicalIanaTimeZone(value);
  } catch {
    throw new ActivityValidationError(
      "expectedProfileTimeZone must be a supported IANA time-zone identifier",
    );
  }
}

function validateOperationIdentity(clientOperationId: string, requestDigest: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      clientOperationId,
    )
  ) {
    throw new ActivityValidationError("clientOperationId must be a UUID");
  }
  if (!/^[0-9a-f]{64}$/u.test(requestDigest)) {
    throw new ActivityValidationError("requestDigest must be a lowercase SHA-256 hex");
  }
}

function canonicalRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new ActivityValidationError("Revision must be positive");
  }
  return text;
}

function validateLocalDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new ActivityValidationError("localDate is invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ActivityValidationError("localDate is invalid");
  }
}

function normalizeDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
