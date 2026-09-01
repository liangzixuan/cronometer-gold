import { DIARY_CURSOR_MAX_LENGTH, DIARY_PAGE_SIZE, isLocalDate, isUuid } from "./diary";

export const SESSION_COOKIE = "__Host-nutrition_session";
export const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
} as const;

const TOKEN = /^[A-Za-z0-9_-]{43,128}$/u;
const IDEMPOTENCY_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ETAG = /^(?:W\/)?"[0-9]+"$/u;

export function resolvePrivateApiBase(value: string | undefined): URL {
  const base = new URL(value?.trim() || "http://127.0.0.1:4000");
  const local = base.hostname === "127.0.0.1" || base.hostname === "localhost";
  if (
    (base.protocol !== "https:" && !(base.protocol === "http:" && local)) ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new TypeError("API_INTERNAL_URL must be a safe API origin.");
  }
  return base;
}

export function requestOrigin(request: Request): string {
  const configured = process.env.WEB_PUBLIC_ORIGIN?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new TypeError("WEB_PUBLIC_ORIGIN is required in production.");
    }
    return new URL(request.url).origin;
  }
  const publicOrigin = new URL(configured);
  const localHttp =
    publicOrigin.protocol === "http:" &&
    (publicOrigin.hostname === "localhost" || publicOrigin.hostname === "127.0.0.1");
  if (
    (publicOrigin.protocol !== "https:" && !localHttp) ||
    publicOrigin.username !== "" ||
    publicOrigin.password !== "" ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search !== "" ||
    publicOrigin.hash !== ""
  ) {
    throw new TypeError(
      "WEB_PUBLIC_ORIGIN must be a credential-free HTTPS origin (or loopback HTTP for local smoke tests).",
    );
  }
  return publicOrigin.origin;
}

export function isTrustedMutationRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return (
      origin !== null &&
      origin === requestOrigin(request) &&
      (fetchSite === null || fetchSite === "same-origin" || fetchSite === "none")
    );
  } catch {
    return false;
  }
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return TOKEN.test(value) ? value : null;
  }
  return null;
}

export function sessionCookie(token: string, expiresAt: string): string {
  if (!TOKEN.test(token)) throw new TypeError("The API returned an invalid access token.");
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime()))
    throw new TypeError("The API returned an invalid expiry.");
  const remainingSeconds = Math.floor((expiry.getTime() - Date.now()) / 1_000);
  if (remainingSeconds < 1 || remainingSeconds > 60 * 60 * 24 * 31) {
    throw new RangeError("The access-token expiry is outside the accepted lifetime.");
  }
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${remainingSeconds}; Expires=${expiry.toUTCString()}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

export function privateJsonError(status: number, error: string, code?: string): Response {
  return Response.json(
    { error, ...(code ? { code } : {}) },
    { status, headers: PRIVATE_RESPONSE_HEADERS },
  );
}

export async function readBoundedJson(request: Request, maximumBytes = 65_536): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (contentType !== "application/json" || declaredLength > maximumBytes) {
    throw new TypeError("The request must contain a bounded JSON body.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new TypeError("The request body is too large.");
  }
  return JSON.parse(raw) as unknown;
}

function safeProblem(
  value: unknown,
  fallback: string,
): { readonly error: string; readonly code?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { error: fallback };
  const problem = value as Record<string, unknown>;
  const detail =
    typeof problem.detail === "string" && problem.detail.length <= 500 ? problem.detail : fallback;
  const code =
    typeof problem.code === "string" && /^[A-Z0-9_]{2,80}$/u.test(problem.code)
      ? problem.code
      : undefined;
  return { error: detail, ...(code ? { code } : {}) };
}

export async function safeUpstreamProblem(upstream: Response, fallback: string): Promise<Response> {
  let problem: { readonly error: string; readonly code?: string } = { error: fallback };
  try {
    problem = safeProblem(await upstream.json(), fallback);
  } catch {
    // A malformed upstream failure is deliberately replaced with a bounded local message.
  }
  const allowedStatus = [400, 401, 403, 404, 409, 412, 422, 428, 429, 503].includes(upstream.status)
    ? upstream.status
    : 502;
  const response = privateJsonError(allowedStatus, problem.error, problem.code);
  if (allowedStatus === 401) response.headers.set("set-cookie", clearedSessionCookie());
  return response;
}

export function validatedIdempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key");
  return value && IDEMPOTENCY_KEY.test(value) ? value : null;
}

export function validatedIfMatch(request: Request): string | null {
  const value = request.headers.get("if-match");
  return value && ETAG.test(value) ? value : null;
}

export function validatedDiaryDate(request: Request): string | null {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "date")) return null;
  const values = url.searchParams.getAll("date");
  return values.length === 1 && isLocalDate(values[0]) ? (values[0] ?? null) : null;
}

export interface DiaryReadQuery {
  readonly date: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Validate the paged read surface without changing the stricter mutation query contract. */
export function validatedDiaryReadQuery(request: Request): DiaryReadQuery | null {
  const url = new URL(request.url);
  const allowed = new Set(["date", "limit", "cursor"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null;
  const dates = url.searchParams.getAll("date");
  const limits = url.searchParams.getAll("limit");
  const cursors = url.searchParams.getAll("cursor");
  if (dates.length !== 1 || limits.length > 1 || cursors.length > 1) return null;
  const date = dates[0];
  const rawLimit = limits[0];
  const rawCursor = cursors[0];
  if (!isLocalDate(date) || (rawLimit !== undefined && !/^(?:[1-9]|1[0-9]|20)$/u.test(rawLimit))) {
    return null;
  }
  if (rawCursor !== undefined && rawLimit === undefined) return null;
  if (
    rawCursor !== undefined &&
    (rawCursor.length === 0 ||
      rawCursor.length > DIARY_CURSOR_MAX_LENGTH ||
      !/^d1\.[A-Za-z0-9_-]+$/u.test(rawCursor))
  ) {
    return null;
  }
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > DIARY_PAGE_SIZE)
  ) {
    return null;
  }
  return {
    date,
    ...(limit === undefined ? {} : { limit }),
    ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
  };
}

export function validatedEntryId(value: string): string | null {
  return isUuid(value) ? value : null;
}

/** Redirect only after the same-origin adapter confirms it cleared the HttpOnly cookie. */
export async function confirmBrowserLogout(
  requestLogout: () => Promise<Response>,
  onConfirmed: () => void,
): Promise<boolean> {
  try {
    const response = await requestLogout();
    if (response.status !== 204) return false;
    onConfirmed();
    return true;
  } catch {
    return false;
  }
}

export async function authenticatedFetch(
  request: Request,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = readSessionToken(request);
  if (!token) {
    const response = privateJsonError(401, "Sign in to continue.", "AUTH_REQUIRED");
    response.headers.set("set-cookie", clearedSessionCookie());
    return response;
  }
  let base: URL;
  try {
    base = resolvePrivateApiBase(process.env.API_INTERNAL_URL);
  } catch {
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
  try {
    return await fetch(new URL(path, base), {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
}
