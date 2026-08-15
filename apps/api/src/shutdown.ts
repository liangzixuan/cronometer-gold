import type { FastifyInstance } from "fastify";

import { safeErrorName } from "./logging.js";

export interface ShutdownRuntime {
  exit(code?: number): never;
  exitCode?: number | string | null;
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface GracefulShutdown {
  close(signal?: string): Promise<void>;
  dispose(): void;
}

export interface ShutdownOptions {
  timeoutMs: number;
  runtime?: ShutdownRuntime;
}

export function installGracefulShutdown(
  app: FastifyInstance,
  options: ShutdownOptions,
): GracefulShutdown {
  const runtime = options.runtime ?? process;
  const listeners = new Map<NodeJS.Signals, () => void>();
  let closing: Promise<void> | undefined;

  const close = (signal = "manual"): Promise<void> => {
    if (closing) {
      return closing;
    }

    closing = (async () => {
      app.log.info({ event: "api.shutdown.started", signal }, "Graceful shutdown started");

      const forceExitTimer = setTimeout(() => {
        app.log.fatal({ event: "api.shutdown.timed_out", signal }, "Graceful shutdown timed out");
        runtime.exit(1);
      }, options.timeoutMs);
      forceExitTimer.unref();

      try {
        await app.close();
        app.log.info({ event: "api.shutdown.completed", signal }, "Graceful shutdown completed");
      } catch (error) {
        runtime.exitCode = 1;
        app.log.error(
          {
            event: "api.shutdown.failed",
            signal,
            errorType: safeErrorName(error),
          },
          "Graceful shutdown failed",
        );
        throw error;
      } finally {
        clearTimeout(forceExitTimer);
      }
    })();

    return closing;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => {
      void close(signal).catch(() => {
        runtime.exitCode = 1;
      });
    };
    listeners.set(signal, listener);
    runtime.once(signal, listener);
  }

  return {
    close,
    dispose() {
      for (const [signal, listener] of listeners) {
        runtime.removeListener(signal, listener);
      }
      listeners.clear();
    },
  };
}
