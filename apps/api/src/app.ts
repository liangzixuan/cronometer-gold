import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from "fastify";

import { type AppConfig, loadConfig } from "./config.js";
import { registerErrorHandling } from "./http/error-handler.js";
import { createLoggerOptions } from "./logging.js";
import { type ReadinessCheck, systemRoutes } from "./modules/system/system.routes.js";
import { v1Routes } from "./modules/v1.routes.js";

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: FastifyServerOptions["logger"];
  readinessCheck?: ReadinessCheck;
}

const defaultReadinessCheck: ReadinessCheck = (_signal) => true;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  const app = Fastify({
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? createLoggerOptions(config),
    requestIdHeader: false,
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    reply.header("x-request-id", request.id);
    request.log.info(
      {
        event: "http.request.received",
        requestId: request.id,
        method: request.method,
      },
      "Request received",
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    const durationMs = startedAt
      ? Number(process.hrtime.bigint() - startedAt) / 1_000_000
      : undefined;

    request.log.info(
      {
        event: "http.request.completed",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationMs,
      },
      "Request completed",
    );
  });

  registerErrorHandling(app);
  void app.register(systemRoutes, {
    readinessCheck: options.readinessCheck ?? defaultReadinessCheck,
    readinessTimeoutMs: config.readinessTimeoutMs,
  });
  void app.register(v1Routes, { prefix: "/v1" });

  return app;
}
