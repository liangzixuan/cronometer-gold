import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseWorkerConfig, WorkerConfigValidationError } from "./config.js";
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
  const config = parseWorkerConfig(options.environment ?? process.env);
  const controller = new AbortController();
  const listeners = new Map<NodeJS.Signals, () => void>();

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
        (async (_signal) => {
          // The transactional outbox adapter is attached after the first DB migration.
        }),
    });
  } finally {
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void startWorker().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(workerFailureEvent(error))}\n`);
    process.exitCode = 1;
  });
}
