import process from "node:process";
import { pathToFileURL } from "node:url";

import { createDatabaseFromEnvironment } from "@nutrition-tracker/db";
import { MeilisearchHttpClient } from "@nutrition-tracker/search";

import { parseWorkerConfig, WorkerConfigValidationError } from "./config.js";
import { type FoodSearchWorkerPollResult, runFoodSearchWorkerPoll } from "./food-search-worker.js";
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

export interface WorkerOperationalEvent {
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
  const database =
    options.onPoll === undefined
      ? createDatabaseFromEnvironment({ ...environment, DATABASE_URL: config.DATABASE_URL })
      : undefined;
  const emit =
    options.onOperationalEvent ??
    ((event: WorkerOperationalEvent) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });

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
          const result = await runFoodSearchWorkerPoll({
            client,
            config,
            database,
            signal,
          });
          const event = operationalEvent(result);
          if (event) emit(event);
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
