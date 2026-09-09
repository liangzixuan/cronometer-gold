import { randomUUID } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from "fastify";

import { type AppConfig, ConfigValidationError, loadConfig } from "./config.js";
import { registerAuthContext } from "./http/authentication.js";
import { registerErrorHandling } from "./http/error-handler.js";
import { createLoggerOptions } from "./logging.js";
import type { ActivityService } from "./modules/activity/activity.routes.js";
import type { AuthService } from "./modules/auth/auth-service.js";
import type { DiaryService } from "./modules/diary/diary.routes.js";
import type { FoodSearchService } from "./modules/foods/food.routes.js";
import type { GoalService } from "./modules/goals/goal.routes.js";
import type { HydrationService } from "./modules/hydration/hydration.routes.js";
import type { ProfileService } from "./modules/profile/profile.routes.js";
import type { RecipeService } from "./modules/recipes/recipe.routes.js";
import type { NutritionReportService } from "./modules/reports/nutrition-report.routes.js";
import type { RetentionService } from "./modules/retention/retention.routes.js";
import { type ReadinessCheck, systemRoutes } from "./modules/system/system.routes.js";
import { v1Routes } from "./modules/v1.routes.js";

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: FastifyServerOptions["logger"];
  readinessCheck?: ReadinessCheck;
  foodSearchService?: FoodSearchService;
  authService?: AuthService;
  activityService?: ActivityService;
  profileService?: ProfileService;
  diaryService?: DiaryService;
  hydrationService?: HydrationService;
  recipeService?: RecipeService;
  goalService?: GoalService;
  nutritionReportService?: NutritionReportService;
  referenceTargetsEnabled?: boolean;
  retentionService?: RetentionService;
  retentionClock?: () => Date;
}

const defaultReadinessCheck: ReadinessCheck = (_signal) => true;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  if (config.nodeEnv === "production" && options.referenceTargetsEnabled === true) {
    throw new ConfigValidationError([
      {
        field: "REFERENCE_TARGETS_ENABLED",
        message: "Production approval gate has not been released",
      },
    ]);
  }
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
    ...(options.activityService ? { activityService: options.activityService } : {}),
    ...(options.foodSearchService ? { foodSearchService: options.foodSearchService } : {}),
    ...(options.authService ? { authService: options.authService } : {}),
    ...(options.profileService ? { profileService: options.profileService } : {}),
    ...(options.diaryService ? { diaryService: options.diaryService } : {}),
    ...(options.hydrationService ? { hydrationService: options.hydrationService } : {}),
    ...(options.recipeService ? { recipeService: options.recipeService } : {}),
    ...(options.goalService ? { goalService: options.goalService } : {}),
    ...(options.nutritionReportService
      ? { nutritionReportService: options.nutritionReportService }
      : {}),
    ...(options.referenceTargetsEnabled === true ? { referenceTargetsEnabled: true } : {}),
    ...(options.retentionService ? { retentionService: options.retentionService } : {}),
    ...(options.retentionClock ? { clock: options.retentionClock } : {}),
  });

  return app;
}
