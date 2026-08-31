import { assertDatabaseReady, createDatabaseFromEnvironment } from "@nutrition-tracker/db";
import { MeilisearchHttpClient } from "@nutrition-tracker/search";

import { parseWorkerConfig, type WorkerConfig } from "./config.js";
import { type FoodSearchWorkerPollResult, runFoodSearchWorkerPoll } from "./food-search-worker.js";
import { createRetentionWorkerRepository } from "./retention-database-repository.js";
import { createRetentionStorageRuntime } from "./retention-storage.js";
import { type RetentionWorkerEvent, runRetentionWorkerPoll } from "./retention-worker.js";

export interface SearchWorkerOperationalEvent {
  readonly event:
    | "search.rebuild.cleanup_pending"
    | "search.rebuild.completed"
    | "search.rebuild.retry_scheduled";
  readonly level: "info" | "warn";
  readonly eventId: string;
  readonly eventCount?: number;
  readonly includedCount?: number;
  readonly deadLettered?: boolean;
  readonly cleanupErrorCode?: "DISPLACED_INDEX_DELETE_FAILED";
  readonly cleanupIndexUid?: string;
}

export type WorkerOperationalEvent =
  | SearchWorkerOperationalEvent
  | RetentionWorkerEvent
  | {
      readonly event: "worker.poll.slice_failed";
      readonly level: "warn";
      readonly slice: "search" | "retention";
      readonly errorType: string;
    };

export interface WorkerPollRuntime {
  readonly pollIntervalMs: number;
  readonly shutdownGraceMs: number;
  close(options?: WorkerPollRuntimeCloseOptions): Promise<void>;
  pollOnce(signal?: AbortSignal): Promise<void>;
}

export interface WorkerPollRuntimeCloseOptions {
  /** The caller already gave this admitted poll the full configured drain grace. */
  readonly pollDrainAlreadyTimedOut?: boolean;
}

export interface WorkerPollRuntimeOptions {
  readonly clock?: () => Date;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onOperationalEvent?: (event: WorkerOperationalEvent) => void;
}

export class WorkerPollDrainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Worker poll did not drain during close within ${timeoutMs} milliseconds.`);
    this.name = "WorkerPollDrainTimeoutError";
  }
}

export class WorkerDatabaseCleanupTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Worker database cleanup did not finish within ${timeoutMs} milliseconds.`);
    this.name = "WorkerDatabaseCleanupTimeoutError";
  }
}

type BoundedSettlement =
  | { readonly status: "fulfilled" }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timed-out" };

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<BoundedSettlement> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled: Promise<BoundedSettlement> = promise.then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ reason, status: "rejected" as const }),
  );
  const timedOut = new Promise<BoundedSettlement>((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise({ status: "timed-out" }), timeoutMs);
  });

  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function safeErrorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
    return error.name;
  }
  return "UnknownError";
}

export async function assertWorkerDatabaseReady(
  database: ReturnType<typeof createDatabaseFromEnvironment>,
  config: Pick<WorkerConfig, "DATABASE_RESTORE_EPOCH" | "NODE_ENV">,
): Promise<void> {
  if (config.NODE_ENV === "production") {
    if (!config.DATABASE_RESTORE_EPOCH) {
      throw new Error("Database restore epoch was not configured");
    }
    await assertDatabaseReady(database, {
      requireRestoreAttestation: true,
      restoreEpoch: config.DATABASE_RESTORE_EPOCH,
    });
    return;
  }
  await assertDatabaseReady(database, {
    requireRestoreAttestation: false,
    ...(config.DATABASE_RESTORE_EPOCH ? { restoreEpoch: config.DATABASE_RESTORE_EPOCH } : {}),
  });
}

export async function createWorkerPollRuntime(
  options: WorkerPollRuntimeOptions = {},
): Promise<WorkerPollRuntime> {
  const environment = options.environment ?? process.env;
  const config = parseWorkerConfig(environment);
  const emit =
    options.onOperationalEvent ??
    ((event: WorkerOperationalEvent) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
  const client = new MeilisearchHttpClient({
    host: config.MEILI_URL,
    requestTimeoutMs: config.SEARCH_REQUEST_TIMEOUT_MS,
    ...(config.MEILI_ADMIN_KEY === undefined ? {} : { apiKey: config.MEILI_ADMIN_KEY }),
    ...(config.MEILI_TASK_OBSERVER_KEY === undefined
      ? {}
      : { taskApiKey: config.MEILI_TASK_OBSERVER_KEY }),
  });
  const database = createDatabaseFromEnvironment({
    ...environment,
    DATABASE_URL: config.DATABASE_URL,
  });

  let retentionStorage: Awaited<ReturnType<typeof createRetentionStorageRuntime>> | undefined;
  let retentionRepository: ReturnType<typeof createRetentionWorkerRepository> | undefined;
  try {
    retentionStorage = config.RETENTION_FEATURES_ENABLED
      ? await createRetentionStorageRuntime(config, {
          ...(options.clock ? { clock: options.clock } : {}),
        })
      : undefined;
    await assertWorkerDatabaseReady(database, config);
    retentionRepository = retentionStorage ? createRetentionWorkerRepository(database) : undefined;
  } catch (error) {
    try {
      await database.destroy();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Worker dependency construction and database cleanup failed",
      );
    }
    throw error;
  }

  const closeController = new AbortController();
  let closed = false;
  let activePoll: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const performPoll = async (signal: AbortSignal): Promise<void> => {
    try {
      const result = await runFoodSearchWorkerPoll({
        client,
        config,
        database,
        signal,
      });
      const event = operationalEvent(result);
      if (event) emit(event);
    } catch (error) {
      emit({
        errorType: safeErrorName(error),
        event: "worker.poll.slice_failed",
        level: "warn",
        slice: "search",
      });
    }
    // close() and caller cancellation both prohibit admitting a new retention
    // slice. Work that was already inside retention receives this same signal
    // and is allowed only the bounded close drain below.
    if (closed || signal.aborted) return;
    if (retentionStorage && retentionRepository) {
      try {
        await runRetentionWorkerPoll(
          {
            erasureLedger: retentionStorage.erasureLedger,
            exportArtifactStore: retentionStorage.exportArtifactStore,
            exportTtlMs: 7 * 86_400_000,
            onEvent: emit,
            repository: retentionRepository,
            spoolMaximumBytes: config.RETENTION_EXPORT_SPOOL_MAX_BYTES,
            temporaryDirectory: config.RETENTION_EXPORT_SPOOL_DIR,
            uploadLeaseMs: Math.min(
              15 * 60_000,
              Math.max(
                config.EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS * 2,
                config.EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS + 30_000,
              ),
            ),
            workerId: config.RETENTION_WORKER_ID,
            ...(options.clock ? { clock: options.clock } : {}),
          },
          signal,
        );
      } catch (error) {
        emit({
          errorType: safeErrorName(error),
          event: "worker.poll.slice_failed",
          level: "warn",
          slice: "retention",
        });
      }
    }
  };

  const closeAfterBoundedDrain = async (
    admittedPoll: Promise<void> | undefined,
    pollDrainAlreadyTimedOut: boolean,
  ) => {
    const failures: unknown[] = [];
    if (admittedPoll && !pollDrainAlreadyTimedOut) {
      const drain = await settleWithin(admittedPoll, config.SHUTDOWN_GRACE_MS);
      if (drain.status === "timed-out") {
        failures.push(new WorkerPollDrainTimeoutError(config.SHUTDOWN_GRACE_MS));
      }
    }

    // Invoke destroy exactly once through the cached close promise. Its own
    // settlement handler remains attached after a timeout, so a late rejection
    // cannot become an unhandled rejection.
    const cleanup = Promise.resolve().then(() => database.destroy());
    const cleanupResult = await settleWithin(cleanup, config.SHUTDOWN_GRACE_MS);
    if (cleanupResult.status === "timed-out") {
      failures.push(new WorkerDatabaseCleanupTimeoutError(config.SHUTDOWN_GRACE_MS));
    } else if (cleanupResult.status === "rejected") {
      failures.push(cleanupResult.reason);
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Worker poll drain and database cleanup failed");
    }
  };

  return {
    pollIntervalMs: config.POLL_INTERVAL_MS,
    shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
    close(closeOptions = {}) {
      closed = true;
      if (!closeController.signal.aborted) {
        const reason = new Error("Worker poll runtime is closing");
        reason.name = "AbortError";
        closeController.abort(reason);
      }
      closePromise ??= closeAfterBoundedDrain(
        activePoll,
        closeOptions.pollDrainAlreadyTimedOut === true,
      );
      return closePromise;
    },
    pollOnce(callerSignal = new AbortController().signal) {
      if (closed) return Promise.reject(new Error("Worker poll runtime is closed"));
      if (activePoll) {
        return Promise.reject(new Error("Worker poll runtime already has an active poll"));
      }
      const signal = AbortSignal.any([callerSignal, closeController.signal]);
      const poll = performPoll(signal);
      activePoll = poll;
      // Both branches consume the internal observation promise. The original
      // poll still resolves or rejects normally for its caller.
      void poll.then(
        () => {
          if (activePoll === poll) activePoll = undefined;
        },
        () => {
          if (activePoll === poll) activePoll = undefined;
        },
      );
      return poll;
    },
  };
}

function operationalEvent(result: FoodSearchWorkerPollResult): WorkerOperationalEvent | null {
  switch (result.status) {
    case "rebuilt":
      if (result.cleanup.status === "pending") {
        return {
          cleanupErrorCode: result.cleanup.errorCode,
          cleanupIndexUid: result.cleanup.indexUid,
          event: "search.rebuild.cleanup_pending",
          eventCount: result.eventCount,
          eventId: result.eventId,
          includedCount: result.includedCount,
          level: "warn",
        };
      }
      return {
        event: "search.rebuild.completed",
        eventCount: result.eventCount,
        eventId: result.eventId,
        includedCount: result.includedCount,
        level: "info",
      };
    case "retry-scheduled":
      return {
        event: "search.rebuild.retry_scheduled",
        eventCount: result.eventCount,
        eventId: result.eventId,
        deadLettered: result.deadLettered,
        level: "warn",
      };
    case "busy":
    case "idle":
      return null;
  }
}
