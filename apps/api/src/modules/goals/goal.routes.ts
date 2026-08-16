import { createHash } from "node:crypto";

import {
  GENERAL_WELLNESS_NOTICE,
  type GoalProgressRow,
  goalDateQuerySchema,
  goalParamsSchema,
  type NutritionGoal,
  type NutritionGoalDraftRequest,
  type NutritionGoalMutationResponse,
  type NutritionGoalProgressResponse,
  type NutritionGoalResponse,
  type NutritionGoalRevisionRequest,
  nutritionGoalDraftRequestSchema,
  nutritionGoalMutationResponseSchema,
  nutritionGoalProgressResponseSchema,
  nutritionGoalResponseSchema,
  nutritionGoalRevisionRequestSchema,
  problemDetailsSchema,
  type TargetableNutrientListResponse,
  targetableNutrientListResponseSchema,
} from "@nutrition-tracker/contracts";
import {
  DomainError,
  decimal,
  MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH,
  validatePalSelection,
} from "@nutrition-tracker/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { authenticatedPrincipal, requireAuthentication } from "../../http/authentication.js";
import { requireIdempotencyKey, requireRevision, revisionEtag } from "../../http/preconditions.js";
import { HttpProblem } from "../../http/problem.js";
import {
  rejectUnexpectedBodyKeys,
  rejectUnexpectedQueryKeys,
} from "../../http/request-validation.js";
import type { AuthService } from "../auth/auth-service.js";

export interface GoalService {
  getCurrent(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly signal?: AbortSignal;
  }): Promise<NutritionGoal | null>;
  create(input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly goal: NutritionGoalDraftRequest;
    readonly signal?: AbortSignal;
  }): Promise<NutritionGoalMutationResponse>;
  revise(input: {
    readonly userId: string;
    readonly goalId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly goal: NutritionGoalRevisionRequest;
    readonly signal?: AbortSignal;
  }): Promise<NutritionGoalMutationResponse>;
  progress(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly signal?: AbortSignal;
  }): Promise<NutritionGoalProgressResponse>;
  listTargetable(input: {
    readonly userId: string;
    readonly signal?: AbortSignal;
  }): Promise<TargetableNutrientListResponse>;
}

export interface GoalRoutesOptions {
  readonly authService?: AuthService;
  readonly goalService?: GoalService;
}

export class GoalNotFoundServiceError extends Error {}
export class GoalRevisionConflictServiceError extends Error {}
export class GoalIdempotencyConflictServiceError extends Error {}
export class GoalValidationServiceError extends Error {}
export class GoalUnsupportedProfileServiceError extends Error {}
export class GoalPeriodConflictServiceError extends Error {}

interface GoalParams {
  goalId: string;
}

interface GoalDateQuery {
  date: string;
}

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Nutrition goal services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapGoalError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof GoalNotFoundServiceError) {
    return new HttpProblem({
      statusCode: 404,
      code: "NOT_FOUND",
      title: "Not Found",
      detail: "The nutrition goal was not found.",
      expose: true,
    });
  }
  if (error instanceof GoalRevisionConflictServiceError) {
    return new HttpProblem({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      title: "Precondition Failed",
      detail: "The nutrition goal changed. Refresh it and retry your revision.",
      expose: true,
    });
  }
  if (error instanceof GoalIdempotencyConflictServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The Idempotency-Key was already used for a different goal operation.",
      expose: true,
    });
  }
  if (error instanceof GoalPeriodConflictServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The nutrition goal overlaps another active goal period.",
      expose: true,
    });
  }
  if (error instanceof GoalUnsupportedProfileServiceError) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail:
        "This profile does not support the selected energy equation. A fixed wellness target remains available.",
      expose: true,
    });
  }
  if (error instanceof GoalValidationServiceError || error instanceof DomainError) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail: "The nutrition goal is invalid for this account.",
      expose: true,
    });
  }
  return unavailable(error);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requestDigest(operation: string, value: unknown): string {
  return createHash("sha256").update(canonicalJson({ operation, value }), "utf8").digest("hex");
}

async function withRequestSignal<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort("request-aborted");
  if (request.raw.aborted) abort();
  else request.raw.once("aborted", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
  }
}

function assertDraft(goal: NutritionGoalDraftRequest | NutritionGoalRevisionRequest): void {
  if (goal.energy.mode === "derived") {
    validatePalSelection(goal.energy.activityLevelCode, goal.energy.activityFactor);
  }
  const nutrientIds = new Set<string>();
  for (const target of goal.nutrientTargets) {
    if (nutrientIds.has(target.nutrientId)) throw new GoalValidationServiceError();
    nutrientIds.add(target.nutrientId);
    const minimum = target.minimumAmount === null ? null : decimal(target.minimumAmount);
    const desired = target.targetAmount === null ? null : decimal(target.targetAmount);
    const maximum = target.maximumAmount === null ? null : decimal(target.maximumAmount);
    if (
      (minimum && desired && minimum.gt(desired)) ||
      (desired && maximum && desired.gt(maximum)) ||
      (minimum && maximum && minimum.gt(maximum))
    ) {
      throw new GoalValidationServiceError();
    }
  }
}

function assertGoal(goal: NutritionGoal): void {
  if (goal.notice !== GENERAL_WELLNESS_NOTICE) throw new Error("Invalid wellness notice");
  const ids = new Set<string>();
  for (const target of goal.currentVersion.nutrientTargets) {
    if (ids.has(target.definition.id)) throw new Error("Duplicate goal nutrient");
    ids.add(target.definition.id);
    if (target.definition.category === "energy" || target.definition.code === "energy") {
      throw new Error("Energy must not be duplicated as a nutrient target");
    }
  }
}

function expectedMinimumState(
  row: GoalProgressRow,
): GoalProgressRow["minimum"] extends infer _ ? "met" | "below" | "indeterminate" | null : never {
  if (!row.minimum) return null;
  if (decimal(row.knownAmount).gte(row.minimum.amount)) return "met";
  return row.amountInterpretation === "exact" ? "below" : "indeterminate";
}

function expectedMaximumState(
  row: GoalProgressRow,
): "within" | "exceeded" | "indeterminate" | null {
  if (!row.maximum) return null;
  if (decimal(row.knownAmount).gt(row.maximum.amount)) return "exceeded";
  return row.amountInterpretation === "exact" ? "within" : "indeterminate";
}

function assertProgressRow(row: GoalProgressRow): void {
  if (row.amountInterpretation === "exact" && row.completeness !== "complete") {
    throw new Error("Incomplete progress cannot be exact");
  }
  if (row.minimum && row.minimum.state !== expectedMinimumState(row)) {
    throw new Error("Invalid minimum progress state");
  }
  if (row.maximum && row.maximum.state !== expectedMaximumState(row)) {
    throw new Error("Invalid maximum progress state");
  }
  if (row.target && row.target.percentIsExact !== (row.amountInterpretation === "exact")) {
    throw new Error("Invalid target percentage certainty");
  }
  if (row.target) {
    const expectedPercentage = decimal(row.target.amount).isZero()
      ? null
      : decimal(row.knownAmount).mul(100).div(row.target.amount).toFixed();
    if (
      (row.target.lowerBoundPercent === null) !== (expectedPercentage === null) ||
      (row.target.lowerBoundPercent?.length ?? 0) > MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH ||
      (expectedPercentage !== null &&
        !decimal(row.target.lowerBoundPercent ?? "0").eq(expectedPercentage))
    ) {
      throw new Error("Invalid target progress percentage");
    }
  }
}

function assertProgress(result: NutritionGoalProgressResponse): void {
  if (result.data.notice !== GENERAL_WELLNESS_NOTICE) throw new Error("Invalid wellness notice");
  if (!result.data.goal) {
    if (result.data.energy || result.data.nutrients.length > 0) {
      throw new Error("Progress without an effective goal must be empty");
    }
    return;
  }
  if (!result.data.energy) throw new Error("An effective goal requires energy progress");
  if (result.data.energy.code !== "energy" || result.data.energy.unit !== "kcal") {
    throw new Error("Energy progress must use the canonical energy nutrient");
  }
  assertProgressRow(result.data.energy);
  const nutrientIds = new Set<string>();
  for (const row of result.data.nutrients) {
    if (nutrientIds.has(row.nutrientId)) throw new Error("Duplicate goal progress nutrient");
    nutrientIds.add(row.nutrientId);
    assertProgressRow(row);
  }
}

export const goalRoutes: FastifyPluginAsync<GoalRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService);

  app.get<{ Querystring: GoalDateQuery }>(
    "/current",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys(["date"]),
      schema: {
        querystring: goalDateQuerySchema,
        response: {
          200: nutritionGoalResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<NutritionGoalResponse> => {
      if (!options.goalService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const goal = await withRequestSignal(
          request,
          (signal) =>
            options.goalService?.getCurrent({
              userId: principal.userId,
              localDate: request.query.date,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        if (goal) assertGoal(goal);
        reply.header("cache-control", "no-store");
        if (goal) reply.header("etag", revisionEtag(goal.revision));
        return { data: { goal } };
      } catch (error) {
        throw mapGoalError(error);
      }
    },
  );

  app.post<{ Body: NutritionGoalDraftRequest }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys(["effectiveFrom", "energy", "nutrientTargets"]),
      ],
      schema: {
        body: nutritionGoalDraftRequestSchema,
        response: {
          200: nutritionGoalMutationResponseSchema,
          201: nutritionGoalMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<NutritionGoalMutationResponse> => {
      if (!options.goalService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      try {
        assertDraft(request.body);
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.goalService?.create({
              userId: principal.userId,
              clientOperationId,
              requestDigest: requestDigest("create-nutrition-goal", request.body),
              goal: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertGoal(result.data.goal);
        reply
          .header("cache-control", "no-store")
          .header("etag", revisionEtag(result.data.goal.revision))
          .status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapGoalError(error);
      }
    },
  );

  app.post<{ Params: GoalParams; Body: NutritionGoalRevisionRequest }>(
    "/:goalId/revisions",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys(["energy", "nutrientTargets"]),
      ],
      schema: {
        params: goalParamsSchema,
        body: nutritionGoalRevisionRequestSchema,
        response: {
          200: nutritionGoalMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          422: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<NutritionGoalMutationResponse> => {
      if (!options.goalService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        assertDraft(request.body);
        const digestInput = {
          goalId: request.params.goalId,
          expectedRevision,
          goal: request.body,
        };
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.goalService?.revise({
              userId: principal.userId,
              goalId: request.params.goalId,
              expectedRevision,
              clientOperationId,
              requestDigest: requestDigest("revise-nutrition-goal", digestInput),
              goal: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertGoal(result.data.goal);
        reply
          .header("cache-control", "no-store")
          .header("etag", revisionEtag(result.data.goal.revision));
        return result;
      } catch (error) {
        throw mapGoalError(error);
      }
    },
  );

  app.get<{ Querystring: GoalDateQuery }>(
    "/progress",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys(["date"]),
      schema: {
        querystring: goalDateQuerySchema,
        response: {
          200: nutritionGoalProgressResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<NutritionGoalProgressResponse> => {
      if (!options.goalService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.goalService?.progress({
              userId: principal.userId,
              localDate: request.query.date,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertProgress(result);
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapGoalError(error);
      }
    },
  );
};

export const targetableNutrientRoutes: FastifyPluginAsync<GoalRoutesOptions> = async (
  app,
  options,
) => {
  const requireAuth = requireAuthentication(options.authService);
  app.get(
    "/targetable",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys([]),
      schema: {
        response: {
          200: targetableNutrientListResponseSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<TargetableNutrientListResponse> => {
      if (!options.goalService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.goalService?.listTargetable({ userId: principal.userId, signal }) ??
            Promise.reject(unavailable()),
        );
        if (
          result.data.some(
            (nutrient) => nutrient.category === "energy" || nutrient.code === "energy",
          )
        ) {
          throw new Error("Energy must not be listed as a nutrient target");
        }
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapGoalError(error);
      }
    },
  );
};
