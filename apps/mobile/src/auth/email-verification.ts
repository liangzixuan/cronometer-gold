import { apiUrl, authenticatedHeaders, jsonBody, responseError } from "../api/private-api";
import { parseSession, type SessionSummary } from "../diary/diary";

export class EmailVerificationUnauthorizedError extends Error {
  constructor() {
    super("Authentication expired.");
    this.name = "EmailVerificationUnauthorizedError";
  }
}

export type EmailVerificationFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface EmailVerificationActionFence {
  readonly busy: () => boolean;
  readonly run: (action: () => Promise<void>) => Promise<void>;
}

export interface EmailVerificationRequestOptions {
  readonly fetcher?: EmailVerificationFetch;
  readonly signal?: AbortSignal;
}

export interface EmailVerificationSessionUpdate {
  readonly initiatingSessionEpoch: number;
  readonly initiatingUserId: string;
  readonly session: SessionSummary;
}

export type AcceptedEmailVerificationRequestResult =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "unverified" | "verified";
      readonly session: SessionSummary;
    };

export function createEmailVerificationActionFence(): EmailVerificationActionFence {
  let flight: Promise<void> | null = null;
  let owner: symbol | null = null;
  return {
    busy: () => flight !== null,
    run(action) {
      if (flight) return flight;
      const currentOwner = Symbol("email-verification-action");
      owner = currentOwner;
      const running = Promise.resolve()
        .then(action)
        .finally(() => {
          if (owner === currentOwner) {
            owner = null;
            flight = null;
          }
        });
      flight = running;
      return running;
    },
  };
}

export async function requestEmailVerification(
  apiBase: URL,
  accessToken: string,
  options: EmailVerificationRequestOptions = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    apiUrl(apiBase, "/v1/auth/email-verification/request").toString(),
    {
      method: "POST",
      headers: authenticatedHeaders(accessToken),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (response.status === 401) throw new EmailVerificationUnauthorizedError();
  const body = await jsonBody(response);
  if (response.status !== 202) {
    if (response.ok) {
      throw new TypeError("The account service returned an invalid verification status.");
    }
    throw new Error(responseError(body, "A verification email could not be requested."));
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as Record<string, unknown>).data !== "object" ||
    (body as Record<string, unknown>).data === null ||
    Array.isArray((body as Record<string, unknown>).data) ||
    Object.keys((body as { readonly data: Record<string, unknown> }).data).length !== 1 ||
    (body as { readonly data: Record<string, unknown> }).data.status !== "accepted"
  ) {
    throw new TypeError("The account service returned an invalid verification response.");
  }
}

export async function loadEmailVerificationSession(
  apiBase: URL,
  accessToken: string,
  options: EmailVerificationRequestOptions = {},
): Promise<SessionSummary> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(apiUrl(apiBase, "/v1/auth/me").toString(), {
    headers: authenticatedHeaders(accessToken),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status === 401) throw new EmailVerificationUnauthorizedError();
  const body = await jsonBody(response);
  if (response.status !== 200) {
    if (response.ok) {
      throw new TypeError("The account service returned an invalid session status.");
    }
    throw new Error(responseError(body, "Verification status could not be refreshed."));
  }
  return parseSession(body);
}

export async function requestAndReconcileEmailVerification(
  apiBase: URL,
  accessToken: string,
  options: EmailVerificationRequestOptions = {},
): Promise<AcceptedEmailVerificationRequestResult> {
  await requestEmailVerification(apiBase, accessToken, options);
  try {
    const session = await loadEmailVerificationSession(apiBase, accessToken, options);
    return {
      kind: session.user.emailVerified ? "verified" : "unverified",
      session,
    };
  } catch (error) {
    if (error instanceof EmailVerificationUnauthorizedError) throw error;
    return { kind: "unknown" };
  }
}

export function acceptEmailVerificationSessionUpdate(
  currentSession: SessionSummary | null,
  currentSessionEpoch: number,
  update: EmailVerificationSessionUpdate,
): SessionSummary | null {
  if (
    currentSessionEpoch !== update.initiatingSessionEpoch ||
    currentSession?.user.id !== update.initiatingUserId ||
    update.session.user.id !== update.initiatingUserId
  ) {
    return currentSession;
  }
  return update.session;
}
