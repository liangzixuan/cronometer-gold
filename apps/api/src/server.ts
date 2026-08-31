import { pathToFileURL } from "node:url";

import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { buildApp } from "./app.js";
import {
  type AppConfig,
  ConfigValidationError,
  loadApiDependencyConfig,
  loadConfig,
} from "./config.js";
import { safeErrorName } from "./logging.js";
import { createApiSearchRuntime } from "./search-runtime.js";
import { type GracefulShutdown, installGracefulShutdown } from "./shutdown.js";

export interface RunningServer {
  app: FastifyInstance;
  shutdown: GracefulShutdown;
}

export interface ApiApplicationRuntime {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  close(): Promise<void>;
}

export interface ApiApplicationRuntimeOptions {
  readonly clock?: () => Date;
  readonly logger?: FastifyServerOptions["logger"];
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

export async function createApiApplicationRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  options: ApiApplicationRuntimeOptions = {},
): Promise<ApiApplicationRuntime> {
  const config = loadConfig(environment);
  const dependencyConfig = loadApiDependencyConfig(environment);
  const dependencies = await createApiSearchRuntime(environment, dependencyConfig, {
    ...(options.clock ? { clock: options.clock } : {}),
  });
  let dependencyCloseEntered = false;
  let dependencyClosePromise: Promise<void> | undefined;
  const closeDependencies = () => {
    dependencyCloseEntered = true;
    dependencyClosePromise ??= (async () => {
      await dependencies.close();
    })();
    return dependencyClosePromise;
  };
  let app: FastifyInstance | undefined;
  try {
    app = buildApp({
      authService: dependencies.authService,
      config,
      diaryService: dependencies.diaryService,
      foodSearchService: dependencies.foodSearchService,
      goalService: dependencies.goalService,
      profileService: dependencies.profileService,
      recipeService: dependencies.recipeService,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.clock ? { retentionClock: options.clock } : {}),
      ...(dependencies.retentionService ? { retentionService: dependencies.retentionService } : {}),
      readinessCheck: dependencies.readinessCheck,
    });
    app.addHook("onClose", closeDependencies);
    await app.ready();
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (app) {
      try {
        await app.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!dependencyCloseEntered) {
      try {
        await closeDependencies();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "API application construction and dependency cleanup failed",
      );
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const application = app;
  return {
    app: application,
    config,
    close() {
      closePromise ??= application.close();
      return closePromise;
    },
  };
}

export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunningServer> {
  const runtime = await createApiApplicationRuntime(environment);
  const { app, config } = runtime;
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
    try {
      await runtime.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "API failed to start and application cleanup failed",
      );
    }
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
