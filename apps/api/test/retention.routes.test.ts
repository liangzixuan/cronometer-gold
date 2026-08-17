import { createHash } from "node:crypto";
import {
  type AccountErasureMutationResponse,
  type AccountErasureResponse,
  type AccountExportResponse,
  canonicalJson,
  type DiaryMutationResponse,
  type HealthImportBatchResponse,
  healthImportSignaturePayload,
  type NutrientTrendResponse,
  type ReminderMutationResponse,
} from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  RetentionDeviceAuthenticationServiceError,
  RetentionExportInProgressServiceError,
  type RetentionService,
} from "../src/modules/retention/retention.routes.js";
import { account, bearerToken, diaryEntry, operationId, userId } from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const entryId = diaryEntry.id;
const deviceId = "30000000-0000-4000-8000-000000000003";
const batchId = "40000000-0000-4000-8000-000000000004";
const exportId = "50000000-0000-4000-8000-000000000005";
const erasureId = "51000000-0000-4000-8000-000000000005";
const now = "2026-08-16T12:00:00.000Z";
const sessionTokenHash = "a".repeat(64);

function authStub(): AuthService {
  return {
    reauthenticate: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    authenticate: vi.fn(async (header) =>
      header === `Bearer ${bearerToken}` ? { userId, account, sessionTokenHash } : null,
    ),
    authenticateErasureRecovery: vi.fn(async () => null),
    logout: vi.fn(),
  };
}

function retentionStub(overrides: Partial<RetentionService>): RetentionService {
  return new Proxy(overrides as Record<string, unknown>, {
    get(target, property) {
      if (typeof property === "string" && property in target) return target[property];
      return vi.fn(async () =>
        Promise.reject(new Error(`unexpected service call: ${String(property)}`)),
      );
    },
  }) as unknown as RetentionService;
}

function createTestApp(service: RetentionService, authService: AuthService = authStub()) {
  const app = buildApp({
    authService,
    config: testConfig,
    logger: false,
    retentionService: service,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

const authHeaders = { authorization: `Bearer ${bearerToken}` };

const aggregate = {
  nutrientId: "1",
  code: "energy",
  name: "Energy",
  unit: "kcal",
  knownAmount: "123.45",
  completeness: "partial" as const,
  isExact: false,
  contributorCount: 2,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 1,
  unknownReasonCounts: { not_reported: 1, not_analyzed: 0, not_applicable: 0, withheld: 0 },
};

const trend: NutrientTrendResponse = {
  data: {
    nutrient: { id: "1", code: "energy", name: "Energy", unit: "kcal" },
    timeZone: "America/Chicago",
    from: "2026-08-16",
    to: "2026-08-16",
    bucket: "day",
    watermarkRevision: "3",
    points: [
      {
        localDate: "2026-08-16",
        startsAt: "2026-08-16T05:00:00.000Z",
        endsAt: "2026-08-17T05:00:00.000Z",
        aggregate,
      },
    ],
  },
};

describe("retention routes", () => {
  it("authenticates and returns exact timezone-correct nutrient trends without caching", async () => {
    const nutrientTrend = vi.fn(async () => trend);
    const app = createTestApp(retentionStub({ nutrientTrend }));
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/trends/nutrients?nutrientId=1&from=2026-08-16&to=2026-08-16",
        })
      ).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/v1/trends/nutrients?nutrientId=1&from=2026-08-16&to=2026-08-16",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(trend);
    expect(nutrientTrend).toHaveBeenCalledWith(
      expect.objectContaining({ userId, nutrientId: "1", from: "2026-08-16", to: "2026-08-16" }),
    );
  });

  it("bounds trend windows and rejects unexpected query keys", async () => {
    const app = createTestApp(retentionStub({ nutrientTrend: vi.fn(async () => trend) }));
    const tooLong = await app.inject({
      method: "GET",
      url: "/v1/trends/nutrients?nutrientId=1&from=2025-01-01&to=2026-08-16",
      headers: authHeaders,
    });
    expect(tooLong.statusCode).toBe(422);
    const unexpected = await app.inject({
      method: "GET",
      url: "/v1/reminders?include=private",
      headers: authHeaders,
    });
    expect(unexpected.statusCode).toBe(400);
    expect(unexpected.body).not.toContain("private");
  });

  it("repeats the exact source revision while deriving destination coordinates server-side", async () => {
    const repeated: DiaryMutationResponse = {
      data: {
        replayed: false,
        entry: { ...diaryEntry, id: "60000000-0000-4000-8000-000000000006", revision: "1" },
        affectedDays: [{ localDate: "2026-08-16", revision: "4" }],
      },
    };
    const repeatEntry = vi.fn(async () => repeated);
    const app = createTestApp(retentionStub({ repeatEntry }));
    const response = await app.inject({
      method: "POST",
      url: `/v1/diary/entries/${entryId}/repeat`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload: { occurredAt: now, mealSlot: "dinner" },
    });
    expect(response.statusCode).toBe(201);
    expect(repeatEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        sourceEntryId: entryId,
        expectedSourceRevision: "3",
        clientOperationId: operationId,
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    const authoredCoordinates = await app.inject({
      method: "POST",
      url: `/v1/diary/entries/${entryId}/repeat`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload: { occurredAt: now, localDate: "2026-08-16" },
    });
    expect(authoredCoordinates.statusCode).toBe(400);
  });

  it("fails closed if reminder delivery content contains a private label", async () => {
    const baseReminder = {
      id: "70000000-0000-4000-8000-000000000007",
      revision: "1",
      status: "active" as const,
      label: "Weigh myself",
      localTime: "08:00",
      daysOfWeek: [1],
      timeZone: "America/Chicago",
      channel: "local" as const,
      consent: { policyVersion: "local-reminders-v1" as const, grantedAt: now, revokedAt: null },
      deliveryPolicy: {
        title: "Nutrition Tracker" as const,
        lockScreenText: "Time to check in." as const,
        includesHealthDetails: false as const,
      },
      createdAt: now,
      updatedAt: now,
    };
    const valid: ReminderMutationResponse = { data: { replayed: false, reminder: baseReminder } };
    const app = createTestApp(
      retentionStub({
        createReminder: vi
          .fn()
          .mockResolvedValueOnce(valid)
          .mockResolvedValueOnce({
            data: {
              replayed: false,
              reminder: {
                ...baseReminder,
                deliveryPolicy: {
                  ...baseReminder.deliveryPolicy,
                  lockScreenText: baseReminder.label,
                },
              },
            },
          }),
      }),
    );
    const payload = {
      label: baseReminder.label,
      localTime: "08:00",
      daysOfWeek: [1],
      timeZone: "America/Chicago",
      channel: "local",
      consentGranted: true,
    };
    const good = await app.inject({
      method: "POST",
      url: "/v1/reminders",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload,
    });
    expect(good.statusCode).toBe(201);
    const bad = await app.inject({
      method: "POST",
      url: "/v1/reminders",
      headers: {
        ...authHeaders,
        "idempotency-key": "80000000-0000-4000-8000-000000000008",
      },
      payload,
    });
    expect(bad.statusCode).toBe(503);
    expect(bad.body).not.toContain(baseReminder.label);
  });

  it("binds a signed empty health batch to device, platform, cursor transition, and canonical body", async () => {
    const result: HealthImportBatchResponse = {
      data: { replayed: false, accepted: 0, deleted: 0, duplicates: 0, conflicts: [] },
    };
    const importPlatformHealth = vi.fn(
      async (_input: Parameters<RetentionService["importPlatformHealth"]>[0]) => result,
    );
    const app = buildApp({
      authService: authStub(),
      config: testConfig,
      logger: false,
      retentionService: retentionStub({ importPlatformHealth }),
      retentionClock: () => new Date(now),
    });
    apps.push(app);
    const payload = {
      deviceId,
      batchId,
      platform: "apple_healthkit",
      cursorEpoch: "1",
      sourceCursor: null,
      nextSourceCursor: "next-anchor-digest",
      records: [],
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/imports",
      headers: {
        ...authHeaders,
        "x-device-timestamp": now,
        "x-device-nonce": "n".repeat(22),
        "x-device-signature": "s".repeat(86),
      },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(importPlatformHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        clientOperationId: batchId,
        request: expect.objectContaining({ cursorEpoch: "1" }),
        canonicalSignaturePayload: healthImportSignaturePayload({
          deviceId,
          platform: "apple_healthkit",
          batchId,
          signedAt: now,
          nonce: "n".repeat(22),
          bodySha256: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
        }),
      }),
    );
    const missingEpoch = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/imports",
      headers: {
        ...authHeaders,
        "x-device-timestamp": now,
        "x-device-nonce": "n".repeat(22),
        "x-device-signature": "s".repeat(86),
      },
      payload: { ...payload, cursorEpoch: undefined },
    });
    expect(missingEpoch.statusCode).toBe(400);
    const outOfRangeEpoch = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/imports",
      headers: {
        ...authHeaders,
        "x-device-timestamp": now,
        "x-device-nonce": "n".repeat(22),
        "x-device-signature": "s".repeat(86),
      },
      payload: { ...payload, cursorEpoch: "9223372036854775808" },
    });
    expect(outOfRangeEpoch.statusCode).toBe(400);
    const nextEpoch = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/imports",
      headers: {
        ...authHeaders,
        "x-device-timestamp": now,
        "x-device-nonce": "n".repeat(22),
        "x-device-signature": "s".repeat(86),
      },
      payload: { ...payload, cursorEpoch: "2" },
    });
    expect(nextEpoch.statusCode).toBe(201);
    const firstFrame = importPlatformHealth.mock.calls[0]?.[0].canonicalSignaturePayload;
    const nextEpochFrame = importPlatformHealth.mock.calls[1]?.[0].canonicalSignaturePayload;
    expect(firstFrame).toBeTypeOf("string");
    expect(nextEpochFrame).toBeTypeOf("string");
    expect(nextEpochFrame).not.toBe(firstFrame);
    const reusedCursor = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/imports",
      headers: {
        ...authHeaders,
        "x-device-timestamp": now,
        "x-device-nonce": "n".repeat(22),
        "x-device-signature": "s".repeat(86),
      },
      payload: { ...payload, sourceCursor: "next-anchor-digest" },
    });
    expect(reusedCursor.statusCode).toBe(409);
  });

  it("lets the verified service recover an exact committed import after the timestamp window but rejects stale first use", async () => {
    const importPlatformHealth = vi.fn(
      async (input: Parameters<RetentionService["importPlatformHealth"]>[0]) => {
        // This stands in for the service ordering invariant: verify the registered-key
        // signature, look up the exact envelope, then apply freshness to first use only.
        if (input.request.batchId === batchId && input.timestampFresh === false) {
          return {
            data: { replayed: true, accepted: 0, deleted: 0, duplicates: 0, conflicts: [] },
          };
        }
        throw new RetentionDeviceAuthenticationServiceError();
      },
    );
    const app = buildApp({
      authService: authStub(),
      config: testConfig,
      logger: false,
      retentionService: retentionStub({ importPlatformHealth }),
      retentionClock: () => new Date("2026-08-16T12:10:01.000Z"),
    });
    apps.push(app);
    const headers = {
      ...authHeaders,
      "x-device-timestamp": now,
      "x-device-nonce": "n".repeat(22),
      "x-device-signature": "s".repeat(86),
    };
    const basePayload = {
      deviceId,
      batchId,
      platform: "apple_healthkit",
      cursorEpoch: "1",
      sourceCursor: null,
      nextSourceCursor: "next-anchor-digest",
      records: [],
    };

    const exactReplay = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/imports",
      headers,
      payload: basePayload,
    });
    expect(exactReplay.statusCode).toBe(200);
    expect(exactReplay.json()).toMatchObject({ data: { replayed: true } });
    expect(importPlatformHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ timestampFresh: false }),
    );

    const firstUse = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/imports",
      headers,
      payload: {
        ...basePayload,
        batchId: "41000000-0000-4000-8000-000000000004",
      },
    });
    expect(firstUse.statusCode).toBe(401);
    expect(firstUse.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rebinds a connected integration to an explicit active device and starts a null cursor epoch", async () => {
    const rebindPlatformIntegration = vi.fn(async () => ({
      data: {
        replayed: false,
        integration: {
          platform: "apple_healthkit" as const,
          deviceId,
          cursorEpoch: "2",
          revision: "2",
          status: "connected" as const,
          dataTypeCodes: ["body_weight"] as const,
          consentGrantedAt: now,
          disconnectedAt: null,
          lastImportAt: null,
          currentSourceCursor: null,
          consentHistory: [
            {
              id: erasureId,
              dataTypeCodes: ["body_weight"] as const,
              status: "granted" as const,
              recordedAt: now,
            },
          ],
        },
      },
    }));
    const app = createTestApp(retentionStub({ rebindPlatformIntegration }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/health/apple_healthkit/rebind",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"1"',
      },
      payload: { deviceId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(response.json()).toMatchObject({
      data: { integration: { deviceId, cursorEpoch: "2", currentSourceCursor: null } },
    });
    expect(rebindPlatformIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        platform: "apple_healthkit",
        expectedRevision: "1",
        request: { deviceId },
      }),
    );
  });

  it("requires a session-bound recent-auth proof for an idempotent export request", async () => {
    const queued: AccountExportResponse = {
      data: {
        replayed: false,
        export: {
          id: exportId,
          status: "queued",
          formats: ["json", "csv"],
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          expiresAt: null,
          artifacts: [],
          manifestSha256: null,
          reconciliation: null,
          failureCode: null,
        },
      },
    };
    const createExport = vi
      .fn()
      .mockResolvedValueOnce(queued)
      .mockResolvedValueOnce({ data: { ...queued.data, replayed: true } });
    const app = createTestApp(retentionStub({ createExport }));
    const missingProof = await app.inject({
      method: "POST",
      url: "/v1/exports",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: { formats: ["json", "csv"] },
    });
    expect(missingProof.statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "x-reauthentication-token": "r".repeat(43),
      },
      payload: { formats: ["json", "csv"] },
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(createExport).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        sessionTokenHash,
        reauthenticationToken: "r".repeat(43),
        clientOperationId: operationId,
      }),
    );
    const replay = await app.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "x-reauthentication-token": "r".repeat(43),
      },
      payload: { formats: ["json", "csv"] },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ data: { replayed: true } });
  });

  it("rate-limits a distinct export while one account export remains active", async () => {
    const app = createTestApp(
      retentionStub({
        createExport: vi.fn(async () => {
          throw new RetentionExportInProgressServiceError();
        }),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/exports",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "x-reauthentication-token": "r".repeat(43),
      },
      payload: { formats: ["json"] },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "RATE_LIMITED",
      detail: "An account export is already in progress. Try again after it finishes.",
    });
  });

  it("uses ownership-indistinguishable not-found responses", async () => {
    const app = createTestApp(retentionStub({ getCustomFood: vi.fn(async () => null) }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/custom-foods/90000000-0000-4000-8000-000000000009",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      detail: "The requested resource was not found.",
    });
  });

  it("returns not found for expired export status and artifact lookups", async () => {
    const app = createTestApp(
      retentionStub({
        getExport: vi.fn(async () => null),
        getExportArtifact: vi.fn(async () => null),
      }),
    );
    const status = await app.inject({
      method: "GET",
      url: `/v1/exports/${exportId}`,
      headers: authHeaders,
    });
    const artifact = await app.inject({
      method: "GET",
      url: `/v1/exports/${exportId}/artifacts/json`,
      headers: authHeaders,
    });
    expect(status.statusCode).toBe(404);
    expect(artifact.statusCode).toBe(404);
    expect(status.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(artifact.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses a narrowly scoped capability to report erasure after all general sessions are revoked", async () => {
    const erasure = {
      id: erasureId,
      status: "queued" as const,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      executeAfter: "2026-08-17T12:00:00.000Z",
      recentAuthenticationSatisfied: true as const,
      consequences: [
        "ACCOUNT_ACCESS_REVOKED",
        "PRIVATE_HEALTH_DATA_DELETED",
        "EXPORT_LINKS_REVOKED",
      ] as const,
      failureCode: null,
    };
    const mutation: AccountErasureMutationResponse = {
      data: {
        replayed: false,
        erasure,
        statusCapability: {
          token: "e".repeat(43),
          expiresAt: "2026-09-16T12:00:00.000Z",
        },
      },
    };
    const failed: AccountErasureResponse = {
      data: {
        replayed: false,
        erasure: {
          ...erasure,
          status: "failed",
          startedAt: now,
          failureCode: "ERASURE_FAILED",
        },
      },
    };
    const requestErasure = vi.fn(async () => mutation);
    const getErasureByCapability = vi.fn(async () => failed);
    const app = createTestApp(retentionStub({ requestErasure, getErasureByCapability }));
    const created = await app.inject({
      method: "POST",
      url: "/v1/account/erasure",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "x-reauthentication-token": "r".repeat(43),
      },
      payload: { confirmation: "DELETE_MY_ACCOUNT" },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toEqual(mutation);

    const status = await app.inject({
      method: "GET",
      url: `/v1/account/erasure/${erasureId}`,
      headers: { "x-erasure-status-token": "e".repeat(43) },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual(failed);
    expect(getErasureByCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        erasureId,
        statusTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    const missingCapability = await app.inject({
      method: "GET",
      url: `/v1/account/erasure/${erasureId}`,
    });
    expect(missingCapability.statusCode).toBe(401);
  });

  it("recovers an exact lost erasure response through only the initiating revoked session", async () => {
    const erasure = {
      completedAt: null,
      consequences: [
        "ACCOUNT_ACCESS_REVOKED",
        "PRIVATE_HEALTH_DATA_DELETED",
        "EXPORT_LINKS_REVOKED",
      ] as const,
      executeAfter: "2026-08-17T12:00:00.000Z",
      failureCode: null,
      id: erasureId,
      recentAuthenticationSatisfied: true as const,
      requestedAt: now,
      startedAt: null,
      status: "queued" as const,
    };
    const exactReplay: AccountErasureMutationResponse = {
      data: {
        erasure,
        replayed: true,
        statusCapability: {
          expiresAt: "2026-09-16T12:00:00.000Z",
          token: "e".repeat(43),
        },
      },
    };
    const requestErasure = vi.fn(async (input: { clientOperationId: string }) =>
      input.clientOperationId === operationId
        ? exactReplay
        : { ...exactReplay, data: { ...exactReplay.data, replayed: false } },
    );
    const auth = authStub();
    vi.mocked(auth.authenticate).mockResolvedValue(null);
    vi.mocked(auth.authenticateErasureRecovery).mockResolvedValue({
      account,
      erasureJobId: erasureId,
      executeAfter: new Date("2026-08-17T12:00:00.000Z"),
      sessionTokenHash,
      userId,
    });
    const app = createTestApp(retentionStub({ requestErasure }), auth);
    const exact = await app.inject({
      method: "POST",
      url: "/v1/account/erasure",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "x-reauthentication-token": "r".repeat(43),
      },
      payload: { confirmation: "DELETE_MY_ACCOUNT" },
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toEqual(exactReplay);

    const mutated = await app.inject({
      method: "POST",
      url: "/v1/account/erasure",
      headers: {
        ...authHeaders,
        "idempotency-key": "61000000-0000-4000-8000-000000000006",
        "x-reauthentication-token": "r".repeat(43),
      },
      payload: { confirmation: "DELETE_MY_ACCOUNT" },
    });
    expect(mutated.statusCode).toBe(401);
    const unrelated = await app.inject({
      method: "GET",
      url: "/v1/trends/nutrients?nutrientId=1&from=2026-08-16&to=2026-08-16",
      headers: authHeaders,
    });
    expect(unrelated.statusCode).toBe(401);
  });
});
