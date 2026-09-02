import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  AuthRateLimitedError,
  type AuthService,
  EmailVerificationTokenExpiredError,
  EmailVerificationTokenInvalidError,
  InvalidCredentialsError,
  PasswordRecoveryTokenExpiredError,
  PasswordRecoveryTokenInvalidError,
} from "../src/modules/auth/auth-service.js";
import { account, bearerToken, profile, userId } from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

function authStub(overrides: Partial<AuthService> = {}): AuthService {
  return {
    confirmEmailVerification: vi.fn(async () => ({ data: { verified: true as const } })),
    confirmPasswordRecovery: vi.fn(async () => ({ data: { passwordReset: true as const } })),
    reauthenticate: vi.fn(async () => ({
      data: {
        expiresAt: "2026-08-15T00:10:00.000Z",
        reauthenticationToken: "r".repeat(43),
      },
    })),
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
      header === `Bearer ${bearerToken}`
        ? { userId, account, sessionTokenHash: "a".repeat(64) }
        : null,
    ),
    authenticateErasureRecovery: vi.fn(async () => null),
    logout: vi.fn(async () => undefined),
    requestEmailVerification: vi.fn(async () => ({ data: { status: "accepted" as const } })),
    requestPasswordRecovery: vi.fn(async () => ({ data: { status: "accepted" as const } })),
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

  it("declares the safe 401 returned when registration loses the credential race", async () => {
    const service = authStub({
      register: vi.fn(async () => Promise.reject(new InvalidCredentialsError())),
    });
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: "ada@example.com",
        password: "correct horse battery staple",
        timeZone: "America/Chicago",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      code: "UNAUTHORIZED",
      detail: "Email or password is incorrect.",
    });
    expect(response.body).not.toContain(bearerToken);
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

  it("accepts an authenticated verification request without accepting request fields", async () => {
    const service = authStub();
    const app = createTestApp(service);
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/auth/email-verification/request",
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/auth/email-verification/request",
    });
    const unexpectedBodies = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/request",
        headers: { authorization: `Bearer ${bearerToken}` },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/request",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        payload: "null",
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/request",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        payload: "7",
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/request",
        headers: { authorization: `Bearer ${bearerToken}` },
        payload: { email: "other@example.com" },
      }),
    ]);

    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(accepted.json()).toEqual({ data: { status: "accepted" } });
    expect(service.requestEmailVerification).toHaveBeenCalledWith(account);
    expect(unauthorized.statusCode).toBe(401);
    expect(unexpectedBodies.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    expect(service.requestEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("confirms a public fragment token without requiring a bearer session", async () => {
    const service = authStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/auth/email-verification/confirm",
      payload: { token: `${"v".repeat(42)}A` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ data: { verified: true } });
    expect(service.confirmEmailVerification).toHaveBeenCalledWith(
      `${"v".repeat(42)}A`,
      expect.any(String),
    );
  });

  it.each([
    [new EmailVerificationTokenInvalidError(), 400, "EMAIL_VERIFICATION_TOKEN_INVALID"],
    [new EmailVerificationTokenExpiredError(), 410, "EMAIL_VERIFICATION_TOKEN_EXPIRED"],
  ] as const)(
    "maps verification failure without echoing the token",
    async (error, status, code) => {
      const token = `${"q".repeat(42)}A`;
      const response = await createTestApp(
        authStub({ confirmEmailVerification: vi.fn(async () => Promise.reject(error)) }),
      ).inject({
        method: "POST",
        url: "/v1/auth/email-verification/confirm",
        payload: { token },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain(token);
    },
  );

  it("returns the same public recovery acknowledgement without authentication", async () => {
    const privateEmail = "private.person@example.com";
    const service = authStub();
    const app = createTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password-recovery/request",
      payload: { email: privateEmail },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ data: { status: "accepted" } });
    expect(response.body).not.toContain(privateEmail);
    expect(service.requestPasswordRecovery).toHaveBeenCalledWith(privateEmail);

    const unexpected = await app.inject({
      method: "POST",
      url: "/v1/auth/password-recovery/request?source=private",
      payload: { email: privateEmail, accountId: userId },
    });
    expect(unexpected.statusCode).toBe(400);
    expect(service.requestPasswordRecovery).toHaveBeenCalledTimes(1);
  });

  it("confirms recovery without creating or returning a session", async () => {
    const service = authStub();
    const token = `${"r".repeat(42)}A`;
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/auth/password-recovery/confirm",
      payload: { token, newPassword: "a new correct horse battery staple" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ data: { passwordReset: true } });
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain("accessToken");
    expect(service.confirmPasswordRecovery).toHaveBeenCalledWith(
      token,
      "a new correct horse battery staple",
      expect.any(String),
    );
  });

  it.each([
    [new PasswordRecoveryTokenInvalidError(), 400, "PASSWORD_RECOVERY_TOKEN_INVALID"],
    [new PasswordRecoveryTokenExpiredError(), 410, "PASSWORD_RECOVERY_TOKEN_EXPIRED"],
  ] as const)(
    "maps recovery failure without echoing the capability",
    async (error, status, code) => {
      const token = `${"s".repeat(42)}A`;
      const response = await createTestApp(
        authStub({ confirmPasswordRecovery: vi.fn(async () => Promise.reject(error)) }),
      ).inject({
        method: "POST",
        url: "/v1/auth/password-recovery/confirm",
        payload: { token, newPassword: "a new correct horse battery staple" },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain(token);
    },
  );

  it("rejects malformed recovery bodies before service invocation", async () => {
    const service = authStub();
    const app = createTestApp(service);
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/request",
        payload: { email: "not-an-email" },
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/confirm",
        payload: { token: "too-short", newPassword: "a new correct horse battery staple" },
      }),
      app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/confirm",
        payload: {
          token: `${"t".repeat(42)}A`,
          newPassword: "a new correct horse battery staple",
          email: "private@example.com",
        },
      }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400]);
    expect(service.requestPasswordRecovery).not.toHaveBeenCalled();
    expect(service.confirmPasswordRecovery).not.toHaveBeenCalled();
  });
});
