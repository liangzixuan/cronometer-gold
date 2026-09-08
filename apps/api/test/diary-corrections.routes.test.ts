import { createHash } from "node:crypto";

import {
  type DiaryCorrectionKind,
  type DiaryCorrectionMutationResponse,
  diaryDayOrderDigestPayload,
  type ReorderDiaryDayResponse,
} from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  DiaryLockedServiceError,
  DiaryNotFoundServiceError,
  DiaryRevisionConflictServiceError,
  type DiaryService,
  DiaryTimeZoneChangedServiceError,
} from "../src/modules/diary/diary.routes.js";
import type { RetentionService } from "../src/modules/retention/retention.routes.js";
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
const secondOperationId = "10000000-0000-4000-8000-000000000010";
const repeatedEntryId = "60000000-0000-4000-8000-000000000006";
const expectedOrderDigest = "a".repeat(64);
const authHeaders = { authorization: `Bearer ${bearerToken}` };

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

function diaryStub(overrides: Partial<DiaryService> = {}): DiaryService {
  return {
    getDay: vi.fn(async () => diaryDay),
    createEntry: vi.fn(async () => mutationResponse),
    updateEntry: vi.fn(async () => mutationResponse),
    deleteEntry: vi.fn(async () => ({ data: { ...mutationResponse.data, entry: null } })),
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

function retentionStub(overrides: Partial<RetentionService>): RetentionService {
  return new Proxy(overrides as Record<string, unknown>, {
    get(target, property) {
      if (typeof property === "string" && property in target) return target[property];
      return vi.fn(async () => Promise.reject(new Error(`unexpected call: ${String(property)}`)));
    },
  }) as unknown as RetentionService;
}

function correctionResponse(
  kind: DiaryCorrectionKind,
  options: {
    readonly operationId?: string;
    readonly replayed?: boolean;
    readonly resultEntryId?: string;
    readonly resultRevision?: string;
  } = {},
): DiaryCorrectionMutationResponse {
  const resultEntryId = options.resultEntryId ?? entryId;
  const resultRevision = options.resultRevision ?? "4";
  const deleted = kind === "delete";
  const localDate = kind === "repeat" ? "2026-08-16" : "2026-08-15";
  const entry = deleted
    ? null
    : {
        ...diaryEntry,
        id: resultEntryId,
        revision: resultRevision,
        localDate,
      };
  const affectedDays = [{ localDate, revision: "5" }];
  return {
    data: {
      replayed: options.replayed ?? false,
      entry,
      affectedDays,
      receipt: {
        protocol: "v1",
        operationId: options.operationId ?? operationId,
        kind,
        expectedSubjects: [{ entryId, revision: "3" }],
        resultSubjects: [
          {
            entryId: resultEntryId,
            revision: resultRevision,
            state: deleted ? "deleted" : "active",
          },
        ],
        affectedDays,
      },
    },
  };
}

function withAffectedDays(
  response: DiaryCorrectionMutationResponse,
  affectedDays: DiaryCorrectionMutationResponse["data"]["affectedDays"],
): DiaryCorrectionMutationResponse {
  return {
    data: {
      ...response.data,
      affectedDays,
      receipt: {
        ...response.data.receipt,
        affectedDays,
      },
    },
  };
}

const reorderRequest = {
  groups: { breakfast: [0], lunch: [], dinner: [], snacks: [] },
};

const reorderedGroups = [
  {
    mealSlot: "breakfast" as const,
    entries: [{ entryId, entryRevision: "4", position: 0 }],
  },
  { mealSlot: "lunch" as const, entries: [] },
  { mealSlot: "dinner" as const, entries: [] },
  { mealSlot: "snacks" as const, entries: [] },
] as const;
const resultingOrderDigest = createHash("sha256")
  .update(diaryDayOrderDigestPayload("2026-08-15", "UTC", reorderedGroups), "utf8")
  .digest("hex");

const reorderResponse: ReorderDiaryDayResponse = {
  data: {
    replayed: false,
    receipt: {
      operationId,
      localDate: "2026-08-15",
      timeZone: "UTC",
      expectedDayRevision: "4",
      resultingDayRevision: "5",
      previousOrderDigest: expectedOrderDigest,
      orderDigest: resultingOrderDigest,
      groups: reorderedGroups,
    },
  },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("durable diary correction routes", () => {
  it("preserves the legacy PATCH route, digest domain, and response", async () => {
    const updateEntry = vi.fn(async () => mutationResponse);
    const updateEntryCorrection = vi.fn(async () => correctionResponse("update"));
    const service = diaryStub({ updateEntry, updateEntryCorrection });
    const response = await createTestApp(service).inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
      payload: { mealSlot: "lunch" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(mutationResponse);
    expect(updateEntry).toHaveBeenCalledOnce();
    expect(updateEntryCorrection).not.toHaveBeenCalled();
  });

  it("returns a strong v1 edit receipt and requires timezone pairing exactly for moves", async () => {
    const corrected = correctionResponse("update");
    const updateEntryCorrection = vi.fn(async (input) =>
      correctionResponse("update", { operationId: input.clientOperationId }),
    );
    const service = diaryStub({ updateEntryCorrection });
    const app = createTestApp(service);
    const ordinary = await app.inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
      payload: { note: "Private note" },
    });
    const invalidExtraZone = await app.inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1&profileTimeZonePrecondition=v1`,
      headers: {
        ...authHeaders,
        "idempotency-key": secondOperationId,
        "if-match": '"3"',
        "x-expected-profile-time-zone": "America/Chicago",
      },
      payload: { note: "Private note" },
    });
    const missingMoveZone = await app.inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1`,
      headers: { ...authHeaders, "idempotency-key": secondOperationId, "if-match": '"3"' },
      payload: { occurredAt: "2026-08-16T12:00:00.000Z" },
    });
    const moved = await app.inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1&profileTimeZonePrecondition=v1`,
      headers: {
        ...authHeaders,
        "idempotency-key": secondOperationId,
        "if-match": '"3"',
        "x-expected-profile-time-zone": "America/Chicago",
      },
      payload: { occurredAt: "2026-08-16T12:00:00.000Z" },
    });

    expect(ordinary.statusCode, ordinary.body).toBe(200);
    expect(ordinary.headers.etag).toBe('"4"');
    expect(ordinary.headers["cache-control"]).toBe("no-store");
    expect(ordinary.json()).toEqual(corrected);
    expect(invalidExtraZone.statusCode).toBe(400);
    expect(missingMoveZone.statusCode).toBe(400);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(updateEntryCorrection).toHaveBeenCalledTimes(2);
    expect(updateEntryCorrection).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ expectedProfileTimeZone: expect.anything() }),
    );
    expect(updateEntryCorrection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedProfileTimeZone: "America/Chicago",
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
  });

  it("canonicalizes an uppercase correction entry ID before persistence and receipt checks", async () => {
    let call = 0;
    const updateEntryCorrection = vi.fn(async (input) => {
      call += 1;
      return correctionResponse("update", {
        operationId: input.clientOperationId,
        replayed: call > 1,
      });
    });
    const app = createTestApp(diaryStub({ updateEntryCorrection }));
    const request = {
      method: "PATCH" as const,
      url: `/v1/diary/entries/${entryId.toUpperCase()}?diaryCorrectionProtocol=v1`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
      payload: { note: "Private note" },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(updateEntryCorrection).toHaveBeenCalledTimes(2);
    const firstInput = updateEntryCorrection.mock.calls[0]?.[0];
    const replayInput = updateEntryCorrection.mock.calls[1]?.[0];
    expect(firstInput).toMatchObject({ entryId, clientOperationId: operationId });
    expect(replayInput).toMatchObject({ entryId, clientOperationId: operationId });
    expect(replayInput?.requestDigest).toBe(firstInput?.requestDigest);
  });

  it("keeps legacy delete intact and exposes durable delete only behind its marker", async () => {
    const legacy = { data: { ...mutationResponse.data, entry: null } };
    const deleted = correctionResponse("delete", { operationId: secondOperationId });
    const deleteEntry = vi.fn(async () => legacy);
    const deleteEntryCorrection = vi.fn(async (input) =>
      correctionResponse("delete", { operationId: input.clientOperationId }),
    );
    const service = diaryStub({ deleteEntry, deleteEntryCorrection });
    const app = createTestApp(service);
    const legacyResponse = await app.inject({
      method: "DELETE",
      url: `/v1/diary/entries/${entryId}`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
    });
    const correction = await app.inject({
      method: "DELETE",
      url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1`,
      headers: { ...authHeaders, "idempotency-key": secondOperationId, "if-match": '"3"' },
    });

    expect(legacyResponse.statusCode, legacyResponse.body).toBe(200);
    expect(legacyResponse.json()).toEqual(legacy);
    expect(correction.statusCode, correction.body).toBe(200);
    expect(correction.json()).toEqual(deleted);
    expect(deleteEntry).toHaveBeenCalledOnce();
    expect(deleteEntryCorrection).toHaveBeenCalledOnce();
  });

  it("repeats through the closed guarded path and returns 200 only for an exact replay", async () => {
    const first = correctionResponse("repeat", {
      resultEntryId: repeatedEntryId,
      resultRevision: "1",
    });
    const replay = { ...first, data: { ...first.data, replayed: true } };
    const repeatEntryCorrection = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replay);
    const service = diaryStub({ repeatEntryCorrection });
    const app = createTestApp(service);
    const missingGuard = await app.inject({
      method: "POST",
      url: `/v1/diary/corrections/entries/${entryId}/repeat`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
      payload: { occurredAt: "2026-08-16T12:00:00.000Z" },
    });
    const guardedRequest = {
      method: "POST" as const,
      url: `/v1/diary/corrections/entries/${entryId}/repeat?profileTimeZonePrecondition=v1`,
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"3"',
        "x-expected-profile-time-zone": "America/Chicago",
      },
      payload: { occurredAt: "2026-08-16T12:00:00.000Z" },
    };
    const created = await app.inject(guardedRequest);
    const replayed = await app.inject(guardedRequest);

    expect(missingGuard.statusCode).toBe(400);
    expect(created.statusCode, created.body).toBe(201);
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(created.json()).toEqual(first);
    expect(repeatEntryCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEntryId: entryId,
        expectedSourceRevision: "3",
        expectedProfileTimeZone: "America/Chicago",
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
  });

  it("rejects contradictory repeat result identities, revisions, and affected days", async () => {
    const validRepeat = correctionResponse("repeat", {
      resultEntryId: repeatedEntryId,
      resultRevision: "1",
    });
    const invalidRepeats = [
      [
        "source identity reuse",
        correctionResponse("repeat", {
          resultEntryId: entryId.toUpperCase(),
          resultRevision: "1",
        }),
      ],
      [
        "non-initial result revision",
        correctionResponse("repeat", { resultEntryId: repeatedEntryId, resultRevision: "2" }),
      ],
      [
        "multiple affected days",
        withAffectedDays(validRepeat, [
          { localDate: "2026-08-16", revision: "5" },
          { localDate: "2026-08-17", revision: "1" },
        ]),
      ],
      [
        "unrelated affected day",
        withAffectedDays(validRepeat, [{ localDate: "2026-08-17", revision: "5" }]),
      ],
    ] as const;

    for (const [name, invalidReceipt] of invalidRepeats) {
      const response = await createTestApp(
        diaryStub({ repeatEntryCorrection: vi.fn(async () => invalidReceipt) }),
      ).inject({
        method: "POST",
        url: `/v1/diary/corrections/entries/${entryId}/repeat?profileTimeZonePrecondition=v1`,
        headers: {
          ...authHeaders,
          "idempotency-key": operationId,
          "if-match": '"3"',
          "x-expected-profile-time-zone": "America/Chicago",
        },
        payload: { occurredAt: "2026-08-16T12:00:00.000Z" },
      });

      expect(response.statusCode, `${name}: ${response.body}`).toBe(500);
      expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    }
  });

  it("rejects update and delete receipts with contradictory affected-day sets", async () => {
    const update = correctionResponse("update");
    const invalidUpdates = [
      [
        "returned entry date is absent",
        withAffectedDays(update, [{ localDate: "2026-08-16", revision: "5" }]),
      ],
      [
        "affected dates are duplicated",
        withAffectedDays(update, [
          { localDate: "2026-08-15", revision: "5" },
          { localDate: "2026-08-15", revision: "6" },
        ]),
      ],
    ] as const;

    for (const [name, invalidReceipt] of invalidUpdates) {
      const response = await createTestApp(
        diaryStub({ updateEntryCorrection: vi.fn(async () => invalidReceipt) }),
      ).inject({
        method: "PATCH",
        url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1`,
        headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
        payload: { note: "Private note" },
      });

      expect(response.statusCode, `${name}: ${response.body}`).toBe(500);
      expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    }

    const invalidDelete = withAffectedDays(correctionResponse("delete"), [
      { localDate: "2026-08-15", revision: "5" },
      { localDate: "2026-08-16", revision: "1" },
    ]);
    const deleteResponse = await createTestApp(
      diaryStub({ deleteEntryCorrection: vi.fn(async () => invalidDelete) }),
    ).inject({
      method: "DELETE",
      url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
    });

    expect(deleteResponse.statusCode, deleteResponse.body).toBe(500);
    expect(deleteResponse.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("reports a locked day as 409 through the legacy repeat route", async () => {
    const app = buildApp({
      config: testConfig,
      logger: false,
      authService: authStub(),
      retentionService: retentionStub({
        repeatEntry: vi.fn(async () => Promise.reject(new DiaryLockedServiceError())),
      }),
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/diary/entries/${entryId}/repeat`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
      payload: { occurredAt: "2026-08-16T12:00:00.000Z" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "CONFLICT" });
  });

  it("atomically reorders one exact day baseline and returns the server-computed receipt", async () => {
    const reorderDay = vi.fn(async () => reorderResponse);
    const service = diaryStub({ reorderDay });
    const app = createTestApp(service);
    const missingDigest = await app.inject({
      method: "PUT",
      url: "/v1/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"4"',
        "x-expected-profile-time-zone": "America/Chicago",
      },
      payload: reorderRequest,
    });
    const zeroRevision = await app.inject({
      method: "PUT",
      url: "/v1/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"0"',
        "x-expected-profile-time-zone": "America/Chicago",
        "x-expected-diary-order-digest": expectedOrderDigest,
      },
      payload: reorderRequest,
    });
    const response = await app.inject({
      method: "PUT",
      url: "/v1/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"4"',
        "x-expected-profile-time-zone": "America/Chicago",
        "x-expected-diary-order-digest": expectedOrderDigest,
      },
      payload: reorderRequest,
    });

    expect(missingDigest.statusCode).toBe(400);
    expect(zeroRevision.statusCode).toBe(400);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBe('"5"');
    expect(response.json()).toEqual(reorderResponse);
    expect(reorderDay).toHaveBeenCalledOnce();
    expect(reorderDay).toHaveBeenCalledWith(
      expect.objectContaining({
        localDate: "2026-08-15",
        expectedDayRevision: "4",
        expectedOrderDigest,
        expectedProfileTimeZone: "America/Chicago",
        groups: reorderRequest.groups,
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
  });

  it("fails closed on a mismatched correction identity or client-invented reorder digest", async () => {
    const update = correctionResponse("update", { operationId: secondOperationId });
    const invalidUpdate = await createTestApp(
      diaryStub({ updateEntryCorrection: vi.fn(async () => update) }),
    ).inject({
      method: "PATCH",
      url: `/v1/diary/entries/${entryId}?diaryCorrectionProtocol=v1`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"3"' },
      payload: { mealSlot: "lunch" },
    });
    const invalidReorderBody: ReorderDiaryDayResponse = {
      data: {
        ...reorderResponse.data,
        receipt: {
          ...reorderResponse.data.receipt,
          groups: [
            reorderedGroups[0],
            { mealSlot: "breakfast", entries: [] },
            reorderedGroups[2],
            reorderedGroups[3],
          ],
        },
      },
    };
    const invalidReorderDigestBody: ReorderDiaryDayResponse = {
      data: {
        ...reorderResponse.data,
        receipt: { ...reorderResponse.data.receipt, orderDigest: "f".repeat(64) },
      },
    };
    const invalidReorder = await createTestApp(
      diaryStub({ reorderDay: vi.fn(async () => invalidReorderDigestBody) }),
    ).inject({
      method: "PUT",
      url: "/v1/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"4"',
        "x-expected-profile-time-zone": "America/Chicago",
        "x-expected-diary-order-digest": expectedOrderDigest,
      },
      payload: reorderRequest,
    });
    const invalidReorderGroups = await createTestApp(
      diaryStub({ reorderDay: vi.fn(async () => invalidReorderBody) }),
    ).inject({
      method: "PUT",
      url: "/v1/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
      headers: {
        ...authHeaders,
        "idempotency-key": operationId,
        "if-match": '"4"',
        "x-expected-profile-time-zone": "America/Chicago",
        "x-expected-diary-order-digest": expectedOrderDigest,
      },
      payload: reorderRequest,
    });

    for (const response of [invalidUpdate, invalidReorder, invalidReorderGroups]) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
      expect(response.body).not.toContain(secondOperationId);
      expect(response.body).not.toContain(expectedOrderDigest);
    }
  });

  it.each([
    [new DiaryRevisionConflictServiceError(), 412, "PRECONDITION_FAILED"],
    [new DiaryTimeZoneChangedServiceError(), 409, "DIARY_TIME_ZONE_CHANGED"],
    [new DiaryLockedServiceError(), 409, "CONFLICT"],
    [new DiaryNotFoundServiceError(), 404, "NOT_FOUND"],
  ] as const)(
    "maps durable reorder failures without leaking state",
    async (error, status, code) => {
      const service = diaryStub({ reorderDay: vi.fn(async () => Promise.reject(error)) });
      const response = await createTestApp(service).inject({
        method: "PUT",
        url: "/v1/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
        headers: {
          ...authHeaders,
          "idempotency-key": operationId,
          "if-match": '"4"',
          "x-expected-profile-time-zone": "America/Chicago",
          "x-expected-diary-order-digest": expectedOrderDigest,
        },
        payload: reorderRequest,
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain(expectedOrderDigest);
    },
  );
});
