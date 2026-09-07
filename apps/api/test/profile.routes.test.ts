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
    confirmEmailVerification: vi.fn(),
    confirmPasswordRecovery: vi.fn(),
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
    requestEmailVerification: vi.fn(),
    requestPasswordRecovery: vi.fn(),
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
    expect(response.json()).toMatchObject({
      data: {
        profile: {
          diaryGroups: [
            { mealSlot: "breakfast", label: "Breakfast" },
            { mealSlot: "lunch", label: "Lunch" },
            { mealSlot: "dinner", label: "Dinner" },
            { mealSlot: "snacks", label: "Snacks" },
          ],
        },
      },
    });
  });

  it("binds updates to the expected authenticated owner and strips the transport precondition", async () => {
    const updated = { ...profile, displayName: "Ada Lovelace", revision: "2" };
    const service: ProfileService = {
      get: vi.fn(),
      update: vi.fn(async () => updated),
    };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { expectedOwnerUserId: userId, displayName: "Ada Lovelace" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(service.update).toHaveBeenCalledWith({
      userId,
      expectedRevision: "1",
      patch: { displayName: "Ada Lovelace" },
    });
  });

  it("keeps legacy field patches compatible but fails group writes closed on owner changes", async () => {
    const updated = { ...profile, displayName: "Legacy edit", revision: "2" };
    const service: ProfileService = { get: vi.fn(), update: vi.fn(async () => updated) };
    const app = createTestApp(service);
    const legacy = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { displayName: "Legacy edit" },
    });
    const missingGroupOwner = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { diaryGroups: profile.diaryGroups },
    });
    const changed = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: {
        expectedOwnerUserId: "d7359103-4f83-4b37-a952-66f8e8a3eb3b",
        displayName: "Changed",
      },
    });

    expect(legacy.statusCode).toBe(200);
    expect(missingGroupOwner.statusCode).toBe(400);
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "PROFILE_OWNER_CHANGED" });
    expect(service.update).toHaveBeenCalledOnce();
    expect(service.update).toHaveBeenCalledWith({
      userId,
      expectedRevision: "1",
      patch: { displayName: "Legacy edit" },
    });
  });

  it("accepts revision zero for a newly registered profile", async () => {
    const updated = { ...profile, displayName: "First edit", revision: "1" };
    const service: ProfileService = { get: vi.fn(), update: vi.fn(async () => updated) };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"0"' },
      payload: { expectedOwnerUserId: userId, displayName: "First edit" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: "0", userId }),
    );
  });

  it("canonicalizes and preserves user-selected diary group order", async () => {
    const diaryGroups = [
      { mealSlot: "snacks" as const, label: "Small bites" },
      { mealSlot: "breakfast" as const, label: "Morning" },
      { mealSlot: "dinner" as const, label: "Evening" },
      { mealSlot: "lunch" as const, label: "Midday" },
    ];
    const updated = { ...profile, diaryGroups, revision: "2" };
    const service: ProfileService = {
      get: vi.fn(),
      update: vi.fn(async () => updated),
    };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: {
        expectedOwnerUserId: userId,
        diaryGroups: [
          { mealSlot: "snacks", label: "  Small bites " },
          { mealSlot: "breakfast", label: "Ｍｏｒｎｉｎｇ" },
          { mealSlot: "dinner", label: "Evening" },
          { mealSlot: "lunch", label: "Midday" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      userId,
      expectedRevision: "1",
      patch: { diaryGroups },
    });
  });

  it.each([
    {
      diaryGroups: [
        { mealSlot: "breakfast", label: "Morning" },
        { mealSlot: "lunch", label: "morning" },
        { mealSlot: "dinner", label: "Dinner" },
        { mealSlot: "snacks", label: "Snacks" },
      ],
    },
    {
      diaryGroups: [
        { mealSlot: "breakfast", label: "😀".repeat(31) },
        { mealSlot: "lunch", label: "Lunch" },
        { mealSlot: "dinner", label: "Dinner" },
        { mealSlot: "snacks", label: "Snacks" },
      ],
    },
    {
      diaryGroups: [
        { mealSlot: "breakfast", label: "Morn\u200bing" },
        { mealSlot: "lunch", label: "Lunch" },
        { mealSlot: "dinner", label: "Dinner" },
        { mealSlot: "snacks", label: "Snacks" },
      ],
    },
    {
      diaryGroups: [
        { mealSlot: "breakfast", label: "Breakfast" },
        { mealSlot: "lunch", label: "Lunch" },
        { mealSlot: "dinner", label: "Dinner" },
      ],
    },
  ])("rejects invalid diary group configuration: %j", async (patch) => {
    const service: ProfileService = { get: vi.fn(), update: vi.fn() };
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { expectedOwnerUserId: userId, ...patch },
    });

    expect(response.statusCode).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
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
      payload: { expectedOwnerUserId: userId, displayName: "Changed" },
    });
    const weak = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": 'W/"1"' },
      payload: { expectedOwnerUserId: userId, displayName: "Changed" },
    });
    const stale = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${bearerToken}`, "if-match": '"1"' },
      payload: { expectedOwnerUserId: userId, displayName: "Changed" },
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
      payload: { expectedOwnerUserId: userId, ...patch },
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
      payload: {
        expectedOwnerUserId: userId,
        heightCm: "170.000",
        baselineWeightKg: "65.500",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      userId,
      expectedRevision: "1",
      patch: { heightCm: "170", baselineWeightKg: "65.5" },
    });
  });
});
