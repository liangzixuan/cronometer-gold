import { isSupportedTimeZone, parseSession } from "../../../lib/diary";
import {
  clearedSessionCookie,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  privateJsonError,
  readBoundedJson,
  readSessionToken,
  resolvePrivateApiBase,
  safeUpstreamProblem,
  sessionCookie,
} from "../../../lib/private-api";

interface Credentials {
  readonly email: string;
  readonly password: string;
  readonly timeZone?: string;
  readonly displayName?: string;
}

function parseCredentials(value: unknown, operation: "login" | "register"): Credentials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Credentials are required.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) =>
        key !== "email" &&
        key !== "password" &&
        !(operation === "register" && (key === "timeZone" || key === "displayName")),
    ) ||
    typeof candidate.email !== "string" ||
    candidate.email.length < 3 ||
    candidate.email.length > 254 ||
    typeof candidate.password !== "string" ||
    candidate.password.length < 12 ||
    candidate.password.length > 128
  ) {
    throw new TypeError("Enter a valid email and a password of at least 12 characters.");
  }
  if (
    operation === "register" &&
    (typeof candidate.timeZone !== "string" || !isSupportedTimeZone(candidate.timeZone))
  ) {
    throw new TypeError("Choose a valid IANA time zone for local diary days.");
  }
  if (
    candidate.displayName !== undefined &&
    (typeof candidate.displayName !== "string" ||
      candidate.displayName.trim().length < 1 ||
      candidate.displayName.trim().length > 100)
  ) {
    throw new TypeError("Display name must contain between 1 and 100 characters.");
  }
  return {
    email: candidate.email.normalize("NFKC").trim(),
    password: candidate.password,
    ...(operation === "register" ? { timeZone: String(candidate.timeZone) } : {}),
    ...(typeof candidate.displayName === "string"
      ? { displayName: candidate.displayName.normalize("NFKC").trim() }
      : {}),
  };
}

function apiBase(): URL | null {
  try {
    return resolvePrivateApiBase(process.env.API_INTERNAL_URL);
  } catch {
    return null;
  }
}

export async function proxyCredentials(
  request: Request,
  operation: "login" | "register",
): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This account request did not come from this application.");
  }
  let credentials: Credentials;
  try {
    credentials = parseCredentials(await readBoundedJson(request, 4_096), operation);
  } catch (error) {
    return privateJsonError(
      400,
      error instanceof Error ? error.message : "The account request was invalid.",
    );
  }
  const base = apiBase();
  if (!base) return privateJsonError(503, "The account service is temporarily unavailable.");

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/v1/auth/${operation}`, base), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(credentials),
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return privateJsonError(503, "The account service is temporarily unavailable.");
  }
  if (!upstream.ok)
    return safeUpstreamProblem(upstream, "The account request could not be completed.");

  try {
    const body: unknown = await upstream.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TypeError();
    const data = (body as Record<string, unknown>).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new TypeError();
    const accessToken = (data as Record<string, unknown>).accessToken;
    const expiresAt = (data as Record<string, unknown>).expiresAt;
    if (typeof accessToken !== "string" || typeof expiresAt !== "string") throw new TypeError();
    const session = parseSession(body);
    return Response.json(
      { data: session },
      {
        status: operation === "register" ? 201 : 200,
        headers: {
          ...PRIVATE_RESPONSE_HEADERS,
          "set-cookie": sessionCookie(accessToken, expiresAt),
        },
      },
    );
  } catch {
    return privateJsonError(502, "The account service returned an invalid response.");
  }
}

export async function proxyLogout(request: Request): Promise<Response> {
  if (!isTrustedMutationRequest(request)) {
    return privateJsonError(403, "This sign-out request did not come from this application.");
  }
  const base = apiBase();
  const token = readSessionToken(request);
  if (base && token) {
    try {
      await fetch(new URL("/v1/auth/logout", base), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: request.signal,
      });
    } catch {
      // Local session destruction succeeds even when remote revocation is temporarily unavailable.
    }
  }
  return new Response(null, {
    status: 204,
    headers: { ...PRIVATE_RESPONSE_HEADERS, "set-cookie": clearedSessionCookie() },
  });
}
