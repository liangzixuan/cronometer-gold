import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  proxyPasswordRecoveryConfirm,
  proxyPasswordRecoveryRequest,
} from "../app/api/auth/password-recovery/proxy";
import {
  createPasswordRecoveryFragmentCoordinator,
  isPasswordRecoveryToken,
  isValidNewPassword,
  PASSWORD_RECOVERY_BOOTSTRAP_PROPERTY,
  PASSWORD_RECOVERY_BOOTSTRAP_SCRIPT,
  type PasswordRecoveryBootstrapOutcome,
  type PasswordRecoveryNavigationSource,
  parsePasswordRecoveryAccepted,
  parsePasswordRecoveryConfirmed,
  requestPasswordRecovery,
  takePasswordRecoveryBootstrap,
} from "./password-recovery";
import { SESSION_COOKIE } from "./private-api";

const recoveryToken = `${"r".repeat(42)}A`;
const newPassword = "correct horse battery staple";

interface BootstrapWindow {
  readonly addEventListener: (
    type: "pagehide",
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ) => void;
  readonly history: {
    readonly state: unknown;
    readonly replaceState: (state: unknown, title: string, url: string) => void;
  };
  readonly location: { readonly hash: string; readonly pathname: string };
  [PASSWORD_RECOVERY_BOOTSTRAP_PROPERTY]?: Promise<PasswordRecoveryBootstrapOutcome>;
}

function executeBootstrap(window: BootstrapWindow, fetcher: typeof fetch) {
  runInNewContext(PASSWORD_RECOVERY_BOOTSTRAP_SCRIPT, {
    AbortController,
    fetch: fetcher,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    window,
  });
  return takePasswordRecoveryBootstrap(window);
}

function navigationSource(initialHash: string, options: { readonly scrubFails?: boolean } = {}) {
  const events: string[] = [];
  const historyState = { __NA: true, _N: true, marker: "preserve" };
  const location = { hash: initialHash, pathname: "/reset-password" };
  const listeners: Partial<Record<"hashchange" | "pagehide" | "pageshow", EventListener>> = {};
  const source: PasswordRecoveryNavigationSource = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    history: {
      state: historyState,
      replaceState(state, _title, pathname) {
        events.push(`replace:${pathname}`);
        expect(state).toEqual({ marker: "preserve" });
        if (options.scrubFails) throw new Error("history unavailable");
        location.hash = "";
      },
    },
    location,
    removeEventListener(type, listener) {
      if (listeners[type] === listener) delete listeners[type];
    },
  };
  return {
    emitHashChange() {
      listeners.hashchange?.(new Event("hashchange"));
    },
    emitPageHide() {
      listeners.pagehide?.(new Event("pagehide"));
    },
    emitPageShow() {
      listeners.pageshow?.(new Event("pageshow"));
    },
    events,
    location,
    source,
  };
}

function chunkedOversizedResponse(status: number) {
  const state = { cancelled: false, pulls: 0 };
  const chunks = Array.from({ length: 8 }, () => new Uint8Array(2_048).fill(120));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulls];
      state.pulls += 1;
      if (chunk) controller.enqueue(chunk);
      // Stay open after the supplied chunks so the production reader must cancel
      // the underlying response stream when it reaches the actual bound.
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "application/json" }, status }),
    state,
  };
}

function declaredResponse(status: number, declaredLength: string, bodyValue: unknown) {
  const state = { cancelled: false };
  const bytes = new TextEncoder().encode(JSON.stringify(bodyValue));
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      state.cancelled = true;
    },
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    response: new Response(body, {
      headers: { "content-length": declaredLength, "content-type": "application/json" },
      status,
    }),
    state,
  };
}

function chunkedRequest(
  path: "confirm" | "request",
  chunks: readonly Uint8Array[],
  declaredLength?: string,
) {
  const state = { cancelled: false, pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulls];
      state.pulls += 1;
      if (chunk) controller.enqueue(chunk);
      // Stay open after the supplied chunks so rejection must cancel the stream.
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const headers = new Headers({
    "content-type": "application/json",
    origin: "https://app.test",
    "sec-fetch-site": "same-origin",
  });
  if (declaredLength !== undefined) headers.set("content-length", declaredLength);
  const request = new Request(`https://app.test/api/auth/password-recovery/${path}`, {
    body,
    duplex: "half",
    headers,
    method: "POST",
  } as RequestInit & { duplex: "half" });
  return { request, state };
}

function browserRequest(path: "confirm" | "request", body: unknown, origin = "https://app.test") {
  return new Request(`https://app.test/api/auth/password-recovery/${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": origin === "https://app.test" ? "same-origin" : "cross-site",
    },
    method: "POST",
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("web password recovery", () => {
  it("scrubs the fragment before exposing a non-serializable submission capability", async () => {
    const events: string[] = [];
    const window: BootstrapWindow = {
      addEventListener() {
        // This case exercises submission; lifecycle disposal has a dedicated case below.
      },
      history: {
        state: null,
        replaceState: (_state, _title, pathname) => events.push(`replace:${pathname}`),
      },
      location: { hash: `#token=${recoveryToken}`, pathname: "/reset-password" },
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      events.push("fetch");
      expect(input).toBe("/api/auth/password-recovery/confirm");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({ token: recoveryToken, newPassword });
      expect(String(input)).not.toContain(recoveryToken);
      return Response.json({ data: { passwordReset: true } });
    });

    const outcome = await executeBootstrap(window, fetcher);

    expect(events).toEqual(["replace:/reset-password"]);
    expect(PASSWORD_RECOVERY_BOOTSTRAP_PROPERTY in window).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(recoveryToken);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") throw new Error("Expected a recovery capability.");
    await expect(outcome.capability.submit(newPassword)).resolves.toEqual({
      kind: "success",
      retryable: false,
    });
    expect(events).toEqual(["replace:/reset-password", "fetch"]);
    await expect(outcome.capability.submit(newPassword)).resolves.toEqual({
      kind: "invalid",
      retryable: false,
    });
  });

  it("disposes a pre-hydration capability and publishes a fail-closed result on pagehide", async () => {
    const pageHideListeners: EventListener[] = [];
    const window: BootstrapWindow = {
      addEventListener(type, listener) {
        expect(type).toBe("pagehide");
        pageHideListeners.push(listener);
      },
      history: {
        state: null,
        replaceState() {
          // The fragment is captured before this synchronous scrub.
        },
      },
      location: { hash: `#token=${recoveryToken}`, pathname: "/reset-password" },
    };
    const fetcher = vi.fn<typeof fetch>();
    const ready = await executeBootstrap(window, fetcher);
    if (ready.kind !== "ready") throw new Error("Expected a recovery capability.");

    expect(pageHideListeners).toHaveLength(1);
    pageHideListeners[0]?.(new Event("pagehide"));

    await expect(ready.capability.submit(newPassword)).resolves.toEqual({
      kind: "invalid",
      retryable: false,
    });
    await expect(takePasswordRecoveryBootstrap(window, fetcher)).resolves.toEqual({
      historySafe: true,
      kind: "missing",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on scrub failure and rejects missing, query-only, or malformed fragments locally", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const failed = navigationSource(`#token=${recoveryToken}`, { scrubFails: true });
    await expect(takePasswordRecoveryBootstrap(failed.source, fetcher)).resolves.toEqual({
      historySafe: false,
      kind: "scrub_failed",
    });

    for (const hash of ["", "#token=short", `#other=${recoveryToken}`, `?token=${recoveryToken}`]) {
      const source = navigationSource(hash);
      const outcome = await takePasswordRecoveryBootstrap(source.source, fetcher);
      expect(outcome).toEqual({
        historySafe: true,
        kind: hash === "" ? "missing" : "invalid",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(isPasswordRecoveryToken(recoveryToken)).toBe(true);
    expect(isPasswordRecoveryToken("r".repeat(43))).toBe(false);
  });

  it("preserves user history state, removes Next sentinels, and rotates capabilities on hashchange", async () => {
    const source = navigationSource(`#token=${recoveryToken}`);
    const outcomes: PasswordRecoveryBootstrapOutcome[] = [];
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { passwordReset: true } }),
    );
    const coordinator = createPasswordRecoveryFragmentCoordinator(
      source.source,
      (outcome) => outcomes.push(outcome),
      fetcher,
    );
    coordinator.start();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    const first = outcomes[0];
    if (first?.kind !== "ready") throw new Error("Expected first recovery capability.");

    source.location.hash = `#token=${"s".repeat(42)}A`;
    source.emitHashChange();
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    const second = outcomes[1];
    if (second?.kind !== "ready") throw new Error("Expected second recovery capability.");

    await expect(first.capability.submit(newPassword)).resolves.toEqual({
      kind: "invalid",
      retryable: false,
    });
    coordinator.stop();
    await Promise.resolve();
    await expect(second.capability.submit(newPassword)).resolves.toEqual({
      kind: "invalid",
      retryable: false,
    });
    expect(source.events).toEqual(["replace:/reset-password", "replace:/reset-password"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("survives a synchronous stop/start effect replay but disposes after a real stop", async () => {
    const source = navigationSource(`#token=${recoveryToken}`);
    const outcomes: PasswordRecoveryBootstrapOutcome[] = [];
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { passwordReset: true } }),
    );
    const coordinator = createPasswordRecoveryFragmentCoordinator(
      source.source,
      (outcome) => outcomes.push(outcome),
      fetcher,
    );
    coordinator.start();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    const outcome = outcomes[0];
    if (outcome?.kind !== "ready") throw new Error("Expected a recovery capability.");

    coordinator.stop();
    coordinator.start();
    await Promise.resolve();
    await expect(outcome.capability.submit(newPassword)).resolves.toEqual({
      kind: "success",
      retryable: false,
    });

    const nextSource = navigationSource(`#token=${recoveryToken}`);
    const nextOutcomes: PasswordRecoveryBootstrapOutcome[] = [];
    const nextCoordinator = createPasswordRecoveryFragmentCoordinator(
      nextSource.source,
      (nextOutcome) => nextOutcomes.push(nextOutcome),
      fetcher,
    );
    nextCoordinator.start();
    await vi.waitFor(() => expect(nextOutcomes).toHaveLength(1));
    const nextOutcome = nextOutcomes[0];
    if (nextOutcome?.kind !== "ready") throw new Error("Expected a recovery capability.");
    nextCoordinator.stop();
    await Promise.resolve();
    await expect(nextOutcome.capability.submit(newPassword)).resolves.toEqual({
      kind: "invalid",
      retryable: false,
    });
  });

  it("disposes the active capability on pagehide and stays fail-closed after BFCache restore", async () => {
    const source = navigationSource(`#token=${recoveryToken}`);
    const outcomes: PasswordRecoveryBootstrapOutcome[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const coordinator = createPasswordRecoveryFragmentCoordinator(
      source.source,
      (outcome) => outcomes.push(outcome),
      fetcher,
    );
    coordinator.start();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    const ready = outcomes[0];
    if (ready?.kind !== "ready") throw new Error("Expected a recovery capability.");

    source.emitPageHide();
    await expect(ready.capability.submit(newPassword)).resolves.toEqual({
      kind: "invalid",
      retryable: false,
    });
    source.emitPageShow();

    expect(outcomes.at(-1)).toEqual({ historySafe: true, kind: "missing" });
    expect(fetcher).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("matches the API password character and UTF-8 byte bounds without normalization", () => {
    expect(isValidNewPassword("a".repeat(11))).toBe(false);
    expect(isValidNewPassword("a".repeat(12))).toBe(true);
    expect(isValidNewPassword("a".repeat(128))).toBe(true);
    expect(isValidNewPassword("a".repeat(129))).toBe(false);
    expect(isValidNewPassword("😀".repeat(128))).toBe(true);
    expect(isValidNewPassword(`${"😀".repeat(127)}é`)).toBe(true);
    expect(isValidNewPassword(`${"😀".repeat(127)}€`)).toBe(true);
    expect(isValidNewPassword(`${"😀".repeat(128)}a`)).toBe(false);
  });

  it("single-flights submission and retains the token only for retryable 429, 503, and network outcomes", async () => {
    const source = navigationSource(`#token=${recoveryToken}`);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: "RATE_LIMITED" }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ code: "SERVICE_NOT_READY" }, { status: 503 }))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(Response.json({ data: { passwordReset: true } }));
    const outcome = await takePasswordRecoveryBootstrap(source.source, fetcher);
    if (outcome.kind !== "ready") throw new Error("Expected a recovery capability.");

    const first = outcome.capability.submit(newPassword);
    const racing = outcome.capability.submit(newPassword);
    expect(racing).toBe(first);
    await expect(first).resolves.toEqual({ kind: "rate_limited", retryable: true });
    await expect(outcome.capability.submit(newPassword)).resolves.toEqual({
      kind: "unavailable",
      retryable: true,
    });
    await expect(outcome.capability.submit(newPassword)).resolves.toEqual({
      kind: "unavailable",
      retryable: true,
    });
    await expect(outcome.capability.submit(newPassword)).resolves.toEqual({
      kind: "success",
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("hard-caps browser responses for inline, fallback, and request recovery paths", async () => {
    const inlineResponse = chunkedOversizedResponse(200);
    const inlineWindow: BootstrapWindow = {
      addEventListener() {
        // Lifecycle behavior is covered independently.
      },
      history: { state: null, replaceState() {} },
      location: { hash: `#token=${recoveryToken}`, pathname: "/reset-password" },
    };
    const inline = await executeBootstrap(
      inlineWindow,
      vi.fn(async () => inlineResponse.response),
    );
    if (inline.kind !== "ready") throw new Error("Expected an inline recovery capability.");
    await expect(inline.capability.submit(newPassword)).resolves.toEqual({
      kind: "unavailable",
      retryable: false,
    });
    expect(inlineResponse.state.cancelled).toBe(true);
    expect(inlineResponse.state.pulls).toBeLessThan(8);

    const fallbackResponse = chunkedOversizedResponse(200);
    const fallbackSource = navigationSource(`#token=${recoveryToken}`);
    const fallback = await takePasswordRecoveryBootstrap(
      fallbackSource.source,
      vi.fn(async () => fallbackResponse.response),
    );
    if (fallback.kind !== "ready") throw new Error("Expected a fallback recovery capability.");
    await expect(fallback.capability.submit(newPassword)).resolves.toEqual({
      kind: "unavailable",
      retryable: false,
    });
    expect(fallbackResponse.state.cancelled).toBe(true);
    expect(fallbackResponse.state.pulls).toBeLessThan(8);

    const requestResponse = chunkedOversizedResponse(202);
    await expect(
      requestPasswordRecovery("ada@example.test", async () => requestResponse.response),
    ).resolves.toMatchObject({ kind: "rejected", problem: { kind: "unavailable" } });
    expect(requestResponse.state.cancelled).toBe(true);
    expect(requestResponse.state.pulls).toBeLessThan(8);
  });

  it("rejects oversized or malformed declared browser response lengths before parsing", async () => {
    const inlineResponse = declaredResponse(200, "4097", { data: { passwordReset: true } });
    const inlineWindow: BootstrapWindow = {
      addEventListener() {},
      history: { state: null, replaceState() {} },
      location: { hash: `#token=${recoveryToken}`, pathname: "/reset-password" },
    };
    const inline = await executeBootstrap(
      inlineWindow,
      vi.fn(async () => inlineResponse.response),
    );
    if (inline.kind !== "ready") throw new Error("Expected an inline recovery capability.");
    await expect(inline.capability.submit(newPassword)).resolves.toEqual({
      kind: "unavailable",
      retryable: false,
    });
    await vi.waitFor(() => expect(inlineResponse.state.cancelled).toBe(true));

    const requestResponse = declaredResponse(202, "1e3", { data: { status: "accepted" } });
    await expect(
      requestPasswordRecovery("ada@example.test", async () => requestResponse.response),
    ).resolves.toMatchObject({ kind: "rejected", problem: { kind: "unavailable" } });
    await vi.waitFor(() => expect(requestResponse.state.cancelled).toBe(true));
  });

  it("disposes the token after semantic failure, expiry, or a protocol-invalid response", async () => {
    const cases = [
      {
        response: Response.json({ code: "PASSWORD_RECOVERY_TOKEN_INVALID" }, { status: 400 }),
        result: { kind: "invalid", retryable: false },
      },
      {
        response: Response.json({ code: "PASSWORD_RECOVERY_TOKEN_EXPIRED" }, { status: 410 }),
        result: { kind: "expired", retryable: false },
      },
      {
        response: Response.json({ data: { passwordReset: true } }, { status: 201 }),
        result: { kind: "unavailable", retryable: false },
      },
    ] as const;

    for (const testCase of cases) {
      const source = navigationSource(`#token=${recoveryToken}`);
      const fetcher = vi.fn<typeof fetch>(async () => testCase.response);
      const outcome = await takePasswordRecoveryBootstrap(source.source, fetcher);
      if (outcome.kind !== "ready") throw new Error("Expected a recovery capability.");
      await expect(outcome.capability.submit(newPassword)).resolves.toEqual(testCase.result);
      await expect(outcome.capability.submit(newPassword)).resolves.toEqual({
        kind: "invalid",
        retryable: false,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("requests recovery with normalized email in a body and accepts only the exact 202 envelope", async () => {
    const accepted = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { status: "accepted" } }, { status: 202 }),
    );
    await expect(requestPasswordRecovery("  ada@example.test  ", accepted)).resolves.toEqual({
      kind: "accepted",
    });
    const [url, init] = accepted.mock.calls[0] ?? [];
    expect(url).toBe("/api/auth/password-recovery/request");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "ada@example.test" });
    expect(String(url)).not.toContain("ada@example.test");

    for (const response of [
      Response.json({ data: { status: "accepted" } }, { status: 200 }),
      Response.json({ data: { status: "accepted", account: true } }, { status: 202 }),
    ]) {
      await expect(
        requestPasswordRecovery("ada@example.test", async () => response),
      ).resolves.toMatchObject({ kind: "rejected", problem: { kind: "unavailable" } });
    }
    expect(parsePasswordRecoveryAccepted({ data: { status: "accepted" } })).toBe(true);
    expect(parsePasswordRecoveryConfirmed({ data: { passwordReset: true } })).toBe(true);
  });

  it("forwards an enumeration-safe request only from the same origin", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({ data: { status: "accepted" } }, { status: 202 });
      }),
    );
    const response = await proxyPasswordRecoveryRequest(
      browserRequest("request", { email: "  ada@example.test  " }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { status: "accepted" } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/auth/password-recovery/request");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ email: "ada@example.test" });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBeNull();

    const untrusted = await proxyPasswordRecoveryRequest(
      browserRequest("request", { email: "ada@example.test" }, "https://evil.test"),
    );
    expect(untrusted.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("confirms through a body only, requires exact success, and clears the browser session", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({ data: { passwordReset: true } });
      }),
    );
    const response = await proxyPasswordRecoveryConfirm(
      browserRequest("confirm", { token: recoveryToken, newPassword }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { passwordReset: true } });
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/auth/password-recovery/confirm");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.url).not.toContain(recoveryToken);
    expect(JSON.stringify(calls[0]?.init?.headers)).not.toContain(recoveryToken);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: recoveryToken, newPassword });
  });

  it("maps only stable confirmation failures and never echoes upstream token or password detail", async () => {
    const cases = [
      {
        body: {
          code: "PASSWORD_RECOVERY_TOKEN_INVALID",
          detail: `${recoveryToken} ${newPassword}`,
        },
        expected: {
          code: "PASSWORD_RECOVERY_TOKEN_INVALID",
          error: "This recovery link is invalid or has already been used.",
        },
        status: 400,
      },
      {
        body: {
          code: "PASSWORD_RECOVERY_TOKEN_EXPIRED",
          detail: `${recoveryToken} ${newPassword}`,
        },
        expected: {
          code: "PASSWORD_RECOVERY_TOKEN_EXPIRED",
          error: "This recovery link has expired.",
        },
        status: 410,
      },
      {
        body: { code: "RATE_LIMITED", detail: `${recoveryToken} ${newPassword}` },
        expected: {
          code: "RATE_LIMITED",
          error: "Password recovery is temporarily busy. Wait a moment and try again.",
        },
        status: 429,
      },
    ] as const;
    for (const testCase of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(testCase.body, { status: testCase.status })),
      );
      const response = await proxyPasswordRecoveryConfirm(
        browserRequest("confirm", { token: recoveryToken, newPassword }),
      );
      expect(response.status).toBe(testCase.status);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(testCase.expected);
      expect(text).not.toContain(recoveryToken);
      expect(text).not.toContain(newPassword);
    }
  });

  it("rejects cross-origin, malformed, extra-key, and over-1-KiB requests before upstream", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const requests = [
      browserRequest("confirm", { token: "short", newPassword }),
      browserRequest("confirm", { token: recoveryToken, newPassword: "short" }),
      browserRequest("confirm", { token: recoveryToken, newPassword, extra: true }),
      browserRequest("request", { email: "ada@example.test", extra: true }),
      browserRequest("confirm", { token: recoveryToken, newPassword }, "https://evil.test"),
      new Request("https://app.test/api/auth/password-recovery/confirm?token=must-not-be-read", {
        body: JSON.stringify({ token: recoveryToken, newPassword }),
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
      new Request("https://app.test/api/auth/password-recovery/request", {
        body: JSON.stringify({ email: `${"a".repeat(1_024)}@example.test` }),
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
    ];
    for (const request of requests) {
      const response = request.url.endsWith("/confirm")
        ? await proxyPasswordRecoveryConfirm(request)
        : await proxyPasswordRecoveryRequest(request);
      expect([400, 403]).toContain(response.status);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("hard-caps chunked inbound bodies and rejects lying or malformed declared lengths", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const smallBody = new TextEncoder().encode(JSON.stringify({ email: "ada@example.test" }));
    const cases = [
      chunkedRequest("request", [new Uint8Array(700), new Uint8Array(700)]),
      chunkedRequest("confirm", [new Uint8Array(700), new Uint8Array(700)], "1"),
      chunkedRequest("request", [smallBody], "1e3"),
      chunkedRequest("confirm", [smallBody], "1025"),
    ];

    for (const testCase of cases) {
      const response = testCase.request.url.endsWith("/confirm")
        ? await proxyPasswordRecoveryConfirm(testCase.request)
        : await proxyPasswordRecoveryRequest(testCase.request);
      expect(response.status).toBe(400);
      await vi.waitFor(() => expect(testCase.state.cancelled).toBe(true));
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns 502 for wrong success statuses or non-closed success bodies", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ data: { passwordReset: true } }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ data: { passwordReset: true, session: "must-not-appear" } }),
      );
    vi.stubGlobal("fetch", upstream);

    const responses = [
      await proxyPasswordRecoveryRequest(browserRequest("request", { email: "ada@example.test" })),
      await proxyPasswordRecoveryConfirm(
        browserRequest("confirm", { token: recoveryToken, newPassword }),
      ),
      await proxyPasswordRecoveryConfirm(
        browserRequest("confirm", { token: recoveryToken, newPassword }),
      ),
    ];
    expect(responses.map((response) => response.status)).toEqual([502, 502, 502]);
    expect(responses[1]?.headers.get("set-cookie")).toBeNull();
    expect(responses[2]?.headers.get("set-cookie")).toBeNull();
  });

  it("hard-caps chunked upstream success and error bodies on every recovery path", async () => {
    const cases = [
      {
        operation: () =>
          proxyPasswordRecoveryRequest(browserRequest("request", { email: "ada@example.test" })),
        upstreamStatus: 202,
      },
      {
        operation: () =>
          proxyPasswordRecoveryRequest(browserRequest("request", { email: "ada@example.test" })),
        upstreamStatus: 503,
      },
      {
        operation: () =>
          proxyPasswordRecoveryConfirm(
            browserRequest("confirm", { token: recoveryToken, newPassword }),
          ),
        upstreamStatus: 200,
      },
      {
        operation: () =>
          proxyPasswordRecoveryConfirm(
            browserRequest("confirm", { token: recoveryToken, newPassword }),
          ),
        upstreamStatus: 400,
      },
      {
        operation: () =>
          proxyPasswordRecoveryConfirm(
            browserRequest("confirm", { token: recoveryToken, newPassword }),
          ),
        upstreamStatus: 503,
      },
    ] as const;

    for (const testCase of cases) {
      const oversized = chunkedOversizedResponse(testCase.upstreamStatus);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => oversized.response),
      );
      const response = await testCase.operation();
      expect(response.status).toBe(502);
      expect(oversized.state.cancelled).toBe(true);
      expect(oversized.state.pulls).toBeLessThan(8);
    }
  });

  it("rejects a declared upstream body over 4 KiB without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([123, 125]));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-length": "4097", "content-type": "application/json" },
            status: 202,
          }),
      ),
    );
    const response = await proxyPasswordRecoveryRequest(
      browserRequest("request", { email: "ada@example.test" }),
    );
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
  });
});
