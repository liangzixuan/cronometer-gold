import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyCredentials } from "../app/api/auth/proxy";
import {
  authenticatedFetch,
  clearedSessionCookie,
  confirmBrowserLogout,
  isTrustedMutationRequest,
  PRIVATE_RESPONSE_HEADERS,
  readSessionToken,
  SESSION_COOKIE,
  safeUpstreamProblem,
  sessionCookie,
} from "./private-api";

const token = "t".repeat(43);
const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

function profile() {
  return {
    displayName: "Ada",
    birthDate: null,
    sexAtBirth: null,
    heightCm: null,
    baselineWeightKg: null,
    activityLevelCode: null,
    locale: "en-US",
    timeZone: "America/Chicago",
    unitSystem: "metric",
    onboardingCompletedAt: null,
    revision: "0",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private web API boundary", () => {
  it("requires a matching Origin for state-changing requests", () => {
    expect(
      isTrustedMutationRequest(
        new Request("https://app.example.test/api/diary/entries", {
          method: "POST",
          headers: { origin: "https://app.example.test", "sec-fetch-site": "same-origin" },
        }),
      ),
    ).toBe(true);
    expect(
      isTrustedMutationRequest(
        new Request("https://app.example.test/api/diary/entries", {
          method: "POST",
          headers: { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toBe(false);
    expect(
      isTrustedMutationRequest(
        new Request("https://app.example.test/api/diary/entries", {
          method: "POST",
          headers: {
            origin: "https://evil.example.test",
            "sec-fetch-site": "same-origin",
            "x-forwarded-host": "evil.example.test",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isTrustedMutationRequest(
        new Request("https://app.example.test/api/diary/entries", { method: "POST" }),
      ),
    ).toBe(false);
  });

  it("fails closed without a pinned public origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_PUBLIC_ORIGIN", "");
    expect(
      isTrustedMutationRequest(
        new Request("https://app.example.test/api/diary/entries", {
          method: "POST",
          headers: { origin: "https://app.example.test", "sec-fetch-site": "same-origin" },
        }),
      ),
    ).toBe(false);

    vi.stubEnv("WEB_PUBLIC_ORIGIN", "https://app.example.test");
    expect(
      isTrustedMutationRequest(
        new Request("https://untrusted-host.invalid/api/diary/entries", {
          method: "POST",
          headers: { origin: "https://app.example.test", "sec-fetch-site": "same-origin" },
        }),
      ),
    ).toBe(true);
  });

  it("keeps bearer credentials in a host-only secure cookie", () => {
    const setCookie = sessionCookie(token, expiresAt);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");
    expect(
      readSessionToken(new Request("https://app.example.test", { headers: { cookie: setCookie } })),
    ).toBe(token);
    expect(clearedSessionCookie()).toContain("Max-Age=0");
    expect(PRIVATE_RESPONSE_HEADERS["cache-control"]).toContain("no-store");
  });

  it("refuses redirects on authenticated upstream requests", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://127.0.0.1:4000");
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.href).toBe("http://127.0.0.1:4000/v1/auth/me");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ data: { status: "ok" } });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await authenticatedFetch(
      new Request("https://app.example.test/api/auth/me", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
      "/v1/auth/me",
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("expires malformed or rejected session cookies instead of trapping login navigation", async () => {
    const missing = await authenticatedFetch(
      new Request("https://app.example.test/api/auth/me", {
        headers: { cookie: `${SESSION_COOKIE}=malformed` },
      }),
      "/v1/auth/me",
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get("set-cookie")).toContain("Max-Age=0");

    const rejected = await safeUpstreamProblem(
      Response.json({ detail: "Authentication expired.", code: "UNAUTHORIZED" }, { status: 401 }),
      "Sign in to continue.",
    );
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("does not leave the diary after an unconfirmed browser logout", async () => {
    const confirmed = vi.fn();
    expect(
      await confirmBrowserLogout(async () => Promise.reject(new Error("offline")), confirmed),
    ).toBe(false);
    expect(
      await confirmBrowserLogout(async () => new Response(null, { status: 503 }), confirmed),
    ).toBe(false);
    expect(confirmed).not.toHaveBeenCalled();

    expect(
      await confirmBrowserLogout(async () => new Response(null, { status: 204 }), confirmed),
    ).toBe(true);
    expect(confirmed).toHaveBeenCalledOnce();
  });

  it("forwards registration time zone but strips the bearer token from page JSON", async () => {
    let upstreamBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        upstreamBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json(
          {
            data: {
              accessToken: token,
              expiresAt,
              user: {
                id: "96aac405-c107-4776-923e-a40ca5014975",
                email: "ada@example.test",
                emailVerified: false,
              },
              profile: profile(),
            },
          },
          { status: 201 },
        );
      }),
    );
    const response = await proxyCredentials(
      new Request("https://app.example.test/api/auth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          email: "ada@example.test",
          password: "correct horse battery staple",
          timeZone: "America/Chicago",
          displayName: "Ada",
        }),
      }),
      "register",
    );
    expect(response.status).toBe(201);
    expect(upstreamBody).toEqual({
      email: "ada@example.test",
      password: "correct horse battery staple",
      timeZone: "America/Chicago",
      displayName: "Ada",
    });
    expect(response.headers.get("set-cookie")).toContain(token);
    const browserBody = JSON.stringify(await response.json());
    expect(browserBody).not.toContain(token);
    expect(browserBody).not.toContain("accessToken");
  });
});
