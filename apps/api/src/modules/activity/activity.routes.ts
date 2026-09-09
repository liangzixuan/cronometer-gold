import { createHash } from "node:crypto";

import {
  type ActivityDay,
  type ActivityDayResponse,
  type ActivityEntry,
  type ActivityMutationResponse,
  type ActivityOwnerHeaders,
  activityDayResponseSchema,
  activityMutationResponseSchema,
  activityOwnerHeadersSchema,
  type CreateActivityEntryHeaders,
  type CreateActivityEntryQuery,
  type CreateActivityEntryRequest,
  canonicalJson,
  createActivityEntryHeadersSchema,
  createActivityEntryQuerySchema,
  createActivityEntryRequestSchema,
  MAX_ACTIVITY_DAY_DURATION_MINUTES,
  MAX_ACTIVITY_ENTRIES_PER_DAY,
  problemDetailsSchema,
  type UpdateActivityEntryRequest,
  updateActivityEntryRequestSchema,
} from "@nutrition-tracker/contracts";
import {
  canonicalActivityDurationMinutes,
  canonicalActivityName,
  canonicalActivitySelfReportedEnergyKilocalories,
  canonicalIanaTimeZone,
  deriveDiaryLocalCoordinates,
} from "@nutrition-tracker/domain";
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

export interface ActivityService {
  getDay(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly signal?: AbortSignal;
  }): Promise<ActivityDay>;
  createEntry(input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly expectedProfileTimeZone: string;
    readonly entry: CreateActivityEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<ActivityMutationResponse>;
  updateEntry(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly expectedProfileTimeZone?: string;
    readonly patch: UpdateActivityEntryRequest;
    readonly signal?: AbortSignal;
  }): Promise<ActivityMutationResponse>;
  deleteEntry(input: {
    readonly userId: string;
    readonly entryId: string;
    readonly expectedRevision: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<ActivityMutationResponse>;
}

export interface ActivityRoutesOptions {
  readonly authService?: AuthService;
  readonly activityService?: ActivityService;
}

export class ActivityNotFoundServiceError extends Error {
  constructor() {
    super("Activity entry not found");
    this.name = "ActivityNotFoundServiceError";
  }
}

export class ActivityRevisionConflictServiceError extends Error {
  constructor() {
    super("Activity entry revision conflict");
    this.name = "ActivityRevisionConflictServiceError";
  }
}

export class ActivityIdempotencyConflictServiceError extends Error {
  constructor() {
    super("Activity idempotency conflict");
    this.name = "ActivityIdempotencyConflictServiceError";
  }
}

export class ActivityTimeZoneChangedServiceError extends Error {
  constructor() {
    super("Activity profile time zone changed");
    this.name = "ActivityTimeZoneChangedServiceError";
  }
}

export class ActivityValidationServiceError extends Error {
  constructor() {
    super("Activity validation failed");
    this.name = "ActivityValidationServiceError";
  }
}

interface ActivityDayQuerystring {
  readonly date: string;
}

interface ActivityEntryParams {
  readonly entryId: string;
}

const activityDayQuerySchema = {
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

const activityEntryParamsSchema = {
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
    detail: "Activity services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapActivityError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof ActivityNotFoundServiceError) {
    return new HttpProblem({
      statusCode: 404,
      code: "NOT_FOUND",
      title: "Not Found",
      detail: "The activity entry was not found.",
      expose: true,
    });
  }
  if (error instanceof ActivityRevisionConflictServiceError) {
    return new HttpProblem({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      title: "Precondition Failed",
      detail: "The activity entry changed. Refresh the day and retry your edit.",
      expose: true,
    });
  }
  if (error instanceof ActivityIdempotencyConflictServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The Idempotency-Key was already used for a different operation.",
      expose: true,
    });
  }
  if (error instanceof ActivityTimeZoneChangedServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "ACTIVITY_TIME_ZONE_CHANGED",
      title: "Conflict",
      detail:
        "The profile time zone changed before the activity entry was saved. Review the date and try again.",
      expose: true,
    });
  }
  if (error instanceof ActivityValidationServiceError || error instanceof RangeError) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail: "The activity entry is invalid for this account or day.",
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

function invalidProfileTimeZonePrecondition(): never {
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    expose: true,
  });
}

const OWNER_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireExpectedActivityOwner(
  value: string | string[] | undefined,
  authenticatedUserId: string,
): string {
  if (typeof value !== "string" || !OWNER_USER_ID.test(value)) {
    throw new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: "One or more request fields are invalid.",
      issues: [
        {
          path: "/headers/x-expected-owner-user-id",
          code: "invalid",
          message: "Invalid value.",
        },
      ],
      expose: true,
    });
  }
  const expectedUserId = value.toLowerCase();
  if (expectedUserId !== authenticatedUserId.toLowerCase()) {
    throw new HttpProblem({
      statusCode: 409,
      code: "ACTIVITY_OWNER_CHANGED",
      title: "Conflict",
      detail: "The signed-in account changed. Reload before accessing activity history.",
      expose: true,
    });
  }
  return expectedUserId;
}

function profileTimeZoneSignals(request: FastifyRequest): {
  readonly marker: unknown;
  readonly header: string | string[] | undefined;
} {
  const query =
    typeof request.query === "object" && request.query !== null && !Array.isArray(request.query)
      ? (request.query as Readonly<Record<string, unknown>>)
      : {};
  return {
    marker: query.profileTimeZonePrecondition,
    header: request.headers["x-expected-profile-time-zone"],
  };
}

async function requireProfileTimeZonePreconditionV1(request: FastifyRequest): Promise<void> {
  const { marker, header } = profileTimeZoneSignals(request);
  if (marker !== "v1" || typeof header !== "string") invalidProfileTimeZonePrecondition();
  expectedProfileTimeZone(header);
}

async function requireTimeZoneGuardForOccurredAtUpdate(request: FastifyRequest): Promise<void> {
  const body =
    typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
      ? (request.body as Readonly<Record<string, unknown>>)
      : {};
  const { marker, header } = profileTimeZoneSignals(request);
  if (Object.hasOwn(body, "occurredAt")) {
    if (marker !== "v1" || typeof header !== "string") invalidProfileTimeZonePrecondition();
    expectedProfileTimeZone(header);
    return;
  }
  if (marker !== undefined || header !== undefined) invalidProfileTimeZonePrecondition();
}

function requestDigest(subjectUserId: string, operation: string, value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ operation, subjectUserId, value }), "utf8")
    .digest("hex");
}

function activityDayEtag(response: ActivityDayResponse): string {
  const digest = createHash("sha256").update(canonicalJson(response), "utf8").digest("base64url");
  return `"a-${digest}"`;
}

function invalidActivityResponse(): HttpProblem {
  return new HttpProblem({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    title: "Invalid activity response",
    detail: "Activity response invariants failed.",
  });
}

function assertActivityEntry(entry: ActivityEntry): void {
  let coordinates: ReturnType<typeof deriveDiaryLocalCoordinates>;
  try {
    coordinates = deriveDiaryLocalCoordinates(entry.occurredAt, entry.timeZone);
    if (
      canonicalActivityName(entry.name) !== entry.name ||
      canonicalActivityDurationMinutes(entry.durationMinutes) !== entry.durationMinutes ||
      canonicalActivitySelfReportedEnergyKilocalories(entry.selfReportedEnergyKilocalories) !==
        entry.selfReportedEnergyKilocalories
    ) {
      throw invalidActivityResponse();
    }
  } catch {
    throw invalidActivityResponse();
  }
  if (
    coordinates.occurredAt !== entry.occurredAt ||
    coordinates.localDate !== entry.localDate ||
    coordinates.localTime !== entry.localTime ||
    coordinates.timeZone !== entry.timeZone
  ) {
    throw invalidActivityResponse();
  }
}

function activityEntriesAreOrdered(entries: readonly ActivityEntry[]): boolean {
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

export function assertActivityDay(day: ActivityDay): void {
  try {
    if (canonicalIanaTimeZone(day.timeZone) !== day.timeZone) throw invalidActivityResponse();
  } catch {
    throw invalidActivityResponse();
  }
  const total = day.entries.reduce((sum, entry) => {
    assertActivityEntry(entry);
    if (entry.localDate !== day.localDate) {
      throw invalidActivityResponse();
    }
    return sum + entry.durationMinutes;
  }, 0);
  if (
    day.entries.length > MAX_ACTIVITY_ENTRIES_PER_DAY ||
    new Set(day.entries.map((entry) => entry.id)).size !== day.entries.length ||
    !activityEntriesAreOrdered(day.entries) ||
    !Number.isSafeInteger(day.totalDurationMinutes) ||
    day.totalDurationMinutes < 0 ||
    day.totalDurationMinutes > MAX_ACTIVITY_DAY_DURATION_MINUTES ||
    total !== day.totalDurationMinutes ||
    (day.updatedAt === null &&
      (day.revision !== "0" || day.entries.length !== 0 || day.totalDurationMinutes !== 0))
  ) {
    throw invalidActivityResponse();
  }
}

function assertActivityMutation(
  result: ActivityMutationResponse,
  operation: "create" | "delete" | "update",
): void {
  const { affectedDays, entry } = result.data;
  if (entry) assertActivityEntry(entry);
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
    throw invalidActivityResponse();
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

export const activityRoutes: FastifyPluginAsync<ActivityRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService);

  app.get<{ Headers: ActivityOwnerHeaders; Querystring: ActivityDayQuerystring }>(
    "/",
    {
      preHandler: requireAuth,
      preValidation: rejectUnexpectedQueryKeys(["date"]),
      schema: {
        headers: activityOwnerHeadersSchema,
        querystring: activityDayQuerySchema,
        response: {
          200: activityDayResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<ActivityDayResponse> => {
      if (!options.activityService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      try {
        requireExpectedActivityOwner(request.headers["x-expected-owner-user-id"], principal.userId);
        const day = await withRequestSignal(
          request,
          (signal) =>
            options.activityService?.getDay({
              userId: principal.userId,
              localDate: request.query.date,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertActivityDay(day);
        const response: ActivityDayResponse = { data: day };
        reply.header("cache-control", "no-store").header("etag", activityDayEtag(response));
        return response;
      } catch (error) {
        throw mapActivityError(error);
      }
    },
  );

  app.post<{
    Body: CreateActivityEntryRequest;
    Headers: CreateActivityEntryHeaders;
    Querystring: CreateActivityEntryQuery;
  }>(
    "/entries",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["profileTimeZonePrecondition"]),
        rejectUnexpectedBodyKeys([
          "name",
          "durationMinutes",
          "selfReportedEnergyKilocalories",
          "occurredAt",
        ]),
        requireProfileTimeZonePreconditionV1,
      ],
      schema: {
        headers: createActivityEntryHeadersSchema,
        querystring: createActivityEntryQuerySchema,
        body: createActivityEntryRequestSchema,
        response: {
          200: activityMutationResponseSchema,
          201: activityMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<ActivityMutationResponse> => {
      if (!options.activityService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      try {
        const expectedOwnerUserId = requireExpectedActivityOwner(
          request.headers["x-expected-owner-user-id"],
          principal.userId,
        );
        const expectedTimeZone = expectedProfileTimeZone(
          request.headers["x-expected-profile-time-zone"],
        );
        if (expectedTimeZone === undefined) invalidProfileTimeZonePrecondition();
        const digest = requestDigest(
          expectedOwnerUserId,
          "create-activity-entry-with-expected-profile-time-zone-v1",
          {
            entry: request.body,
            expectedProfileTimeZone: expectedTimeZone,
          },
        );
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.activityService?.createEntry({
              userId: principal.userId,
              clientOperationId,
              requestDigest: digest,
              expectedProfileTimeZone: expectedTimeZone,
              entry: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertActivityMutation(result, "create");
        reply.header("cache-control", "no-store").status(result.data.replayed ? 200 : 201);
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapActivityError(error);
      }
    },
  );

  app.patch<{
    Params: ActivityEntryParams;
    Body: UpdateActivityEntryRequest;
    Headers: CreateActivityEntryHeaders;
    Querystring: CreateActivityEntryQuery;
  }>(
    "/entries/:entryId",
    {
      preHandler: requireAuth,
      preValidation: [
        rejectUnexpectedQueryKeys(["profileTimeZonePrecondition"]),
        rejectUnexpectedBodyKeys([
          "name",
          "durationMinutes",
          "selfReportedEnergyKilocalories",
          "occurredAt",
        ]),
        requireTimeZoneGuardForOccurredAtUpdate,
      ],
      schema: {
        params: activityEntryParamsSchema,
        headers: createActivityEntryHeadersSchema,
        querystring: createActivityEntryQuerySchema,
        body: updateActivityEntryRequestSchema,
        response: {
          200: activityMutationResponseSchema,
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
    async (request, reply): Promise<ActivityMutationResponse> => {
      if (!options.activityService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        const expectedOwnerUserId = requireExpectedActivityOwner(
          request.headers["x-expected-owner-user-id"],
          principal.userId,
        );
        const expectedTimeZone = expectedProfileTimeZone(
          request.headers["x-expected-profile-time-zone"],
        );
        const digest = requestDigest(
          expectedOwnerUserId,
          expectedTimeZone === undefined
            ? "update-activity-entry"
            : "update-activity-entry-with-expected-profile-time-zone-v1",
          {
            entryId: request.params.entryId,
            expectedRevision,
            patch: request.body,
            ...(expectedTimeZone === undefined
              ? {}
              : { expectedProfileTimeZone: expectedTimeZone }),
          },
        );
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.activityService?.updateEntry({
              userId: principal.userId,
              entryId: request.params.entryId,
              expectedRevision,
              clientOperationId,
              requestDigest: digest,
              ...(expectedTimeZone === undefined
                ? {}
                : { expectedProfileTimeZone: expectedTimeZone }),
              patch: request.body,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertActivityMutation(result, "update");
        reply.header("cache-control", "no-store");
        if (result.data.entry) reply.header("etag", revisionEtag(result.data.entry.revision));
        return result;
      } catch (error) {
        throw mapActivityError(error);
      }
    },
  );

  app.delete<{ Headers: ActivityOwnerHeaders; Params: ActivityEntryParams }>(
    "/entries/:entryId",
    {
      preHandler: requireAuth,
      preValidation: [rejectUnexpectedQueryKeys([]), rejectRequestBody()],
      schema: {
        params: activityEntryParamsSchema,
        headers: activityOwnerHeadersSchema,
        response: {
          200: activityMutationResponseSchema,
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
    async (request, reply): Promise<ActivityMutationResponse> => {
      if (!options.activityService) throw unavailable();
      const principal = authenticatedPrincipal(request);
      const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
      const expectedRevision = requireRevision(request.headers["if-match"]);
      try {
        const expectedOwnerUserId = requireExpectedActivityOwner(
          request.headers["x-expected-owner-user-id"],
          principal.userId,
        );
        const digest = requestDigest(expectedOwnerUserId, "delete-activity-entry", {
          entryId: request.params.entryId,
          expectedRevision,
        });
        const result = await withRequestSignal(
          request,
          (signal) =>
            options.activityService?.deleteEntry({
              userId: principal.userId,
              entryId: request.params.entryId,
              expectedRevision,
              clientOperationId,
              requestDigest: digest,
              signal,
            }) ?? Promise.reject(unavailable()),
        );
        assertActivityMutation(result, "delete");
        reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        throw mapActivityError(error);
      }
    },
  );
};
