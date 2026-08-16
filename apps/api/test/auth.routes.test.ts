import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  AuthRateLimitedError,
  type AuthService,
  InvalidCredentialsError,
} from "../src/modules/auth/auth-service.js";
import { account, bearerToken, profile, userId } from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

function authStub(overrides: Partial<AuthService> = {}): AuthService {
  return {
    register: vi.fn(async () => ({
      data: {
        accessToken: bearerToken,
        expiresAt: "2026-09-15T00:00:00.000Z",
        ...account,
      },
    })),
    login: vi.fn(async () => ({
      data: {
        accessToken: bearerToken,
        expiresAt: "2026-09-15T00:00:00.000Z",
        ...account,
      },
    })),
    authenticate: vi.fn(async (header) =>
      header === `Bearer ${bearerToken}` ? { userId, account } : null,
    ),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createTestApp(authService?: AuthService): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    ...(authService ? { authService } : {}),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("account routes", () => {
  it("registers with a required profile time zone and returns a no-store session", async () => {
    const service = authStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "Ada@Example.com",
        password: "correct horse battery staple",
        timeZone: "America/Chicago",
        displayName: "Ada",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ data: { accessToken: bearerToken, profile } });
    expect(service.register).toHaveBeenCalledOnce();
  });

  it("uses the same safe 401 for unknown accounts and wrong passwords", async () => {
    const app = createTestApp(
      authStub({ login: vi.fn(async () => Promise.reject(new InvalidCredentialsError())) }),
    );
    const responses = await Promise.all(
      ["unknown@example.com", "ada@example.com"].map((email) =>
        app.inject({
          method: "POST",
          url: "/v1/auth/login",
          payload: { email, password: "incorrect password value" },
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([401, 401]);
    expect(responses[0]?.json()).toMatchObject({
      code: "UNAUTHORIZED",
      detail: "Email or password is incorrect.",
    });
    expect(responses[1]?.json()).toMatchObject({
      code: "UNAUTHORIZED",
      detail: "Email or password is incorrect.",
    });
  });

  it("returns a stable 429 without exposing limiter keys", async () => {
    const privateEmail = "private@example.com";
    const app = createTestApp(
      authStub({ login: vi.fn(async () => Promise.reject(new AuthRateLimitedError())) }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: privateEmail, password: "incorrect password value" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.body).not.toContain(privateEmail);
    expect(response.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("requires a valid opaque bearer session for me and logout", async () => {
    const service = authStub();
    const app = createTestApp(service);
    const unauthorized = await app.inject({ method: "GET", url: "/v1/auth/me" });
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${bearerToken}` },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toBe('Bearer realm="nutrition-api"');
    expect(unauthorized.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(me.json()).toEqual({ data: account });
    expect(logout.statusCode).toBe(204);
    expect(logout.body).toBe("");
    expect(logout.headers["cache-control"]).toBe("no-store");
    expect(service.logout).toHaveBeenCalledWith(`Bearer ${bearerToken}`, userId);
  });

  it("fails safely when account persistence is not wired", async () => {
    const response = await createTestApp().inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "ada@example.com", password: "incorrect password value" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "SERVICE_NOT_READY" });
  });

  it("rejects unexpected credential fields without forwarding them", async () => {
    const service = authStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email: "ada@example.com",
        password: "incorrect password value",
        analyticsLabel: "private-health-segment",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("private-health-segment");
    expect(service.login).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only or oversized UTF-8 display names before persistence", async () => {
    const service = authStub({
      register: vi.fn(async (input) => {
        if (
          input.displayName?.trim().length === 0 ||
          (input.displayName !== undefined && Buffer.byteLength(input.displayName, "utf8") > 300)
        ) {
          throw new RangeError("private display value");
        }
        return {
          data: {
            accessToken: bearerToken,
            expiresAt: "2026-09-15T00:00:00.000Z",
            ...account,
          },
        };
      }),
    });
    const app = createTestApp(service);
    const whitespace = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "ada@example.com",
        password: "correct horse battery staple",
        timeZone: "America/Chicago",
        displayName: "   ",
      },
    });
    const oversized = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "ada@example.com",
        password: "correct horse battery staple",
        timeZone: "America/Chicago",
        displayName: "🫐".repeat(76),
      },
    });

    expect(whitespace.statusCode).toBe(400);
    expect(whitespace.body).not.toContain("private display value");
    expect(oversized.statusCode).toBe(400);
  });
});
