import {
  HOSTED_DEVELOPMENT_API_ORIGIN,
  HOSTED_DEVELOPMENT_PROFILE,
  HOSTED_DEVELOPMENT_WEB_ORIGIN,
  webCredentialCookieName,
} from "@nutrition-tracker/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyCredentials, proxyLogout } from "../app/api/auth/proxy";
import { proxyFoodGet } from "../app/api/foods/proxy";
import { proxyRetentionRequest } from "../app/api/retention/proxy";
import { resolveInternalApiBase } from "./food-search";
import {
  authenticatedFetch,
  credentialCookieName,
  isTrustedMutationRequest,
  readSessionToken,
  resolvePrivateApiBase,
  SESSION_COOKIE,
  sessionCookie,
} from "./private-api";

const token = "t".repeat(43);
const recent = "r".repeat(43);
const capability = "s".repeat(43);
const operation = "61eec75e-fe16-47e4-9f7b-efb6914ad9dc";
const job = "318f6f58-4e2c-7b62-8f0b-3d75491713b5";
const pendingName = "__Secure-nutrition_erasure_pending";
const statusName = "__Secure-nutrition_erasure_status";
function request(path: string, options: RequestInit = {}) {
  return new Request(HOSTED_DEVELOPMENT_WEB_ORIGIN + path, {
    ...options,
    headers: {
      origin: HOSTED_DEVELOPMENT_WEB_ORIGIN,
      "sec-fetch-site": "same-origin",
      ...options.headers,
    },
  });
}
beforeEach(() => {
  vi.stubEnv("NOURISHING_WEB_PROFILE", HOSTED_DEVELOPMENT_PROFILE);
  vi.stubEnv("API_INTERNAL_URL", HOSTED_DEVELOPMENT_API_ORIGIN);
  vi.stubEnv("WEB_PUBLIC_ORIGIN", HOSTED_DEVELOPMENT_WEB_ORIGIN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hosted development BFF isolation", () => {
  it.each([
    undefined,
    "",
    "http://127.0.0.1:4000",
    "https://api.nourishing.app",
    "https://other.example.test",
  ])("has no origin fallback for %s", async (value) => {
    vi.stubEnv("API_INTERNAL_URL", value);
    expect(() => resolvePrivateApiBase(value)).toThrow(TypeError);
    expect(() => resolveInternalApiBase(value)).toThrow(TypeError);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await authenticatedFetch(
      request("/api/auth/me", {
        headers: { cookie: credentialCookieName(SESSION_COOKIE) + "=" + token },
      }),
      "/v1/auth/me",
    );
    expect(response.status).toBe(503);
    expect(
      (
        await proxyFoodGet({
          request: request("/api/foods/search"),
          upstreamPath: "/v1/foods/search",
          allowedQueryFields: [],
          parser: (body) => body,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await proxyRetentionRequest(
          request("/api/retention/account/erasure/status", {
            headers: {
              cookie:
                credentialCookieName(statusName) +
                "=" +
                job +
                "." +
                capability +
                "." +
                (Date.now() + 600_000),
            },
          }),
          ["account", "erasure", "status"],
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await proxyRetentionRequest(
          request("/api/retention/account/erasure/submit", {
            method: "POST",
            headers: {
              cookie:
                credentialCookieName(SESSION_COOKIE) +
                "=" +
                token +
                "; " +
                credentialCookieName(pendingName) +
                "=" +
                operation +
                "." +
                recent +
                "." +
                Date.now(),
            },
          }),
          ["account", "erasure", "submit"],
        )
      ).status,
    ).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("pins the local HTTPS mutation origin", () => {
    expect(isTrustedMutationRequest(request("/api/auth/login", { method: "POST" }))).toBe(true);
    expect(
      isTrustedMutationRequest(
        request("/api/auth/login", {
          method: "POST",
          headers: { origin: "https://other.example.test" },
        }),
      ),
    ).toBe(false);
    vi.stubEnv("WEB_PUBLIC_ORIGIN", "");
    expect(isTrustedMutationRequest(request("/api/auth/login", { method: "POST" }))).toBe(false);
  });
  it("does not forward a valid earlier session to the selected development API", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const stale = request("/api/auth/me", { headers: { cookie: SESSION_COOKIE + "=" + token } });
    expect(readSessionToken(stale)).toBeNull();
    expect((await authenticatedFetch(stale, "/v1/auth/me")).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const issued = sessionCookie(token, new Date(Date.now() + 600_000).toISOString());
    expect(issued.startsWith(credentialCookieName(SESSION_COOKIE) + "=")).toBe(true);
    expect(issued).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(issued).not.toContain("Domain=");
    expect(readSessionToken(request("/api/auth/me", { headers: { cookie: issued } }))).toBe(token);
  });
  it("does not forward valid prior erasure envelopes or capabilities", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const status = await proxyRetentionRequest(
      request("/api/retention/account/erasure/status", {
        headers: {
          cookie: statusName + "=" + job + "." + capability + "." + (Date.now() + 600_000),
        },
      }),
      ["account", "erasure", "status"],
    );
    const submit = await proxyRetentionRequest(
      request("/api/retention/account/erasure/submit", {
        method: "POST",
        headers: {
          cookie:
            credentialCookieName(SESSION_COOKIE) +
            "=" +
            token +
            "; " +
            pendingName +
            "=" +
            operation +
            "." +
            recent +
            "." +
            Date.now(),
        },
      }),
      ["account", "erasure", "submit"],
    );
    expect(status.status).toBe(401);
    expect(submit.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("issues origin-bound pending erasure cookies without sending their secret to an upstream", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await proxyRetentionRequest(
      request("/api/retention/account/erasure/stage", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": operation,
          "x-reauthentication-token": recent,
        },
        body: '{"confirmation":"DELETE_MY_ACCOUNT"}',
      }),
      ["account", "erasure", "stage"],
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(credentialCookieName(pendingName) + "=");
    expect(JSON.stringify(await response.json())).not.toContain(recent);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses redirected login, logout, search and erasure capability requests", async () => {
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.origin).toBe(HOSTED_DEVELOPMENT_API_ORIGIN);
      expect(init?.redirect).toBe("error");
      throw new TypeError("synthetic redirect blocked");
    });
    vi.stubGlobal("fetch", fetcher);
    const login = await proxyCredentials(
      request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "test@example.test", password: "synthetic-password" }),
      }),
      "login",
    );
    const logout = await proxyLogout(
      request("/api/auth/logout", {
        method: "POST",
        headers: { cookie: credentialCookieName(SESSION_COOKIE) + "=" + token },
      }),
    );
    const foods = await proxyFoodGet({
      request: request("/api/foods/search"),
      upstreamPath: "/v1/foods/search",
      allowedQueryFields: [],
      parser: (value) => value,
    });
    const status = await proxyRetentionRequest(
      request("/api/retention/account/erasure/status", {
        headers: {
          cookie:
            credentialCookieName(statusName) +
            "=" +
            job +
            "." +
            capability +
            "." +
            (Date.now() + 600_000),
        },
      }),
      ["account", "erasure", "status"],
    );
    expect(login.status).toBe(503);
    expect(logout.status).toBe(204);
    expect(foods.status).toBe(503);
    expect(status.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("rejects cookies from the development origin after returning to the local profile", async () => {
    const cookies = [
      webCredentialCookieName(SESSION_COOKIE, HOSTED_DEVELOPMENT_PROFILE) + "=" + token,
      webCredentialCookieName(statusName, HOSTED_DEVELOPMENT_PROFILE) +
        "=" +
        job +
        "." +
        capability +
        "." +
        (Date.now() + 600_000),
      webCredentialCookieName(pendingName, HOSTED_DEVELOPMENT_PROFILE) +
        "=" +
        operation +
        "." +
        recent +
        "." +
        Date.now(),
    ].join("; ");
    vi.stubEnv("NOURISHING_WEB_PROFILE", undefined);
    vi.stubEnv("API_INTERNAL_URL", "http://127.0.0.1:4000");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (
        await authenticatedFetch(
          request("/api/auth/me", { headers: { cookie: cookies } }),
          "/v1/auth/me",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await proxyRetentionRequest(
          request("/api/retention/account/erasure/status", { headers: { cookie: cookies } }),
          ["account", "erasure", "status"],
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await proxyRetentionRequest(
          request("/api/retention/account/erasure/submit", {
            method: "POST",
            headers: { cookie: cookies },
          }),
          ["account", "erasure", "submit"],
        )
      ).status,
    ).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
