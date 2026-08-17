import { parseDiaryMutation } from "../../../lib/diary";
import {
  authenticatedFetch,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  resolvePrivateApiBase,
  safeUpstreamProblem,
  validatedIdempotencyKey,
  validatedIfMatch,
} from "../../../lib/private-api";
import {
  parseBiometricDefinitionResponse,
  parseBiometricDefinitions,
  parseBiometricEvents,
  parseBiometricMutation,
  parseBiometricTrend,
  parseCustomFoodList,
  parseCustomFoodMutation,
  parseCustomFoodResponse,
  parseErasureJob,
  parseErasureMutation,
  parseExportJob,
  parseIntegrationMutation,
  parseIntegrations,
  parseNutrientTrend,
  parseReauthentication,
  parseReminderResponse,
  parseReminders,
} from "../../../lib/retention";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/u;
const LOCAL_DATE = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const CURSOR = /^[A-Za-z0-9_.-]{1,512}$/u;
const RECENT_AUTH = /^[A-Za-z0-9_-]{43,128}$/u;
const ERASURE_STATUS_COOKIE = "__Secure-nutrition_erasure_status";
const ERASURE_STATUS_PATH = "/api/retention/account/erasure/status";
const ERASURE_PENDING_COOKIE = "__Secure-nutrition_erasure_pending";
const ERASURE_PENDING_PATH = "/api/retention/account/erasure";
const ERASURE_BODY = '{"confirmation":"DELETE_MY_ACCOUNT"}';
const STATUS_TOKEN = /^[A-Za-z0-9_-]{43,128}$/u;
// Matches the reviewed default encrypted-artifact/spool ceiling (10 GiB), while streaming.
const MAX_EXPORT_ARTIFACT_BYTES = 10_737_418_240;

type Parser = (value: unknown) => unknown;

interface RouteSpec {
  readonly upstreamPath: string;
  readonly parser: Parser;
  readonly mutation: boolean;
  readonly requiresIfMatch?: boolean;
  readonly requiresRecentAuth?: boolean;
  readonly maximumBytes?: number;
  readonly erasureMutation?: boolean;
  readonly erasureStatus?: boolean;
  readonly erasureStage?: boolean;
  readonly erasureSubmit?: boolean;
}

function pendingErasureCookie(operationId: string, recentAuth: string): string {
  if (!UUID.test(operationId) || !RECENT_AUTH.test(recentAuth)) {
    throw new TypeError("The pending erasure envelope was invalid.");
  }
  const maxAge = 24 * 60 * 60;
  const expires = new Date(Date.now() + maxAge * 1_000);
  return `${ERASURE_PENDING_COOKIE}=${operationId}.${recentAuth}.${Date.now()}; Path=${ERASURE_PENDING_PATH}; Max-Age=${maxAge}; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

function clearedPendingErasureCookie(): string {
  return `${ERASURE_PENDING_COOKIE}=; Path=${ERASURE_PENDING_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

function readPendingErasure(
  request: Request,
):
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "valid"; readonly operationId: string; readonly recentAuth: string } {
  const cookie = request.headers.get("cookie");
  if (!cookie) return { state: "absent" };
  const values = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ERASURE_PENDING_COOKIE}=`))
    .map((part) => part.slice(ERASURE_PENDING_COOKIE.length + 1));
  if (values.length === 0) return { state: "absent" };
  if (values.length !== 1) return { state: "invalid" };
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43,128})\.([0-9]{13})$/iu.exec(values[0] ?? "");
  const createdAt = Number(match?.[3]);
  if (
    !match ||
    !UUID.test(match[1] ?? "") ||
    !RECENT_AUTH.test(match[2] ?? "") ||
    !Number.isSafeInteger(createdAt) ||
    createdAt > Date.now() + 5 * 60_000 ||
    Date.now() - createdAt > 24 * 60 * 60_000
  ) {
    return { state: "invalid" };
  }
  return { state: "valid", operationId: match[1] ?? "", recentAuth: match[2] ?? "" };
}

function erasureStatusCookie(jobId: string, token: string, expiresAt: string): string {
  if (!UUID.test(jobId) || !STATUS_TOKEN.test(token)) {
    throw new TypeError("The erasure status capability was invalid.");
  }
  const expiry = new Date(expiresAt);
  const maximum = Date.now() + 31 * 24 * 60 * 60 * 1_000;
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiry.getTime() <= Date.now() ||
    expiry.getTime() > maximum
  ) {
    throw new TypeError("The erasure status capability expiry was invalid.");
  }
  const seconds = Math.max(1, Math.floor((expiry.getTime() - Date.now()) / 1_000));
  return `${ERASURE_STATUS_COOKIE}=${jobId}.${token}.${expiry.getTime()}; Path=${ERASURE_STATUS_PATH}; Max-Age=${seconds}; Expires=${expiry.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

function clearedErasureStatusCookie(): string {
  return `${ERASURE_STATUS_COOKIE}=; Path=${ERASURE_STATUS_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

function readErasureStatusCapability(
  request: Request,
):
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "valid"; readonly jobId: string; readonly token: string } {
  const cookie = request.headers.get("cookie");
  if (!cookie) return { state: "absent" };
  const values: string[] = [];
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== ERASURE_STATUS_COOKIE) continue;
    values.push(part.slice(separator + 1).trim());
  }
  if (values.length === 0) return { state: "absent" };
  if (values.length !== 1) return { state: "invalid" };
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43,128})\.([0-9]{13})$/iu.exec(values[0] ?? "");
  if (!match || !UUID.test(match[1] ?? "") || !STATUS_TOKEN.test(match[2] ?? "")) {
    return { state: "invalid" };
  }
  const expiresAt = Number(match[3]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return { state: "invalid" };
  return { state: "valid", jobId: match[1] ?? "", token: match[2] ?? "" };
}

async function erasureCapabilityFetch(
  request: Request,
  upstreamPath: string,
  token: string,
): Promise<Response> {
  let base: URL;
  try {
    base = resolvePrivateApiBase(process.env.API_INTERNAL_URL);
  } catch {
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
  try {
    return await fetch(new URL(upstreamPath, base), {
      headers: { accept: "application/json", "x-erasure-status-token": token },
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
}

function exactQuery(
  request: Request,
  validators: Readonly<Record<string, (value: string) => boolean>>,
  required: readonly string[] = [],
): string | null {
  const incoming = new URL(request.url).searchParams;
  for (const key of incoming.keys()) {
    if (!(key in validators) || incoming.getAll(key).length !== 1) return null;
  }
  for (const key of required) if (incoming.getAll(key).length !== 1) return null;
  const outgoing = new URLSearchParams();
  for (const [key, validator] of Object.entries(validators)) {
    const value = incoming.get(key);
    if (value === null) continue;
    if (!validator(value)) return null;
    outgoing.set(key, value);
  }
  const query = outgoing.toString();
  return query ? `?${query}` : "";
}

function timestamp(value: string): boolean {
  return value.length <= 64 && value.includes("T") && Number.isFinite(new Date(value).getTime());
}

function routeSpec(request: Request, segments: readonly string[]): RouteSpec | null {
  const method = request.method;
  const path = segments.join("/");
  if (method === "GET" && path === "trends/nutrients") {
    const query = exactQuery(
      request,
      {
        nutrientId: (value) => POSITIVE_ID.test(value),
        from: (value) => LOCAL_DATE.test(value),
        to: (value) => LOCAL_DATE.test(value),
      },
      ["nutrientId", "from", "to"],
    );
    return query === null
      ? null
      : {
          upstreamPath: `/v1/trends/nutrients${query}`,
          parser: parseNutrientTrend,
          mutation: false,
        };
  }
  if (method === "GET" && path === "trends/biometrics") {
    const query = exactQuery(
      request,
      {
        definitionId: (value) => UUID.test(value),
        from: (value) => LOCAL_DATE.test(value),
        to: (value) => LOCAL_DATE.test(value),
      },
      ["definitionId", "from", "to"],
    );
    return query === null
      ? null
      : {
          upstreamPath: `/v1/trends/biometrics${query}`,
          parser: parseBiometricTrend,
          mutation: false,
        };
  }
  if (path === "custom-foods" && method === "GET") {
    const query = exactQuery(request, {
      cursor: (value) => CURSOR.test(value),
      limit: (value) => /^[1-9][0-9]?$/u.test(value) && Number(value) <= 50,
    });
    return query === null
      ? null
      : { upstreamPath: `/v1/custom-foods${query}`, parser: parseCustomFoodList, mutation: false };
  }
  if (path === "custom-foods" && method === "POST") {
    return {
      upstreamPath: "/v1/custom-foods",
      parser: parseCustomFoodMutation,
      mutation: true,
      maximumBytes: 131_072,
    };
  }
  if (segments[0] === "custom-foods" && segments.length === 2 && UUID.test(segments[1] ?? "")) {
    if (method === "GET")
      return { upstreamPath: `/v1/${path}`, parser: parseCustomFoodResponse, mutation: false };
    if (method === "DELETE")
      return {
        upstreamPath: `/v1/${path}`,
        parser: parseCustomFoodMutation,
        mutation: true,
        requiresIfMatch: true,
      };
  }
  if (segments[0] === "custom-foods" && UUID.test(segments[1] ?? "") && segments.length === 3) {
    if (segments[2] === "revisions" && method === "POST") {
      return {
        upstreamPath: `/v1/${path}`,
        parser: parseCustomFoodMutation,
        mutation: true,
        requiresIfMatch: true,
        maximumBytes: 131_072,
      };
    }
    if (segments[2] === "log" && method === "POST") {
      return { upstreamPath: `/v1/${path}`, parser: parseDiaryMutation, mutation: true };
    }
  }
  if (path === "biometrics/definitions" && method === "GET") {
    if (exactQuery(request, {}) !== "") return null;
    return {
      upstreamPath: "/v1/biometrics/definitions",
      parser: parseBiometricDefinitions,
      mutation: false,
    };
  }
  if (path === "biometrics/definitions" && method === "POST") {
    return {
      upstreamPath: "/v1/biometrics/definitions",
      parser: parseBiometricDefinitionResponse,
      mutation: true,
    };
  }
  if (
    segments[0] === "biometrics" &&
    segments[1] === "definitions" &&
    UUID.test(segments[2] ?? "")
  ) {
    if (segments.length === 3 && method === "PATCH") {
      return {
        upstreamPath: `/v1/${path}`,
        parser: parseBiometricDefinitionResponse,
        mutation: true,
        requiresIfMatch: true,
      };
    }
    if (segments.length === 3 && method === "DELETE") {
      return {
        upstreamPath: `/v1/${path}`,
        parser: parseBiometricDefinitionResponse,
        mutation: true,
        requiresIfMatch: true,
      };
    }
  }
  if (path === "biometrics/events" && method === "GET") {
    const query = exactQuery(
      request,
      {
        from: timestamp,
        to: timestamp,
        definitionId: (value) => UUID.test(value),
        cursor: (value) => CURSOR.test(value),
        limit: (value) => /^[1-9][0-9]{0,2}$/u.test(value) && Number(value) <= 500,
      },
      ["from", "to"],
    );
    return query === null
      ? null
      : {
          upstreamPath: `/v1/biometrics/events${query}`,
          parser: parseBiometricEvents,
          mutation: false,
        };
  }
  if (path === "biometrics/events" && method === "POST") {
    return {
      upstreamPath: "/v1/biometrics/events",
      parser: parseBiometricMutation,
      mutation: true,
    };
  }
  if (
    segments[0] === "biometrics" &&
    segments[1] === "events" &&
    segments.length === 3 &&
    UUID.test(segments[2] ?? "") &&
    (method === "PATCH" || method === "DELETE")
  ) {
    return {
      upstreamPath: `/v1/${path}`,
      parser: parseBiometricMutation,
      mutation: true,
      requiresIfMatch: true,
    };
  }
  if (path === "reminders" && method === "GET") {
    if (exactQuery(request, {}) !== "") return null;
    return { upstreamPath: "/v1/reminders", parser: parseReminders, mutation: false };
  }
  if (path === "reminders" && method === "POST") {
    return { upstreamPath: "/v1/reminders", parser: parseReminderResponse, mutation: true };
  }
  if (
    segments[0] === "reminders" &&
    segments.length === 2 &&
    UUID.test(segments[1] ?? "") &&
    (method === "PATCH" || method === "DELETE")
  ) {
    return {
      upstreamPath: `/v1/${path}`,
      parser: parseReminderResponse,
      mutation: true,
      requiresIfMatch: true,
    };
  }
  if (path === "integrations/health" && method === "GET") {
    if (exactQuery(request, {}) !== "") return null;
    return { upstreamPath: "/v1/integrations/health", parser: parseIntegrations, mutation: false };
  }
  if (path === "integrations/health/consents" && method === "POST") {
    return {
      upstreamPath: "/v1/integrations/health/consents",
      parser: parseIntegrationMutation,
      mutation: true,
    };
  }
  if (
    segments[0] === "integrations" &&
    segments[1] === "health" &&
    ["apple_healthkit", "android_health_connect"].includes(segments[2] ?? "") &&
    segments[3] === "disconnect" &&
    segments.length === 4 &&
    method === "POST"
  ) {
    return {
      upstreamPath: `/v1/${path}`,
      parser: parseIntegrationMutation,
      mutation: true,
      requiresIfMatch: true,
    };
  }
  if (path === "exports" && method === "POST") {
    return {
      upstreamPath: "/v1/exports",
      parser: parseExportJob,
      mutation: true,
      requiresRecentAuth: true,
    };
  }
  if (
    segments[0] === "exports" &&
    segments.length === 2 &&
    UUID.test(segments[1] ?? "") &&
    method === "GET"
  ) {
    return { upstreamPath: `/v1/${path}`, parser: parseExportJob, mutation: false };
  }
  if (path === "account/erasure" && method === "POST") {
    return {
      upstreamPath: "/v1/account/erasure",
      parser: parseErasureMutation,
      mutation: true,
      requiresRecentAuth: true,
      erasureMutation: true,
    };
  }
  if (path === "account/erasure/stage" && method === "POST") {
    return {
      upstreamPath: "",
      parser: () => undefined,
      mutation: true,
      requiresRecentAuth: true,
      erasureStage: true,
    };
  }
  if (
    (path === "account/erasure/submit" || path === "account/erasure/recover") &&
    method === "POST"
  ) {
    return {
      upstreamPath: "/v1/account/erasure",
      parser: parseErasureMutation,
      mutation: true,
      erasureSubmit: true,
    };
  }
  if (path === "account/erasure/status" && method === "GET") {
    if (exactQuery(request, {}) !== "") return null;
    return { upstreamPath: "", parser: parseErasureJob, mutation: false, erasureStatus: true };
  }
  if (
    segments[0] === "account" &&
    segments[1] === "erasure" &&
    segments.length === 3 &&
    UUID.test(segments[2] ?? "") &&
    method === "GET"
  ) {
    return { upstreamPath: `/v1/${path}`, parser: parseErasureJob, mutation: false };
  }
  if (path === "auth/reauthenticate" && method === "POST") {
    return {
      upstreamPath: "/v1/auth/reauthenticate",
      parser: parseReauthentication,
      mutation: true,
      maximumBytes: 4_096,
    };
  }
  return null;
}

async function checkedResponse(upstream: Response, parser: Parser): Promise<Response> {
  if (!upstream.ok)
    return safeUpstreamProblem(upstream, "The private account request could not be completed.");
  try {
    const value: unknown = await upstream.json();
    parser(value);
    const etag = upstream.headers.get("etag");
    return Response.json(value, {
      status: upstream.status,
      headers: { ...PRIVATE_RESPONSE_HEADERS, ...(etag ? { etag } : {}) },
    });
  } catch {
    return privateJsonError(502, "The private account service returned an invalid response.");
  }
}

async function erasureMutationResponse(
  upstream: Response,
  clearPending: boolean,
): Promise<Response> {
  if (!upstream.ok) {
    const response = await safeUpstreamProblem(
      upstream,
      "The exact account-erasure request could not be completed.",
    );
    // A revoked session cookie is still the bearer proof for an exact committed replay. Never
    // destroy it until the one-purpose status capability has been recovered.
    response.headers.delete("set-cookie");
    return response;
  }
  try {
    const value: unknown = await upstream.json();
    const parsed = parseErasureMutation(value);
    const raw = value as {
      readonly data: { readonly replayed: boolean; readonly erasure: unknown };
    };
    const response = Response.json(
      { data: { replayed: raw.data.replayed, erasure: raw.data.erasure } },
      { status: upstream.status, headers: PRIVATE_RESPONSE_HEADERS },
    );
    response.headers.append(
      "set-cookie",
      erasureStatusCookie(
        parsed.job.id,
        parsed.statusCapability.token,
        parsed.statusCapability.expiresAt,
      ),
    );
    if (clearPending) response.headers.append("set-cookie", clearedPendingErasureCookie());
    return response;
  } catch {
    return privateJsonError(502, "The private account service returned an invalid response.");
  }
}

function abortableArtifactBody(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let output: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const detach = () => signal.removeEventListener("abort", abort);
  const abort = () => {
    if (closed) return;
    closed = true;
    void reader.cancel("request-aborted").catch(() => undefined);
    output?.error(new DOMException("The artifact request was aborted.", "AbortError"));
    detach();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (closed) return;
      try {
        const next = await reader.read();
        if (next.done) {
          closed = true;
          detach();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (!closed) {
          closed = true;
          detach();
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      detach();
      await reader.cancel(reason);
    },
  });
}

export async function proxyRetentionRequest(
  request: Request,
  segments: readonly string[],
): Promise<Response> {
  const spec = routeSpec(request, segments);
  if (!spec) return privateJsonError(400, "The private account request is invalid.");
  if (!spec.mutation) {
    if (spec.erasureStatus) {
      const capability = readErasureStatusCapability(request);
      if (capability.state === "invalid") {
        const response = privateJsonError(400, "The erasure status capability is invalid.");
        response.headers.set("set-cookie", clearedErasureStatusCookie());
        return response;
      }
      if (capability.state === "absent") {
        return privateJsonError(401, "No account-erasure status capability is available.");
      }
      const upstreamPath = `/v1/account/erasure/${capability.jobId}`;
      const upstream = await erasureCapabilityFetch(request, upstreamPath, capability.token);
      const response = await checkedResponse(upstream, spec.parser);
      if (response.ok) {
        try {
          const job = parseErasureJob(await response.clone().json());
          if (job.status === "completed" || job.status === "failed") {
            response.headers.set("set-cookie", clearedErasureStatusCookie());
          }
        } catch {
          // checkedResponse already converted malformed upstream JSON into a fail-closed response.
        }
      }
      return response;
    }
    return checkedResponse(await authenticatedFetch(request, spec.upstreamPath), spec.parser);
  }
  if (spec.erasureSubmit) {
    if (!isTrustedMutationRequest(request)) {
      return privateJsonError(403, "This account request did not come from this application.");
    }
    const pending = readPendingErasure(request);
    if (pending.state === "invalid") {
      const response = privateJsonError(400, "The protected pending erasure request is invalid.");
      response.headers.set("set-cookie", clearedPendingErasureCookie());
      return response;
    }
    if (pending.state === "absent") {
      return request.url.endsWith("/recover")
        ? new Response(null, { status: 204, headers: PRIVATE_RESPONSE_HEADERS })
        : privateJsonError(409, "No protected pending erasure request is available.");
    }
    const upstream = await authenticatedFetch(request, spec.upstreamPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": pending.operationId,
        "x-reauthentication-token": pending.recentAuth,
      },
      body: ERASURE_BODY,
    });
    return erasureMutationResponse(upstream, true);
  }
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This account request did not come from this application.");
  }
  const idempotencyKey = validatedIdempotencyKey(request);
  if (!idempotencyKey) return privateJsonError(400, "The account operation key is invalid.");
  const ifMatch = spec.requiresIfMatch ? validatedIfMatch(request) : null;
  if (spec.requiresIfMatch && !ifMatch) {
    return privateJsonError(400, "The account request is missing its revision precondition.");
  }
  const recentAuth = request.headers.get("x-reauthentication-token");
  if (spec.requiresRecentAuth && (!recentAuth || !RECENT_AUTH.test(recentAuth))) {
    return privateJsonError(
      428,
      "Confirm your password immediately before this request.",
      "RECENT_AUTH_REQUIRED",
    );
  }
  let body: string | undefined;
  if (request.method !== "DELETE") {
    try {
      body = JSON.stringify(await readBoundedJson(request, spec.maximumBytes ?? 65_536));
    } catch {
      return privateJsonError(400, "The account request must contain bounded JSON.");
    }
  }
  if (spec.erasureStage) {
    if (body !== ERASURE_BODY || !recentAuth) {
      return privateJsonError(400, "The staged account-erasure request was invalid.");
    }
    const response = Response.json(
      { data: { staged: true } },
      { status: 201, headers: PRIVATE_RESPONSE_HEADERS },
    );
    response.headers.set("set-cookie", pendingErasureCookie(idempotencyKey, recentAuth));
    return response;
  }
  const upstream = await authenticatedFetch(request, spec.upstreamPath, {
    method: request.method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "idempotency-key": idempotencyKey,
      ...(ifMatch ? { "if-match": ifMatch } : {}),
      ...(spec.requiresRecentAuth && recentAuth ? { "x-reauthentication-token": recentAuth } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  if (spec.erasureMutation) return erasureMutationResponse(upstream, false);
  return checkedResponse(upstream, spec.parser);
}

export async function proxyExportArtifact(
  request: Request,
  exportId: string,
  format: string,
): Promise<Response> {
  if (request.method !== "GET" || !UUID.test(exportId) || !["json", "csv"].includes(format)) {
    return privateJsonError(400, "The export artifact request is invalid.");
  }
  const upstream = await authenticatedFetch(
    request,
    `/v1/exports/${exportId}/artifacts/${format}`,
    { headers: { accept: format === "json" ? "application/json" : "application/zip" } },
  );
  if (!upstream.ok) {
    return safeUpstreamProblem(upstream, "The export artifact could not be downloaded.");
  }
  const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const expectedType = format === "json" ? "application/json" : "application/zip";
  const declaredLength = upstream.headers.get("content-length");
  if (
    contentType !== expectedType ||
    upstream.body === null ||
    (declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) ||
        !Number.isSafeInteger(Number(declaredLength)) ||
        Number(declaredLength) > MAX_EXPORT_ARTIFACT_BYTES))
  ) {
    upstream.body?.cancel().catch(() => undefined);
    return privateJsonError(502, "The export service returned an invalid artifact.");
  }
  const streamedBody = abortableArtifactBody(upstream.body, request.signal);
  return new Response(streamedBody, {
    status: 200,
    headers: {
      ...PRIVATE_RESPONSE_HEADERS,
      "content-type": expectedType,
      "content-disposition": `attachment; filename="nutrition-export-${exportId}.${format === "json" ? "json" : "zip"}"`,
      ...(declaredLength ? { "content-length": declaredLength } : {}),
    },
  });
}
