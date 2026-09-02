import {
  isPasswordRecoveryToken,
  isValidNewPassword,
  parsePasswordRecoveryAccepted,
  parsePasswordRecoveryConfirmed,
} from "../../../../lib/password-recovery";
import {
  clearedSessionCookie,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  resolvePrivateApiBase,
} from "../../../../lib/private-api";

const MAXIMUM_REQUEST_BYTES = 1_024;
const MAXIMUM_UPSTREAM_BYTES = 4_096;

class PasswordRecoveryUpstreamBodyTooLargeError extends Error {
  constructor() {
    super("The password-recovery upstream body exceeded its hard byte limit.");
    this.name = "PasswordRecoveryUpstreamBodyTooLargeError";
  }
}

function apiBase(): URL | null {
  try {
    return resolvePrivateApiBase(process.env.API_INTERNAL_URL);
  } catch {
    return null;
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  void body.cancel().catch(() => undefined);
}

async function readBoundedRequestJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const declaredLength = request.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (declaredLength !== null &&
      (!/^\d{1,10}$/u.test(declaredLength) || Number(declaredLength) > MAXIMUM_REQUEST_BYTES))
  ) {
    cancelBody(request.body);
    throw new TypeError("The password-recovery request must contain bounded JSON.");
  }
  if (!request.body) throw new TypeError("The password-recovery request body was empty.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (totalBytes + next.value.byteLength > MAXIMUM_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TypeError("The password-recovery request body was too large.");
      }
      chunks.push(next.value);
      totalBytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function readBoundedUpstreamJson(upstream: Response): Promise<unknown> {
  const declaredLength = upstream.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/u.test(declaredLength) || Number(declaredLength) > MAXIMUM_UPSTREAM_BYTES)
  ) {
    cancelBody(upstream.body);
    throw new PasswordRecoveryUpstreamBodyTooLargeError();
  }
  if (!upstream.body) throw new TypeError("The password-recovery upstream body was empty.");

  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (totalBytes + chunk.byteLength > MAXIMUM_UPSTREAM_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new PasswordRecoveryUpstreamBodyTooLargeError();
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problemCode(value: unknown): string | null {
  if (!record(value)) return null;
  return typeof value.code === "string" && /^[A-Z0-9_]{2,80}$/u.test(value.code)
    ? value.code
    : null;
}

function trustedMutationError(request: Request): Response | null {
  return isTrustedMutationRequest(request)
    ? null
    : privateJsonError(403, "This password-recovery request did not come from this application.");
}

function invalidRequest(message: string): Response {
  return privateJsonError(400, message, "VALIDATION_ERROR");
}

async function fetchPasswordRecovery(
  request: Request,
  path: "/v1/auth/password-recovery/confirm" | "/v1/auth/password-recovery/request",
  body: Readonly<Record<string, string>>,
): Promise<Response | null> {
  const base = apiBase();
  if (!base) return null;
  try {
    return await fetch(new URL(path, base), {
      body: JSON.stringify(body),
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: request.signal,
    });
  } catch {
    return null;
  }
}

export async function proxyPasswordRecoveryRequest(request: Request): Promise<Response> {
  const untrusted = trustedMutationError(request);
  if (untrusted) return untrusted;
  if (new URL(request.url).search !== "") {
    return invalidRequest("The password-recovery request was invalid.");
  }

  let email: string;
  try {
    const body = await readBoundedRequestJson(request);
    if (!record(body) || Object.keys(body).length !== 1 || typeof body.email !== "string") {
      throw new TypeError();
    }
    email = body.email.normalize("NFKC").trim();
    if (email.length < 3 || email.length > 254) throw new RangeError();
  } catch {
    return invalidRequest("Enter a valid email address.");
  }

  const upstream = await fetchPasswordRecovery(request, "/v1/auth/password-recovery/request", {
    email,
  });
  if (!upstream) {
    return privateJsonError(503, "Password recovery is temporarily unavailable.");
  }

  let body: unknown;
  try {
    body = await readBoundedUpstreamJson(upstream);
  } catch {
    return privateJsonError(502, "The account service returned an invalid response.");
  }
  if (upstream.status === 202 && parsePasswordRecoveryAccepted(body)) {
    return Response.json(body, { status: 202, headers: PRIVATE_RESPONSE_HEADERS });
  }
  if (upstream.status === 400 && problemCode(body) === "VALIDATION_ERROR") {
    return invalidRequest("Enter a valid email address.");
  }
  if (upstream.status === 503) {
    return privateJsonError(503, "Password recovery is temporarily unavailable.");
  }
  return privateJsonError(502, "The account service returned an invalid response.");
}

export async function proxyPasswordRecoveryConfirm(request: Request): Promise<Response> {
  const untrusted = trustedMutationError(request);
  if (untrusted) return untrusted;
  if (new URL(request.url).search !== "") {
    return invalidRequest("The password-recovery request was invalid.");
  }

  let token: string;
  let newPassword: string;
  try {
    const body = await readBoundedRequestJson(request);
    if (
      !record(body) ||
      Object.keys(body).length !== 2 ||
      !isPasswordRecoveryToken(body.token) ||
      !isValidNewPassword(body.newPassword)
    ) {
      throw new TypeError();
    }
    token = body.token;
    newPassword = body.newPassword;
  } catch {
    return invalidRequest("The recovery link or new password is invalid.");
  }

  const upstream = await fetchPasswordRecovery(request, "/v1/auth/password-recovery/confirm", {
    token,
    newPassword,
  });
  token = "";
  newPassword = "";
  if (!upstream) {
    return privateJsonError(503, "Password recovery is temporarily unavailable.");
  }

  let body: unknown;
  try {
    body = await readBoundedUpstreamJson(upstream);
  } catch {
    return privateJsonError(502, "The account service returned an invalid response.");
  }
  if (upstream.status === 200 && parsePasswordRecoveryConfirmed(body)) {
    const headers = new Headers(PRIVATE_RESPONSE_HEADERS);
    headers.set("set-cookie", clearedSessionCookie());
    return Response.json(body, { headers });
  }
  const code = problemCode(body);
  if (upstream.status === 400 && code === "PASSWORD_RECOVERY_TOKEN_INVALID") {
    return privateJsonError(
      400,
      "This recovery link is invalid or has already been used.",
      "PASSWORD_RECOVERY_TOKEN_INVALID",
    );
  }
  if (upstream.status === 410 && code === "PASSWORD_RECOVERY_TOKEN_EXPIRED") {
    return privateJsonError(
      410,
      "This recovery link has expired.",
      "PASSWORD_RECOVERY_TOKEN_EXPIRED",
    );
  }
  if (upstream.status === 429) {
    return privateJsonError(
      429,
      "Password recovery is temporarily busy. Wait a moment and try again.",
      "RATE_LIMITED",
    );
  }
  if (upstream.status === 503) {
    return privateJsonError(503, "Password recovery is temporarily unavailable.");
  }
  return privateJsonError(502, "The account service returned an invalid response.");
}
