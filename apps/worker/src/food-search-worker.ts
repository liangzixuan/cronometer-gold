import {
  assertFoodSearchProjectionRevision,
  claimFoodSearchRebuildEvents,
  publishFoodSearchProjectionAndAcknowledgeEvents,
  publishFoodSearchProjectionRevision,
  releaseFoodSearchRebuildEvents,
  withFoodSearchRebuildLock,
} from "@nutrition-tracker/db";
import {
  FoodSearchError,
  type FoodSearchIndexAdmin,
  type RebuildFoodSearchIndexResult,
  rebuildFoodSearchIndex,
} from "@nutrition-tracker/search";

import type { WorkerConfig } from "./config.js";
import {
  createPostgresFoodSearchProjectionSource,
  FoodSearchProjectionSpoolLimitError,
} from "./search-projection.js";

type FoodSearchDatabase = Parameters<typeof claimFoodSearchRebuildEvents>[0];

export type FoodSearchWorkerPollResult =
  | { readonly status: "busy" | "idle" }
  | {
      readonly status: "rebuilt";
      readonly eventId: string;
      readonly eventCount: number;
      readonly includedCount: number;
      readonly cleanup: RebuildFoodSearchIndexResult["cleanup"];
    }
  | {
      readonly status: "retry-scheduled";
      readonly eventId: string;
      readonly eventCount: number;
      readonly deadLettered: boolean;
    };

export interface RunFoodSearchWorkerPollOptions {
  readonly client: FoodSearchIndexAdmin;
  readonly config: Pick<
    WorkerConfig,
    | "SEARCH_REBUILD_BATCH_SIZE"
    | "SEARCH_REBUILD_EVENT_BATCH_SIZE"
    | "SEARCH_REBUILD_SPOOL_DIR"
    | "SEARCH_REBUILD_SPOOL_MAX_BYTES"
    | "SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS"
    | "SEARCH_REBUILD_WORKER_ID"
    | "SEARCH_TASK_TIMEOUT_MS"
  >;
  readonly database: FoodSearchDatabase;
  readonly signal?: AbortSignal;
}

export interface RebuildFoodSearchNowOptions {
  readonly batchSize: number;
  readonly client: FoodSearchIndexAdmin;
  readonly database: FoodSearchDatabase;
  readonly signal?: AbortSignal;
  readonly spoolDirectory?: string;
  readonly spoolMaxBytes: number;
  readonly spoolMaxDocuments: number;
  readonly taskTimeoutMs: number;
}

function safeRebuildErrorCode(error: unknown): string {
  if (error instanceof FoodSearchError && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)) {
    return error.code;
  }
  if (error instanceof FoodSearchProjectionSpoolLimitError) {
    return "SEARCH_REBUILD_SPOOL_LIMIT";
  }
  return "SEARCH_REBUILD_FAILED";
}

async function rebuild(
  database: FoodSearchDatabase,
  client: FoodSearchIndexAdmin,
  options: {
    readonly batchSize: number;
    readonly signal?: AbortSignal;
    readonly spoolDirectory?: string;
    readonly spoolMaxBytes: number;
    readonly spoolMaxDocuments: number;
    readonly taskTimeoutMs: number;
  },
): Promise<RebuildFoodSearchIndexResult> {
  return rebuildFoodSearchIndex({
    assertProjectionCurrent: async (projectionRevision, signal) => {
      signal?.throwIfAborted();
      await assertFoodSearchProjectionRevision(database, projectionRevision);
    },
    batchSize: options.batchSize,
    client,
    source: createPostgresFoodSearchProjectionSource(database, options.batchSize, {
      maxBytes: options.spoolMaxBytes,
      maxDocuments: options.spoolMaxDocuments,
      ...(options.spoolDirectory === undefined ? {} : { directory: options.spoolDirectory }),
    }),
    taskTimeoutMs: options.taskTimeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** Coalesce a bounded activation batch and rebuild under the cross-process swap lock. */
export async function runFoodSearchWorkerPoll(
  options: RunFoodSearchWorkerPollOptions,
): Promise<FoodSearchWorkerPollResult> {
  options.signal?.throwIfAborted();
  const locked = await withFoodSearchRebuildLock(options.database, async (connection) => {
    const events = await claimFoodSearchRebuildEvents(connection, {
      limit: options.config.SEARCH_REBUILD_EVENT_BATCH_SIZE,
      workerId: options.config.SEARCH_REBUILD_WORKER_ID,
    });
    if (events.length === 0) return { status: "idle" as const };
    const firstEvent = events[0];
    if (!firstEvent) throw new Error("food-search rebuild claim returned an empty batch");
    const eventIds = events.map((event) => event.id);

    try {
      const result = await rebuild(connection, options.client, {
        batchSize: options.config.SEARCH_REBUILD_BATCH_SIZE,
        spoolMaxBytes: options.config.SEARCH_REBUILD_SPOOL_MAX_BYTES,
        spoolMaxDocuments: options.config.SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS,
        taskTimeoutMs: options.config.SEARCH_TASK_TIMEOUT_MS,
        ...(options.config.SEARCH_REBUILD_SPOOL_DIR === undefined
          ? {}
          : { spoolDirectory: options.config.SEARCH_REBUILD_SPOOL_DIR }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await publishFoodSearchProjectionAndAcknowledgeEvents(connection, {
        eventIds,
        expectedRevision: result.projectionRevision,
        workerId: firstEvent.workerId,
      });
      return {
        status: "rebuilt" as const,
        eventCount: events.length,
        eventId: firstEvent.id,
        includedCount: result.includedCount,
        cleanup: result.cleanup,
      };
    } catch (error) {
      const released = await releaseFoodSearchRebuildEvents(connection, {
        eventIds,
        errorCode: safeRebuildErrorCode(error),
        workerId: firstEvent.workerId,
      });
      return {
        status: "retry-scheduled" as const,
        eventCount: events.length,
        eventId: firstEvent.id,
        deadLettered: released.some((event) => event.deadLettered),
      };
    }
  });
  return locked?.result ?? { status: "busy" };
}

/** Full operator rebuild; returns null when another generation owns the lock. */
export async function rebuildFoodSearchNow(
  options: RebuildFoodSearchNowOptions,
): Promise<RebuildFoodSearchIndexResult | null> {
  options.signal?.throwIfAborted();
  const locked = await withFoodSearchRebuildLock(options.database, async (connection) => {
    const result = await rebuild(connection, options.client, {
      batchSize: options.batchSize,
      spoolMaxBytes: options.spoolMaxBytes,
      spoolMaxDocuments: options.spoolMaxDocuments,
      taskTimeoutMs: options.taskTimeoutMs,
      ...(options.spoolDirectory === undefined ? {} : { spoolDirectory: options.spoolDirectory }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await publishFoodSearchProjectionRevision(connection, {
      expectedRevision: result.projectionRevision,
    });
    return result;
  });
  return locked?.result ?? null;
}
