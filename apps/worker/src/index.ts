import process from "node:process";
import { pathToFileURL } from "node:url";

import { assertDatabaseReady, createDatabaseFromEnvironment } from "@nutrition-tracker/db";
import { MeilisearchHttpClient } from "@nutrition-tracker/search";

import { parseWorkerConfig, type WorkerConfig, WorkerConfigValidationError } from "./config.js";
import { type FoodSearchWorkerPollResult, runFoodSearchWorkerPoll } from "./food-search-worker.js";
import { createRetentionWorkerRepository } from "./retention-database-repository.js";
import { createRetentionStorageRuntime } from "./retention-storage.js";
import { type RetentionWorkerEvent, runRetentionWorkerPoll } from "./retention-worker.js";
import { runWorker } from "./runtime.js";

export interface WorkerFailureEvent {
  readonly event: "worker.bootstrap.failed";
  readonly errorType: string;
  readonly invalidFields?: readonly string[];
  readonly level: "fatal";
}

export interface StartWorkerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly onPoll?: (signal: AbortSignal) => Promise<void>;
  readonly onOperationalEvent?: (event: WorkerOperationalEvent) => void;
}

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

function safeErrorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
    return error.name;
  }
  return "UnknownError";
}

export function workerFailureEvent(error: unknown): WorkerFailureEvent {
  const invalidFields =
    error instanceof WorkerConfigValidationError
      ? [...new Set(error.issues.map((issue) => issue.field))].filter((field) =>
          /^[A-Z0-9_.-]{1,64}$/.test(field),
        )
      : [];
  return {
    event: "worker.bootstrap.failed",
    errorType: safeErrorName(error),
    ...(invalidFields.length > 0 ? { invalidFields } : {}),
    level: "fatal",
  };
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

export async function startWorker(options: StartWorkerOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const config = parseWorkerConfig(environment);
  const controller = new AbortController();
  const listeners = new Map<NodeJS.Signals, () => void>();
  const client =
    options.onPoll === undefined
      ? new MeilisearchHttpClient({
          host: config.MEILI_URL,
          requestTimeoutMs: config.SEARCH_REQUEST_TIMEOUT_MS,
          ...(config.MEILI_ADMIN_KEY === undefined ? {} : { apiKey: config.MEILI_ADMIN_KEY }),
        })
      : undefined;
  const retentionStorage =
    options.onPoll === undefined && config.RETENTION_FEATURES_ENABLED
      ? await createRetentionStorageRuntime(config)
      : undefined;
  const database =
    options.onPoll === undefined
      ? createDatabaseFromEnvironment({ ...environment, DATABASE_URL: config.DATABASE_URL })
      : undefined;
  const retentionRepository =
    database && retentionStorage ? createRetentionWorkerRepository(database) : undefined;
  const emit =
    options.onOperationalEvent ??
    ((event: WorkerOperationalEvent) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });

  if (database) {
    try {
      await assertWorkerDatabaseReady(database, config);
    } catch (error) {
      await database.destroy();
      throw error;
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => controller.abort(signal);
    listeners.set(signal, listener);
    process.once(signal, listener);
  }

  try {
    await runWorker({
      pollIntervalMs: config.POLL_INTERVAL_MS,
      shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
      signal: controller.signal,
      onPoll:
        options.onPoll ??
        (async (signal) => {
          if (!database || !client) throw new Error("worker dependencies were not initialized");
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
        }),
    });
  } finally {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    await database?.destroy();
  }
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

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void startWorker().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(workerFailureEvent(error))}\n`);
    process.exitCode = 1;
  });
}
