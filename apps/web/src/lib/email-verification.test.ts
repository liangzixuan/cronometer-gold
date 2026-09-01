import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  proxyEmailVerificationConfirm,
  proxyEmailVerificationRequest,
} from "../app/api/auth/email-verification/proxy";
import { GET as proxyCurrentSession } from "../app/api/auth/me/route";
import {
  createEmailVerificationFragmentCoordinator,
  EMAIL_VERIFICATION_BOOTSTRAP_PROPERTY,
  EMAIL_VERIFICATION_BOOTSTRAP_SCRIPT,
  type EmailVerificationNavigationSource,
  type EmailVerificationStatusFetch,
  emailVerificationProblem,
  isEmailVerificationToken,
  parseEmailVerificationAccepted,
  parseEmailVerificationConfirmed,
  requestAndReconcileEmailVerification,
  takeEmailVerificationBootstrap,
} from "./email-verification";
import { SESSION_COOKIE } from "./private-api";

const verificationToken = `${"v".repeat(42)}A`;
const sessionToken = "s".repeat(43);
const webProfile = {
  activityLevelCode: null,
  baselineWeightKg: null,
  birthDate: null,
  displayName: "Ada",
  heightCm: null,
  locale: "en-US",
  onboardingCompletedAt: null,
  revision: "1",
  sexAtBirth: null,
  timeZone: "America/Chicago",
  unitSystem: "metric",
};

interface BootstrapWindow {
  readonly history: {
    readonly state: unknown;
    readonly replaceState: (state: unknown, title: string, url: string) => void;
  };
  readonly location: { readonly hash: string; readonly pathname: string };
  [EMAIL_VERIFICATION_BOOTSTRAP_PROPERTY]?: ReturnType<typeof takeEmailVerificationBootstrap>;
}

function navigationSource(initialHash: string, options: { readonly scrubFails?: boolean } = {}) {
  const events: string[] = [];
  const historyState = { marker: "preserve-next-router-state" };
  const location = { hash: initialHash, pathname: "/verify-email" };
  let hashChangeListener: EventListener | null = null;
  const source: EmailVerificationNavigationSource = {
    addEventListener(type, listener) {
      expect(type).toBe("hashchange");
      hashChangeListener = listener;
    },
    history: {
      state: historyState,
      replaceState(state, _title, pathname) {
        events.push(`replace:${pathname}`);
        expect(state).not.toBe(historyState);
        expect(state).toEqual(historyState);
        if (options.scrubFails) throw new Error("history unavailable");
        location.hash = "";
      },
    },
    location,
    removeEventListener(type, listener) {
      expect(type).toBe("hashchange");
      if (hashChangeListener === listener) hashChangeListener = null;
    },
  };
  return {
    emitHashChange() {
      hashChangeListener?.(new Event("hashchange"));
    },
    events,
    historyState,
    location,
    source,
  };
}

function executeBootstrap(
  window: BootstrapWindow,
  fetcher: typeof fetch,
): ReturnType<typeof takeEmailVerificationBootstrap> {
  runInNewContext(EMAIL_VERIFICATION_BOOTSTRAP_SCRIPT, { fetch: fetcher, window });
  return takeEmailVerificationBootstrap(window);
}

function chunkedOversizedResponse(status: number) {
  const state = { cancelled: false, pulls: 0 };
  const chunks = Array.from({ length: 8 }, () => new Uint8Array(2_048).fill(120));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulls];
      state.pulls += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("web email verification", () => {
  it("scrubs history before the earliest confirmation request and publishes no token", async () => {
    const events: string[] = [];
    const window: BootstrapWindow = {
      history: {
        state: null,
        replaceState: (_state, _title, pathname) => events.push(`replace:${pathname}`),
      },
      location: { hash: `#token=${verificationToken}`, pathname: "/verify-email" },
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      events.push("fetch");
      expect(String(init?.body)).toBe(JSON.stringify({ token: verificationToken }));
      return Response.json({ data: { verified: true } });
    });

    const outcome = await executeBootstrap(window, fetcher);

    expect(events).toEqual(["replace:/verify-email", "fetch"]);
    expect(outcome).toEqual({ historySafe: true, kind: "success" });
    expect(EMAIL_VERIFICATION_BOOTSTRAP_PROPERTY in window).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(verificationToken);
  });

  it("fails closed when history cannot be scrubbed and rejects noncanonical aliases locally", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const failedWindow: BootstrapWindow = {
      history: {
        state: null,
        replaceState: () => {
          throw new Error("history unavailable");
        },
      },
      location: { hash: `#token=${verificationToken}`, pathname: "/verify-email" },
    };
    await expect(executeBootstrap(failedWindow, fetcher)).resolves.toEqual({
      historySafe: false,
      kind: "scrub_failed",
    });
    expect(fetcher).not.toHaveBeenCalled();

    const noncanonicalWindow: BootstrapWindow = {
      history: { state: null, replaceState: () => undefined },
      location: { hash: `#token=${"v".repeat(43)}`, pathname: "/verify-email" },
    };
    await expect(executeBootstrap(noncanonicalWindow, fetcher)).resolves.toEqual({
      historySafe: true,
      kind: "invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(isEmailVerificationToken(verificationToken)).toBe(true);
    expect(isEmailVerificationToken("v".repeat(43))).toBe(false);
  });

  it("handles a missing-bootstrap client navigation synchronously without losing router state", async () => {
    const bare = navigationSource("");
    await expect(takeEmailVerificationBootstrap(bare.source)).resolves.toEqual({
      historySafe: true,
      kind: "ready",
    });
    expect(bare.events).toEqual(["replace:/verify-email"]);

    const navigation = navigationSource(`#token=${verificationToken}`);
    const fetcher = vi.fn<EmailVerificationStatusFetch>(async () => {
      navigation.events.push("fetch");
      return Response.json({ data: { verified: true } });
    });
    const confirmation = takeEmailVerificationBootstrap(navigation.source, fetcher);

    expect(navigation.events).toEqual(["replace:/verify-email", "fetch"]);
    expect(navigation.location.hash).toBe("");
    await expect(confirmation).resolves.toEqual({ historySafe: true, kind: "success" });
  });

  it("removes Next sentinels for patched-history canonical synchronization", async () => {
    const routeTree = { segment: "verify-email" };
    const rawState = {
      __NA: true,
      _N: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: routeTree,
      userField: { preserved: true },
    };
    const location = { hash: `#token=${verificationToken}`, pathname: "/verify-email" };
    let browserUrl = `/verify-email#token=${verificationToken}`;
    let canonicalUrl = browserUrl;
    let currentState: Record<string, unknown> = rawState;
    let rawStateBypassedSynchronization = false;
    let suppliedState: Record<string, unknown> | null = null;
    const patchedReplaceState = (state: unknown, _title: string, url: string) => {
      const nextState = state as Record<string, unknown>;
      if (nextState.__NA || nextState._N) {
        rawStateBypassedSynchronization = true;
        currentState = nextState;
        browserUrl = url;
        return;
      }
      suppliedState = nextState;
      canonicalUrl = url;
      browserUrl = url;
      location.hash = "";
      currentState = {
        ...nextState,
        __NA: true,
        __PRIVATE_NEXTJS_INTERNALS_TREE: currentState.__PRIVATE_NEXTJS_INTERNALS_TREE,
      };
    };
    patchedReplaceState(rawState, "", "/verify-email");
    expect(rawStateBypassedSynchronization).toBe(true);
    expect(canonicalUrl).toContain(verificationToken);

    rawStateBypassedSynchronization = false;
    browserUrl = `/verify-email#token=${verificationToken}`;
    currentState = rawState;
    const fetcher = vi.fn<EmailVerificationStatusFetch>(async () =>
      Response.json({ data: { verified: true } }),
    );
    const confirmation = takeEmailVerificationBootstrap(
      {
        history: { state: rawState, replaceState: patchedReplaceState },
        location,
      },
      fetcher,
    );

    expect(rawStateBypassedSynchronization).toBe(false);
    expect(suppliedState).toEqual({
      __PRIVATE_NEXTJS_INTERNALS_TREE: routeTree,
      userField: { preserved: true },
    });
    expect(browserUrl).toBe("/verify-email");
    expect(canonicalUrl).toBe("/verify-email");
    browserUrl = canonicalUrl;
    expect(browserUrl).not.toContain(verificationToken);
    expect(currentState.userField).toEqual({ preserved: true });
    await expect(confirmation).resolves.toEqual({ historySafe: true, kind: "success" });
  });

  it("uses an empty safe state for null and non-object client history", async () => {
    for (const historyState of [null, "legacy-state"] as const) {
      let suppliedState: unknown = null;
      const location = { hash: "", pathname: "/verify-email" };
      await expect(
        takeEmailVerificationBootstrap({
          history: {
            state: historyState,
            replaceState(state) {
              suppliedState = state;
            },
          },
          location,
        }),
      ).resolves.toEqual({ historySafe: true, kind: "ready" });
      expect(suppliedState).toEqual({});
    }
  });

  it("handles a valid same-document hash once after mount and scrubs before fetching", async () => {
    const navigation = navigationSource("");
    const outcomes: unknown[] = [];
    const fetcher = vi.fn<EmailVerificationStatusFetch>(async () => {
      navigation.events.push("fetch");
      return Response.json({ data: { verified: true } });
    });
    const coordinator = createEmailVerificationFragmentCoordinator(
      navigation.source,
      (outcome) => outcomes.push(outcome),
      fetcher,
    );
    coordinator.start();
    await vi.waitFor(() => expect(outcomes).toEqual([{ historySafe: true, kind: "ready" }]));
    navigation.events.length = 0;
    outcomes.length = 0;

    navigation.location.hash = `#token=${verificationToken}`;
    navigation.emitHashChange();

    expect(navigation.events).toEqual(["replace:/verify-email", "fetch"]);
    expect(navigation.location.hash).toBe("");
    await vi.waitFor(() => expect(outcomes).toEqual([{ historySafe: true, kind: "success" }]));
    expect(fetcher).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  it("scrubs a malformed mounted hash without fetching", async () => {
    const navigation = navigationSource("");
    const outcomes: unknown[] = [];
    const fetcher = vi.fn<EmailVerificationStatusFetch>();
    const coordinator = createEmailVerificationFragmentCoordinator(
      navigation.source,
      (outcome) => outcomes.push(outcome),
      fetcher,
    );
    coordinator.start();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    navigation.events.length = 0;
    outcomes.length = 0;

    navigation.location.hash = "#token=malformed";
    navigation.emitHashChange();

    expect(navigation.events).toEqual(["replace:/verify-email"]);
    expect(navigation.location.hash).toBe("");
    await vi.waitFor(() => expect(outcomes).toEqual([{ historySafe: true, kind: "invalid" }]));
    expect(fetcher).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("does not fetch or expose controls when a mounted hash cannot be scrubbed", async () => {
    const navigation = navigationSource("", { scrubFails: true });
    const outcomes: unknown[] = [];
    const fetcher = vi.fn<EmailVerificationStatusFetch>();
    const coordinator = createEmailVerificationFragmentCoordinator(
      navigation.source,
      (outcome) => outcomes.push(outcome),
      fetcher,
    );
    coordinator.start();
    await vi.waitFor(() =>
      expect(outcomes).toEqual([{ historySafe: false, kind: "scrub_failed" }]),
    );
    outcomes.length = 0;
    navigation.events.length = 0;

    navigation.location.hash = `#token=${verificationToken}`;
    navigation.emitHashChange();

    expect(navigation.events).toEqual(["replace:/verify-email"]);
    await vi.waitFor(() =>
      expect(outcomes).toEqual([{ historySafe: false, kind: "scrub_failed" }]),
    );
    expect(fetcher).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("does not duplicate a full-document bootstrap confirmation when the listener mounts", async () => {
    const navigation = navigationSource(`#token=${verificationToken}`);
    const outcomes: unknown[] = [];
    const fetcher = vi.fn<EmailVerificationStatusFetch>(async () => {
      navigation.events.push("fetch");
      return Response.json({ data: { verified: true } });
    });
    runInNewContext(EMAIL_VERIFICATION_BOOTSTRAP_SCRIPT, {
      fetch: fetcher,
      window: navigation.source,
    });
    const coordinator = createEmailVerificationFragmentCoordinator(
      navigation.source,
      (outcome) => outcomes.push(outcome),
      fetcher,
    );
    coordinator.start();
    navigation.emitHashChange();

    await vi.waitFor(() => expect(outcomes).toEqual([{ historySafe: true, kind: "success" }]));
    expect(navigation.location.hash).toBe("");
    expect(navigation.events.filter((event) => event === "fetch")).toHaveLength(1);
    expect(navigation.events.slice(0, navigation.events.indexOf("fetch"))).toEqual(
      expect.arrayContaining(["replace:/verify-email"]),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(EMAIL_VERIFICATION_BOOTSTRAP_PROPERTY in navigation.source).toBe(false);
    coordinator.stop();
  });

  it("does not accept a wrong confirmation success status", async () => {
    const navigation = navigationSource(`#token=${verificationToken}`);
    const fetcher = vi.fn<EmailVerificationStatusFetch>(async () =>
      Response.json({ data: { verified: true } }, { status: 201 }),
    );

    await expect(takeEmailVerificationBootstrap(navigation.source, fetcher)).resolves.toEqual({
      historySafe: true,
      kind: "unavailable",
    });
    expect(navigation.location.hash).toBe("");
  });

  it("parses only the closed success envelopes and stable failure codes", () => {
    expect(parseEmailVerificationAccepted({ data: { status: "accepted" } })).toBe(true);
    expect(parseEmailVerificationAccepted({ data: { status: "accepted", token: "no" } })).toBe(
      false,
    );
    expect(parseEmailVerificationConfirmed({ data: { verified: true } })).toBe(true);
    expect(parseEmailVerificationConfirmed({ data: { verified: false } })).toBe(false);
    expect(emailVerificationProblem(400, { code: "EMAIL_VERIFICATION_TOKEN_EXPIRED" }).kind).toBe(
      "expired",
    );
    expect(emailVerificationProblem(400, { code: "EMAIL_VERIFICATION_TOKEN_INVALID" }).kind).toBe(
      "invalid",
    );
    expect(emailVerificationProblem(429, null).kind).toBe("rate_limited");
    expect(emailVerificationProblem(401, { code: "UNAUTHORIZED" }).kind).toBe("unauthorized");
  });

  it("reconciles an accepted no-mail request to an already-verified session", async () => {
    const fetcher = vi
      .fn<EmailVerificationStatusFetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            profile: webProfile,
            user: {
              email: "ada@example.test",
              emailVerified: true,
              id: "96aac405-c107-4776-923e-a40ca5014975",
            },
          },
        }),
      );

    await expect(requestAndReconcileEmailVerification(fetcher)).resolves.toEqual({
      kind: "accepted",
      status: "verified",
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/auth/email-verification/request",
      "/api/auth/me",
    ]);
  });

  it("keeps an accepted request truthful when the status refresh fails transiently", async () => {
    const fetcher = vi
      .fn<EmailVerificationStatusFetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ detail: "Try again later." }, { status: 503 }));

    await expect(requestAndReconcileEmailVerification(fetcher)).resolves.toEqual({
      kind: "accepted",
      status: "unknown",
    });
  });

  it("requires exact accepted and current-session statuses before reconciliation", async () => {
    const wrongAccepted = vi
      .fn<EmailVerificationStatusFetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 200 }));
    await expect(requestAndReconcileEmailVerification(wrongAccepted)).rejects.toThrow(
      /invalid verification status/u,
    );
    expect(wrongAccepted).toHaveBeenCalledOnce();

    const wrongSession = vi
      .fn<EmailVerificationStatusFetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              profile: webProfile,
              user: {
                email: "ada@example.test",
                emailVerified: true,
                id: "96aac405-c107-4776-923e-a40ca5014975",
              },
            },
          },
          { status: 201 },
        ),
      );
    await expect(requestAndReconcileEmailVerification(wrongSession)).resolves.toEqual({
      kind: "accepted",
      status: "unknown",
    });
  });

  it("confirms through a same-origin bounded body and never places the token in a URL or header", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({ data: { verified: true } });
      }),
    );
    const response = await proxyEmailVerificationConfirm(
      new Request("https://app.example.test/api/auth/email-verification/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token: verificationToken }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { verified: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/auth/email-verification/confirm");
    expect(calls[0]?.url).not.toContain(verificationToken);
    expect(JSON.stringify(calls[0]?.init?.headers)).not.toContain(verificationToken);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: verificationToken });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("preserves only the stable expired-token 410 without echoing upstream detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "EMAIL_VERIFICATION_TOKEN_EXPIRED",
            detail: `Expired token ${verificationToken}`,
          },
          { status: 410 },
        ),
      ),
    );
    const response = await proxyEmailVerificationConfirm(
      new Request("https://app.example.test/api/auth/email-verification/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token: verificationToken }),
      }),
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "EMAIL_VERIFICATION_TOKEN_EXPIRED",
      error: "This verification link has expired.",
    });
  });

  it("maps invalid-token failures to fixed copy without echoing malicious detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "EMAIL_VERIFICATION_TOKEN_INVALID",
            detail: `Invalid capability ${verificationToken}`,
          },
          { status: 400 },
        ),
      ),
    );
    const response = await proxyEmailVerificationConfirm(
      new Request("https://app.example.test/api/auth/email-verification/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token: verificationToken }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "EMAIL_VERIFICATION_TOKEN_INVALID",
      error: "This verification link is invalid or has already been used.",
    });
  });

  it("requests delivery only for an authenticated same-origin session", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({ data: { status: "accepted" } }, { status: 202 });
      }),
    );
    const request = () =>
      new Request("https://app.example.test/api/auth/email-verification/request", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
      });
    const response = await proxyEmailVerificationRequest(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { status: "accepted" } });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/auth/email-verification/request");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${sessionToken}`,
    );
    expect(calls[0]?.init?.body).toBeUndefined();

    const untrusted = await proxyEmailVerificationRequest(
      new Request("https://app.example.test/api/auth/email-verification/request", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
          origin: "https://evil.example.test",
          "sec-fetch-site": "cross-site",
        },
      }),
    );
    expect(untrusted.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("returns 502 instead of normalizing otherwise-valid wrong upstream success statuses", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { status: "accepted" } }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ data: { verified: true } }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            data: {
              profile: webProfile,
              user: {
                email: "ada@example.test",
                emailVerified: true,
                id: "96aac405-c107-4776-923e-a40ca5014975",
              },
            },
          },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", upstream);

    const requestResponse = await proxyEmailVerificationRequest(
      new Request("https://app.example.test/api/auth/email-verification/request", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
      }),
    );
    const confirmResponse = await proxyEmailVerificationConfirm(
      new Request("https://app.example.test/api/auth/email-verification/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token: verificationToken }),
      }),
    );
    const sessionResponse = await proxyCurrentSession(
      new Request("https://app.example.test/api/auth/me", {
        headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
      }),
    );

    expect([requestResponse.status, confirmResponse.status, sessionResponse.status]).toEqual([
      502, 502, 502,
    ]);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("hard-caps chunked upstream bodies on every request and confirmation path", async () => {
    const request = () =>
      new Request("https://app.example.test/api/auth/email-verification/request", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
      });
    const confirmation = () =>
      new Request("https://app.example.test/api/auth/email-verification/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token: verificationToken }),
      });
    const cases = [
      {
        expectedStatus: 502,
        operation: () => proxyEmailVerificationRequest(request()),
        upstreamStatus: 202,
      },
      {
        expectedStatus: 502,
        operation: () => proxyEmailVerificationRequest(request()),
        upstreamStatus: 503,
      },
      {
        expectedStatus: 502,
        operation: () => proxyEmailVerificationConfirm(confirmation()),
        upstreamStatus: 200,
      },
      {
        expectedStatus: 502,
        operation: () => proxyEmailVerificationConfirm(confirmation()),
        upstreamStatus: 410,
      },
      {
        expectedStatus: 503,
        operation: () => proxyEmailVerificationConfirm(confirmation()),
        upstreamStatus: 503,
      },
    ] as const;

    for (const testCase of cases) {
      const oversized = chunkedOversizedResponse(testCase.upstreamStatus);
      expect(oversized.response.headers.get("content-length")).toBeNull();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => oversized.response),
      );

      const response = await testCase.operation();

      expect(response.status).toBe(testCase.expectedStatus);
      expect(oversized.state.cancelled).toBe(true);
      expect(oversized.state.pulls).toBeLessThan(8);
    }
  });

  it("rejects malformed or cross-origin confirmation before an upstream call", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const invalid = await proxyEmailVerificationConfirm(
      new Request("https://app.example.test/api/auth/email-verification/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token: "short" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      code: "EMAIL_VERIFICATION_TOKEN_INVALID",
      error: "The verification link is invalid.",
    });

    const untrusted = await proxyEmailVerificationConfirm(
      new Request("https://app.example.test/api/auth/email-verification/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example.test",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ token: verificationToken }),
      }),
    );
    expect(untrusted.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
