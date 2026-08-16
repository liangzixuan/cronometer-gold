import type { Kysely } from "kysely";
import { sql } from "kysely";

import { FoodSearchProjectionRevisionChangedError } from "./food-search.js";
import type { Database, JsonObject } from "./types.js";

const FOOD_SEARCH_REBUILD_EVENT = "catalogue.source_release_activated";
const FOOD_SEARCH_REBUILD_LOCK = "nutrition-tracker:food-search-rebuild:v1";
const DEFAULT_STALE_LOCK_SECONDS = 300;
const MAX_STALE_LOCK_SECONDS = 3_600;
const DEFAULT_REBUILD_EVENT_BATCH_SIZE = 100;
const MAX_REBUILD_EVENT_BATCH_SIZE = 500;
const MAX_REBUILD_FAILURES = 8;
const INITIAL_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 3_600;
const MAX_BIGINT_ID = 9_223_372_036_854_775_807n;

export interface ClaimFoodSearchRebuildEventInput {
  /** Optional source aggregate partition; omit for the ordinary global worker. */
  readonly aggregateId?: string;
  /** Stable deployment/instance identity; must not contain a random value per poll. */
  readonly workerId: string;
  readonly staleLockSeconds?: number;
}

export interface ClaimFoodSearchRebuildEventsInput extends ClaimFoodSearchRebuildEventInput {
  /** Bounds one coalesced full-catalogue rebuild and its atomic acknowledgement. */
  readonly limit?: number;
}

export interface ClaimedFoodSearchRebuildEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventVersion: number;
  readonly payload: JsonObject;
  readonly occurredAt: string;
  /** One plus the number of recorded processing failures. */
  readonly attemptNumber: number;
  readonly workerId: string;
}

export interface MarkFoodSearchRebuildEventPublishedInput {
  readonly eventId: string;
  readonly workerId: string;
}

export interface MarkFoodSearchRebuildEventsPublishedInput {
  readonly eventIds: readonly string[];
  readonly workerId: string;
}

export interface PublishFoodSearchProjectionAndAcknowledgeEventsInput
  extends MarkFoodSearchRebuildEventsPublishedInput {
  /** Exact authority revision returned by the verified external index swap. */
  readonly expectedRevision: string;
}

export interface ReleaseFoodSearchRebuildEventInput {
  readonly eventId: string;
  /** Sanitized machine code, never an exception message or user/source data. */
  readonly errorCode: string;
  readonly workerId: string;
}

export interface ReleaseFoodSearchRebuildEventsInput {
  readonly eventIds: readonly string[];
  readonly errorCode: string;
  readonly workerId: string;
}

export interface ReleasedFoodSearchRebuildEvent {
  readonly attemptCount: number;
  readonly availableAt: string | null;
  readonly deadLettered: boolean;
}

export interface ReleasedFoodSearchRebuildEventResult extends ReleasedFoodSearchRebuildEvent {
  readonly eventId: string;
}

export interface FoodSearchRebuildLockResult<Result> {
  readonly acquired: true;
  readonly result: Result;
}

/** Atomically claim one due rebuild event, recovering a stale worker lock. */
export async function claimFoodSearchRebuildEvent(
  database: Kysely<Database>,
  input: ClaimFoodSearchRebuildEventInput,
): Promise<ClaimedFoodSearchRebuildEvent | null> {
  return (await claimFoodSearchRebuildEvents(database, { ...input, limit: 1 }))[0] ?? null;
}

/** Atomically claim a bounded due batch so one full rebuild coalesces activations. */
export async function claimFoodSearchRebuildEvents(
  database: Kysely<Database>,
  input: ClaimFoodSearchRebuildEventsInput,
): Promise<readonly ClaimedFoodSearchRebuildEvent[]> {
  const workerId = normalizeWorkerId(input.workerId);
  const aggregateId = input.aggregateId ? normalizeAggregateId(input.aggregateId) : null;
  const limit = boundedInteger(
    input.limit,
    DEFAULT_REBUILD_EVENT_BATCH_SIZE,
    1,
    MAX_REBUILD_EVENT_BATCH_SIZE,
    "limit",
  );
  const staleLockSeconds = boundedInteger(
    input.staleLockSeconds,
    DEFAULT_STALE_LOCK_SECONDS,
    30,
    MAX_STALE_LOCK_SECONDS,
    "staleLockSeconds",
  );
  const result = await sql<{
    aggregate_id: string;
    attempt_count: number;
    event_version: number;
    id: string;
    occurred_at: Date;
    payload: JsonObject;
  }>`
    with candidate as (
      select event.id
      from outbox_event as event
      where event.event_type = ${FOOD_SEARCH_REBUILD_EVENT}
        and event.aggregate_type = 'food_source'
        and event.published_at is null
        and event.dead_lettered_at is null
        and event.attempt_count < ${MAX_REBUILD_FAILURES}
        and (${aggregateId}::text is null or event.aggregate_id = ${aggregateId})
        and event.available_at <= clock_timestamp()
        and (
          event.locked_at is null
          or event.locked_at < clock_timestamp() - make_interval(secs => ${staleLockSeconds})
        )
      order by event.available_at, event.occurred_at, event.id
      for update skip locked
      limit ${limit}
    )
    update outbox_event as event
    set locked_at = clock_timestamp(), locked_by = ${workerId}
    from candidate
    where event.id = candidate.id
    returning
      event.id,
      event.aggregate_id,
      event.event_version,
      event.payload,
      event.occurred_at,
      event.attempt_count
  `.execute(database);
  return result.rows
    .map((event) => ({
      aggregateId: event.aggregate_id,
      attemptNumber: event.attempt_count + 1,
      eventVersion: event.event_version,
      id: event.id,
      occurredAt: event.occurred_at.toISOString(),
      payload: event.payload,
      workerId,
    }))
    .sort((left, right) =>
      left.occurredAt === right.occurredAt
        ? left.id.localeCompare(right.id)
        : left.occurredAt.localeCompare(right.occurredAt),
    );
}

/** Acknowledge only the event lock owned by this stable worker identity. */
export async function markFoodSearchRebuildEventPublished(
  database: Kysely<Database>,
  input: MarkFoodSearchRebuildEventPublishedInput,
): Promise<void> {
  await markFoodSearchRebuildEventsPublished(database, {
    eventIds: [input.eventId],
    workerId: input.workerId,
  });
}

/** Acknowledge the complete claimed batch atomically after the index swap. */
export async function markFoodSearchRebuildEventsPublished(
  database: Kysely<Database>,
  input: MarkFoodSearchRebuildEventsPublishedInput,
): Promise<void> {
  const workerId = normalizeWorkerId(input.workerId);
  const eventIds = normalizeEventIds(input.eventIds);
  await database.transaction().execute(async (transaction) => {
    const updated = await transaction
      .updateTable("outbox_event")
      .set({
        last_error: null,
        locked_at: null,
        locked_by: null,
        published_at: sql`clock_timestamp()`,
      })
      .where("id", "in", eventIds)
      .where("aggregate_type", "=", "food_source")
      .where("event_type", "=", FOOD_SEARCH_REBUILD_EVENT)
      .where("published_at", "is", null)
      .where("dead_lettered_at", "is", null)
      .where("locked_by", "=", workerId)
      .returning("id")
      .execute();
    if (updated.length !== eventIds.length) {
      throw new Error("food-search rebuild event lock is missing or owned by another worker");
    }
  });
}

/**
 * Commit the verified projection revision and its complete claimed event batch
 * as one database transaction. A lost acknowledgement can therefore never
 * make an older external index appear current.
 */
export async function publishFoodSearchProjectionAndAcknowledgeEvents(
  database: Kysely<Database>,
  input: PublishFoodSearchProjectionAndAcknowledgeEventsInput,
): Promise<void> {
  const workerId = normalizeWorkerId(input.workerId);
  const eventIds = normalizeEventIds(input.eventIds);
  const expectedRevision = normalizeProjectionRevision(input.expectedRevision);
  await database.transaction().execute(async (transaction) => {
    const state = await transaction
      .selectFrom("food_search_projection_revision")
      .select("current_revision")
      .where("singleton", "=", true)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (state.current_revision !== expectedRevision) {
      throw new FoodSearchProjectionRevisionChangedError();
    }

    await transaction
      .updateTable("food_search_projection_revision")
      .set({
        published_revision: expectedRevision,
        updated_at: sql`clock_timestamp()`,
      })
      .where("singleton", "=", true)
      .executeTakeFirstOrThrow();

    const acknowledged = await transaction
      .updateTable("outbox_event")
      .set({
        last_error: null,
        locked_at: null,
        locked_by: null,
        published_at: sql`clock_timestamp()`,
      })
      .where("id", "in", eventIds)
      .where("aggregate_type", "=", "food_source")
      .where("event_type", "=", FOOD_SEARCH_REBUILD_EVENT)
      .where("published_at", "is", null)
      .where("dead_lettered_at", "is", null)
      .where("locked_by", "=", workerId)
      .returning("id")
      .execute();
    if (acknowledged.length !== eventIds.length) {
      throw new Error("food-search rebuild event lock is missing or owned by another worker");
    }
  });
}

/** Record a bounded retry or dead-letter the event after eight processing failures. */
export async function releaseFoodSearchRebuildEvent(
  database: Kysely<Database>,
  input: ReleaseFoodSearchRebuildEventInput,
): Promise<ReleasedFoodSearchRebuildEvent> {
  const released = await releaseFoodSearchRebuildEvents(database, {
    eventIds: [input.eventId],
    errorCode: input.errorCode,
    workerId: input.workerId,
  });
  const first = released[0];
  if (!first) throw new Error("food-search rebuild event release returned no row");
  return first;
}

/** Atomically release or dead-letter every event represented by a failed rebuild. */
export async function releaseFoodSearchRebuildEvents(
  database: Kysely<Database>,
  input: ReleaseFoodSearchRebuildEventsInput,
): Promise<readonly ReleasedFoodSearchRebuildEventResult[]> {
  const workerId = normalizeWorkerId(input.workerId);
  const eventIds = normalizeEventIds(input.eventIds);
  const errorCode = normalizeErrorCode(input.errorCode);
  return database.transaction().execute(async (transaction) => {
    const events = await transaction
      .selectFrom("outbox_event")
      .select(["id", "attempt_count", "locked_by"])
      .where("id", "in", eventIds)
      .where("aggregate_type", "=", "food_source")
      .where("event_type", "=", FOOD_SEARCH_REBUILD_EVENT)
      .where("published_at", "is", null)
      .where("dead_lettered_at", "is", null)
      .orderBy("id")
      .forUpdate()
      .execute();
    if (events.length !== eventIds.length || events.some((event) => event.locked_by !== workerId)) {
      throw new Error("food-search rebuild event lock is missing or owned by another worker");
    }
    const released: ReleasedFoodSearchRebuildEventResult[] = [];
    for (const event of events) {
      const attemptCount = event.attempt_count + 1;
      const deadLettered = attemptCount >= MAX_REBUILD_FAILURES;
      const retrySeconds = Math.min(
        INITIAL_RETRY_SECONDS * 2 ** Math.max(0, attemptCount - 1),
        MAX_RETRY_SECONDS,
      );
      const updated = await transaction
        .updateTable("outbox_event")
        .set({
          attempt_count: attemptCount,
          available_at: deadLettered
            ? sql`available_at`
            : sql`clock_timestamp() + make_interval(secs => ${retrySeconds})`,
          dead_lettered_at: deadLettered ? sql`clock_timestamp()` : null,
          last_error: errorCode,
          locked_at: null,
          locked_by: null,
        })
        .where("id", "=", event.id)
        .returning(["attempt_count", "available_at", "dead_lettered_at"])
        .executeTakeFirstOrThrow();
      released.push({
        attemptCount: updated.attempt_count,
        availableAt: deadLettered ? null : updated.available_at.toISOString(),
        deadLettered: updated.dead_lettered_at !== null,
        eventId: event.id,
      });
    }
    return released.sort(
      (left, right) => eventIds.indexOf(left.eventId) - eventIds.indexOf(right.eventId),
    );
  });
}

/**
 * Hold a session-level advisory lock for the complete build-and-swap operation.
 * `null` means another builder owns the lock; operation failures are rethrown
 * after the pinned session is unlocked.
 */
export async function withFoodSearchRebuildLock<Result>(
  database: Kysely<Database>,
  operation: (connection: Kysely<Database>) => Promise<Result>,
): Promise<FoodSearchRebuildLockResult<Result> | null> {
  return database.connection().execute(async (connection) => {
    const acquired = await sql<{ acquired: boolean }>`
      select pg_try_advisory_lock(hashtext(${FOOD_SEARCH_REBUILD_LOCK})) as acquired
    `.execute(connection);
    if (acquired.rows[0]?.acquired !== true) return null;
    let operationCompleted = false;
    let operationResult: Result | undefined;
    let operationFailure: unknown;
    try {
      operationResult = await operation(connection);
      operationCompleted = true;
    } catch (error) {
      operationFailure = error;
    }
    const released = await sql<{ released: boolean }>`
      select pg_advisory_unlock(hashtext(${FOOD_SEARCH_REBUILD_LOCK})) as released
    `.execute(connection);
    if (released.rows[0]?.released !== true) {
      throw new Error("food-search rebuild advisory lock could not be released", {
        cause: operationFailure,
      });
    }
    if (!operationCompleted) throw operationFailure;
    return { acquired: true, result: operationResult as Result };
  });
}

function normalizeWorkerId(value: string): string {
  const candidate = value.trim();
  if (
    candidate !== value ||
    candidate !== candidate.toLowerCase() ||
    !/^[a-z0-9][a-z0-9._:/-]{2,127}$/.test(candidate)
  ) {
    throw new Error("workerId must be a stable canonical lowercase identity");
  }
  return candidate;
}

function normalizeErrorCode(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) {
    throw new Error("errorCode must be a sanitized uppercase machine code");
  }
  return value;
}

function normalizeProjectionRevision(value: string): string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value) || BigInt(value) > MAX_BIGINT_ID) {
    throw new Error("expectedRevision must be a PostgreSQL bigint decimal string");
  }
  return value;
}

function normalizeUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
}

function normalizeEventIds(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > MAX_REBUILD_EVENT_BATCH_SIZE) {
    throw new Error(
      `eventIds must contain between 1 and ${MAX_REBUILD_EVENT_BATCH_SIZE} identifiers`,
    );
  }
  const unique = new Set<string>();
  for (const value of values) {
    normalizeUuid(value, "eventId");
    if (unique.has(value)) throw new Error("eventIds must not contain duplicates");
    unique.add(value);
  }
  return [...values];
}

function normalizeAggregateId(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("aggregateId must be a positive decimal food-source ID");
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}
