import { createHash } from "node:crypto";

import {
  type CreateRecipeDiaryEntryRequest,
  createRecipeDiaryEntryRequestSchema,
  type DiaryMutationResponse,
  diaryMutationResponseSchema,
  problemDetailsSchema,
  type Recipe,
  type RecipeDraftRequest,
  type RecipeListResponse,
  type RecipeMutationResponse,
  type RecipeResponse,
  type RecipeSummary,
  recipeDraftRequestSchema,
  recipeListQuerySchema,
  recipeListResponseSchema,
  recipeMutationResponseSchema,
  recipeParamsSchema,
  recipeResponseSchema,
} from "@nutrition-tracker/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { authenticatedPrincipal, requireAuthentication } from "../../http/authentication.js";
import { requireIdempotencyKey, requireRevision, revisionEtag } from "../../http/preconditions.js";
import { HttpProblem } from "../../http/problem.js";
import {
  rejectUnexpectedBodyKeys,
  rejectUnexpectedQueryKeys,
} from "../../http/request-validation.js";
import type { AuthService } from "../auth/auth-service.js";
import {
  assertDiaryEntry,
  assertNutrientAggregate,
  DiaryIdempotencyConflictServiceError,
  DiaryLockedServiceError,
  DiaryNotFoundServiceError,
  DiaryValidationServiceError,
} from "../diary/diary.routes.js";

export interface RecipeService {
  list(input: {
    readonly userId: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<RecipeListResponse>;
  get(input: {
    readonly userId: string;
    readonly recipeId: string;
    readonly signal?: AbortSignal;
  }): Promise<Recipe | null>;
  create(input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly recipe: RecipeDraftRequest;
    readonly signal?: AbortSignal;
  }): Promise<RecipeMutationResponse>;
  revise(input: {
    readonly userId: string;
    readonly recipeId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly recipe: RecipeDraftRequest;
    readonly signal?: AbortSignal;
  }): Promise<RecipeMutationResponse>;
  log(input: {
    readonly userId: string;
    readonly recipeId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly entry: CreateRecipeDiaryEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<DiaryMutationResponse>;
}

export interface RecipeRoutesOptions {
  readonly authService?: AuthService;
  readonly recipeService?: RecipeService;
}

export class RecipeNotFoundServiceError extends Error {}
export class RecipeRevisionConflictServiceError extends Error {}
export class RecipeIdempotencyConflictServiceError extends Error {}
export class RecipeValidationServiceError extends Error {}
export class RecipeDependencyServiceError extends Error {}
export class RecipeCursorServiceError extends Error {}

interface RecipeParams {
  recipeId: string;
}

interface RecipeListQuery {
  cursor?: string;
  limit?: number;
}

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Recipe services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapRecipeError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof RecipeNotFoundServiceError || error instanceof DiaryNotFoundServiceError) {
    return new HttpProblem({
      statusCode: 404,
      code: "NOT_FOUND",
      title: "Not Found",
      detail: "The recipe was not found.",
      expose: true,
    });
  }
  if (error instanceof RecipeRevisionConflictServiceError) {
    return new HttpProblem({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      title: "Precondition Failed",
      detail: "The recipe changed. Refresh it and retry your revision.",
      expose: true,
    });
  }
  if (
    error instanceof RecipeIdempotencyConflictServiceError ||
    error instanceof DiaryIdempotencyConflictServiceError
  ) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The Idempotency-Key was already used for a different recipe operation.",
      expose: true,
    });
  }
  if (error instanceof DiaryLockedServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The diary day is locked.",
      expose: true,
    });
  }
  if (error instanceof RecipeDependencyServiceError) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail: "The nested recipe dependencies are unsafe or exceed supported limits.",
      expose: true,
    });
  }
  if (error instanceof RecipeCursorServiceError) {
    return new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "One or more request fields are invalid.",
      issues: [{ path: "/cursor", code: "invalid", message: "Invalid value." }],
      expose: true,
    });
  }
  if (
    error instanceof RecipeValidationServiceError ||
    error instanceof DiaryValidationServiceError
  ) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail: "The recipe is invalid for this account.",
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

function hasServingPair(servingCount: string | null, servingLabel: string | null): boolean {
  return (servingCount === null) === (servingLabel === null);
}

function assertDraft(recipe: RecipeDraftRequest): void {
  if (!hasServingPair(recipe.servingCount, recipe.servingLabel)) {
    throw new RecipeValidationServiceError();
  }
  const positions = new Set<number>();
  recipe.ingredients.forEach((ingredient, index) => {
    const position = ingredient.position ?? index;
    if (positions.has(position)) throw new RecipeValidationServiceError();
    positions.add(position);
  });
}

function assertWarningVector(warnings: Recipe["currentVersion"]["warnings"]): void {
  const codes = new Set<string>();
  for (const warning of warnings) {
    if (codes.has(warning.code)) throw new Error("Duplicate recipe warning code");
    codes.add(warning.code);
  }
}

function sameNutrientEvidence(
  left: Recipe["currentVersion"]["nutrition"]["totals"][number],
  right: Recipe["currentVersion"]["nutrition"]["totals"][number],
): boolean {
  return (
    left.nutrientId === right.nutrientId &&
    left.code === right.code &&
    left.name === right.name &&
    left.unit === right.unit &&
    left.completeness === right.completeness &&
    left.isExact === right.isExact &&
    left.contributorCount === right.contributorCount &&
    left.quantifiedCount === right.quantifiedCount &&
    left.traceCount === right.traceCount &&
    left.unknownCount === right.unknownCount &&
    Object.keys(left.unknownReasonCounts).every(
      (reason) =>
        left.unknownReasonCounts[reason as keyof typeof left.unknownReasonCounts] ===
        right.unknownReasonCounts[reason as keyof typeof right.unknownReasonCounts],
    )
  );
}

function assertRecipe(recipe: Recipe): void {
  if (!hasServingPair(recipe.currentVersion.servingCount, recipe.currentVersion.servingLabel)) {
    throw new Error("Recipe serving count and label are inconsistent");
  }
  if (
    (recipe.currentVersion.servingCount === null) !==
    (recipe.currentVersion.nutrition.perServing === null)
  ) {
    throw new Error("Recipe serving nutrition does not match its serving definition");
  }
  assertWarningVector(recipe.currentVersion.warnings);
  if (
    !recipe.currentVersion.warnings.some(
      (warning) => warning.code === "RETENTION_FACTORS_DEFAULTED",
    )
  ) {
    throw new Error("Recipe response is missing its default retention warning");
  }
  const positions = recipe.currentVersion.ingredients.map((ingredient) => ingredient.position);
  if (new Set(positions).size !== positions.length) throw new Error("Duplicate recipe position");
  const sourceKeys = recipe.currentVersion.sources.map(
    (source) => `${source.code}\u0000${source.releaseId}`,
  );
  if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error("Duplicate recipe source");
  if (sourceKeys.some((key, index) => index > 0 && (sourceKeys[index - 1] ?? "") > key)) {
    throw new Error("Recipe sources are not in deterministic order");
  }
  const totals = recipe.currentVersion.nutrition.totals;
  const scaledVectors = [
    recipe.currentVersion.nutrition.per100Grams,
    ...(recipe.currentVersion.nutrition.perServing
      ? [recipe.currentVersion.nutrition.perServing]
      : []),
  ];
  for (const vector of [totals, ...scaledVectors]) {
    if (vector.length === 0) throw new Error("Recipe nutrient vectors must not be empty");
    vector.forEach(assertNutrientAggregate);
    const nutrientIds = vector.map((nutrient) => nutrient.nutrientId);
    if (new Set(nutrientIds).size !== nutrientIds.length) {
      throw new Error("Duplicate nutrient in recipe response");
    }
  }
  for (const vector of scaledVectors) {
    if (
      vector.length !== totals.length ||
      vector.some((nutrient, index) => {
        const total = totals[index];
        return !total || !sameNutrientEvidence(total, nutrient);
      })
    ) {
      throw new Error("Recipe nutrient vectors do not share identical evidence");
    }
  }
}

function assertSummary(summary: RecipeSummary): void {
  if (!hasServingPair(summary.currentVersion.servingCount, summary.currentVersion.servingLabel)) {
    throw new Error("Recipe summary serving count and label are inconsistent");
  }
  assertWarningVector(summary.currentVersion.warnings);
  if (
    !summary.currentVersion.warnings.some(
      (warning) => warning.code === "RETENTION_FACTORS_DEFAULTED",
    )
  ) {
    throw new Error("Recipe summary is missing its default retention warning");
  }
}

export const recipeRoutes: FastifyPluginAsync<RecipeRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService);

  app.get<{ Querystring: RecipeListQuery }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys(["cursor", "limit"]),
      schema: {
        querystring: recipeListQuerySchema,
        response: {
          200: recipeListResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<RecipeListResponse> => {
      if (!options.recipeService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.recipeService?.list({
              userId: principal.userId,
              limit: request.query.limit ?? 20,
              ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        result.data.forEach(assertSummary);
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapRecipeError(error);
      }
    },
  );

  app.post<{ Body: RecipeDraftRequest }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys([
          "name",
          "description",
          "instructions",
          "ingredients",
          "finalYield",
          "servingCount",
          "servingLabel",
        ]),
      ],
      schema: {
        body: recipeDraftRequestSchema,
        response: {
          200: recipeMutationResponseSchema,
          201: recipeMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<RecipeMutationResponse> => {
      if (!options.recipeService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      try {
        assertDraft(request.body);
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.recipeService?.create({
              userId: principal.userId,
              clientOperationId,
              requestDigest: requestDigest("create-recipe", request.body),
              recipe: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertRecipe(result.data.recipe);
        reply
          .header("cache-control", "no-store")
          .header("etag", revisionEtag(result.data.recipe.revision))
          .status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapRecipeError(error);
      }
    },
  );

  app.get<{ Params: RecipeParams }>(
    "/:recipeId",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys([]),
      schema: {
        params: recipeParamsSchema,
        response: {
          200: recipeResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<RecipeResponse> => {
      if (!options.recipeService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const recipe = await withRequestSignal(
          request,
          (signal) =>
            options.recipeService?.get({
              userId: principal.userId,
              recipeId: request.params.recipeId,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        if (!recipe) throw new RecipeNotFoundServiceError();
        if (recipe.id !== request.params.recipeId) throw new Error("Recipe identity mismatch");
        assertRecipe(recipe);
        reply.header("cache-control", "no-store").header("etag", revisionEtag(recipe.revision));
        return { data: { recipe } };
      } catch (error) {
        throw mapRecipeError(error);
      }
    },
  );

  app.post<{ Params: RecipeParams; Body: RecipeDraftRequest }>(
    "/:recipeId/revisions",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys([
          "name",
          "description",
          "instructions",
          "ingredients",
          "finalYield",
          "servingCount",
          "servingLabel",
        ]),
      ],
      schema: {
        params: recipeParamsSchema,
        body: recipeDraftRequestSchema,
        response: {
          200: recipeMutationResponseSchema,
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
    async (request, reply): Promise<RecipeMutationResponse> => {
      if (!options.recipeService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        assertDraft(request.body);
        const digestInput = {
          recipeId: request.params.recipeId,
          expectedRevision,
          recipe: request.body,
        };
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.recipeService?.revise({
              userId: principal.userId,
              recipeId: request.params.recipeId,
              expectedRevision,
              clientOperationId,
              requestDigest: requestDigest("revise-recipe", digestInput),
              recipe: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertRecipe(result.data.recipe);
        if (result.data.recipe.id !== request.params.recipeId) {
          throw new Error("Recipe identity mismatch");
        }
        reply
          .header("cache-control", "no-store")
          .header("etag", revisionEtag(result.data.recipe.revision));
        return result;
      } catch (error) {
        throw mapRecipeError(error);
      }
    },
  );

  app.post<{ Params: RecipeParams; Body: CreateRecipeDiaryEntryRequest }>(
    "/:recipeId/log",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys([
          "recipeVersionId",
          "portion",
          "mealSlot",
          "occurredAt",
          "position",
        ]),
      ],
      schema: {
        params: recipeParamsSchema,
        body: createRecipeDiaryEntryRequestSchema,
        response: {
          200: diaryMutationResponseSchema,
          201: diaryMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DiaryMutationResponse> => {
      if (!options.recipeService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      try {
        const digestInput = { recipeId: request.params.recipeId, entry: request.body };
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.recipeService?.log({
              userId: principal.userId,
              recipeId: request.params.recipeId,
              clientOperationId,
              requestDigest: requestDigest("log-recipe", digestInput),
              entry: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        const logged = result.data.entry;
        if (
          logged?.entryKind !== "recipe" ||
          logged.recipe.id !== request.params.recipeId ||
          logged.recipeVersionId !== request.body.recipeVersionId
        ) {
          throw new Error("Logged recipe identity mismatch");
        }
        assertDiaryEntry(logged);
        reply.header("cache-control", "no-store").status(result.data.replayed ? 200 : 201);
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapRecipeError(error);
      }
    },
  );
};
