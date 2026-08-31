import process from "node:process";
import { pathToFileURL } from "node:url";

import { WorkerConfigValidationError } from "./config.js";
import { runWorker, WorkerShutdownTimeoutError } from "./runtime.js";
import { createWorkerPollRuntime, type WorkerOperationalEvent } from "./worker-runtime.js";

export {
  assertWorkerDatabaseReady,
  type SearchWorkerOperationalEvent,
  type WorkerOperationalEvent,
} from "./worker-runtime.js";

export interface WorkerFailureEvent {
  readonly event: "worker.bootstrap.failed";
  readonly errorType: string;
  readonly invalidFields?: readonly string[];
  readonly level: "fatal";
}

export interface StartWorkerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly onOperationalEvent?: (event: WorkerOperationalEvent) => void;
  readonly processRuntime?: WorkerProcessRuntime;
  readonly watchdogTimers?: WorkerWatchdogTimers;
}

export interface WorkerProcessRuntime {
  exit(code: number): void;
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface WorkerWatchdogTimers {
  clear(handle: unknown): void;
  set(listener: () => void, timeoutMs: number): unknown;
}

export const workerShutdownWatchdogMarginMs = 2_500;
export const workerShutdownGraceMinimumMs = 100;
export const workerShutdownGraceMaximumMs = 300_000;
export const workerGracefulShutdownPhaseCount = 2;
export const workerShutdownWatchdogMaximumMs =
  workerShutdownGraceMaximumMs * workerGracefulShutdownPhaseCount + workerShutdownWatchdogMarginMs;

export function workerShutdownWatchdogTimeoutMs(shutdownGraceMs: number): number {
  if (
    !Number.isSafeInteger(shutdownGraceMs) ||
    shutdownGraceMs < workerShutdownGraceMinimumMs ||
    shutdownGraceMs > workerShutdownGraceMaximumMs
  ) {
    throw new Error("Worker requires a bounded shutdown grace period");
  }
  return shutdownGraceMs * workerGracefulShutdownPhaseCount + workerShutdownWatchdogMarginMs;
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
  const runtime = await createWorkerPollRuntime({
    environment,
    ...(options.onOperationalEvent ? { onOperationalEvent: options.onOperationalEvent } : {}),
  });
  const processRuntime = options.processRuntime ?? process;
  const watchdogTimers =
    options.watchdogTimers ??
    ({
      clear(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      set(listener: () => void, timeoutMs: number) {
        return setTimeout(listener, timeoutMs);
      },
    } satisfies WorkerWatchdogTimers);
  const watchdogTimeoutMs = workerShutdownWatchdogTimeoutMs(runtime.shutdownGraceMs);
  const controller = new AbortController();
  const listeners = new Map<NodeJS.Signals, () => void>();
  let watchdogArmed = false;
  let watchdogHandle: unknown;
  let failed = false;
  let failure: unknown;
  let pollDrainAlreadyTimedOut = false;
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listener = () => {
        if (!watchdogArmed) {
          watchdogArmed = true;
          watchdogHandle = watchdogTimers.set(() => processRuntime.exit(1), watchdogTimeoutMs);
        }
        controller.abort(signal);
      };
      listeners.set(signal, listener);
      processRuntime.once(signal, listener);
    }
    await runWorker({
      pollIntervalMs: runtime.pollIntervalMs,
      shutdownGraceMs: runtime.shutdownGraceMs,
      signal: controller.signal,
      onPoll: (signal) => runtime.pollOnce(signal),
    });
  } catch (error) {
    failed = true;
    failure = error;
    pollDrainAlreadyTimedOut = error instanceof WorkerShutdownTimeoutError;
  } finally {
    for (const [signal, listener] of listeners) processRuntime.removeListener(signal, listener);
    try {
      if (pollDrainAlreadyTimedOut) {
        await runtime.close({ pollDrainAlreadyTimedOut: true });
      } else {
        await runtime.close();
      }
    } catch (cleanupError) {
      failure = failed
        ? new AggregateError([failure, cleanupError], "Worker execution and cleanup failed")
        : cleanupError;
      failed = true;
    }
  }
  if (watchdogArmed && !failed) watchdogTimers.clear(watchdogHandle);
  if (failed) throw failure;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void startWorker().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(workerFailureEvent(error))}\n`);
    process.exitCode = 1;
  });
}
