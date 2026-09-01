import {
  isEmailVerificationToken,
  parseEmailVerificationAccepted,
  parseEmailVerificationConfirmed,
} from "../../../../lib/email-verification";
import {
  authenticatedFetch,
  clearedSessionCookie,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  resolvePrivateApiBase,
} from "../../../../lib/private-api";

const MAXIMUM_UPSTREAM_BYTES = 4_096;

class EmailVerificationUpstreamBodyTooLargeError extends Error {
  constructor() {
    super("The email-verification upstream body exceeded its hard byte limit.");
    this.name = "EmailVerificationUpstreamBodyTooLargeError";
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

async function readBoundedUpstreamJson(upstream: Response): Promise<unknown> {
  const declaredLength = upstream.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/u.test(declaredLength) || Number(declaredLength) > MAXIMUM_UPSTREAM_BYTES)
  ) {
    cancelBody(upstream.body);
    throw new EmailVerificationUpstreamBodyTooLargeError();
  }
  if (!upstream.body) throw new TypeError("The email-verification upstream body was empty.");

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
        throw new EmailVerificationUpstreamBodyTooLargeError();
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

function trustedMutationError(request: Request, action: string): Response | null {
  return isTrustedMutationRequest(request)
    ? null
    : privateJsonError(403, `This ${action} request did not come from this application.`);
}

async function safeEmailVerificationProblem(
  upstream: Response,
  fallback: string,
): Promise<Response> {
  if (upstream.status === 503) {
    cancelBody(upstream.body);
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
  if (upstream.status !== 400 && upstream.status !== 410) {
    cancelBody(upstream.body);
    return privateJsonError(502, fallback);
  }
  try {
    const body = await readBoundedUpstreamJson(upstream);
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      upstream.status === 400 &&
      (body as Record<string, unknown>).code === "EMAIL_VERIFICATION_TOKEN_INVALID"
    ) {
      return privateJsonError(
        400,
        "This verification link is invalid or has already been used.",
        "EMAIL_VERIFICATION_TOKEN_INVALID",
      );
    }
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      upstream.status === 410 &&
      (body as Record<string, unknown>).code === "EMAIL_VERIFICATION_TOKEN_EXPIRED"
    ) {
      return privateJsonError(
        410,
        "This verification link has expired.",
        "EMAIL_VERIFICATION_TOKEN_EXPIRED",
      );
    }
  } catch {
    // A malformed confirmation response is replaced with the bounded local fallback.
  }
  return privateJsonError(502, fallback);
}

async function safeEmailVerificationRequestProblem(upstream: Response): Promise<Response> {
  let oversized = false;
  try {
    await readBoundedUpstreamJson(upstream);
  } catch (error) {
    oversized = error instanceof EmailVerificationUpstreamBodyTooLargeError;
  }

  if (upstream.status === 401) {
    const response = privateJsonError(401, "Sign in to continue.", "AUTH_REQUIRED");
    response.headers.set("set-cookie", clearedSessionCookie());
    return response;
  }
  if (oversized) {
    return privateJsonError(502, "A verification email could not be requested.");
  }
  if (upstream.status === 429) {
    return privateJsonError(429, "Too many verification emails were requested.", "RATE_LIMITED");
  }
  if (upstream.status === 503) {
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
  return privateJsonError(502, "A verification email could not be requested.");
}

export async function proxyEmailVerificationRequest(request: Request): Promise<Response> {
  const untrusted = trustedMutationError(request, "verification-email");
  if (untrusted) return untrusted;

  const upstream = await authenticatedFetch(request, "/v1/auth/email-verification/request", {
    method: "POST",
  });
  if (!upstream.ok) {
    return safeEmailVerificationRequestProblem(upstream);
  }
  if (upstream.status !== 202) {
    cancelBody(upstream.body);
    return privateJsonError(502, "The account service returned an invalid response.");
  }
  try {
    const body = await readBoundedUpstreamJson(upstream);
    if (!parseEmailVerificationAccepted(body)) throw new TypeError();
    return Response.json(body, { status: 202, headers: PRIVATE_RESPONSE_HEADERS });
  } catch {
    return privateJsonError(502, "The account service returned an invalid response.");
  }
}

export async function proxyEmailVerificationConfirm(request: Request): Promise<Response> {
  const untrusted = trustedMutationError(request, "email-verification");
  if (untrusted) return untrusted;

  let token: string;
  try {
    const body = await readBoundedJson(request, 256);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !isEmailVerificationToken((body as Record<string, unknown>).token)
    ) {
      throw new TypeError();
    }
    token = (body as { readonly token: string }).token;
  } catch {
    return privateJsonError(
      400,
      "The verification link is invalid.",
      "EMAIL_VERIFICATION_TOKEN_INVALID",
    );
  }

  const base = apiBase();
  if (!base) return privateJsonError(503, "The account service is temporarily unavailable.");

  let upstream: Response;
  try {
    upstream = await fetch(new URL("/v1/auth/email-verification/confirm", base), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
  if (!upstream.ok) {
    return safeEmailVerificationProblem(upstream, "The email address could not be verified.");
  }
  if (upstream.status !== 200) {
    cancelBody(upstream.body);
    return privateJsonError(502, "The account service returned an invalid response.");
  }
  try {
    const body = await readBoundedUpstreamJson(upstream);
    if (!parseEmailVerificationConfirmed(body)) throw new TypeError();
    return Response.json(body, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch {
    return privateJsonError(502, "The account service returned an invalid response.");
  }
}
