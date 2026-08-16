import process from "node:process";
import { pathToFileURL } from "node:url";

import { createDatabaseFromEnvironment } from "@nutrition-tracker/db";
import { MeilisearchHttpClient } from "@nutrition-tracker/search";

import { parseWorkerConfig } from "./config.js";
import { rebuildFoodSearchNow } from "./food-search-worker.js";

function rebuildFailureEvent(error: unknown): {
  readonly event: "search.rebuild.failed";
  readonly errorType: string;
  readonly level: "fatal";
} {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  return {
    event: "search.rebuild.failed",
    errorType: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(candidate) ? candidate : "UnknownError",
    level: "fatal",
  };
}

export async function runSearchRebuildCommand(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const config = parseWorkerConfig(environment);
  const client = new MeilisearchHttpClient({
    host: config.MEILI_URL,
    requestTimeoutMs: config.SEARCH_REQUEST_TIMEOUT_MS,
    ...(config.MEILI_ADMIN_KEY === undefined ? {} : { apiKey: config.MEILI_ADMIN_KEY }),
  });
  const database = createDatabaseFromEnvironment({
    ...environment,
    DATABASE_URL: config.DATABASE_URL,
  });
  const controller = new AbortController();
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => controller.abort(signal);
    listeners.set(signal, listener);
    process.once(signal, listener);
  }

  try {
    const result = await rebuildFoodSearchNow({
      batchSize: config.SEARCH_REBUILD_BATCH_SIZE,
      client,
      database,
      signal: controller.signal,
      spoolMaxBytes: config.SEARCH_REBUILD_SPOOL_MAX_BYTES,
      spoolMaxDocuments: config.SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS,
      taskTimeoutMs: config.SEARCH_TASK_TIMEOUT_MS,
      ...(config.SEARCH_REBUILD_SPOOL_DIR === undefined
        ? {}
        : { spoolDirectory: config.SEARCH_REBUILD_SPOOL_DIR }),
    });
    if (!result) {
      process.stdout.write(`${JSON.stringify({ event: "search.rebuild.busy", level: "warn" })}\n`);
      return 2;
    }
    if (result.cleanup.status === "pending") {
      process.stdout.write(
        `${JSON.stringify({
          errorCode: result.cleanup.errorCode,
          event: "search.rebuild.cleanup_pending",
          indexUid: result.cleanup.indexUid,
          level: "warn",
        })}\n`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        cleanupStatus: result.cleanup.status,
        event: "search.rebuild.completed",
        excludedCount: result.excludedCount,
        includedCount: result.includedCount,
        level: "info",
        stableIndex: result.stableIndex,
      })}\n`,
    );
    return 0;
  } finally {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runSearchRebuildCommand()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify(rebuildFailureEvent(error))}\n`);
      process.exitCode = 1;
    });
}
