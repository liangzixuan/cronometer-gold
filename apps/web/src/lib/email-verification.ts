import { parseSession } from "./diary";

export type EmailVerificationProblemKind =
  | "expired"
  | "invalid"
  | "rate_limited"
  | "unauthorized"
  | "unavailable";

export interface EmailVerificationProblem {
  readonly kind: EmailVerificationProblemKind;
  readonly message: string;
}

export type EmailVerificationBootstrapOutcome =
  | { readonly historySafe: false; readonly kind: "scrub_failed" }
  | {
      readonly historySafe: true;
      readonly kind: "expired" | "invalid" | "ready" | "success" | "unavailable";
    };

export const EMAIL_VERIFICATION_BOOTSTRAP_PROPERTY =
  "__nutritionEmailVerificationBootstrap" as const;

declare global {
  interface Window {
    __nutritionEmailVerificationBootstrap?: Promise<EmailVerificationBootstrapOutcome>;
  }
}

export interface EmailVerificationBootstrapSource {
  readonly history: {
    readonly state: unknown;
    readonly replaceState: (state: unknown, title: string, url: string) => void;
  };
  readonly location: { readonly hash: string; readonly pathname: string };
  __nutritionEmailVerificationBootstrap?: Promise<EmailVerificationBootstrapOutcome>;
}

export interface EmailVerificationNavigationSource extends EmailVerificationBootstrapSource {
  readonly addEventListener: (type: "hashchange", listener: EventListener) => void;
  readonly removeEventListener: (type: "hashchange", listener: EventListener) => void;
}

export interface EmailVerificationFragmentCoordinator {
  readonly start: () => void;
  readonly stop: () => void;
}

export type AcceptedEmailVerificationStatus = "unknown" | "unverified" | "verified";

export type EmailVerificationRequestOutcome =
  | {
      readonly kind: "accepted";
      readonly status: AcceptedEmailVerificationStatus;
    }
  | {
      readonly kind: "rejected";
      readonly problem: EmailVerificationProblem;
    };

export type EmailVerificationStatusFetch = (input: string, init?: RequestInit) => Promise<Response>;

const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/**
 * This nonce-authorized beforeInteractive script runs before page hydration. The
 * server-rendered verification surface contains no navigation or controls until
 * it scrubs the full visible URL, then it exposes only a non-secret outcome promise.
 */
export const EMAIL_VERIFICATION_BOOTSTRAP_SCRIPT = `(() => {
  if (window.location.pathname !== "/verify-email") return;
  const property = "__nutritionEmailVerificationBootstrap";
  const outcome = (kind, historySafe) => ({ historySafe, kind });
  const publish = (result) => {
    Object.defineProperty(window, property, {
      configurable: true,
      enumerable: false,
      value: Promise.resolve(result),
      writable: false,
    });
  };
  let fragment = window.location.hash;
  try {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  } catch {
    fragment = "";
    publish(outcome("scrub_failed", false));
    return;
  }
  if (fragment.length === 0) {
    publish(outcome("ready", true));
    return;
  }
  const prefix = "#token=";
  let token = fragment.startsWith(prefix) ? fragment.slice(prefix.length) : "";
  fragment = "";
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) {
    token = "";
    publish(outcome("invalid", true));
    return;
  }
  let requestBody = JSON.stringify({ token });
  token = "";
  let confirmation;
  try {
    confirmation = fetch("/api/auth/email-verification/confirm", {
      body: requestBody,
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    requestBody = "";
    publish(outcome("unavailable", true));
    return;
  }
  requestBody = "";
  publish(
    Promise.resolve(confirmation)
      .then(async (response) => {
        let body = null;
        try {
          body = await response.json();
        } catch {
          return outcome("unavailable", true);
        }
        const closedData =
          body !== null &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          Object.keys(body).length === 1 &&
          body.data !== null &&
          typeof body.data === "object" &&
          !Array.isArray(body.data) &&
          Object.keys(body.data).length === 1 &&
          body.data.verified === true;
        if (response.status === 200 && closedData) return outcome("success", true);
        const code =
          body !== null && typeof body === "object" && !Array.isArray(body) ? body.code : null;
        if (response.status === 410 && code === "EMAIL_VERIFICATION_TOKEN_EXPIRED") {
          return outcome("expired", true);
        }
        if (response.status === 400 && code === "EMAIL_VERIFICATION_TOKEN_INVALID") {
          return outcome("invalid", true);
        }
        return outcome("unavailable", true);
      })
      .catch(() => outcome("unavailable", true)),
  );
})();`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problemCode(value: unknown): string | null {
  if (!record(value)) return null;
  return typeof value.code === "string" && /^[A-Z0-9_]{2,80}$/u.test(value.code)
    ? value.code
    : null;
}

function synchronizedHistoryState(value: unknown): Record<string, unknown> {
  if (!record(value)) return {};
  const state = { ...value };
  // Next's patched replaceState synchronizes its canonical URL only when callers
  // omit these routing sentinels; it copies/rebuilds them from the current entry.
  delete state.__NA;
  delete state._N;
  return state;
}

export function isEmailVerificationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

async function confirmEmailVerificationRequestBody(
  requestBody: string,
  fetcher: EmailVerificationStatusFetch,
): Promise<EmailVerificationBootstrapOutcome> {
  try {
    const response = await fetcher("/api/auth/email-verification/confirm", {
      body: requestBody,
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    requestBody = "";
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      return { historySafe: true, kind: "unavailable" };
    }
    if (response.status === 200 && parseEmailVerificationConfirmed(body)) {
      return { historySafe: true, kind: "success" };
    }
    const code = problemCode(body);
    if (response.status === 410 && code === "EMAIL_VERIFICATION_TOKEN_EXPIRED") {
      return { historySafe: true, kind: "expired" };
    }
    if (response.status === 400 && code === "EMAIL_VERIFICATION_TOKEN_INVALID") {
      return { historySafe: true, kind: "invalid" };
    }
    return { historySafe: true, kind: "unavailable" };
  } catch {
    requestBody = "";
    return { historySafe: true, kind: "unavailable" };
  }
}

/** Capture and scrub the current fragment synchronously before starting confirmation. */
export function consumeEmailVerificationFragment(
  source: EmailVerificationBootstrapSource,
  fetcher: EmailVerificationStatusFetch = fetch,
): Promise<EmailVerificationBootstrapOutcome> {
  if (source.location.pathname !== "/verify-email") {
    return Promise.resolve({ historySafe: false, kind: "scrub_failed" });
  }

  let fragment = source.location.hash;
  try {
    source.history.replaceState(
      synchronizedHistoryState(source.history.state),
      "",
      source.location.pathname,
    );
  } catch {
    fragment = "";
    return Promise.resolve({ historySafe: false, kind: "scrub_failed" });
  }
  if (fragment.length === 0) {
    return Promise.resolve({ historySafe: true, kind: "ready" });
  }

  const prefix = "#token=";
  let token = fragment.startsWith(prefix) ? fragment.slice(prefix.length) : "";
  fragment = "";
  if (!isEmailVerificationToken(token)) {
    token = "";
    return Promise.resolve({ historySafe: true, kind: "invalid" });
  }
  let requestBody = JSON.stringify({ token });
  token = "";
  const confirmation = confirmEmailVerificationRequestBody(requestBody, fetcher);
  requestBody = "";
  return confirmation;
}

export function takeEmailVerificationBootstrap(
  source: EmailVerificationBootstrapSource,
  fetcher: EmailVerificationStatusFetch = fetch,
): Promise<EmailVerificationBootstrapOutcome> {
  const result = source[EMAIL_VERIFICATION_BOOTSTRAP_PROPERTY];
  try {
    delete source[EMAIL_VERIFICATION_BOOTSTRAP_PROPERTY];
  } catch {
    // The outcome contains no capability; failure to remove it still fails closed below if absent.
  }
  if (result) return result;
  // Client-side and same-document navigation do not rerun beforeInteractive scripts.
  return consumeEmailVerificationFragment(source, fetcher);
}

export function createEmailVerificationFragmentCoordinator(
  source: EmailVerificationNavigationSource,
  onOutcome: (outcome: EmailVerificationBootstrapOutcome) => void,
  fetcher: EmailVerificationStatusFetch = fetch,
): EmailVerificationFragmentCoordinator {
  let active = false;
  let generation = 0;
  let listenerInstalled = false;
  let started = false;

  const deliver = (
    expectedGeneration: number,
    result: Promise<EmailVerificationBootstrapOutcome>,
  ) => {
    void result.then((outcome) => {
      if (active && generation === expectedGeneration) onOutcome(outcome);
    });
  };

  const processHashChange = () => {
    if (!active || source.location.hash === "") return;
    const expectedGeneration = ++generation;
    deliver(expectedGeneration, consumeEmailVerificationFragment(source, fetcher));
  };
  const handleHashChange: EventListener = processHashChange;

  return {
    start() {
      active = true;
      if (!started) {
        started = true;
        const expectedGeneration = ++generation;
        deliver(expectedGeneration, takeEmailVerificationBootstrap(source, fetcher));
      } else if (source.location.hash !== "") {
        processHashChange();
      }
      if (!listenerInstalled) {
        source.addEventListener("hashchange", handleHashChange);
        listenerInstalled = true;
      }
    },
    stop() {
      active = false;
      if (listenerInstalled) {
        source.removeEventListener("hashchange", handleHashChange);
        listenerInstalled = false;
      }
    },
  };
}

export async function reconcileAcceptedEmailVerificationRequest(
  fetcher: EmailVerificationStatusFetch = fetch,
): Promise<AcceptedEmailVerificationStatus> {
  try {
    const response = await fetcher("/api/auth/me", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (response.status !== 200) return "unknown";
    const session = parseSession(await response.json());
    return session.user.emailVerified ? "verified" : "unverified";
  } catch {
    return "unknown";
  }
}

export async function requestAndReconcileEmailVerification(
  fetcher: EmailVerificationStatusFetch = fetch,
): Promise<EmailVerificationRequestOutcome> {
  const response = await fetcher("/api/auth/email-verification/request", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    method: "POST",
    redirect: "error",
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The caller treats an invalid success as a request failure; fixed errors need no detail.
  }
  if (!response.ok) {
    return { kind: "rejected", problem: emailVerificationProblem(response.status, body) };
  }
  if (response.status !== 202) {
    throw new TypeError("The account service returned an invalid verification status.");
  }
  if (!parseEmailVerificationAccepted(body)) {
    throw new TypeError("The account service returned an invalid verification response.");
  }
  return {
    kind: "accepted",
    status: await reconcileAcceptedEmailVerificationRequest(fetcher),
  };
}

export function parseEmailVerificationAccepted(value: unknown): boolean {
  return (
    record(value) &&
    record(value.data) &&
    Object.keys(value).length === 1 &&
    Object.keys(value.data).length === 1 &&
    value.data.status === "accepted"
  );
}

export function parseEmailVerificationConfirmed(value: unknown): boolean {
  return (
    record(value) &&
    record(value.data) &&
    Object.keys(value).length === 1 &&
    Object.keys(value.data).length === 1 &&
    value.data.verified === true
  );
}

export function emailVerificationProblem(status: number, value: unknown): EmailVerificationProblem {
  const code = problemCode(value);
  if (code === "EMAIL_VERIFICATION_TOKEN_EXPIRED") {
    return {
      kind: "expired",
      message: "This verification link has expired. Request a fresh email while signed in.",
    };
  }
  if (code === "EMAIL_VERIFICATION_TOKEN_INVALID") {
    return {
      kind: "invalid",
      message: "This verification link is invalid or has already been used.",
    };
  }
  if (status === 401) {
    return {
      kind: "unauthorized",
      message: "Sign in before requesting another verification email.",
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limited",
      message: "Too many verification emails were requested. Wait a few minutes and try again.",
    };
  }
  return {
    kind: "unavailable",
    message: "Email verification is temporarily unavailable. Please try again.",
  };
}
