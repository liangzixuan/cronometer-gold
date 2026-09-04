import { randomUUID } from "node:crypto";

import {
  canonicalHydrationAmountMilliliters,
  canonicalIanaTimeZone,
  deriveDiaryLocalCoordinates,
  MAX_HYDRATION_DAY_TOTAL_MILLILITERS,
  MAX_HYDRATION_ENTRIES_PER_DAY,
  sumHydrationMilliliters,
} from "@nutrition-tracker/domain";
import { type Kysely, sql, type Transaction } from "kysely";

import type { Database, JsonObject } from "./types.js";

export type HydrationPersistenceErrorCode =
  | "HYDRATION_ENTRY_REVISION_CONFLICT"
  | "HYDRATION_IDEMPOTENCY_CONFLICT"
  | "HYDRATION_NOT_FOUND"
  | "HYDRATION_TIME_ZONE_CHANGED"
  | "HYDRATION_VALIDATION";

export class HydrationPersistenceError extends Error {
  override readonly name = "HydrationPersistenceError";
  constructor(
    readonly code: HydrationPersistenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class HydrationNotFoundError extends HydrationPersistenceError {
  constructor() {
    super("HYDRATION_NOT_FOUND", "Hydration entry not found");
  }
}

export class HydrationEntryRevisionConflictError extends HydrationPersistenceError {
  constructor() {
    super("HYDRATION_ENTRY_REVISION_CONFLICT", "Hydration entry revision does not match");
  }
}

export class HydrationIdempotencyConflictError extends HydrationPersistenceError {
  constructor() {
    super(
      "HYDRATION_IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for another hydration request",
    );
  }
}

export class HydrationTimeZoneChangedError extends HydrationPersistenceError {
  constructor() {
    super(
      "HYDRATION_TIME_ZONE_CHANGED",
      "Profile time zone changed before hydration entry creation",
    );
  }
}

export class HydrationValidationError extends HydrationPersistenceError {
  constructor(message: string) {
    super("HYDRATION_VALIDATION", message);
  }
}

export interface HydrationEntryRecord {
  readonly id: string;
  readonly revision: string;
  readonly amountMilliliters: number;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly createdAt: string;
}

export interface HydrationDayRevisionRecord {
  readonly localDate: string;
  readonly revision: string;
}

export interface HydrationDayRecord {
  readonly localDate: string;
  /** Current profile zone. Each immutable entry also exposes its recording zone. */
  readonly timeZone: string;
  readonly revision: string;
  readonly entries: readonly HydrationEntryRecord[];
  readonly totalMilliliters: number;
  readonly updatedAt: string | null;
}

export interface HydrationMutationResult {
  readonly replayed: boolean;
  readonly entry: HydrationEntryRecord | null;
  readonly days: readonly HydrationDayRevisionRecord[];
}

export interface CreateHydrationEntryInput {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedProfileTimeZone?: string;
  readonly amountMilliliters: number;
  readonly occurredAt: string;
}

export interface UpdateHydrationEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
  readonly amountMilliliters?: number;
  readonly occurredAt?: string;
}

export interface DeleteHydrationEntryInput {
  readonly userId: string;
  readonly entryId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly expectedEntryRevision: bigint | number | string;
}

export interface GetHydrationDayInput {
  readonly userId: string;
  readonly localDate: string;
}

interface HydrationCoordinates {
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
}

interface HydrationHead {
  readonly entryId: string;
  readonly dayId: string;
  readonly revisionId: string;
  readonly revisionNumber: string;
  readonly amountMilliliters: number;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
}

export async function createHydrationEntry(
  database: Kysely<Database>,
  input: CreateHydrationEntryInput,
): Promise<HydrationMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const amountMilliliters = boundedHydrationAmount(input.amountMilliliters);
  const expectedProfileTimeZone = optionalExpectedProfileTimeZone(input.expectedProfileTimeZone);

  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserHydration(transaction, input.userId);
      await lockActiveHydrationUser(transaction, input.userId);
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
        throw new HydrationTimeZoneChangedError();
      }
      const coordinates = deriveHydrationCoordinates(input.occurredAt, profile.timeZone);
      const day = await ensureHydrationDay(transaction, input.userId, coordinates);
      await lockHydrationDays(transaction, input.userId, [day.id]);
      await assertHydrationDayBounds(transaction, input.userId, day.id, amountMilliliters);

      const entryId = randomUUID();
      const revisionId = randomUUID();
      await transaction
        .insertInto("hydration_entry")
        .values({
          amount_milliliters: amountMilliliters,
          current_revision_id: revisionId,
          current_revision_number: "1",
          hydration_day_id: day.id,
          id: entryId,
          local_time: coordinates.localTime,
          occurred_at: coordinates.occurredAt,
          user_id: input.userId,
        })
        .execute();
      await insertHydrationRevision(transaction, {
        amountMilliliters,
        coordinates,
        dayId: day.id,
        entryId,
        operation: "create",
        revisionId,
        revisionNumber: "1",
        supersedesRevisionId: null,
        userId: input.userId,
      });
      const dayRevision = await incrementHydrationDay(transaction, day.id, input.userId);
      const entry = await loadHydrationEntryByRevision(
        transaction,
        input.userId,
        entryId,
        revisionId,
      );
      const result: HydrationMutationResult = {
        days: [{ localDate: coordinates.localDate, revision: dayRevision }],
        entry,
        replayed: false,
      };
      await recordOperation(transaction, input, "create", entryId, result);
      return result;
    });
}

export async function updateHydrationEntry(
  database: Kysely<Database>,
  input: UpdateHydrationEntryInput,
): Promise<HydrationMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const expectedRevision = canonicalRevision(input.expectedEntryRevision);
  if (input.amountMilliliters === undefined && input.occurredAt === undefined) {
    throw new HydrationValidationError("At least one hydration field must be updated");
  }
  const requestedAmount =
    input.amountMilliliters === undefined
      ? undefined
      : boundedHydrationAmount(input.amountMilliliters);

  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserHydration(transaction, input.userId);
      await lockActiveHydrationUser(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "update",
      );
      if (replay) return replay;

      const profile = await requireLockedProfile(transaction, input.userId);
      const head = await loadOwnedHydrationHeadForUpdate(transaction, input.userId, input.entryId);
      if (!head) throw new HydrationNotFoundError();
      if (head.revisionNumber !== expectedRevision) {
        throw new HydrationEntryRevisionConflictError();
      }

      const amountMilliliters = requestedAmount ?? head.amountMilliliters;
      const coordinates =
        input.occurredAt === undefined
          ? {
              localDate: head.localDate,
              localTime: head.localTime,
              occurredAt: head.occurredAt,
              timeZone: head.timeZone,
            }
          : deriveHydrationCoordinates(input.occurredAt, profile.timeZone);
      const destination = await ensureHydrationDay(transaction, input.userId, coordinates);
      await lockHydrationDays(transaction, input.userId, [head.dayId, destination.id]);
      await assertHydrationDayBounds(
        transaction,
        input.userId,
        destination.id,
        amountMilliliters,
        input.entryId,
      );

      const revisionId = randomUUID();
      const revisionNumber = (BigInt(head.revisionNumber) + 1n).toString();
      await insertHydrationRevision(transaction, {
        amountMilliliters,
        coordinates,
        dayId: destination.id,
        entryId: input.entryId,
        operation: "update",
        revisionId,
        revisionNumber,
        supersedesRevisionId: head.revisionId,
        userId: input.userId,
      });
      await transaction
        .updateTable("hydration_entry")
        .set({
          amount_milliliters: amountMilliliters,
          current_revision_id: revisionId,
          current_revision_number: revisionNumber,
          hydration_day_id: destination.id,
          local_time: coordinates.localTime,
          occurred_at: coordinates.occurredAt,
          updated_at: sql`clock_timestamp()`,
        })
        .where("id", "=", input.entryId)
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const days = await incrementAffectedHydrationDays(transaction, input.userId, [
        { id: head.dayId, localDate: head.localDate },
        { id: destination.id, localDate: coordinates.localDate },
      ]);
      const entry = await loadHydrationEntryByRevision(
        transaction,
        input.userId,
        input.entryId,
        revisionId,
      );
      const result: HydrationMutationResult = { days, entry, replayed: false };
      await recordOperation(transaction, input, "update", input.entryId, result);
      return result;
    });
}

export async function deleteHydrationEntry(
  database: Kysely<Database>,
  input: DeleteHydrationEntryInput,
): Promise<HydrationMutationResult> {
  validateOperationIdentity(input.clientOperationId, input.requestDigest);
  const expectedRevision = canonicalRevision(input.expectedEntryRevision);

  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockUserHydration(transaction, input.userId);
      await lockActiveHydrationUser(transaction, input.userId);
      const replay = await readOperationReplay(
        transaction,
        input.userId,
        input.clientOperationId,
        input.requestDigest,
        "delete",
      );
      if (replay) return replay;
      await requireLockedProfile(transaction, input.userId);

      const head = await loadOwnedHydrationHeadForUpdate(transaction, input.userId, input.entryId);
      if (!head) throw new HydrationNotFoundError();
      if (head.revisionNumber !== expectedRevision) {
        throw new HydrationEntryRevisionConflictError();
      }
      await lockHydrationDays(transaction, input.userId, [head.dayId]);

      const revisionId = randomUUID();
      const revisionNumber = (BigInt(head.revisionNumber) + 1n).toString();
      await insertHydrationRevision(transaction, {
        amountMilliliters: head.amountMilliliters,
        coordinates: {
          localDate: head.localDate,
          localTime: head.localTime,
          occurredAt: head.occurredAt,
          timeZone: head.timeZone,
        },
        dayId: head.dayId,
        entryId: input.entryId,
        operation: "delete",
        revisionId,
        revisionNumber,
        supersedesRevisionId: head.revisionId,
        userId: input.userId,
      });
      await transaction
        .updateTable("hydration_entry")
        .set({
          current_revision_id: revisionId,
          current_revision_number: revisionNumber,
          deleted_at: sql`clock_timestamp()`,
          updated_at: sql`clock_timestamp()`,
        })
        .where("id", "=", input.entryId)
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const dayRevision = await incrementHydrationDay(transaction, head.dayId, input.userId);
      const result: HydrationMutationResult = {
        days: [{ localDate: head.localDate, revision: dayRevision }],
        entry: null,
        replayed: false,
      };
      await recordOperation(transaction, input, "delete", input.entryId, result);
      return result;
    });
}

export async function getHydrationDay(
  database: Kysely<Database>,
  input: GetHydrationDayInput,
): Promise<HydrationDayRecord> {
  validateLocalDate(input.localDate);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      const profile = await requireProfile(transaction, input.userId);
      const day = await transaction
        .selectFrom("hydration_day")
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
          totalMilliliters: 0,
          updatedAt: null,
        };
      }

      const rows = await transaction
        .selectFrom("hydration_entry as entry")
        .innerJoin(
          "hydration_entry_revision as revision",
          "revision.id",
          "entry.current_revision_id",
        )
        .select([
          "entry.id",
          "entry.current_revision_number",
          "entry.created_at",
          "revision.amount_milliliters",
          "revision.occurred_at",
          "revision.local_date",
          "revision.local_time",
          "revision.time_zone",
        ])
        .where("entry.user_id", "=", input.userId)
        .where("entry.hydration_day_id", "=", day.id)
        .where("entry.deleted_at", "is", null)
        .where("revision.operation", "!=", "delete")
        .orderBy("revision.occurred_at")
        .orderBy("entry.id")
        .execute();
      const entries = rows.map(toHydrationEntryRecord);
      return {
        entries,
        localDate: input.localDate,
        revision: day.revision,
        timeZone: profile.timeZone,
        totalMilliliters: safeHydrationTotal(entries.map((entry) => entry.amountMilliliters)),
        updatedAt: day.updated_at.toISOString(),
      };
    });
}

async function insertHydrationRevision(
  transaction: Transaction<Database>,
  input: {
    readonly amountMilliliters: number;
    readonly coordinates: HydrationCoordinates;
    readonly dayId: string;
    readonly entryId: string;
    readonly operation: "create" | "delete" | "update";
    readonly revisionId: string;
    readonly revisionNumber: string;
    readonly supersedesRevisionId: string | null;
    readonly userId: string;
  },
): Promise<void> {
  await transaction
    .insertInto("hydration_entry_revision")
    .values({
      amount_milliliters: input.amountMilliliters,
      hydration_day_id: input.dayId,
      hydration_entry_id: input.entryId,
      id: input.revisionId,
      local_date: input.coordinates.localDate,
      local_time: input.coordinates.localTime,
      occurred_at: input.coordinates.occurredAt,
      operation: input.operation,
      revision_number: input.revisionNumber,
      supersedes_revision_id: input.supersedesRevisionId,
      time_zone: input.coordinates.timeZone,
      user_id: input.userId,
    })
    .execute();
}

async function loadOwnedHydrationHeadForUpdate(
  transaction: Transaction<Database>,
  userId: string,
  entryId: string,
): Promise<HydrationHead | null> {
  const row = await transaction
    .selectFrom("hydration_entry as entry")
    .innerJoin("hydration_entry_revision as revision", "revision.id", "entry.current_revision_id")
    .select([
      "entry.id as entry_id",
      "entry.hydration_day_id",
      "revision.id as revision_id",
      "revision.revision_number",
      "revision.amount_milliliters",
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
    amountMilliliters: row.amount_milliliters,
    dayId: row.hydration_day_id,
    entryId: row.entry_id,
    localDate: normalizeDateOnly(row.local_date),
    localTime: row.local_time,
    occurredAt: row.occurred_at.toISOString(),
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    timeZone: row.time_zone,
  };
}

async function loadHydrationEntryByRevision(
  database: Kysely<Database>,
  userId: string,
  entryId: string,
  revisionId: string,
): Promise<HydrationEntryRecord> {
  const row = await database
    .selectFrom("hydration_entry as entry")
    .innerJoin("hydration_entry_revision as revision", (join) =>
      join.onRef("revision.hydration_entry_id", "=", "entry.id").on("revision.id", "=", revisionId),
    )
    .select([
      "entry.id",
      "entry.created_at",
      "revision.revision_number",
      "revision.amount_milliliters",
      "revision.occurred_at",
      "revision.local_date",
      "revision.local_time",
      "revision.time_zone",
    ])
    .where("entry.id", "=", entryId)
    .where("entry.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new HydrationNotFoundError();
  return toHydrationEntryRecord({
    ...row,
    current_revision_number: row.revision_number,
  });
}

function toHydrationEntryRecord(row: {
  readonly id: string;
  readonly current_revision_number: string;
  readonly amount_milliliters: number;
  readonly occurred_at: Date;
  readonly local_date: string | Date;
  readonly local_time: string;
  readonly time_zone: string;
  readonly created_at: Date;
}): HydrationEntryRecord {
  return {
    amountMilliliters: row.amount_milliliters,
    createdAt: row.created_at.toISOString(),
    id: row.id,
    localDate: normalizeDateOnly(row.local_date),
    localTime: row.local_time,
    occurredAt: row.occurred_at.toISOString(),
    revision: row.current_revision_number,
    timeZone: row.time_zone,
  };
}

async function ensureHydrationDay(
  transaction: Transaction<Database>,
  userId: string,
  coordinates: HydrationCoordinates,
): Promise<{ readonly id: string }> {
  await transaction
    .insertInto("hydration_day")
    .values({
      local_date: coordinates.localDate,
      time_zone: coordinates.timeZone,
      user_id: userId,
    })
    .onConflict((conflict) => conflict.columns(["user_id", "local_date"]).doNothing())
    .execute();
  return transaction
    .selectFrom("hydration_day")
    .select("id")
    .where("user_id", "=", userId)
    .where("local_date", "=", coordinates.localDate)
    .executeTakeFirstOrThrow();
}

async function lockHydrationDays(
  transaction: Transaction<Database>,
  userId: string,
  dayIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(dayIds)].sort();
  const rows = await transaction
    .selectFrom("hydration_day")
    .select("id")
    .where("user_id", "=", userId)
    .where("id", "in", uniqueIds)
    .orderBy("id")
    .forUpdate()
    .execute();
  if (rows.length !== uniqueIds.length) throw new HydrationNotFoundError();
}

async function assertHydrationDayBounds(
  transaction: Transaction<Database>,
  userId: string,
  dayId: string,
  nextAmountMilliliters: number,
  replacedEntryId?: string,
): Promise<void> {
  let query = transaction
    .selectFrom("hydration_entry")
    .select(({ fn }) => [
      fn.countAll<string>().as("active_count"),
      fn.sum<string | null>("amount_milliliters").as("active_total"),
    ])
    .where("user_id", "=", userId)
    .where("hydration_day_id", "=", dayId)
    .where("deleted_at", "is", null);
  if (replacedEntryId !== undefined) query = query.where("id", "!=", replacedEntryId);
  const row = await query.executeTakeFirstOrThrow();
  if (BigInt(row.active_count) + 1n > BigInt(MAX_HYDRATION_ENTRIES_PER_DAY)) {
    throw new HydrationValidationError("Hydration day has reached the supported entry limit");
  }
  if (
    BigInt(row.active_total ?? "0") + BigInt(nextAmountMilliliters) >
    BigInt(MAX_HYDRATION_DAY_TOTAL_MILLILITERS)
  ) {
    throw new HydrationValidationError("Hydration day has reached the supported volume limit");
  }
}

async function incrementAffectedHydrationDays(
  transaction: Transaction<Database>,
  userId: string,
  days: readonly { readonly id: string; readonly localDate: string }[],
): Promise<readonly HydrationDayRevisionRecord[]> {
  const unique = [...new Map(days.map((day) => [day.id, day])).values()].sort((left, right) =>
    left.localDate.localeCompare(right.localDate),
  );
  const revisions: HydrationDayRevisionRecord[] = [];
  for (const day of unique) {
    revisions.push({
      localDate: day.localDate,
      revision: await incrementHydrationDay(transaction, day.id, userId),
    });
  }
  return revisions;
}

async function incrementHydrationDay(
  transaction: Transaction<Database>,
  dayId: string,
  userId: string,
): Promise<string> {
  const row = await transaction
    .updateTable("hydration_day")
    .set({ revision: sql<string>`revision + 1`, updated_at: sql`clock_timestamp()` })
    .where("id", "=", dayId)
    .where("user_id", "=", userId)
    .returning("revision")
    .executeTakeFirst();
  if (!row) throw new HydrationNotFoundError();
  return row.revision;
}

async function lockUserHydration(
  transaction: Transaction<Database>,
  userId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:hydration:${userId}`}, 0))`.execute(
    transaction,
  );
}

async function lockActiveHydrationUser(
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
  if (!row) throw new HydrationNotFoundError();
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
  if (!row) throw new HydrationNotFoundError();
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
  if (!row) throw new HydrationNotFoundError();
  return { timeZone: row.time_zone };
}

async function readOperationReplay(
  transaction: Transaction<Database>,
  userId: string,
  clientOperationId: string,
  requestDigest: string,
  operation: "create" | "delete" | "update",
): Promise<HydrationMutationResult | null> {
  const existing = await transaction
    .selectFrom("hydration_operation")
    .select(["request_digest", "operation", "result_payload"])
    .where("user_id", "=", userId)
    .where("client_operation_id", "=", clientOperationId)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.request_digest !== requestDigest || existing.operation !== operation) {
    throw new HydrationIdempotencyConflictError();
  }
  return { ...(existing.result_payload as unknown as HydrationMutationResult), replayed: true };
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
  result: HydrationMutationResult,
): Promise<void> {
  await transaction
    .insertInto("hydration_operation")
    .values({
      client_operation_id: input.clientOperationId,
      hydration_entry_id: entryId,
      operation,
      request_digest: input.requestDigest,
      result_payload: JSON.parse(JSON.stringify(result)) as JsonObject,
      user_id: input.userId,
    })
    .execute();
}

function boundedHydrationAmount(value: number): number {
  try {
    return canonicalHydrationAmountMilliliters(value);
  } catch {
    throw new HydrationValidationError("amountMilliliters is outside the supported boundary");
  }
}

function safeHydrationTotal(amounts: readonly number[]): number {
  try {
    return sumHydrationMilliliters(amounts);
  } catch {
    throw new HydrationValidationError("Persisted hydration day violates supported boundaries");
  }
}

function deriveHydrationCoordinates(occurredAt: string, timeZone: string): HydrationCoordinates {
  try {
    return deriveDiaryLocalCoordinates(occurredAt, timeZone);
  } catch {
    throw new HydrationValidationError(
      "occurredAt and profile time zone must define valid local coordinates",
    );
  }
}

function optionalExpectedProfileTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return canonicalIanaTimeZone(value);
  } catch {
    throw new HydrationValidationError(
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
    throw new HydrationValidationError("clientOperationId must be a UUID");
  }
  if (!/^[0-9a-f]{64}$/u.test(requestDigest)) {
    throw new HydrationValidationError("requestDigest must be a lowercase SHA-256 hex");
  }
}

function canonicalRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new HydrationValidationError("Revision must be positive");
  }
  return text;
}

function validateLocalDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new HydrationValidationError("localDate is invalid");
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
    throw new HydrationValidationError("localDate is invalid");
  }
}

function normalizeDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
