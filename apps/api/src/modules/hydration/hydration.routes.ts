import { createHash } from "node:crypto";

import {
  type CreateHydrationEntryHeaders,
  type CreateHydrationEntryQuery,
  type CreateHydrationEntryRequest,
  canonicalJson,
  createHydrationEntryHeadersSchema,
  createHydrationEntryQuerySchema,
  createHydrationEntryRequestSchema,
  type HydrationDay,
  type HydrationDayResponse,
  type HydrationEntry,
  type HydrationMutationResponse,
  hydrationDayResponseSchema,
  hydrationMutationResponseSchema,
  MAX_HYDRATION_AMOUNT_MILLILITERS,
  MAX_HYDRATION_DAY_TOTAL_MILLILITERS,
  MAX_HYDRATION_ENTRIES_PER_DAY,
  problemDetailsSchema,
  type UpdateHydrationEntryRequest,
  updateHydrationEntryRequestSchema,
} from "@nutrition-tracker/contracts";
import { canonicalIanaTimeZone, deriveDiaryLocalCoordinates } from "@nutrition-tracker/domain";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { authenticatedPrincipal, requireAuthentication } from "../../http/authentication.js";
import { requireIdempotencyKey, requireRevision, revisionEtag } from "../../http/preconditions.js";
import { HttpProblem } from "../../http/problem.js";
import {
  rejectRequestBody,
  rejectUnexpectedBodyKeys,
  rejectUnexpectedQueryKeys,
} from "../../http/request-validation.js";
import type { AuthService } from "../auth/auth-service.js";

export interface HydrationService {
  getDay(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly signal?: AbortSignal;
  }): Promise<HydrationDay>;
  createEntry(input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly expectedProfileTimeZone?: string;
    readonly entry: CreateHydrationEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<HydrationMutationResponse>;
  updateEntry(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly patch: UpdateHydrationEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<HydrationMutationResponse>;
  deleteEntry(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<HydrationMutationResponse>;
}

export interface HydrationRoutesOptions {
  readonly authService?: AuthService;
  readonly hydrationService?: HydrationService;
}

export class HydrationNotFoundServiceError extends Error {
  constructor() {
    super("Hydration entry not found");
    this.name = "HydrationNotFoundServiceError";
  }
}

export class HydrationRevisionConflictServiceError extends Error {
  constructor() {
    super("Hydration entry revision conflict");
    this.name = "HydrationRevisionConflictServiceError";
  }
}

export class HydrationIdempotencyConflictServiceError extends Error {
  constructor() {
    super("Hydration idempotency conflict");
    this.name = "HydrationIdempotencyConflictServiceError";
  }
}

export class HydrationTimeZoneChangedServiceError extends Error {
  constructor() {
    super("Hydration profile time zone changed");
    this.name = "HydrationTimeZoneChangedServiceError";
  }
}

export class HydrationValidationServiceError extends Error {
  constructor() {
    super("Hydration validation failed");
    this.name = "HydrationValidationServiceError";
  }
}

interface HydrationDayQuerystring {
  readonly date: string;
}

interface HydrationEntryParams {
  readonly entryId: string;
}

const hydrationDayQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["date"],
  properties: {
    date: {
      type: "string",
      format: "date",
      pattern: "^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$",
    },
  },
} as const;

const hydrationEntryParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entryId"],
  properties: {
    entryId: {
      type: "string",
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    },
  },
} as const;

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Hydration services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapHydrationError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof HydrationNotFoundServiceError) {
    return new HttpProblem({
      statusCode: 404,
      code: "NOT_FOUND",
      title: "Not Found",
      detail: "The hydration entry was not found.",
      expose: true,
    });
  }
  if (error instanceof HydrationRevisionConflictServiceError) {
    return new HttpProblem({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      title: "Precondition Failed",
      detail: "The hydration entry changed. Refresh the day and retry your edit.",
      expose: true,
    });
  }
  if (error instanceof HydrationIdempotencyConflictServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The Idempotency-Key was already used for a different operation.",
      expose: true,
    });
  }
  if (error instanceof HydrationTimeZoneChangedServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "HYDRATION_TIME_ZONE_CHANGED",
      title: "Conflict",
      detail:
        "The profile time zone changed before the hydration entry was saved. Review the date and try again.",
      expose: true,
    });
  }
  if (error instanceof HydrationValidationServiceError || error instanceof RangeError) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail: "The hydration entry is invalid for this account or day.",
      expose: true,
    });
  }
  return unavailable(error);
}

function expectedProfileTimeZone(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string") throw new RangeError("Expected one header value");
    return canonicalIanaTimeZone(value);
  } catch {
    throw new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "One or more request fields are invalid.",
      issues: [
        {
          path: "/headers/x-expected-profile-time-zone",
          code: "invalid",
          message: "Invalid value.",
        },
      ],
      expose: true,
    });
  }
}

async function rejectUnpairedProfileTimeZonePrecondition(request: FastifyRequest): Promise<void> {
  const query =
    typeof request.query === "object" && request.query !== null && !Array.isArray(request.query)
      ? (request.query as Readonly<Record<string, unknown>>)
      : {};
  const marker = query.profileTimeZonePrecondition;
  const header = request.headers["x-expected-profile-time-zone"];
  const isLegacy = marker === undefined && header === undefined;
  const isGuardedV1 = marker === "v1" && typeof header === "string";
  if (isLegacy || isGuardedV1) return;
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    expose: true,
  });
}

function requestDigest(operation: string, value: unknown): string {
  return createHash("sha256").update(canonicalJson({ operation, value }), "utf8").digest("hex");
}

function hydrationDayEtag(response: HydrationDayResponse): string {
  const digest = createHash("sha256").update(canonicalJson(response), "utf8").digest("base64url");
  return `"h-${digest}"`;
}

function invalidHydrationResponse(): HttpProblem {
  return new HttpProblem({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    title: "Invalid hydration response",
    detail: "Hydration response invariants failed.",
  });
}

function assertHydrationEntry(entry: HydrationEntry): void {
  let coordinates: ReturnType<typeof deriveDiaryLocalCoordinates>;
  try {
    coordinates = deriveDiaryLocalCoordinates(entry.occurredAt, entry.timeZone);
  } catch {
    throw invalidHydrationResponse();
  }
  if (
    !Number.isSafeInteger(entry.amountMilliliters) ||
    entry.amountMilliliters < 1 ||
    entry.amountMilliliters > MAX_HYDRATION_AMOUNT_MILLILITERS ||
    coordinates.occurredAt !== entry.occurredAt ||
    coordinates.localDate !== entry.localDate ||
    coordinates.localTime !== entry.localTime ||
    coordinates.timeZone !== entry.timeZone
  ) {
    throw invalidHydrationResponse();
  }
}

function hydrationEntriesAreOrdered(entries: readonly HydrationEntry[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (!previous || !current) return false;
    if (
      previous.occurredAt > current.occurredAt ||
      (previous.occurredAt === current.occurredAt && previous.id > current.id)
    ) {
      return false;
    }
  }
  return true;
}

export function assertHydrationDay(day: HydrationDay): void {
  try {
    if (canonicalIanaTimeZone(day.timeZone) !== day.timeZone) throw invalidHydrationResponse();
  } catch {
    throw invalidHydrationResponse();
  }
  const total = day.entries.reduce((sum, entry) => {
    assertHydrationEntry(entry);
    if (entry.localDate !== day.localDate) {
      throw invalidHydrationResponse();
    }
    return sum + entry.amountMilliliters;
  }, 0);
  if (
    day.entries.length > MAX_HYDRATION_ENTRIES_PER_DAY ||
    new Set(day.entries.map((entry) => entry.id)).size !== day.entries.length ||
    !hydrationEntriesAreOrdered(day.entries) ||
    !Number.isSafeInteger(day.totalMilliliters) ||
    day.totalMilliliters < 0 ||
    day.totalMilliliters > MAX_HYDRATION_DAY_TOTAL_MILLILITERS ||
    total !== day.totalMilliliters ||
    (day.updatedAt === null &&
      (day.revision !== "0" || day.entries.length !== 0 || day.totalMilliliters !== 0))
  ) {
    throw invalidHydrationResponse();
  }
}

function assertHydrationMutation(
  result: HydrationMutationResponse,
  operation: "create" | "delete" | "update",
): void {
  const { affectedDays, entry } = result.data;
  if (entry) assertHydrationEntry(entry);
  const localDates = new Set(affectedDays.map((day) => day.localDate));
  const requiresLiveEntry = operation !== "delete";
  if (
    localDates.size !== affectedDays.length ||
    (requiresLiveEntry && entry === null) ||
    (!requiresLiveEntry && entry !== null) ||
    (entry !== null && !localDates.has(entry.localDate)) ||
    (operation === "create" && affectedDays.length !== 1) ||
    (operation === "delete" && affectedDays.length !== 1) ||
    (operation === "update" && (affectedDays.length < 1 || affectedDays.length > 2))
  ) {
    throw invalidHydrationResponse();
  }
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

export const hydrationRoutes: FastifyPluginAsync<HydrationRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService);

  app.get<{ Querystring: HydrationDayQuerystring }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys(["date"]),
      schema: {
        querystring: hydrationDayQuerySchema,
        response: {
          200: hydrationDayResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<HydrationDayResponse> => {
      if (!options.hydrationService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        const day = await withRequestSignal(
          request,
          (signal) =>
            options.hydrationService?.getDay({
              userId: principal.userId,
              localDate: request.query.date,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertHydrationDay(day);
        const response: HydrationDayResponse = { data: day };
        reply.header("cache-control", "no-store").header("etag", hydrationDayEtag(response));
        return response;
      } catch (error) {
        throw mapHydrationError(error);
      }
    },
  );

  app.post<{
    Body: CreateHydrationEntryRequest;
    Headers: CreateHydrationEntryHeaders;
    Querystring: CreateHydrationEntryQuery;
  }>(
    "/entries",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["profileTimeZonePrecondition"]),
        rejectUnexpectedBodyKeys(["amountMilliliters", "occurredAt"]),
        rejectUnpairedProfileTimeZonePrecondition,
      ],
      schema: {
        headers: createHydrationEntryHeadersSchema,
        querystring: createHydrationEntryQuerySchema,
        body: createHydrationEntryRequestSchema,
        response: {
          200: hydrationMutationResponseSchema,
          201: hydrationMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<HydrationMutationResponse> => {
      if (!options.hydrationService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      try {
        const expectedTimeZone = expectedProfileTimeZone(
          request.headers["x-expected-profile-time-zone"],
        );
        const digest =
          expectedTimeZone === undefined
            ? requestDigest("create-hydration-entry", request.body)
            : requestDigest("create-hydration-entry-with-expected-profile-time-zone-v1", {
                entry: request.body,
                expectedProfileTimeZone: expectedTimeZone,
              });
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.hydrationService?.createEntry({
              userId: principal.userId,
              clientOperationId,
              requestDigest: digest,
              ...(expectedTimeZone === undefined
                ? {}
                : { expectedProfileTimeZone: expectedTimeZone }),
              entry: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertHydrationMutation(result, "create");
        reply.header("cache-control", "no-store").status(result.data.replayed ? 200 : 201);
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapHydrationError(error);
      }
    },
  );

  app.patch<{ Params: HydrationEntryParams; Body: UpdateHydrationEntryRequest }>(
    "/entries/:entryId",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys(["amountMilliliters", "occurredAt"]),
      ],
      schema: {
        params: hydrationEntryParamsSchema,
        body: updateHydrationEntryRequestSchema,
        response: {
          200: hydrationMutationResponseSchema,
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
    async (request, reply): Promise<HydrationMutationResponse> => {
      if (!options.hydrationService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        const digest = requestDigest("update-hydration-entry", {
          entryId: request.params.entryId,
          expectedRevision,
          patch: request.body,
        });
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.hydrationService?.updateEntry({
              userId: principal.userId,
              entryId: request.params.entryId,
              expectedRevision,
              clientOperationId,
              requestDigest: digest,
              patch: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertHydrationMutation(result, "update");
        reply.header("cache-control", "no-store");
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapHydrationError(error);
      }
    },
  );

  app.delete<{ Params: HydrationEntryParams }>(
    "/entries/:entryId",
    {
      preHandler: requireAuth,
      preValidation: [rejectUnexpectedQueryKeys([]), rejectRequestBody()],
      schema: {
        params: hydrationEntryParamsSchema,
        response: {
          200: hydrationMutationResponseSchema,
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
    async (request, reply): Promise<HydrationMutationResponse> => {
      if (!options.hydrationService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        const digest = requestDigest("delete-hydration-entry", {
          entryId: request.params.entryId,
          expectedRevision,
        });
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.hydrationService?.deleteEntry({
              userId: principal.userId,
              entryId: request.params.entryId,
              expectedRevision,
              clientOperationId,
              requestDigest: digest,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertHydrationMutation(result, "delete");
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapHydrationError(error);
      }
    },
  );
};
