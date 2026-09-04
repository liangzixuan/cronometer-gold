import { createHash, randomUUID } from "node:crypto";

import {
  canonicalJson,
  type HydrationDay,
  type HydrationEntry,
  type HydrationMutationResponse,
} from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  HydrationIdempotencyConflictServiceError,
  HydrationNotFoundServiceError,
  HydrationRevisionConflictServiceError,
  type HydrationService,
  HydrationTimeZoneChangedServiceError,
  HydrationValidationServiceError,
} from "../src/modules/hydration/hydration.routes.js";
import { account, bearerToken, operationId, userId } from "./fixtures.js";

const entryId = "6bc0b15e-e674-4e51-a629-e65440b6e53f";
const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const authHeaders = { authorization: `Bearer ${bearerToken}` };

function expectedHydrationDayEtag(day: HydrationDay): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ data: day }), "utf8")
    .digest("base64url");
  return `"h-${digest}"`;
}

const hydrationEntry: HydrationEntry = {
  id: entryId,
  revision: "3",
  amountMilliliters: 350,
  occurredAt: "2026-11-01T06:30:00.000Z",
  localDate: "2026-11-01",
  localTime: "01:30:00",
  // Historical revisions retain the zone used when their local coordinates were derived.
  timeZone: "America/New_York",
  createdAt: "2026-11-01T06:30:01.000Z",
};

const hydrationDay: HydrationDay = {
  localDate: "2026-11-01",
  timeZone: "America/Chicago",
  revision: "4",
  entries: [hydrationEntry],
  totalMilliliters: 350,
  updatedAt: "2026-11-01T06:30:01.000Z",
};

const mutationResponse: HydrationMutationResponse = {
  data: {
    replayed: false,
    entry: hydrationEntry,
    affectedDays: [{ localDate: "2026-11-01", revision: "4" }],
  },
};

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

function hydrationStub(overrides: Partial<HydrationService> = {}): HydrationService {
  return {
    getDay: vi.fn(async () => hydrationDay),
    createEntry: vi.fn(async () => mutationResponse),
    updateEntry: vi.fn(async () => mutationResponse),
    deleteEntry: vi.fn(async () => ({ data: { ...mutationResponse.data, entry: null } })),
    ...overrides,
  };
}

function createTestApp(hydrationService: HydrationService): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    authService: authStub(),
    hydrationService,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("hydration routes", () => {
  it("requires authentication and reads only the authenticated owner's local day", async () => {
    const service = hydrationStub();
    const app = createTestApp(service);
    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/hydration?date=2026-11-01",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/hydration?date=2026-11-01",
      headers: authHeaders,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
    expect(service.getDay).toHaveBeenCalledOnce();
    expect(service.getDay).toHaveBeenCalledWith(
      expect.objectContaining({ userId, localDate: "2026-11-01" }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers.etag).toBe(expectedHydrationDayEtag(hydrationDay));
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ data: hydrationDay });
  });

  it("reads a persisted empty day after its last entry was deleted", async () => {
    const tombstonedDay: HydrationDay = {
      localDate: "2026-11-01",
      timeZone: "America/Chicago",
      revision: "5",
      entries: [],
      totalMilliliters: 0,
      updatedAt: "2026-11-01T07:00:00.000Z",
    };
    const service = hydrationStub({ getDay: vi.fn(async () => tombstonedDay) });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: "/v1/hydration?date=2026-11-01",
      headers: authHeaders,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers.etag).toBe(expectedHydrationDayEtag(tombstonedDay));
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ data: tombstonedDay });
  });

  it("changes the exact strong validator when an empty day's current profile zone changes", async () => {
    const chicagoDay: HydrationDay = {
      localDate: "2026-11-01",
      timeZone: "America/Chicago",
      revision: "0",
      entries: [],
      totalMilliliters: 0,
      updatedAt: null,
    };
    const tokyoDay: HydrationDay = { ...chicagoDay, timeZone: "Asia/Tokyo" };
    const getDay = vi
      .fn<HydrationService["getDay"]>()
      .mockResolvedValueOnce(chicagoDay)
      .mockResolvedValueOnce(tokyoDay);
    const app = createTestApp(hydrationStub({ getDay }));
    const chicagoResponse = await app.inject({
      method: "GET",
      url: "/v1/hydration?date=2026-11-01",
      headers: authHeaders,
    });
    const tokyoResponse = await app.inject({
      method: "GET",
      url: "/v1/hydration?date=2026-11-01",
      headers: authHeaders,
    });

    expect(chicagoResponse.statusCode, chicagoResponse.body).toBe(200);
    expect(tokyoResponse.statusCode, tokyoResponse.body).toBe(200);
    expect(chicagoResponse.headers.etag).toBe(expectedHydrationDayEtag(chicagoDay));
    expect(tokyoResponse.headers.etag).toBe(expectedHydrationDayEtag(tokyoDay));
    expect(tokyoResponse.headers.etag).not.toBe(chicagoResponse.headers.etag);
    expect(chicagoResponse.headers.etag).toMatch(/^"h-[A-Za-z0-9_-]{43}"$/u);
    expect(chicagoResponse.headers["cache-control"]).toBe("no-store");
    expect(tokyoResponse.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    "/v1/hydration",
    "/v1/hydration?date=0000-01-01",
    "/v1/hydration?date=2026-02-30",
    "/v1/hydration?date=2026-11-01&owner=someone-else",
    "/v1/hydration?date=2026-11-01&date=2026-11-02",
  ])("rejects an invalid or ambiguous day query before persistence: %s", async (url) => {
    const service = hydrationStub();
    const response = await createTestApp(service).inject({
      method: "GET",
      url,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(400);
    expect(service.getDay).not.toHaveBeenCalled();
  });

  it("fails closed rather than serializing an inexact daily total", async () => {
    const privateInvariant = "Hydration response invariants failed";
    const service = hydrationStub({
      getDay: vi.fn(async () => ({ ...hydrationDay, totalMilliliters: 349 })),
    });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: "/v1/hydration?date=2026-11-01",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain(privateInvariant);
  });

  it.each([
    [
      "timestamp",
      [
        {
          ...hydrationEntry,
          id: "fbc0b15e-e674-4e51-a629-e65440b6e53f",
          occurredAt: "2026-11-01T07:30:00.000Z",
        },
        hydrationEntry,
      ],
    ],
    [
      "entry id at an equal timestamp",
      [{ ...hydrationEntry, id: "fbc0b15e-e674-4e51-a629-e65440b6e53f" }, hydrationEntry],
    ],
  ] as const)(
    "fails closed when hydration entries are not ordered by %s",
    async (_case, entries) => {
      const service = hydrationStub({
        getDay: vi.fn(async () => ({
          ...hydrationDay,
          entries,
          totalMilliliters: 700,
        })),
      });
      const response = await createTestApp(service).inject({
        method: "GET",
        url: "/v1/hydration?date=2026-11-01",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(500);
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    },
  );

  it("fails closed when persisted local coordinates do not match the immutable entry zone", async () => {
    const service = hydrationStub({
      getDay: vi.fn(async () => ({
        ...hydrationDay,
        entries: [{ ...hydrationEntry, localTime: "02:30:00" }],
      })),
    });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: "/v1/hydration?date=2026-11-01",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("02:30:00");
  });

  it("creates with an operation ID and an optional profile-time-zone precondition", async () => {
    const service = hydrationStub();
    const createBody = {
      amountMilliliters: 350,
      occurredAt: "2026-11-01T06:30:00.000Z",
    };
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/hydration/entries?profileTimeZonePrecondition=v1",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "x-expected-profile-time-zone": "America/Chicago",
      },
      payload: createBody,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers.etag).toBe('"3"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        clientOperationId: operationId,
        expectedProfileTimeZone: "America/Chicago",
        entry: createBody,
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("requires a UUID operation ID for create without reaching persistence", async () => {
    const service = hydrationStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/hydration/entries",
      headers: authHeaders,
      payload: {
        amountMilliliters: 250,
        occurredAt: "2026-11-01T06:30:00.000Z",
      },
    });

    // Shared mutation-header policy treats a missing/malformed operation UUID as request validation.
    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(service.createEntry).not.toHaveBeenCalled();
  });

  it("requires the guarded time-zone header and capability marker as one pair", async () => {
    const service = hydrationStub();
    const app = createTestApp(service);
    const payload = {
      amountMilliliters: 250,
      occurredAt: "2026-11-01T06:30:00.000Z",
    };
    const guardedHeaders = {
      ...authHeaders,
      "idempotency-key": operationId,
      "x-expected-profile-time-zone": "America/Chicago",
    };
    const requests = [
      { url: "/v1/hydration/entries", headers: guardedHeaders },
      {
        url: "/v1/hydration/entries?profileTimeZonePrecondition=v1",
        headers: { ...authHeaders, "idempotency-key": operationId },
      },
      {
        url: "/v1/hydration/entries?profileTimeZonePrecondition=v2",
        headers: guardedHeaders,
      },
      {
        url: "/v1/hydration/entries?profileTimeZonePrecondition=v1&profileTimeZonePrecondition=v1",
        headers: guardedHeaders,
      },
      {
        url: "/v1/hydration/entries?profileTimeZonePrecondition=v1&unknown=v1",
        headers: guardedHeaders,
      },
    ];

    for (const request of requests) {
      const response = await app.inject({
        method: "POST",
        url: request.url,
        headers: request.headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(service.createEntry).not.toHaveBeenCalled();
  });

  it.each([
    { amountMilliliters: 0, occurredAt: "2026-11-01T06:30:00.000Z" },
    { amountMilliliters: 20_001, occurredAt: "2026-11-01T06:30:00.000Z" },
    { amountMilliliters: 1.5, occurredAt: "2026-11-01T06:30:00.000Z" },
    { amountMilliliters: 250, occurredAt: "2026-11-01T06:30:00" },
    {
      amountMilliliters: 250,
      occurredAt: "2026-11-01T06:30:00.000Z",
      localDate: "2026-11-01",
    },
    {
      amountMilliliters: 250,
      occurredAt: "2026-11-01T06:30:00.000Z",
      targetMilliliters: 2_000,
    },
  ])("enforces non-clinical operational write bounds before persistence", async (payload) => {
    const service = hydrationStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/hydration/entries",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.createEntry).not.toHaveBeenCalled();
  });

  it("returns 200 for an exact create replay", async () => {
    const replay = { data: { ...mutationResponse.data, replayed: true } };
    const service = hydrationStub({ createEntry: vi.fn(async () => replay) });
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/hydration/entries",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: {
        amountMilliliters: 350,
        occurredAt: "2026-11-01T06:30:00.000Z",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(replay);
  });

  it("requires both mutation preconditions and binds revision and patch into the digest", async () => {
    const service = hydrationStub();
    const app = createTestApp(service);
    const payload = { amountMilliliters: 500 };
    const noOperation = await app.inject({
      method: "PATCH",
      url: `/v1/hydration/entries/${entryId}`,
      headers: { ...authHeaders, "if-match": '"3"' },
      payload,
    });
    const noRevision = await app.inject({
      method: "PATCH",
      url: `/v1/hydration/entries/${entryId}`,
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload,
    });
    const first = await app.inject({
      method: "PATCH",
      url: `/v1/hydration/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload,
    });
    const second = await app.inject({
      method: "PATCH",
      url: `/v1/hydration/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": randomUUID(),
        "if-match": '"4"',
      },
      payload,
    });

    expect(noOperation.statusCode).toBe(400);
    expect(noRevision.statusCode).toBe(428);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(first.headers.etag).toBe('"3"');
    expect(first.headers["cache-control"]).toBe("no-store");
    const calls = vi.mocked(service.updateEntry).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toMatchObject({
      userId,
      entryId,
      expectedRevision: "3",
      patch: payload,
    });
    expect(calls[1]?.[0]).toMatchObject({ expectedRevision: "4" });
    expect(calls[0]?.[0].requestDigest).not.toBe(calls[1]?.[0].requestDigest);
  });

  it.each([{}, { amountMilliliters: 0 }, { amountMilliliters: 20_001 }, { clinicalTarget: 2_000 }])(
    "rejects an empty, out-of-bounds, or coupled update: %j",
    async (payload) => {
      const service = hydrationStub();
      const response = await createTestApp(service).inject({
        method: "PATCH",
        url: `/v1/hydration/entries/${entryId}`,
        headers: {
          ...authHeaders,
          "idempotency-key": operationId,
          "if-match": '"3"',
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(service.updateEntry).not.toHaveBeenCalled();
    },
  );

  it("passes only the authenticated owner to delete and fails cross-owner misses closed", async () => {
    const privateOwner = "private-owner-id-must-not-leak";
    const service = hydrationStub({
      deleteEntry: vi.fn(async () => Promise.reject(new HydrationNotFoundServiceError())),
    });
    const response = await createTestApp(service).inject({
      method: "DELETE",
      url: `/v1/hydration/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(privateOwner);
    expect(service.deleteEntry).toHaveBeenCalledWith(
      expect.objectContaining({ userId, entryId, expectedRevision: "3" }),
    );
  });

  it("rejects every DELETE body before persistence", async () => {
    const service = hydrationStub();
    const response = await createTestApp(service).inject({
      method: "DELETE",
      url: `/v1/hydration/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "content-type": "application/json",
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload: { privateField: "must-not-be-accepted" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("must-not-be-accepted");
    expect(service.deleteEntry).not.toHaveBeenCalled();
  });

  it("returns a retry-safe deleted result without advertising a stale entry ETag", async () => {
    const deleted = { data: { ...mutationResponse.data, entry: null } };
    const service = hydrationStub({ deleteEntry: vi.fn(async () => deleted) });
    const response = await createTestApp(service).inject({
      method: "DELETE",
      url: `/v1/hydration/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBeUndefined();
    expect(response.json()).toEqual(deleted);
  });

  it.each([
    [new HydrationRevisionConflictServiceError(), 412, "PRECONDITION_FAILED"],
    [new HydrationIdempotencyConflictServiceError(), 409, "CONFLICT"],
    [new HydrationTimeZoneChangedServiceError(), 409, "HYDRATION_TIME_ZONE_CHANGED"],
    [new HydrationValidationServiceError(), 422, "VALIDATION_ERROR"],
  ] as const)(
    "maps a typed persistence failure without exposing internals",
    async (error, status, code) => {
      const service = hydrationStub({ createEntry: vi.fn(async () => Promise.reject(error)) });
      const response = await createTestApp(service).inject({
        method: "POST",
        url: "/v1/hydration/entries",
        headers: { ...authHeaders, "idempotency-key": operationId },
        payload: {
          amountMilliliters: 250,
          occurredAt: "2026-11-01T06:30:00.000Z",
        },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(error.message);
    },
  );

  it("rejects operation-incompatible mutation results from persistence", async () => {
    const service = hydrationStub({
      createEntry: vi.fn(async () => ({
        data: { ...mutationResponse.data, entry: null },
      })),
      updateEntry: vi.fn(async () => ({
        data: {
          ...mutationResponse.data,
          affectedDays: [{ localDate: "2026-11-02", revision: "5" }],
        },
      })),
      deleteEntry: vi.fn(async () => mutationResponse),
    });
    const app = createTestApp(service);
    const mutationHeaders = {
      ...authHeaders,
      "idempotency-key": operationId,
      "if-match": '"3"',
    };
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/hydration/entries",
        headers: mutationHeaders,
        payload: {
          amountMilliliters: 350,
          occurredAt: "2026-11-01T06:30:00.000Z",
        },
      }),
      app.inject({
        method: "PATCH",
        url: `/v1/hydration/entries/${entryId}`,
        headers: mutationHeaders,
        payload: { amountMilliliters: 500 },
      }),
      app.inject({
        method: "DELETE",
        url: `/v1/hydration/entries/${entryId}`,
        headers: mutationHeaders,
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(500);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.etag).toBeUndefined();
      expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    }
  });

  it("rejects duplicate affected days from a corrupt mutation response", async () => {
    const service = hydrationStub({
      updateEntry: vi.fn(async () => ({
        data: {
          ...mutationResponse.data,
          affectedDays: [
            { localDate: "2026-11-01", revision: "4" },
            { localDate: "2026-11-01", revision: "5" },
          ],
        },
      })),
    });
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: `/v1/hydration/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload: { amountMilliliters: 500 },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("Hydration response invariants failed");
  });
});
