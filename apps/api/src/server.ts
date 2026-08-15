import { pathToFileURL } from "node:url";

import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { ConfigValidationError, loadConfig } from "./config.js";
import { safeErrorName } from "./logging.js";
import { type GracefulShutdown, installGracefulShutdown } from "./shutdown.js";

export interface RunningServer {
  app: FastifyInstance;
  shutdown: GracefulShutdown;
}

export interface BootstrapFailureEvent {
  readonly event: "api.bootstrap.failed";
  readonly errorType: string;
  readonly invalidFields?: readonly string[];
  readonly level: "fatal";
}

export function bootstrapFailureEvent(error: unknown): BootstrapFailureEvent {
  const invalidFields =
    error instanceof ConfigValidationError
      ? [...new Set(error.issues.map((issue) => issue.field))].filter((field) =>
          /^[A-Z0-9_.-]{1,64}$/.test(field),
        )
      : [];

  return {
    event: "api.bootstrap.failed",
    errorType: safeErrorName(error),
    ...(invalidFields.length > 0 ? { invalidFields } : {}),
    level: "fatal",
  };
}

export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunningServer> {
  const config = loadConfig(environment);
  const app = buildApp({ config });
  const shutdown = installGracefulShutdown(app, {
    timeoutMs: config.shutdownGraceMs,
  });

  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
    app.log.info(
      {
        event: "api.started",
        host: config.apiHost,
        port: config.apiPort,
      },
      "API listening",
    );
    return { app, shutdown };
  } catch (error) {
    shutdown.dispose();
    app.log.fatal(
      {
        event: "api.start.failed",
        errorType: safeErrorName(error),
      },
      "API failed to start",
    );
    await app.close().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void startServer().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(bootstrapFailureEvent(error))}\n`);
    process.exitCode = 1;
  });
}
