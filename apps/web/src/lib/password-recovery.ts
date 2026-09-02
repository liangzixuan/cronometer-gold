export type PasswordRecoveryProblemKind = "invalid_email" | "unavailable";

export interface PasswordRecoveryProblem {
  readonly kind: PasswordRecoveryProblemKind;
  readonly message: string;
}

export type PasswordRecoverySubmissionOutcome =
  | { readonly kind: "expired" | "invalid" | "success"; readonly retryable: false }
  | { readonly kind: "rate_limited" | "validation"; readonly retryable: true }
  | { readonly kind: "unavailable"; readonly retryable: boolean };

export interface PasswordRecoverySubmissionCapability {
  readonly dispose: () => void;
  readonly submit: (newPassword: string) => Promise<PasswordRecoverySubmissionOutcome>;
}

export type PasswordRecoveryBootstrapOutcome =
  | { readonly historySafe: false; readonly kind: "scrub_failed" }
  | { readonly historySafe: true; readonly kind: "invalid" | "missing" }
  | {
      readonly capability: PasswordRecoverySubmissionCapability;
      readonly historySafe: true;
      readonly kind: "ready";
    };

export const PASSWORD_RECOVERY_BOOTSTRAP_PROPERTY = "__nutritionPasswordRecoveryBootstrap" as const;

declare global {
  interface Window {
    __nutritionPasswordRecoveryBootstrap?: Promise<PasswordRecoveryBootstrapOutcome>;
  }
}

export interface PasswordRecoveryBootstrapSource {
  readonly history: {
    readonly state: unknown;
    readonly replaceState: (state: unknown, title: string, url: string) => void;
  };
  readonly location: { readonly hash: string; readonly pathname: string };
  __nutritionPasswordRecoveryBootstrap?: Promise<PasswordRecoveryBootstrapOutcome>;
}

export interface PasswordRecoveryNavigationSource extends PasswordRecoveryBootstrapSource {
  readonly addEventListener: (
    type: "hashchange" | "pagehide" | "pageshow",
    listener: EventListener,
  ) => void;
  readonly removeEventListener: (
    type: "hashchange" | "pagehide" | "pageshow",
    listener: EventListener,
  ) => void;
}

export interface PasswordRecoveryFragmentCoordinator {
  readonly start: () => void;
  readonly stop: () => void;
}

export type PasswordRecoveryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type PasswordRecoveryRequestOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly problem: PasswordRecoveryProblem };

const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const MAXIMUM_RESPONSE_BYTES = 4_096;

/**
 * Capture the fragment before hydration and retain it only inside a disposable,
 * non-enumerable submission capability. The token never enters React state,
 * router state, a query string, storage, or a rendered value.
 */
export const PASSWORD_RECOVERY_BOOTSTRAP_SCRIPT = `(() => {
  if (window.location.pathname !== "/reset-password") return;
  const property = "__nutritionPasswordRecoveryBootstrap";
  const terminal = new Set(["expired", "invalid", "success"]);
  const maximumResponseBytes = 4096;
  const cancelBody = (body) => {
    if (body) void body.cancel().catch(() => undefined);
  };
  const readBoundedJson = async (response) => {
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\\d{1,10}$/.test(declaredLength) || Number(declaredLength) > maximumResponseBytes)
    ) {
      cancelBody(response.body);
      throw new TypeError("The password-recovery response was not bounded.");
    }
    if (!response.body) throw new TypeError("The password-recovery response was empty.");
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (totalBytes + next.value.byteLength > maximumResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new TypeError("The password-recovery response was too large.");
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  const passwordIsValid = (value) => {
    if (typeof value !== "string") return false;
    const length = Array.from(value).length;
    return length >= 12 && length <= 128 && new TextEncoder().encode(value).byteLength <= 512;
  };
  const closedSuccess = (body) =>
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    body.data !== null &&
    typeof body.data === "object" &&
    !Array.isArray(body.data) &&
    Object.keys(body.data).length === 1 &&
    body.data.passwordReset === true;
  const codeOf = (body) =>
    body !== null && typeof body === "object" && !Array.isArray(body) &&
    typeof body.code === "string" ? body.code : null;
  const createCapability = (capturedToken) => {
    let token = capturedToken;
    let controller = null;
    let disposed = false;
    let flight = null;
    const clear = () => {
      token = "";
      disposed = true;
    };
    const dispose = () => {
      clear();
      if (controller) controller.abort();
      controller = null;
    };
    const submit = (newPassword) => {
      if (disposed || token.length === 0) {
        return Promise.resolve({ kind: "invalid", retryable: false });
      }
      if (!passwordIsValid(newPassword)) {
        return Promise.resolve({ kind: "validation", retryable: true });
      }
      if (flight) return flight;
      const activeController = new AbortController();
      controller = activeController;
      let requestBody = JSON.stringify({ token, newPassword });
      let request;
      try {
        request = fetch("/api/auth/password-recovery/confirm", {
          body: requestBody,
          cache: "no-store",
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: activeController.signal,
        });
      } catch {
        requestBody = "";
        controller = null;
        return Promise.resolve({ kind: "unavailable", retryable: true });
      }
      requestBody = "";
      const running = Promise.resolve(request)
        .then(async (response) => {
          let body = null;
          try {
            body = await readBoundedJson(response);
          } catch {
            if (response.status === 429) return { kind: "rate_limited", retryable: true };
            if (response.status === 503) return { kind: "unavailable", retryable: true };
            clear();
            return { kind: "unavailable", retryable: false };
          }
          let result;
          const code = codeOf(body);
          if (response.status === 200 && closedSuccess(body)) {
            result = { kind: "success", retryable: false };
          } else if (response.status === 400 && code === "PASSWORD_RECOVERY_TOKEN_INVALID") {
            result = { kind: "invalid", retryable: false };
          } else if (response.status === 410 && code === "PASSWORD_RECOVERY_TOKEN_EXPIRED") {
            result = { kind: "expired", retryable: false };
          } else if (response.status === 429) {
            result = { kind: "rate_limited", retryable: true };
          } else if (response.status === 503) {
            result = { kind: "unavailable", retryable: true };
          } else {
            result = { kind: "unavailable", retryable: false };
          }
          if (terminal.has(result.kind) || !result.retryable) clear();
          return result;
        })
        .catch(() =>
          disposed
            ? { kind: "invalid", retryable: false }
            : { kind: "unavailable", retryable: true },
        )
        .finally(() => {
          if (controller === activeController) controller = null;
          if (flight === running) flight = null;
        });
      flight = running;
      return running;
    };
    return Object.freeze(
      Object.defineProperties({}, {
        dispose: { enumerable: false, value: dispose },
        submit: { enumerable: false, value: submit },
      }),
    );
  };
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
    publish({ historySafe: false, kind: "scrub_failed" });
    return;
  }
  if (fragment.length === 0) {
    publish({ historySafe: true, kind: "missing" });
    return;
  }
  const prefix = "#token=";
  let token = fragment.startsWith(prefix) ? fragment.slice(prefix.length) : "";
  fragment = "";
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) {
    token = "";
    publish({ historySafe: true, kind: "invalid" });
    return;
  }
  const capability = createCapability(token);
  token = "";
  window.addEventListener(
    "pagehide",
    () => {
      capability.dispose();
      publish({ historySafe: true, kind: "missing" });
    },
    { once: true },
  );
  publish({ capability, historySafe: true, kind: "ready" });
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

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  void body.cancel().catch(() => undefined);
}

async function readBoundedPasswordRecoveryJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d{1,10}$/u.test(declaredLength) || Number(declaredLength) > MAXIMUM_RESPONSE_BYTES)
  ) {
    cancelBody(response.body);
    throw new TypeError("The password-recovery response was not bounded.");
  }
  if (!response.body) throw new TypeError("The password-recovery response was empty.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (totalBytes + next.value.byteLength > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TypeError("The password-recovery response was too large.");
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

function synchronizedHistoryState(value: unknown): Record<string, unknown> {
  if (!record(value)) return {};
  const state = { ...value };
  delete state.__NA;
  delete state._N;
  return state;
}

export function isPasswordRecoveryToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function isValidNewPassword(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return length >= 12 && length <= 128 && new TextEncoder().encode(value).byteLength <= 512;
}

export function parsePasswordRecoveryAccepted(value: unknown): boolean {
  return (
    record(value) &&
    record(value.data) &&
    Object.keys(value).length === 1 &&
    Object.keys(value.data).length === 1 &&
    value.data.status === "accepted"
  );
}

export function parsePasswordRecoveryConfirmed(value: unknown): boolean {
  return (
    record(value) &&
    record(value.data) &&
    Object.keys(value).length === 1 &&
    Object.keys(value.data).length === 1 &&
    value.data.passwordReset === true
  );
}

function createPasswordRecoveryCapability(
  initialToken: string,
  fetcher: PasswordRecoveryFetch,
): PasswordRecoverySubmissionCapability {
  let token = initialToken;
  let controller: AbortController | null = null;
  let disposed = false;
  let flight: Promise<PasswordRecoverySubmissionOutcome> | null = null;

  const clear = () => {
    token = "";
    disposed = true;
  };
  const dispose = () => {
    clear();
    controller?.abort();
    controller = null;
  };
  const submit = (newPassword: string): Promise<PasswordRecoverySubmissionOutcome> => {
    if (disposed || token.length === 0) {
      return Promise.resolve({ kind: "invalid", retryable: false });
    }
    if (!isValidNewPassword(newPassword)) {
      return Promise.resolve({ kind: "validation", retryable: true });
    }
    if (flight) return flight;

    const activeController = new AbortController();
    controller = activeController;
    let requestBody = JSON.stringify({ token, newPassword });
    let request: Promise<Response>;
    try {
      request = fetcher("/api/auth/password-recovery/confirm", {
        body: requestBody,
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: activeController.signal,
      });
    } catch {
      requestBody = "";
      controller = null;
      return Promise.resolve({ kind: "unavailable", retryable: true });
    }
    requestBody = "";

    const running = Promise.resolve(request)
      .then(async (response): Promise<PasswordRecoverySubmissionOutcome> => {
        let body: unknown = null;
        try {
          body = await readBoundedPasswordRecoveryJson(response);
        } catch {
          if (response.status === 429) return { kind: "rate_limited", retryable: true };
          if (response.status === 503) return { kind: "unavailable", retryable: true };
          clear();
          return { kind: "unavailable", retryable: false };
        }
        const code = problemCode(body);
        let result: PasswordRecoverySubmissionOutcome;
        if (response.status === 200 && parsePasswordRecoveryConfirmed(body)) {
          result = { kind: "success", retryable: false };
        } else if (response.status === 400 && code === "PASSWORD_RECOVERY_TOKEN_INVALID") {
          result = { kind: "invalid", retryable: false };
        } else if (response.status === 410 && code === "PASSWORD_RECOVERY_TOKEN_EXPIRED") {
          result = { kind: "expired", retryable: false };
        } else if (response.status === 429) {
          result = { kind: "rate_limited", retryable: true };
        } else if (response.status === 503) {
          result = { kind: "unavailable", retryable: true };
        } else {
          result = { kind: "unavailable", retryable: false };
        }
        if (!result.retryable) clear();
        return result;
      })
      .catch(
        (): PasswordRecoverySubmissionOutcome =>
          disposed
            ? { kind: "invalid", retryable: false }
            : { kind: "unavailable", retryable: true },
      )
      .finally(() => {
        if (controller === activeController) controller = null;
        if (flight === running) flight = null;
      });
    flight = running;
    return running;
  };

  return Object.freeze(
    Object.defineProperties(
      {},
      {
        dispose: { enumerable: false, value: dispose },
        submit: { enumerable: false, value: submit },
      },
    ),
  ) as PasswordRecoverySubmissionCapability;
}

/** Capture and scrub the fragment synchronously before returning a capability. */
export function consumePasswordRecoveryFragment(
  source: PasswordRecoveryBootstrapSource,
  fetcher: PasswordRecoveryFetch = fetch,
): Promise<PasswordRecoveryBootstrapOutcome> {
  if (source.location.pathname !== "/reset-password") {
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
    return Promise.resolve({ historySafe: true, kind: "missing" });
  }
  const prefix = "#token=";
  let token = fragment.startsWith(prefix) ? fragment.slice(prefix.length) : "";
  fragment = "";
  if (!isPasswordRecoveryToken(token)) {
    token = "";
    return Promise.resolve({ historySafe: true, kind: "invalid" });
  }
  const capability = createPasswordRecoveryCapability(token, fetcher);
  token = "";
  return Promise.resolve({ capability, historySafe: true, kind: "ready" });
}

export function takePasswordRecoveryBootstrap(
  source: PasswordRecoveryBootstrapSource,
  fetcher: PasswordRecoveryFetch = fetch,
): Promise<PasswordRecoveryBootstrapOutcome> {
  const result = source[PASSWORD_RECOVERY_BOOTSTRAP_PROPERTY];
  try {
    delete source[PASSWORD_RECOVERY_BOOTSTRAP_PROPERTY];
  } catch {
    // The property is non-enumerable and is removed on the ordinary path.
  }
  return result ?? consumePasswordRecoveryFragment(source, fetcher);
}

export function createPasswordRecoveryFragmentCoordinator(
  source: PasswordRecoveryNavigationSource,
  onOutcome: (outcome: PasswordRecoveryBootstrapOutcome) => void,
  fetcher: PasswordRecoveryFetch = fetch,
): PasswordRecoveryFragmentCoordinator {
  let active = false;
  let currentCapability: PasswordRecoverySubmissionCapability | null = null;
  let generation = 0;
  let listenerInstalled = false;
  let lifecycleGeneration = 0;
  let pageHidden = false;
  let pageListenersInstalled = false;
  let started = false;

  const deliver = (
    expectedGeneration: number,
    result: Promise<PasswordRecoveryBootstrapOutcome>,
  ) => {
    void result.then((outcome) => {
      if (!active || generation !== expectedGeneration) {
        if (outcome.kind === "ready") outcome.capability.dispose();
        return;
      }
      if (
        currentCapability &&
        currentCapability !== (outcome.kind === "ready" ? outcome.capability : null)
      ) {
        currentCapability.dispose();
      }
      currentCapability = outcome.kind === "ready" ? outcome.capability : null;
      onOutcome(outcome);
    });
  };
  const processHashChange = () => {
    if (!active || source.location.hash === "") return;
    const expectedGeneration = ++generation;
    deliver(expectedGeneration, consumePasswordRecoveryFragment(source, fetcher));
  };
  const handleHashChange: EventListener = processHashChange;
  const handlePageHide: EventListener = () => {
    if (!active) return;
    pageHidden = true;
    generation += 1;
    currentCapability?.dispose();
    currentCapability = null;
  };
  const handlePageShow: EventListener = () => {
    if (!active || !pageHidden) return;
    pageHidden = false;
    if (source.location.hash !== "") {
      processHashChange();
      return;
    }
    onOutcome({ historySafe: true, kind: "missing" });
  };

  return {
    start() {
      active = true;
      lifecycleGeneration += 1;
      if (!started) {
        started = true;
        const expectedGeneration = ++generation;
        deliver(expectedGeneration, takePasswordRecoveryBootstrap(source, fetcher));
      } else if (source.location.hash !== "") {
        processHashChange();
      }
      if (!listenerInstalled) {
        source.addEventListener("hashchange", handleHashChange);
        listenerInstalled = true;
      }
      if (!pageListenersInstalled) {
        source.addEventListener("pagehide", handlePageHide);
        source.addEventListener("pageshow", handlePageShow);
        pageListenersInstalled = true;
      }
    },
    stop() {
      active = false;
      if (listenerInstalled) {
        source.removeEventListener("hashchange", handleHashChange);
        listenerInstalled = false;
      }
      if (pageListenersInstalled) {
        source.removeEventListener("pagehide", handlePageHide);
        source.removeEventListener("pageshow", handlePageShow);
        pageListenersInstalled = false;
      }
      const expectedLifecycleGeneration = ++lifecycleGeneration;
      queueMicrotask(() => {
        if (!active && lifecycleGeneration === expectedLifecycleGeneration) {
          currentCapability?.dispose();
          currentCapability = null;
        }
      });
    },
  };
}

export async function requestPasswordRecovery(
  emailInput: string,
  fetcher: PasswordRecoveryFetch = fetch,
): Promise<PasswordRecoveryRequestOutcome> {
  const email = emailInput.normalize("NFKC").trim();
  if (email.length < 3 || email.length > 254) {
    return {
      kind: "rejected",
      problem: { kind: "invalid_email", message: "Enter a valid email address." },
    };
  }
  const response = await fetcher("/api/auth/password-recovery/request", {
    body: JSON.stringify({ email }),
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    method: "POST",
    redirect: "error",
  });
  let body: unknown = null;
  try {
    body = await readBoundedPasswordRecoveryJson(response);
  } catch {
    // A malformed response is handled as a fixed local failure below.
  }
  if (response.status === 202 && parsePasswordRecoveryAccepted(body)) {
    return { kind: "accepted" };
  }
  if (response.status === 400 && problemCode(body) === "VALIDATION_ERROR") {
    return {
      kind: "rejected",
      problem: { kind: "invalid_email", message: "Enter a valid email address." },
    };
  }
  return {
    kind: "rejected",
    problem: {
      kind: "unavailable",
      message: "Password recovery is temporarily unavailable. Please try again.",
    },
  };
}
