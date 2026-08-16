import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from "fastify";

import { type AppConfig, loadConfig } from "./config.js";
import { registerAuthContext } from "./http/authentication.js";
import { registerErrorHandling } from "./http/error-handler.js";
import { createLoggerOptions } from "./logging.js";
import type { AuthService } from "./modules/auth/auth-service.js";
import type { DiaryService } from "./modules/diary/diary.routes.js";
import type { FoodSearchService } from "./modules/foods/food.routes.js";
import type { GoalService } from "./modules/goals/goal.routes.js";
import type { ProfileService } from "./modules/profile/profile.routes.js";
import type { RecipeService } from "./modules/recipes/recipe.routes.js";
import { type ReadinessCheck, systemRoutes } from "./modules/system/system.routes.js";
import { v1Routes } from "./modules/v1.routes.js";

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: FastifyServerOptions["logger"];
  readinessCheck?: ReadinessCheck;
  foodSearchService?: FoodSearchService;
  authService?: AuthService;
  profileService?: ProfileService;
  diaryService?: DiaryService;
  recipeService?: RecipeService;
  goalService?: GoalService;
}

const defaultReadinessCheck: ReadinessCheck = (_signal) => true;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
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

  registerAuthContext(app);
  registerErrorHandling(app);
  void app.register(systemRoutes, {
    readinessCheck: options.readinessCheck ?? defaultReadinessCheck,
    readinessTimeoutMs: config.readinessTimeoutMs,
  });
  void app.register(v1Routes, {
    prefix: "/v1",
    ...(options.foodSearchService ? { foodSearchService: options.foodSearchService } : {}),
    ...(options.authService ? { authService: options.authService } : {}),
    ...(options.profileService ? { profileService: options.profileService } : {}),
    ...(options.diaryService ? { diaryService: options.diaryService } : {}),
    ...(options.recipeService ? { recipeService: options.recipeService } : {}),
    ...(options.goalService ? { goalService: options.goalService } : {}),
  });

  return app;
}
