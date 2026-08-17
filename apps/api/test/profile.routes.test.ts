import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  ProfileRevisionConflictServiceError,
  type ProfileService,
} from "../src/modules/profile/profile.routes.js";
import { account, bearerToken, profile, userId } from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

function authStub(): AuthService {
  return {
    reauthenticate: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    authenticate: vi.fn(async (header) =>
      header === `Bearer ${bearerToken}`
        ? { userId, account, sessionTokenHash: "a".repeat(64) }
        : null,
    ),
    authenticateErasureRecovery: vi.fn(async () => null),
    logout: vi.fn(),
  };
}

function createTestApp(profileService: ProfileService): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    authService: authStub(),
    profileService,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("profile routes", () => {
  it("reads only the authenticated profile with a strong revision ETag", async () => {
    const service: ProfileService = {
      get: vi.fn(async () => profile),
      update: vi.fn(),
    };
    const app = createTestApp(service);
    const unauthorized = await app.inject({ method: "GET", url: "/v1/profile" });
    const response = await app.inject({
      method: "GET",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}` },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(service.get).toHaveBeenCalledOnce();
    expect(service.get).toHaveBeenCalledWith(userId);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("updates using only the server-authenticated owner and current revision", async () => {
    const updated = { ...profile, displayName: "Ada Lovelace", revision: "2" };
    const service: ProfileService = {
      get: vi.fn(),
      update: vi.fn(async () => updated),
    };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { displayName: "Ada Lovelace" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(service.update).toHaveBeenCalledWith({
      userId,
      expectedRevision: "1",
      patch: { displayName: "Ada Lovelace" },
    });
  });

  it("accepts revision zero for a newly registered profile", async () => {
    const updated = { ...profile, displayName: "First edit", revision: "1" };
    const service: ProfileService = { get: vi.fn(), update: vi.fn(async () => updated) };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"0"' },
      payload: { displayName: "First edit" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: "0", userId }),
    );
  });

  it("requires a strong If-Match and maps stale writes to 412", async () => {
    const conflict = new ProfileRevisionConflictServiceError();
    const service: ProfileService = {
      get: vi.fn(),
      update: vi.fn(async () => Promise.reject(conflict)),
    };
    const app = createTestApp(service);
    const missing = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: { displayName: "Changed" },
    });
    const weak = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": 'W/"1"' },
      payload: { displayName: "Changed" },
    });
    const stale = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { displayName: "Changed" },
    });

    expect(missing.statusCode).toBe(428);
    expect(weak.statusCode).toBe(400);
    expect(stale.statusCode).toBe(412);
    expect(stale.body).not.toContain("private current profile");
  });

  it.each([
    { heightCm: "500" },
    { baselineWeightKg: "5000" },
    { birthDate: "2999-01-01" },
    { timeZone: "Not/A_Real_Zone" },
  ])("rejects profile values outside persistence constraints: %j", async (patch) => {
    const service: ProfileService = { get: vi.fn(), update: vi.fn() };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: patch,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(service.update).not.toHaveBeenCalled();
  });

  it("canonicalizes bounded exact profile decimals before persistence", async () => {
    const updated = { ...profile, heightCm: "170", baselineWeightKg: "65.5", revision: "2" };
    const service: ProfileService = {
      get: vi.fn(),
      update: vi.fn(async () => updated),
    };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { heightCm: "170.000", baselineWeightKg: "65.500" },
    });

    expect(response.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      userId,
      expectedRevision: "1",
      patch: { heightCm: "170", baselineWeightKg: "65.5" },
    });
  });
});
