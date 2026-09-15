import { createHash } from "node:crypto";
import {
  canonicalJson,
  type DayNote,
  type DayNoteMutationResponse,
  type DayNoteOwnerHeaders,
  type DayNoteResponse,
  type DayNoteWriteHeaders,
  dayNoteDateParamsSchema,
  dayNoteMutationResponseSchema,
  dayNoteOwnerHeadersSchema,
  dayNoteResponseSchema,
  dayNoteWriteHeadersSchema,
  isDayNoteText,
  type PutDayNoteRequest,
  parseDayNoteMutationResponse,
  parseDayNoteResponse,
  problemDetailsSchema,
  putDayNoteRequestSchema,
} from "@nutrition-tracker/contracts";
import { canonicalIanaTimeZone } from "@nutrition-tracker/domain";
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

export interface DayNoteService {
  getNote(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly signal?: AbortSignal;
  }): Promise<DayNote>;
  putNote(input: {
    readonly userId: string;
    readonly localDate: string;
    readonly expectedRevision: string;
    readonly expectedProfileTimeZone: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
    readonly note: string | null;
    readonly signal?: AbortSignal;
  }): Promise<DayNoteMutationResponse>;
}
export interface DayNoteRoutesOptions {
  readonly authService?: AuthService;
  readonly dayNoteService?: DayNoteService;
}
export type DayNoteServiceErrorCode =
  | "DAY_NOTE_NOT_FOUND"
  | "DAY_NOTE_REVISION_CONFLICT"
  | "DAY_NOTE_TIME_ZONE_CHANGED"
  | "DAY_NOTE_IDEMPOTENCY_CONFLICT"
  | "DAY_NOTE_VALIDATION";
export class DayNoteServiceError extends Error {
  override readonly name = "DayNoteServiceError";
  constructor(readonly code: DayNoteServiceErrorCode) {
    super(code);
  }
}
function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Day note services are temporarily unavailable.",
    expose: true,
    cause,
  });
}
function invalidResponse(): HttpProblem {
  return new HttpProblem({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    title: "Invalid day note response",
    detail: "Day note response invariants failed.",
  });
}
function invalidRequest(): never {
  throw new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    expose: true,
  });
}
function mapError(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof DayNoteServiceError) {
    const cases = {
      DAY_NOTE_NOT_FOUND: [404, "NOT_FOUND", "Not Found", "The day note was not found."],
      DAY_NOTE_REVISION_CONFLICT: [
        412,
        "DAY_NOTE_REVISION_CONFLICT",
        "Precondition Failed",
        "The day note changed. Refresh the note and review your draft before saving again.",
      ],
      DAY_NOTE_TIME_ZONE_CHANGED: [
        409,
        "DAY_NOTE_TIME_ZONE_CHANGED",
        "Conflict",
        "The profile time zone changed. Refresh your profile and review the selected date before saving again.",
      ],
      DAY_NOTE_IDEMPOTENCY_CONFLICT: [
        409,
        "DAY_NOTE_IDEMPOTENCY_CONFLICT",
        "Conflict",
        "The Idempotency-Key was already used for a different operation.",
      ],
      DAY_NOTE_VALIDATION: [
        422,
        "DAY_NOTE_VALIDATION",
        "Unprocessable Content",
        "The day note is invalid for this account or date.",
      ],
    } as const;
    const [statusCode, code, title, detail] = cases[error.code];
    return new HttpProblem({ statusCode, code, title, detail, expose: true });
  }
  return unavailable(error);
}
function expectedOwner(request: FastifyRequest): string {
  const actual = authenticatedPrincipal(request).userId.toLowerCase();
  if (request.headers["x-expected-owner-user-id"] !== actual)
    throw new HttpProblem({
      statusCode: 409,
      code: "DAY_NOTE_OWNER_CHANGED",
      title: "Conflict",
      detail: "The signed-in account changed. Reload before accessing day notes.",
      expose: true,
    });
  return actual;
}
async function validateRawNote(request: FastifyRequest): Promise<void> {
  const body = request.body;
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !Object.hasOwn(body, "note")
  )
    return;
  const note = (body as Record<string, unknown>).note;
  if (note !== null && typeof note !== "string") invalidRequest();
  if (!isDayNoteText(note)) throw mapError(new DayNoteServiceError("DAY_NOTE_VALIDATION"));
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
const errors = {
  400: problemDetailsSchema,
  401: problemDetailsSchema,
  404: problemDetailsSchema,
  409: problemDetailsSchema,
  412: problemDetailsSchema,
  422: problemDetailsSchema,
  428: problemDetailsSchema,
  503: problemDetailsSchema,
};
export const dayNoteRoutes: FastifyPluginAsync<DayNoteRoutesOptions> = async (app, options) => {
  const preHandler = requireAuthentication(options.authService);
  app.get<{ Params: { date: string }; Headers: DayNoteOwnerHeaders }>(
    "/:date",
    {
      preHandler,
      preValidation: [rejectUnexpectedQueryKeys([]), rejectRequestBody()],
      schema: {
        params: dayNoteDateParamsSchema,
        headers: dayNoteOwnerHeadersSchema,
        response: { 200: dayNoteResponseSchema, ...errors },
      },
    },
    async (request, reply): Promise<DayNoteResponse> => {
      try {
        const userId = expectedOwner(request);
        const service = options.dayNoteService;
        if (!service) throw unavailable();
        const note = await withSignal(request, (signal) =>
          service.getNote({ userId, localDate: request.params.date, signal }),
        );
        let response: DayNoteResponse;
        try {
          response = parseDayNoteResponse({ data: note });
        } catch {
          throw invalidResponse();
        }
        if (note.ownerUserId !== userId || note.localDate !== request.params.date)
          throw invalidResponse();
        reply.header("cache-control", "no-store").header("etag", revisionEtag(note.revision));
        return response;
      } catch (error) {
        throw mapError(error);
      }
    },
  );
  app.put<{ Params: { date: string }; Headers: DayNoteWriteHeaders; Body: PutDayNoteRequest }>(
    "/:date",
    {
      preHandler,
      preValidation: [
        rejectUnexpectedQueryKeys([]),
        rejectUnexpectedBodyKeys(["note"]),
        validateRawNote,
      ],
      schema: {
        params: dayNoteDateParamsSchema,
        headers: dayNoteWriteHeadersSchema,
        body: putDayNoteRequestSchema,
        response: { 200: dayNoteMutationResponseSchema, ...errors },
      },
    },
    async (request, reply): Promise<DayNoteMutationResponse> => {
      try {
        const userId = expectedOwner(request);
        const service = options.dayNoteService;
        if (!service) throw unavailable();
        const expectedRevision = requireRevision(request.headers["if-match"], { allowZero: true });
        if (expectedRevision.length > 19 || BigInt(expectedRevision) > 9_223_372_036_854_775_807n)
          invalidRequest();
        const clientOperationId = requireIdempotencyKey(request.headers["idempotency-key"]);
        const expectedProfileTimeZone = request.headers["x-expected-profile-time-zone"];
        try {
          if (canonicalIanaTimeZone(expectedProfileTimeZone) !== expectedProfileTimeZone)
            invalidRequest();
        } catch {
          invalidRequest();
        }
        if (!isDayNoteText(request.body.note)) throw new DayNoteServiceError("DAY_NOTE_VALIDATION");
        const input = {
          userId,
          localDate: request.params.date,
          expectedRevision,
          expectedProfileTimeZone,
          clientOperationId,
          note: request.body.note,
        };
        const requestDigest = createHash("sha256")
          .update(canonicalJson({ protocol: "diary-day-note-v1", method: "PUT", ...input }), "utf8")
          .digest("hex");
        const result = await withSignal(request, (signal) =>
          service.putNote({ ...input, requestDigest, signal }),
        );
        let response: DayNoteMutationResponse;
        try {
          response = parseDayNoteMutationResponse(result);
        } catch {
          throw invalidResponse();
        }
        const { note, receipt } = response.data;
        if (
          note.ownerUserId !== userId ||
          note.localDate !== input.localDate ||
          note.note !== input.note ||
          receipt.operationId !== clientOperationId ||
          receipt.expectedRevision !== expectedRevision ||
          receipt.expectedProfileTimeZone !== expectedProfileTimeZone
        )
          throw invalidResponse();
        reply.header("cache-control", "no-store").header("etag", revisionEtag(note.revision));
        return response;
      } catch (error) {
        throw mapError(error);
      }
    },
  );
};
