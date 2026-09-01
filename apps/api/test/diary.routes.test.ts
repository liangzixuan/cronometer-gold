import { randomUUID } from "node:crypto";

import type { DiaryNutrientAggregate, DiaryRecipeEntry } from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  assertDiaryEntry,
  DiaryNotFoundServiceError,
  type DiaryService,
} from "../src/modules/diary/diary.routes.js";
import {
  account,
  bearerToken,
  diaryDay,
  diaryEntry,
  entryId,
  mutationResponse,
  operationId,
  userId,
} from "./fixtures.js";

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

function diaryStub(overrides: Partial<DiaryService> = {}): DiaryService {
  return {
    getDay: vi.fn(async () => diaryDay),
    createEntry: vi.fn(async () => mutationResponse),
    updateEntry: vi.fn(async () => mutationResponse),
    deleteEntry: vi.fn(async () => ({
      data: { ...mutationResponse.data, entry: null },
    })),
    ...overrides,
  };
}

function createTestApp(diaryService: DiaryService): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    authService: authStub(),
    diaryService,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

const authHeaders = { authorization: `Bearer ${bearerToken}` };
const createBody = {
  foodVersionId: "202",
  portion: { kind: "serving" as const, servingId: "303", amount: "1.5" },
  mealSlot: "breakfast" as const,
  occurredAt: "2026-08-15T13:30:00.000Z",
};

describe("diary routes", () => {
  it("requires authentication and reads a profile-local day with a synchronization ETag", async () => {
    const service = diaryStub();
    const app = createTestApp(service);
    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/diary?date=2026-08-15",
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/diary?date=2026-08-15",
      headers: authHeaders,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(service.getDay).toHaveBeenCalledOnce();
    expect(service.getDay).toHaveBeenCalledWith(
      expect.objectContaining({ userId, localDate: "2026-08-15" }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers.etag).toBe('"4"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ data: diaryDay });
  });

  it("creates a serving-resolved entry with a UUID operation key and no caller date", async () => {
    const service = diaryStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/diary/entries",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: createBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"3"');
    expect(service.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        clientOperationId: operationId,
        entry: createBody,
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("rejects a caller-assigned local date instead of trusting it", async () => {
    const service = diaryStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/diary/entries",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: { ...createBody, localDate: "2026-08-14" },
    });
    expect(response.statusCode).toBe(400);
    expect(service.createEntry).not.toHaveBeenCalled();
  });

  it("rejects unexpected nested portion fields rather than silently stripping them", async () => {
    const service = diaryStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/diary/entries",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: {
        ...createBody,
        portion: { ...createBody.portion, hiddenMultiplier: "2" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.createEntry).not.toHaveBeenCalled();
  });

  it("returns 200 for an exact idempotent create replay", async () => {
    const replay = { data: { ...mutationResponse.data, replayed: true } };
    const response = await createTestApp(
      diaryStub({ createEntry: vi.fn(async () => replay) }),
    ).inject({
      method: "POST",
      url: "/v1/diary/entries",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: createBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(replay);
  });

  it("binds entry revision and patch into the idempotency digest", async () => {
    const service = diaryStub();
    const app = createTestApp(service);
    const base = {
      method: "PATCH" as const,
      url: `/v1/diary/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload: { mealSlot: "lunch" },
    };
    const first = await app.inject(base);
    const second = await app.inject({
      ...base,
      headers: { ...base.headers, "idempotency-key": randomUUID(), "if-match": '"4"' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const calls = vi.mocked(service.updateEntry).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ userId, entryId, expectedRevision: "3" });
    expect(calls[1]?.[0]).toMatchObject({ userId, entryId, expectedRevision: "4" });
    expect(calls[0]?.[0].requestDigest).not.toBe(calls[1]?.[0].requestDigest);
  });

  it("preserves exact private note text, clears with null, and rejects invalid lengths", async () => {
    const service = diaryStub();
    const app = createTestApp(service);
    const exactNote = "  Felt 😀 energized after lunch.\nKeep this spacing.  ";
    const setResponse = await app.inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload: { note: exactNote },
    });
    const clearResponse = await app.inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": randomUUID(),
        "if-match": '"4"',
      },
      payload: { note: null },
    });
    for (const invalidNote of ["", "x".repeat(2_001), 42, "bad\u0000note", "\uD800", "\uDC00"]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/diary/entries/${entryId}`,
        headers: {
          ...authHeaders,
          "idempotency-key": randomUUID(),
          "if-match": '"4"',
        },
        payload: { note: invalidNote },
      });
      expect(response.statusCode).toBe(400);
      if (String(invalidNote).length > 0) {
        expect(response.body).not.toContain(String(invalidNote));
      }
    }
    const createWithNote = await app.inject({
      method: "POST",
      url: "/v1/diary/entries",
      headers: { ...authHeaders, "idempotency-key": randomUUID() },
      payload: { ...createBody, note: exactNote },
    });

    expect(setResponse.statusCode, setResponse.body).toBe(200);
    expect(clearResponse.statusCode, clearResponse.body).toBe(200);
    expect(createWithNote.statusCode).toBe(400);
    expect(service.updateEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ patch: { note: exactNote } }),
    );
    expect(service.updateEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ patch: { note: null } }),
    );
    expect(service.updateEntry).toHaveBeenCalledTimes(2);
    expect(service.createEntry).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(10_000), "😀".repeat(2_500)])(
    "serializes a migration-0004-compatible stored note without applying PATCH bounds",
    async (legacyNote) => {
      const app = createTestApp(
        diaryStub({
          getDay: vi.fn(async () => ({
            ...diaryDay,
            entries: [{ ...diaryEntry, note: legacyNote }],
          })),
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: "/v1/diary?date=2026-08-15",
        headers: authHeaders,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.entries[0].note).toBe(legacyNote);
    },
  );

  it("edits and serializes a pinned recipe entry through the ordinary diary route", async () => {
    const recipeVersionId = "d696b6c8-782a-4783-b459-af4698470cf0";
    const { foodProvenance: _foodProvenance, ...diaryEntryWithoutFoodProvenance } = diaryEntry;
    const recipeEntry: DiaryRecipeEntry = {
      ...diaryEntryWithoutFoodProvenance,
      entryKind: "recipe",
      foodVersionId: null,
      recipeVersionId,
      portion: { kind: "serving", amount: "1", servingLabel: "bowl" },
      food: null,
      recipe: {
        id: "2a29e851-eab0-4af6-82f2-5ac633420c2b",
        name: "Porridge",
        versionNumber: 1,
        yieldGrams: "100",
        yieldSource: "measured",
        servingCount: "1",
        servingLabel: "bowl",
        calculationVersion: "nutrition-engine-v1",
        retentionPolicy: {
          code: "identity-retention-default",
          version: "1",
          assumption:
            "No cooking-retention dataset was applied; omitted factors remain exactly one.",
        },
        warnings: [
          {
            code: "RETENTION_FACTORS_DEFAULTED",
            message: "No cooking-retention dataset was applied.",
            nutrientIds: ["1008"],
          },
        ],
      },
      sources: [diaryEntry.source],
      source: null,
    };
    const responseBody = {
      data: { ...mutationResponse.data, entry: recipeEntry },
    };
    expect(() => assertDiaryEntry(recipeEntry)).not.toThrow();
    const service = diaryStub({ updateEntry: vi.fn(async () => responseBody) });
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
      payload: { portion: { kind: "serving", amount: "1" } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.entry).toEqual(recipeEntry);
    expect(service.updateEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId,
        patch: { portion: { kind: "serving", amount: "1" } },
      }),
    );
  });

  it("requires a UUID key and a strong current entry ETag for edits", async () => {
    const service = diaryStub();
    const app = createTestApp(service);
    const missingKey = await app.inject({
      method: "POST",
      url: "/v1/diary/entries",
      headers: authHeaders,
      payload: createBody,
    });
    const missingRevision = await app.inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}`,
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: { mealSlot: "lunch" },
    });
    const weakRevision = await app.inject({
      method: "DELETE",
      url: `/v1/diary/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": 'W/"3"',
      },
    });

    expect(missingKey.statusCode).toBe(400);
    expect(missingRevision.statusCode).toBe(428);
    expect(weakRevision.statusCode).toBe(400);
    expect(service.createEntry).not.toHaveBeenCalled();
    expect(service.updateEntry).not.toHaveBeenCalled();
    expect(service.deleteEntry).not.toHaveBeenCalled();
  });

  it.each([
    "1000000000000",
    "1.1234567",
    "0000-01-01T00:00:00Z",
    "2026-08-15T13:30:00.0000Z",
    "2026-08-15T13:30Z",
    "2026-08-15T13:30:00+14:01",
  ])("rejects input outside the exact decimal/time persistence profile: %s", async (value) => {
    const service = diaryStub();
    const body = value.includes("T")
      ? { ...createBody, occurredAt: value }
      : { ...createBody, portion: { kind: "grams", grams: value } };
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/diary/entries",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(service.createEntry).not.toHaveBeenCalled();
  });

  it("passes only the authenticated owner to delete and fails cross-user misses closed", async () => {
    const notFound = new DiaryNotFoundServiceError();
    const service = diaryStub({ deleteEntry: vi.fn(async () => Promise.reject(notFound)) });
    const response = await createTestApp(service).inject({
      method: "DELETE",
      url: `/v1/diary/entries/${entryId}`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("private owner identifier");
    expect(service.deleteEntry).toHaveBeenCalledWith(
      expect.objectContaining({ userId, entryId, expectedRevision: "3" }),
    );
  });

  it("rejects impossible nutrient aggregates before serializing false certainty", async () => {
    const firstTotal = diaryDay.totals[0];
    if (!firstTotal) throw new Error("fixture requires a nutrient total");
    const invalid: DiaryNutrientAggregate = {
      ...firstTotal,
      completeness: "complete",
      unknownCount: 1,
      contributorCount: 2,
      unknownReasonCounts: { ...firstTotal.unknownReasonCounts, not_reported: 1 },
    };
    const service = diaryStub({
      getDay: vi.fn(async () => ({ ...diaryDay, totals: [invalid] })),
    });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: "/v1/diary?date=2026-08-15",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("Diary aggregate invariants failed");
    expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
