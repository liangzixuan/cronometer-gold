import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import {
  type AccountErasureMutationResponse,
  type AccountErasureRequest,
  type AccountErasureResponse,
  type AccountExportRequest,
  type AccountExportResponse,
  accountErasureMutationResponseSchema,
  accountErasureParamsSchema,
  accountErasureRequestSchema,
  accountErasureResponseSchema,
  accountExportArtifactParamsSchema,
  accountExportParamsSchema,
  accountExportRequestSchema,
  accountExportResponseSchema,
  assertAccountErasureLifecycle,
  assertAccountExportLifecycle,
  type BiometricDefinitionDraftRequest,
  type BiometricDefinitionListResponse,
  type BiometricDefinitionMutationResponse,
  type BiometricDefinitionRevisionRequest,
  type BiometricEventDraftRequest,
  type BiometricEventListResponse,
  type BiometricEventMutationResponse,
  type BiometricEventRevisionRequest,
  type BiometricTrendResponse,
  biometricDefinitionDraftRequestSchema,
  biometricDefinitionListResponseSchema,
  biometricDefinitionMutationResponseSchema,
  biometricDefinitionParamsSchema,
  biometricDefinitionRevisionRequestSchema,
  biometricEventDraftRequestSchema,
  biometricEventListQuerySchema,
  biometricEventListResponseSchema,
  biometricEventMutationResponseSchema,
  biometricEventParamsSchema,
  biometricEventRevisionRequestSchema,
  biometricTrendQuerySchema,
  biometricTrendResponseSchema,
  type CreateCustomFoodDiaryEntryRequest,
  type CustomFood,
  type CustomFoodDraftRequest,
  type CustomFoodListResponse,
  type CustomFoodMutationResponse,
  type CustomFoodResponse,
  canonicalJson,
  createCustomFoodDiaryEntryRequestSchema,
  customFoodDraftRequestSchema,
  customFoodListQuerySchema,
  customFoodListResponseSchema,
  customFoodMutationResponseSchema,
  customFoodParamsSchema,
  customFoodResponseSchema,
  type DeviceChallengeRequest,
  type DeviceChallengeResponse,
  type DiaryMutationResponse,
  type DisconnectPlatformIntegrationRequest,
  deviceChallengeRequestSchema,
  deviceChallengeResponseSchema,
  diaryMutationResponseSchema,
  disconnectPlatformIntegrationRequestSchema,
  type ExportFormat,
  GENERIC_REMINDER_LOCK_SCREEN_TEXT,
  GENERIC_REMINDER_TITLE,
  type HealthDeviceResponse,
  type HealthImportBatchRequest,
  type HealthImportBatchResponse,
  healthDeviceParamsSchema,
  healthDeviceResponseSchema,
  healthImportBatchRequestSchema,
  healthImportBatchResponseSchema,
  healthImportSignaturePayload,
  type NutrientTrendResponse,
  nutrientTrendQuerySchema,
  nutrientTrendResponseSchema,
  type PlatformConsentRequest,
  type PlatformIntegrationListResponse,
  type PlatformIntegrationResponse,
  platformConsentRequestSchema,
  platformIntegrationListResponseSchema,
  platformIntegrationResponseSchema,
  platformParamsSchema,
  problemDetailsSchema,
  type RebindPlatformIntegrationRequest,
  type RegisterHealthDeviceRequest,
  type ReminderDraftRequest,
  type ReminderListResponse,
  type ReminderMutationResponse,
  type ReminderRevisionRequest,
  type RepeatDiaryEntryRequest,
  rebindPlatformIntegrationRequestSchema,
  registerHealthDeviceRequestSchema,
  reminderDraftRequestSchema,
  reminderListResponseSchema,
  reminderMutationResponseSchema,
  reminderParamsSchema,
  reminderRevisionRequestSchema,
  repeatDiaryEntryRequestSchema,
  signedDeviceHeadersSchema,
} from "@nutrition-tracker/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticatedPrincipal,
  authenticationRequired,
  requireAuthentication,
} from "../../http/authentication.js";
import { requireIdempotencyKey, requireRevision, revisionEtag } from "../../http/preconditions.js";
import { HttpProblem } from "../../http/problem.js";
import { rejectUnexpectedQueryKeys } from "../../http/request-validation.js";
import type { AuthService } from "../auth/auth-service.js";
import { BoundedAuthRateLimiter } from "../auth/rate-limiter.js";
import { verifyDeviceRegistration } from "./device-signatures.js";

type Signal = { readonly signal?: AbortSignal };
type Operation = {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
} & Signal;

export interface RetentionService {
  nutrientTrend(
    input: {
      readonly userId: string;
      readonly nutrientId: string;
      readonly from: string;
      readonly to: string;
    } & Signal,
  ): Promise<NutrientTrendResponse>;
  biometricTrend(
    input: {
      readonly userId: string;
      readonly definitionId: string;
      readonly from: string;
      readonly to: string;
    } & Signal,
  ): Promise<BiometricTrendResponse>;
  repeatEntry(
    input: Operation & {
      readonly sourceEntryId: string;
      readonly expectedSourceRevision: string;
      readonly request: RepeatDiaryEntryRequest;
    },
  ): Promise<DiaryMutationResponse>;
  listCustomFoods(
    input: {
      readonly userId: string;
      readonly cursor?: string;
      readonly limit: number;
    } & Signal,
  ): Promise<CustomFoodListResponse>;
  getCustomFood(
    input: { readonly userId: string; readonly customFoodId: string } & Signal,
  ): Promise<CustomFood | null>;
  createCustomFood(
    input: Operation & { readonly draft: CustomFoodDraftRequest },
  ): Promise<CustomFoodMutationResponse>;
  reviseCustomFood(
    input: Operation & {
      readonly customFoodId: string;
      readonly expectedRevision: string;
      readonly draft: CustomFoodDraftRequest;
    },
  ): Promise<CustomFoodMutationResponse>;
  archiveCustomFood(
    input: Operation & {
      readonly customFoodId: string;
      readonly expectedRevision: string;
    },
  ): Promise<CustomFoodMutationResponse>;
  logCustomFood(
    input: Operation & {
      readonly customFoodId: string;
      readonly entry: CreateCustomFoodDiaryEntryRequest;
    },
  ): Promise<DiaryMutationResponse>;
  listBiometricDefinitions(
    input: { readonly userId: string } & Signal,
  ): Promise<BiometricDefinitionListResponse>;
  createBiometricDefinition(
    input: Operation & { readonly draft: BiometricDefinitionDraftRequest },
  ): Promise<BiometricDefinitionMutationResponse>;
  reviseBiometricDefinition(
    input: Operation & {
      readonly definitionId: string;
      readonly expectedRevision: string;
      readonly draft: BiometricDefinitionRevisionRequest;
    },
  ): Promise<BiometricDefinitionMutationResponse>;
  archiveBiometricDefinition(
    input: Operation & {
      readonly definitionId: string;
      readonly expectedRevision: string;
    },
  ): Promise<BiometricDefinitionMutationResponse>;
  listBiometricEvents(
    input: {
      readonly userId: string;
      readonly from: string;
      readonly to: string;
      readonly definitionId?: string;
      readonly cursor?: string;
      readonly limit: number;
    } & Signal,
  ): Promise<BiometricEventListResponse>;
  createBiometricEvent(
    input: Operation & { readonly event: BiometricEventDraftRequest },
  ): Promise<BiometricEventMutationResponse>;
  reviseBiometricEvent(
    input: Operation & {
      readonly eventId: string;
      readonly expectedRevision: string;
      readonly event: BiometricEventRevisionRequest;
    },
  ): Promise<BiometricEventMutationResponse>;
  deleteBiometricEvent(
    input: Operation & {
      readonly eventId: string;
      readonly expectedRevision: string;
    },
  ): Promise<BiometricEventMutationResponse>;
  listReminders(input: { readonly userId: string } & Signal): Promise<ReminderListResponse>;
  createReminder(
    input: Operation & { readonly reminder: ReminderDraftRequest },
  ): Promise<ReminderMutationResponse>;
  reviseReminder(
    input: Operation & {
      readonly reminderId: string;
      readonly expectedRevision: string;
      readonly reminder: ReminderRevisionRequest;
    },
  ): Promise<ReminderMutationResponse>;
  revokeReminder(
    input: Operation & {
      readonly reminderId: string;
      readonly expectedRevision: string;
    },
  ): Promise<ReminderMutationResponse>;
  createDeviceChallenge(
    input: Operation & {
      readonly request: DeviceChallengeRequest;
    },
  ): Promise<{ readonly response: DeviceChallengeResponse; readonly replayed: boolean }>;
  registerDevice(
    input: Operation & {
      readonly request: RegisterHealthDeviceRequest;
      readonly verification: {
        readonly canonicalSignaturePayload: string;
        readonly keyFingerprint: string;
        readonly publicKeySpkiBase64: string;
        readonly proofSignatureDigest: string;
      };
    },
  ): Promise<HealthDeviceResponse>;
  revokeDevice(
    input: Operation & {
      readonly deviceId: string;
      readonly expectedRevision: string;
    },
  ): Promise<HealthDeviceResponse>;
  listPlatformIntegrations(
    input: { readonly userId: string } & Signal,
  ): Promise<PlatformIntegrationListResponse>;
  consentPlatformIntegration(
    input: Operation & { readonly request: PlatformConsentRequest },
  ): Promise<PlatformIntegrationResponse>;
  importPlatformHealth(
    input: Operation & {
      readonly request: HealthImportBatchRequest;
      readonly signedAt: string;
      /** Freshness is enforced only for a never-before-seen envelope, after signature verification. */
      readonly timestampFresh: boolean;
      readonly nonce: string;
      readonly signature: string;
      readonly canonicalSignaturePayload: string;
    },
  ): Promise<HealthImportBatchResponse>;
  disconnectPlatformIntegration(
    input: Operation & {
      readonly platform: "apple_healthkit" | "android_health_connect";
      readonly expectedRevision: string;
      readonly request: DisconnectPlatformIntegrationRequest;
    },
  ): Promise<PlatformIntegrationResponse>;
  rebindPlatformIntegration(
    input: Operation & {
      readonly platform: "apple_healthkit" | "android_health_connect";
      readonly expectedRevision: string;
      readonly request: RebindPlatformIntegrationRequest;
    },
  ): Promise<PlatformIntegrationResponse>;
  createExport(
    input: Operation & {
      readonly request: AccountExportRequest;
      readonly sessionTokenHash: string;
      readonly reauthenticationToken: string;
    },
  ): Promise<AccountExportResponse>;
  getExport(
    input: { readonly userId: string; readonly exportId: string } & Signal,
  ): Promise<AccountExportResponse | null>;
  getExportArtifact(
    input: {
      readonly userId: string;
      readonly exportId: string;
      readonly format: ExportFormat;
    } & Signal,
  ): Promise<{
    readonly stream: Readable;
    readonly fileName: string;
    readonly contentLength: number;
    readonly mediaType: "application/json" | "application/zip";
    readonly sha256: string;
  } | null>;
  requestErasure(
    input: Operation & {
      readonly request: AccountErasureRequest;
      readonly sessionTokenHash: string;
      readonly reauthenticationToken: string;
    },
  ): Promise<AccountErasureMutationResponse>;
  getErasure(
    input: { readonly userId: string; readonly erasureId: string } & Signal,
  ): Promise<AccountErasureResponse | null>;
  getErasureByCapability(
    input: {
      readonly erasureId: string;
      readonly statusTokenHash: string;
    } & Signal,
  ): Promise<AccountErasureResponse | null>;
}

export interface RetentionRoutesOptions {
  readonly authService?: AuthService;
  readonly retentionService?: RetentionService;
  readonly mutationRateLimiter?: BoundedAuthRateLimiter;
  readonly statusCapabilityRateLimiter?: BoundedAuthRateLimiter;
  readonly clock?: () => Date;
}

export class RetentionNotFoundServiceError extends Error {}
export class RetentionValidationServiceError extends Error {}
export class RetentionRevisionConflictServiceError extends Error {}
export class RetentionIdempotencyConflictServiceError extends Error {}
export class RetentionImportConflictServiceError extends Error {}
export class RetentionConsentRequiredServiceError extends Error {}
export class RetentionExportInProgressServiceError extends Error {}
export class RetentionExportNotReadyServiceError extends Error {}
export class RetentionDeviceAuthenticationServiceError extends Error {}
export class RetentionRecentAuthenticationServiceError extends Error {}
export class RetentionDownloadRateLimitedServiceError extends Error {}
export class RetentionDownloadUnavailableServiceError extends Error {}

interface IdParams {
  entryId: string;
}
interface CustomFoodParams {
  customFoodId: string;
}
interface DefinitionParams {
  definitionId: string;
}
interface EventParams {
  eventId: string;
}
interface ReminderParams {
  reminderId: string;
}
interface DeviceParams {
  deviceId: string;
}
interface PlatformParams {
  platform: "apple_healthkit" | "android_health_connect";
}
interface ExportParams {
  exportId: string;
}
interface ExportArtifactParams extends ExportParams {
  format: ExportFormat;
}
interface ErasureParams {
  erasureId: string;
}
interface TrendQuery {
  nutrientId: string;
  from: string;
  to: string;
}
interface BiometricTrendQuery {
  definitionId: string;
  from: string;
  to: string;
}
interface CustomListQuery {
  cursor?: string;
  limit?: number;
}
interface EventListQuery {
  from: string;
  to: string;
  definitionId?: string;
  cursor?: string;
  limit?: number;
}

const idParamsSchema = {
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
    detail: "Retention services are temporarily unavailable.",
    expose: true,
    cause,
  });
}

function mapError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof RetentionNotFoundServiceError) {
    return new HttpProblem({
      statusCode: 404,
      code: "NOT_FOUND",
      title: "Not Found",
      detail: "The requested resource was not found.",
      expose: true,
    });
  }
  if (error instanceof RetentionRevisionConflictServiceError) {
    return new HttpProblem({
      statusCode: 412,
      code: "PRECONDITION_FAILED",
      title: "Precondition Failed",
      detail: "The resource changed. Refresh it and retry.",
      expose: true,
    });
  }
  if (error instanceof RetentionIdempotencyConflictServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The Idempotency-Key was already used for a different operation.",
      expose: true,
    });
  }
  if (error instanceof RetentionImportConflictServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Conflict",
      detail: "The platform import cursor or source revision conflicts with current state.",
      expose: true,
    });
  }
  if (error instanceof RetentionConsentRequiredServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Consent Required",
      detail: "Current explicit consent is required for this operation.",
      expose: true,
    });
  }
  if (error instanceof RetentionExportInProgressServiceError) {
    return new HttpProblem({
      statusCode: 429,
      code: "RATE_LIMITED",
      title: "Export In Progress",
      detail: "An account export is already in progress. Try again after it finishes.",
      expose: true,
    });
  }
  if (error instanceof RetentionExportNotReadyServiceError) {
    return new HttpProblem({
      statusCode: 409,
      code: "CONFLICT",
      title: "Export Not Ready",
      detail: "The requested export artifact is not ready.",
      expose: true,
    });
  }
  if (error instanceof RetentionDeviceAuthenticationServiceError) {
    return new HttpProblem({
      statusCode: 401,
      code: "UNAUTHORIZED",
      title: "Unauthorized",
      detail: "Device authentication failed.",
      expose: true,
    });
  }
  if (error instanceof RetentionRecentAuthenticationServiceError) {
    return new HttpProblem({
      statusCode: 401,
      code: "UNAUTHORIZED",
      title: "Recent Authentication Required",
      detail: "A valid recent reauthentication proof is required.",
      expose: true,
    });
  }
  if (error instanceof RetentionDownloadRateLimitedServiceError) {
    return new HttpProblem({
      statusCode: 429,
      code: "RATE_LIMITED",
      title: "Too Many Requests",
      detail: "The export download budget has been reached. Try again later.",
      expose: true,
    });
  }
  if (error instanceof RetentionDownloadUnavailableServiceError) {
    return unavailable(error);
  }
  if (error instanceof RetentionValidationServiceError || error instanceof RangeError) {
    return new HttpProblem({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      title: "Unprocessable Content",
      detail: "The retention request is invalid for this account.",
      expose: true,
    });
  }
  return unavailable(error);
}

function digest(operation: string, value: unknown): string {
  return createHash("sha256").update(canonicalJson({ operation, value }), "utf8").digest("hex");
}

function requireSingleHeader(
  value: string | string[] | undefined,
  name: string,
  pattern: RegExp,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new HttpProblem({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      title: "Bad Request",
      detail: `A valid ${name} header is required.`,
      issues: [{ path: `/headers/${name}`, code: "invalid", message: "Invalid value." }],
      expose: true,
    });
  }
  return value;
}

function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000;
}

function assertLocalDateRange(from: string, to: string): void {
  const span = dateOrdinal(to) - dateOrdinal(from);
  if (!Number.isSafeInteger(span) || span < 0 || span > 365)
    throw new RetentionValidationServiceError();
}

function assertInstantRange(from: string, to: string): void {
  const span = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(span) || span < 0 || span > 366 * 86_400_000)
    throw new RetentionValidationServiceError();
}

async function withSignal<T>(
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

function headers(reply: FastifyReply, revision?: string): void {
  reply.header("cache-control", "no-store");
  if (revision) reply.header("etag", revisionEtag(revision));
}

function assertReminder(result: ReminderMutationResponse | ReminderListResponse): void {
  const reminders = "replayed" in result.data ? [result.data.reminder] : result.data;
  for (const reminder of reminders) {
    if (
      reminder.channel !== "local" ||
      reminder.deliveryPolicy.title !== GENERIC_REMINDER_TITLE ||
      reminder.deliveryPolicy.lockScreenText !== GENERIC_REMINDER_LOCK_SCREEN_TEXT ||
      reminder.deliveryPolicy.includesHealthDetails
    ) {
      throw new Error("Reminder response violates the generic delivery policy");
    }
  }
}

function consumeMutation(limiter: BoundedAuthRateLimiter, userId: string): void {
  if (!limiter.consume(`retention:${createHash("sha256").update(userId).digest("hex")}`)) {
    throw new HttpProblem({
      statusCode: 429,
      code: "RATE_LIMITED",
      title: "Too Many Requests",
      detail: "Too many retention mutations. Try again later.",
      expose: true,
    });
  }
}

function service(options: RetentionRoutesOptions): RetentionService {
  if (!options.retentionService) throw unavailable();
  return options.retentionService;
}

export const retentionRoutes: FastifyPluginAsync<RetentionRoutesOptions> = async (app, options) => {
  const requireAuth = requireAuthentication(options.authService) as unknown as (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  const limiter =
    options.mutationRateLimiter ??
    new BoundedAuthRateLimiter({ maximumAttempts: 120, windowMs: 60_000 });
  const statusCapabilityLimiter =
    options.statusCapabilityRateLimiter ??
    new BoundedAuthRateLimiter({ maximumAttempts: 30, windowMs: 60_000 });
  const clock = options.clock ?? (() => new Date());
  const erasureRecoveryJobs = new WeakMap<FastifyRequest, string>();

  app.addHook("preHandler", async (request, reply) => {
    const isCapabilityStatusRead =
      request.method === "GET" &&
      request.routeOptions.url?.endsWith("/account/erasure/:erasureId") === true &&
      typeof request.headers["x-erasure-status-token"] === "string";
    if (isCapabilityStatusRead) return;
    const isErasureRequest =
      request.method === "POST" && request.routeOptions.url?.endsWith("/account/erasure") === true;
    if (!isErasureRequest) {
      await requireAuth(request, reply);
      return;
    }
    if (!options.authService) {
      await requireAuth(request, reply);
      return;
    }
    try {
      const principal = await options.authService.authenticate(request.headers.authorization);
      if (principal) {
        request.authPrincipal = principal;
        return;
      }
      const recovery = await options.authService.authenticateErasureRecovery(
        request.headers.authorization,
      );
      if (!recovery) {
        reply.header("www-authenticate", 'Bearer realm="nutrition-api"');
        throw authenticationRequired();
      }
      request.authPrincipal = recovery;
      erasureRecoveryJobs.set(request, recovery.erasureJobId);
    } catch (error) {
      if (error instanceof HttpProblem) throw error;
      throw unavailable(error);
    }
  });
  app.addHook("preValidation", async (request) => {
    const route = request.routeOptions.url ?? "";
    const allowed = route.endsWith("/trends/nutrients")
      ? new Set(["nutrientId", "from", "to"])
      : route.endsWith("/trends/biometrics")
        ? new Set(["definitionId", "from", "to"])
        : route.endsWith("/custom-foods") && request.method === "GET"
          ? new Set(["cursor", "limit"])
          : route.endsWith("/biometrics/events") && request.method === "GET"
            ? new Set(["from", "to", "definitionId", "cursor", "limit"])
            : new Set<string>();
    const unexpected = Object.keys((request.query ?? {}) as object).find(
      (key) => !allowed.has(key),
    );
    if (unexpected) {
      throw new HttpProblem({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        title: "Bad Request",
        detail: "One or more query fields are invalid.",
        issues: [
          { path: `/query/${unexpected}`, code: "additionalProperties", message: "Invalid value." },
        ],
        expose: true,
      });
    }
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.get<{ Querystring: TrendQuery }>(
    "/trends/nutrients",
    {
      preValidation: rejectUnexpectedQueryKeys(["nutrientId", "from", "to"]),
      schema: {
        querystring: nutrientTrendQuerySchema,
        response: {
          200: nutrientTrendResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<NutrientTrendResponse> => {
      try {
        assertLocalDateRange(request.query.from, request.query.to);
        const principal = authenticatedPrincipal(request);
        return await withSignal(request, (signal) =>
          service(options).nutrientTrend({
            userId: principal.userId,
            nutrientId: request.query.nutrientId,
            from: request.query.from,
            to: request.query.to,
            signal,
          }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get<{ Querystring: BiometricTrendQuery }>(
    "/trends/biometrics",
    {
      preValidation: rejectUnexpectedQueryKeys(["definitionId", "from", "to"]),
      schema: {
        querystring: biometricTrendQuerySchema,
        response: {
          200: biometricTrendResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<BiometricTrendResponse> => {
      try {
        assertLocalDateRange(request.query.from, request.query.to);
        const principal = authenticatedPrincipal(request);
        return await withSignal(request, (signal) =>
          service(options).biometricTrend({
            userId: principal.userId,
            definitionId: request.query.definitionId,
            from: request.query.from,
            to: request.query.to,
            signal,
          }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Params: IdParams; Body: RepeatDiaryEntryRequest }>(
    "/diary/entries/:entryId/repeat",
    {
      schema: {
        params: idParamsSchema,
        body: repeatDiaryEntryRequestSchema,
        response: {
          200: diaryMutationResponseSchema,
          201: diaryMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DiaryMutationResponse> => {
      try {
        const principal = authenticatedPrincipal(request);
        consumeMutation(limiter, principal.userId);
        const expectedSourceRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).repeatEntry({
            userId: principal.userId,
            sourceEntryId: request.params.entryId,
            expectedSourceRevision,
            clientOperationId,
            requestDigest: digest("repeat-diary-entry", {
              sourceEntryId: request.params.entryId,
              expectedSourceRevision,
              request: request.body,
            }),
            request: request.body,
            signal,
          }),
        );
        headers(reply, result.data.entry?.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get<{ Querystring: CustomListQuery }>(
    "/custom-foods",
    {
      preValidation: rejectUnexpectedQueryKeys(["cursor", "limit"]),
      schema: {
        querystring: customFoodListQuerySchema,
        response: {
          200: customFoodListResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<CustomFoodListResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        return await withSignal(request, (signal) =>
          service(options).listCustomFoods({
            userId: principal.userId,
            limit: request.query.limit ?? 20,
            ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
            signal,
          }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get<{ Params: CustomFoodParams }>(
    "/custom-foods/:customFoodId",
    {
      schema: {
        params: customFoodParamsSchema,
        response: {
          200: customFoodResponseSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<CustomFoodResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        const customFood = await withSignal(request, (signal) =>
          service(options).getCustomFood({
            userId: principal.userId,
            customFoodId: request.params.customFoodId,
            signal,
          }),
        );
        if (!customFood) throw new RetentionNotFoundServiceError();
        headers(reply, customFood.revision);
        return { data: { customFood } };
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: CustomFoodDraftRequest }>(
    "/custom-foods",
    {
      schema: {
        body: customFoodDraftRequestSchema,
        response: {
          200: customFoodMutationResponseSchema,
          201: customFoodMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<CustomFoodMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).createCustomFood({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("create-custom-food", request.body),
            draft: request.body,
            signal,
          }),
        );
        headers(reply, result.data.customFood.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Params: CustomFoodParams; Body: CustomFoodDraftRequest }>(
    "/custom-foods/:customFoodId/revisions",
    {
      schema: {
        params: customFoodParamsSchema,
        body: customFoodDraftRequestSchema,
        response: {
          200: customFoodMutationResponseSchema,
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
    async (request, reply): Promise<CustomFoodMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).reviseCustomFood({
            userId: principal.userId,
            customFoodId: request.params.customFoodId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("revise-custom-food", {
              customFoodId: request.params.customFoodId,
              expectedRevision,
              draft: request.body,
            }),
            draft: request.body,
            signal,
          }),
        );
        headers(reply, result.data.customFood.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.delete<{ Params: CustomFoodParams }>(
    "/custom-foods/:customFoodId",
    {
      schema: {
        params: customFoodParamsSchema,
        response: {
          200: customFoodMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<CustomFoodMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).archiveCustomFood({
            userId: principal.userId,
            customFoodId: request.params.customFoodId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("archive-custom-food", {
              customFoodId: request.params.customFoodId,
              expectedRevision,
            }),
            signal,
          }),
        );
        headers(reply, result.data.customFood.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Params: CustomFoodParams; Body: CreateCustomFoodDiaryEntryRequest }>(
    "/custom-foods/:customFoodId/log",
    {
      schema: {
        params: customFoodParamsSchema,
        body: createCustomFoodDiaryEntryRequestSchema,
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
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).logCustomFood({
            userId: principal.userId,
            customFoodId: request.params.customFoodId,
            clientOperationId,
            requestDigest: digest("log-custom-food", {
              customFoodId: request.params.customFoodId,
              entry: request.body,
            }),
            entry: request.body,
            signal,
          }),
        );
        headers(reply, result.data.entry?.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get(
    "/biometrics/definitions",
    {
      schema: {
        response: {
          200: biometricDefinitionListResponseSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<BiometricDefinitionListResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        return await withSignal(request, (signal) =>
          service(options).listBiometricDefinitions({ userId: principal.userId, signal }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: BiometricDefinitionDraftRequest }>(
    "/biometrics/definitions",
    {
      schema: {
        body: biometricDefinitionDraftRequestSchema,
        response: {
          200: biometricDefinitionMutationResponseSchema,
          201: biometricDefinitionMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<BiometricDefinitionMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).createBiometricDefinition({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("create-biometric-definition", request.body),
            draft: request.body,
            signal,
          }),
        );
        headers(reply, result.data.definition.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.patch<{ Params: DefinitionParams; Body: BiometricDefinitionRevisionRequest }>(
    "/biometrics/definitions/:definitionId",
    {
      schema: {
        params: biometricDefinitionParamsSchema,
        body: biometricDefinitionRevisionRequestSchema,
        response: {
          200: biometricDefinitionMutationResponseSchema,
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
    async (request, reply): Promise<BiometricDefinitionMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).reviseBiometricDefinition({
            userId: principal.userId,
            definitionId: request.params.definitionId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("revise-biometric-definition", {
              definitionId: request.params.definitionId,
              expectedRevision,
              draft: request.body,
            }),
            draft: request.body,
            signal,
          }),
        );
        headers(reply, result.data.definition.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.delete<{ Params: DefinitionParams }>(
    "/biometrics/definitions/:definitionId",
    {
      schema: {
        params: biometricDefinitionParamsSchema,
        response: {
          200: biometricDefinitionMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<BiometricDefinitionMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).archiveBiometricDefinition({
            userId: principal.userId,
            definitionId: request.params.definitionId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("archive-biometric-definition", {
              definitionId: request.params.definitionId,
              expectedRevision,
            }),
            signal,
          }),
        );
        headers(reply, result.data.definition.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get<{ Querystring: EventListQuery }>(
    "/biometrics/events",
    {
      preValidation: rejectUnexpectedQueryKeys(["from", "to", "definitionId", "cursor", "limit"]),
      schema: {
        querystring: biometricEventListQuerySchema,
        response: {
          200: biometricEventListResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<BiometricEventListResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        assertInstantRange(request.query.from, request.query.to);
        return await withSignal(request, (signal) =>
          service(options).listBiometricEvents({
            userId: principal.userId,
            from: request.query.from,
            to: request.query.to,
            limit: request.query.limit ?? 100,
            ...(request.query.definitionId ? { definitionId: request.query.definitionId } : {}),
            ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
            signal,
          }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: BiometricEventDraftRequest }>(
    "/biometrics/events",
    {
      schema: {
        body: biometricEventDraftRequestSchema,
        response: {
          200: biometricEventMutationResponseSchema,
          201: biometricEventMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<BiometricEventMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).createBiometricEvent({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("create-biometric-event", request.body),
            event: request.body,
            signal,
          }),
        );
        headers(reply, result.data.event?.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.patch<{ Params: EventParams; Body: BiometricEventRevisionRequest }>(
    "/biometrics/events/:eventId",
    {
      schema: {
        params: biometricEventParamsSchema,
        body: biometricEventRevisionRequestSchema,
        response: {
          200: biometricEventMutationResponseSchema,
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
    async (request, reply): Promise<BiometricEventMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).reviseBiometricEvent({
            userId: principal.userId,
            eventId: request.params.eventId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("revise-biometric-event", {
              eventId: request.params.eventId,
              expectedRevision,
              event: request.body,
            }),
            event: request.body,
            signal,
          }),
        );
        headers(reply, result.data.event?.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.delete<{ Params: EventParams }>(
    "/biometrics/events/:eventId",
    {
      schema: {
        params: biometricEventParamsSchema,
        response: {
          200: biometricEventMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<BiometricEventMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        return await withSignal(request, (signal) =>
          service(options).deleteBiometricEvent({
            userId: principal.userId,
            eventId: request.params.eventId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("delete-biometric-event", {
              eventId: request.params.eventId,
              expectedRevision,
            }),
            signal,
          }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get(
    "/reminders",
    {
      schema: {
        response: {
          200: reminderListResponseSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<ReminderListResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        const result = await withSignal(request, (signal) =>
          service(options).listReminders({ userId: principal.userId, signal }),
        );
        assertReminder(result);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: ReminderDraftRequest }>(
    "/reminders",
    {
      schema: {
        body: reminderDraftRequestSchema,
        response: {
          200: reminderMutationResponseSchema,
          201: reminderMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<ReminderMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).createReminder({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("create-reminder", request.body),
            reminder: request.body,
            signal,
          }),
        );
        assertReminder(result);
        headers(reply, result.data.reminder.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.patch<{ Params: ReminderParams; Body: ReminderRevisionRequest }>(
    "/reminders/:reminderId",
    {
      schema: {
        params: reminderParamsSchema,
        body: reminderRevisionRequestSchema,
        response: {
          200: reminderMutationResponseSchema,
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
    async (request, reply): Promise<ReminderMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).reviseReminder({
            userId: principal.userId,
            reminderId: request.params.reminderId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("revise-reminder", {
              reminderId: request.params.reminderId,
              expectedRevision,
              reminder: request.body,
            }),
            reminder: request.body,
            signal,
          }),
        );
        assertReminder(result);
        headers(reply, result.data.reminder.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.delete<{ Params: ReminderParams }>(
    "/reminders/:reminderId",
    {
      schema: {
        params: reminderParamsSchema,
        response: {
          200: reminderMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<ReminderMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).revokeReminder({
            userId: principal.userId,
            reminderId: request.params.reminderId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("revoke-reminder", {
              reminderId: request.params.reminderId,
              expectedRevision,
            }),
            signal,
          }),
        );
        assertReminder(result);
        headers(reply, result.data.reminder.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: DeviceChallengeRequest }>(
    "/devices/challenges",
    {
      schema: {
        body: deviceChallengeRequestSchema,
        response: {
          200: deviceChallengeResponseSchema,
          201: deviceChallengeResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<DeviceChallengeResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).createDeviceChallenge({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("create-device-challenge", request.body),
            request: request.body,
            signal,
          }),
        );
        reply.status(result.replayed ? 200 : 201);
        return result.response;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: RegisterHealthDeviceRequest }>(
    "/devices",
    {
      schema: {
        body: registerHealthDeviceRequestSchema,
        response: {
          200: healthDeviceResponseSchema,
          201: healthDeviceResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<HealthDeviceResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        let verification: ReturnType<typeof verifyDeviceRegistration>;
        try {
          verification = verifyDeviceRegistration(request.body);
        } catch {
          throw new RetentionDeviceAuthenticationServiceError();
        }
        const result = await withSignal(request, (signal) =>
          service(options).registerDevice({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("register-health-device", request.body),
            request: request.body,
            verification,
            signal,
          }),
        );
        headers(reply, result.data.device.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.delete<{ Params: DeviceParams }>(
    "/devices/:deviceId",
    {
      schema: {
        params: healthDeviceParamsSchema,
        response: {
          200: healthDeviceResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<HealthDeviceResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).revokeDevice({
            userId: principal.userId,
            deviceId: request.params.deviceId,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("revoke-health-device", {
              deviceId: request.params.deviceId,
              expectedRevision,
            }),
            signal,
          }),
        );
        headers(reply, result.data.device.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get(
    "/integrations/health",
    {
      schema: {
        response: {
          200: platformIntegrationListResponseSchema,
          401: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<PlatformIntegrationListResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        return await withSignal(request, (signal) =>
          service(options).listPlatformIntegrations({ userId: principal.userId, signal }),
        );
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: PlatformConsentRequest }>(
    "/integrations/health/consents",
    {
      schema: {
        body: platformConsentRequestSchema,
        response: {
          200: platformIntegrationResponseSchema,
          201: platformIntegrationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<PlatformIntegrationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).consentPlatformIntegration({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("consent-platform-health", request.body),
            request: request.body,
            signal,
          }),
        );
        headers(reply, result.data.integration.revision);
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: HealthImportBatchRequest }>(
    "/integrations/health/imports",
    {
      schema: {
        headers: signedDeviceHeadersSchema,
        body: healthImportBatchRequestSchema,
        response: {
          200: healthImportBatchResponseSchema,
          201: healthImportBatchResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          422: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<HealthImportBatchResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const signedAt = requireSingleHeader(
          request.headers["x-device-timestamp"],
          "x-device-timestamp",
          /^\d{4}-\d{2}-\d{2}T/,
        );
        const nonce = requireSingleHeader(
          request.headers["x-device-nonce"],
          "x-device-nonce",
          /^[A-Za-z0-9_-]{22,128}$/,
        );
        const signature = requireSingleHeader(
          request.headers["x-device-signature"],
          "x-device-signature",
          /^[A-Za-z0-9_-]{86,512}$/,
        );
        if (request.body.sourceCursor === request.body.nextSourceCursor) {
          throw new RetentionImportConflictServiceError();
        }
        const signedTime = Date.parse(signedAt);
        if (!Number.isFinite(signedTime)) throw new RetentionDeviceAuthenticationServiceError();
        // Do not reject a stale envelope here. The service first verifies the registered
        // device signature, then the repository may return an exact durable replay. It
        // rejects timestampFresh=false only if no matching committed batch exists.
        const timestampFresh = Math.abs(clock().getTime() - signedTime) <= 5 * 60_000;
        const clientOperationId = request.body.batchId.toLowerCase();
        const bodyHash = createHash("sha256")
          .update(canonicalJson(request.body), "utf8")
          .digest("hex");
        const canonicalSignaturePayload = healthImportSignaturePayload({
          deviceId: request.body.deviceId,
          platform: request.body.platform,
          batchId: request.body.batchId,
          signedAt,
          nonce,
          bodySha256: bodyHash,
        });
        const result = await withSignal(request, (signal) =>
          service(options).importPlatformHealth({
            userId: principal.userId,
            clientOperationId,
            requestDigest: digest("import-platform-health", {
              request: request.body,
              signedAt,
              nonce,
              signature,
            }),
            request: request.body,
            signedAt,
            timestampFresh,
            nonce,
            signature,
            canonicalSignaturePayload,
            signal,
          }),
        );
        reply.status(result.data.replayed ? 200 : 201);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Params: PlatformParams; Body: DisconnectPlatformIntegrationRequest }>(
    "/integrations/health/:platform/disconnect",
    {
      schema: {
        params: platformParamsSchema,
        body: disconnectPlatformIntegrationRequestSchema,
        response: {
          200: platformIntegrationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          412: problemDetailsSchema,
          428: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<PlatformIntegrationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).disconnectPlatformIntegration({
            userId: principal.userId,
            platform: request.params.platform,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("disconnect-platform-health", {
              platform: request.params.platform,
              expectedRevision,
              request: request.body,
            }),
            request: request.body,
            signal,
          }),
        );
        headers(reply, result.data.integration.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Params: PlatformParams; Body: RebindPlatformIntegrationRequest }>(
    "/integrations/health/:platform/rebind",
    {
      schema: {
        params: platformParamsSchema,
        body: rebindPlatformIntegrationRequestSchema,
        response: {
          200: platformIntegrationResponseSchema,
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
    async (request, reply): Promise<PlatformIntegrationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const expectedRevision = requireRevision(request.headers["if-match"]);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const result = await withSignal(request, (signal) =>
          service(options).rebindPlatformIntegration({
            userId: principal.userId,
            platform: request.params.platform,
            expectedRevision,
            clientOperationId,
            requestDigest: digest("rebind-platform-health", {
              platform: request.params.platform,
              expectedRevision,
              request: request.body,
            }),
            request: request.body,
            signal,
          }),
        );
        headers(reply, result.data.integration.revision);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: AccountExportRequest }>(
    "/exports",
    {
      schema: {
        body: accountExportRequestSchema,
        response: {
          200: accountExportResponseSchema,
          202: accountExportResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<AccountExportResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const reauthenticationToken = requireSingleHeader(
          request.headers["x-reauthentication-token"],
          "x-reauthentication-token",
          /^[A-Za-z0-9_-]{43,128}$/,
        );
        const result = await withSignal(request, (signal) =>
          service(options).createExport({
            userId: principal.userId,
            sessionTokenHash: principal.sessionTokenHash,
            clientOperationId,
            requestDigest: digest("create-account-export", request.body),
            request: request.body,
            reauthenticationToken,
            signal,
          }),
        );
        assertAccountExportLifecycle(result.data.export);
        reply.status(result.data.replayed ? 200 : 202);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get<{ Params: ExportParams }>(
    "/exports/:exportId",
    {
      schema: {
        params: accountExportParamsSchema,
        response: {
          200: accountExportResponseSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<AccountExportResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        const result = await withSignal(request, (signal) =>
          service(options).getExport({
            userId: principal.userId,
            exportId: request.params.exportId,
            signal,
          }),
        );
        if (!result) throw new RetentionNotFoundServiceError();
        assertAccountExportLifecycle(result.data.export);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get<{ Params: ExportArtifactParams }>(
    "/exports/:exportId/artifacts/:format",
    {
      schema: {
        params: accountExportArtifactParamsSchema,
        response: {
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          409: problemDetailsSchema,
          416: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = authenticatedPrincipal(request);
      try {
        if (request.headers.range !== undefined) {
          throw new HttpProblem({
            statusCode: 416,
            code: "REQUEST_ERROR",
            title: "Range Not Satisfiable",
            detail: "Partial export downloads are not supported.",
            expose: true,
          });
        }
        const artifact = await withSignal(request, (signal) =>
          service(options).getExportArtifact({
            userId: principal.userId,
            exportId: request.params.exportId,
            format: request.params.format,
            signal,
          }),
        );
        if (!artifact) throw new RetentionNotFoundServiceError();
        if (
          !Number.isSafeInteger(artifact.contentLength) ||
          artifact.contentLength < 0 ||
          !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
          artifact.mediaType !==
            (request.params.format === "json" ? "application/json" : "application/zip")
        )
          throw new Error("Export artifact metadata is invalid");
        const safeFileName = artifact.fileName.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
        const abort = () => artifact.stream.destroy(new Error("request-aborted"));
        request.raw.once("aborted", abort);
        artifact.stream.once("close", () => request.raw.off("aborted", abort));
        headers(reply);
        return reply
          .type(artifact.mediaType)
          .header("accept-ranges", "none")
          .header("content-length", String(artifact.contentLength))
          .header("content-disposition", `attachment; filename="${safeFileName}"`)
          .send(artifact.stream);
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.post<{ Body: AccountErasureRequest }>(
    "/account/erasure",
    {
      schema: {
        body: accountErasureRequestSchema,
        response: {
          200: accountErasureMutationResponseSchema,
          202: accountErasureMutationResponseSchema,
          400: problemDetailsSchema,
          401: problemDetailsSchema,
          409: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<AccountErasureMutationResponse> => {
      const principal = authenticatedPrincipal(request);
      try {
        consumeMutation(limiter, principal.userId);
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const reauthenticationToken = requireSingleHeader(
          request.headers["x-reauthentication-token"],
          "x-reauthentication-token",
          /^[A-Za-z0-9_-]{43,128}$/,
        );
        const result = await withSignal(request, (signal) =>
          service(options).requestErasure({
            userId: principal.userId,
            sessionTokenHash: principal.sessionTokenHash,
            clientOperationId,
            requestDigest: digest("request-account-erasure", request.body),
            request: request.body,
            reauthenticationToken,
            signal,
          }),
        );
        const recoveryJobId = erasureRecoveryJobs.get(request);
        if (
          recoveryJobId !== undefined &&
          (!result.data.replayed || result.data.erasure.id !== recoveryJobId)
        ) {
          throw new RetentionDeviceAuthenticationServiceError();
        }
        assertAccountErasureLifecycle(result.data.erasure);
        reply.status(result.data.replayed ? 200 : 202);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );

  app.get<{ Params: ErasureParams }>(
    "/account/erasure/:erasureId",
    {
      schema: {
        params: accountErasureParamsSchema,
        response: {
          200: accountErasureResponseSchema,
          401: problemDetailsSchema,
          404: problemDetailsSchema,
          429: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request): Promise<AccountErasureResponse> => {
      try {
        const rawStatusToken = request.headers["x-erasure-status-token"];
        if (
          typeof rawStatusToken === "string" &&
          !statusCapabilityLimiter.consume(
            `erasure-status:${createHash("sha256").update(rawStatusToken, "utf8").digest("hex")}`,
            clock().getTime(),
          )
        ) {
          throw new HttpProblem({
            statusCode: 429,
            code: "RATE_LIMITED",
            title: "Too Many Requests",
            detail: "Too many erasure status requests. Try again later.",
            expose: true,
          });
        }
        const result =
          typeof rawStatusToken === "string"
            ? await withSignal(request, (signal) =>
                service(options).getErasureByCapability({
                  erasureId: request.params.erasureId,
                  statusTokenHash: createHash("sha256")
                    .update(
                      requireSingleHeader(
                        rawStatusToken,
                        "x-erasure-status-token",
                        /^[A-Za-z0-9_-]{43,128}$/,
                      ),
                      "utf8",
                    )
                    .digest("hex"),
                  signal,
                }),
              )
            : await withSignal(request, (signal) => {
                const principal = authenticatedPrincipal(request);
                return service(options).getErasure({
                  userId: principal.userId,
                  erasureId: request.params.erasureId,
                  signal,
                });
              });
        if (!result) throw new RetentionNotFoundServiceError();
        assertAccountErasureLifecycle(result.data.erasure);
        return result;
      } catch (error) {
        throw mapError(error);
      }
    },
  );
};
