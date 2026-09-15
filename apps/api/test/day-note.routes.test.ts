import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  type DayNote,
  type DayNoteMutationResponse,
} from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import { type DayNoteService, DayNoteServiceError } from "../src/modules/diary/day-note.routes.js";
import { account, bearerToken, operationId, userId } from "./fixtures.js";

const localDate = "2026-11-01";
const noteId = randomUUID();
const raw = "  Cafe\u0301\r\n🫐  ";
const headers = {
  authorization: `Bearer ${bearerToken}`,
  "x-expected-owner-user-id": userId,
  "x-expected-profile-time-zone": "America/Chicago",
  "idempotency-key": operationId,
  "if-match": '"0"',
};
const virgin: DayNote = {
  ownerUserId: userId,
  localDate,
  id: null,
  revision: "0",
  note: null,
  recordedTimeZone: null,
  createdAt: null,
  updatedAt: null,
};
const saved: DayNote = {
  ...virgin,
  id: noteId,
  revision: "1",
  note: raw,
  recordedTimeZone: "America/Chicago",
  createdAt: "2026-11-01T05:30:00.000Z",
  updatedAt: "2026-11-01T05:30:00.000Z",
};
const receipt = {
  protocol: "diary-day-note-v1",
  operationId,
  ownerUserId: userId,
  localDate,
  expectedRevision: "0",
  expectedProfileTimeZone: "America/Chicago",
  resultRevision: "1",
} as const;
const mutation: DayNoteMutationResponse = { data: { replayed: false, note: saved, receipt } };
const apps: ReturnType<typeof buildApp>[] = [];
function authStub(): AuthService {
  return {
    confirmEmailVerification: vi.fn(),
    confirmPasswordRecovery: vi.fn(),
    reauthenticate: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    authenticate: vi.fn(async (header) =>
      header === headers.authorization
        ? { userId, account, sessionTokenHash: "a".repeat(64) }
        : null,
    ),
    authenticateErasureRecovery: vi.fn(async () => null),
    logout: vi.fn(),
    requestEmailVerification: vi.fn(),
    requestPasswordRecovery: vi.fn(),
  };
}
function serviceStub(overrides: Partial<DayNoteService> = {}): DayNoteService {
  return { getNote: vi.fn(async () => virgin), putNote: vi.fn(async () => mutation), ...overrides };
}
function createApp(dayNoteService?: DayNoteService) {
  const app = buildApp({
    config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    logger: false,
    authService: authStub(),
    ...(dayNoteService ? { dayNoteService } : {}),
  });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe("owner-private standalone day notes", () => {
  it("authenticates the selected owner and reads virgin, saved and cleared representations with exact strong validators", async () => {
    const service = serviceStub();
    const app = createApp(service);
    const url = `/v1/diary/day-notes/${localDate}`;
    expect(
      (await app.inject({ method: "GET", url, headers: { "x-expected-owner-user-id": userId } }))
        .statusCode,
    ).toBe(401);
    for (const value of [virgin, saved, { ...saved, revision: "2", note: null }]) {
      vi.mocked(service.getNote).mockResolvedValueOnce(value);
      const result = await app.inject({ method: "GET", url, headers });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual({ data: value });
      expect(result.headers.etag).toBe(`"${value.revision}"`);
      expect(result.headers["cache-control"]).toBe("no-store");
    }
    expect(service.getNote).toHaveBeenCalledWith(expect.objectContaining({ userId, localDate }));
    const wrong = await app.inject({
      method: "GET",
      url,
      headers: { ...headers, "x-expected-owner-user-id": randomUUID() },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe("DAY_NOTE_OWNER_CHANGED");
    expect(service.getNote).toHaveBeenCalledTimes(3);
  });
  it("passes the exact raw text and all write guards into a deterministic operation digest and preserves historical replay", async () => {
    const service = serviceStub();
    const app = createApp(service);
    const url = `/v1/diary/day-notes/${localDate}`;
    for (const replayed of [false, true]) {
      vi.mocked(service.putNote).mockResolvedValueOnce({ data: { ...mutation.data, replayed } });
      const result = await app.inject({ method: "PUT", url, headers, payload: { note: raw } });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual({ data: { ...mutation.data, replayed } });
      expect(result.headers.etag).toBe('"1"');
      expect(result.headers["cache-control"]).toBe("no-store");
    }
    const input = {
      userId,
      localDate,
      expectedRevision: "0",
      expectedProfileTimeZone: "America/Chicago",
      clientOperationId: operationId,
      note: raw,
    };
    expect(service.putNote).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ...input,
        requestDigest: createHash("sha256")
          .update(canonicalJson({ protocol: "diary-day-note-v1", method: "PUT", ...input }), "utf8")
          .digest("hex"),
      }),
    );
    expect(vi.mocked(service.putNote).mock.calls[0]?.[0].requestDigest).toBe(
      vi.mocked(service.putNote).mock.calls[1]?.[0].requestDigest,
    );
  });
  it("binds nullable clear, date, exact revision and zone separately in the digest", async () => {
    const service = serviceStub({
      putNote: vi.fn(async (input) => ({
        data: {
          replayed: false,
          note: {
            ...saved,
            localDate: input.localDate,
            revision: (BigInt(input.expectedRevision) + 1n).toString(),
            note: input.note,
            recordedTimeZone: input.expectedProfileTimeZone,
          },
          receipt: {
            ...receipt,
            localDate: input.localDate,
            expectedRevision: input.expectedRevision,
            expectedProfileTimeZone: input.expectedProfileTimeZone,
            resultRevision: (BigInt(input.expectedRevision) + 1n).toString(),
          },
        },
      })),
    });
    const app = createApp(service);
    for (const [date, revision, zone, note] of [
      [localDate, "1", "America/Chicago", null],
      [localDate, "1", "America/Chicago", raw],
      ["2026-11-02", "1", "America/Chicago", null],
      [localDate, "2", "America/Chicago", null],
      [localDate, "1", "Asia/Tokyo", null],
    ] as const) {
      const result = await app.inject({
        method: "PUT",
        url: `/v1/diary/day-notes/${date}`,
        headers: { ...headers, "if-match": `"${revision}"`, "x-expected-profile-time-zone": zone },
        payload: { note },
      });
      expect(result.statusCode, result.body).toBe(200);
    }
    expect(
      new Set(vi.mocked(service.putNote).mock.calls.map(([input]) => input.requestDigest)).size,
    ).toBe(5);
  });
  it("rejects missing or malformed preconditions, unknown authority fields and invalid raw Unicode before persistence", async () => {
    const service = serviceStub();
    const app = createApp(service);
    const url = `/v1/diary/day-notes/${localDate}`;
    const withoutRevision = { ...headers } as Record<string, string>;
    delete withoutRevision["if-match"];
    const missing = await app.inject({
      method: "PUT",
      url,
      headers: withoutRevision,
      payload: { note: raw },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json().code).toBe("PRECONDITION_REQUIRED");
    for (const value of ['W/"0"', '"00"', '"9223372036854775808"', '"0", "1"'])
      expect(
        (
          await app.inject({
            method: "PUT",
            url,
            headers: { ...headers, "if-match": value },
            payload: { note: raw },
          })
        ).statusCode,
      ).toBe(400);
    for (const payload of [
      { note: raw, userId: randomUUID() },
      { note: raw, revision: "1" },
      {},
      { note: 123 },
      { note: false },
    ])
      expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(400);
    for (const note of ["", "a".repeat(2001), "\u0000", "\ud800"]) {
      const result = await app.inject({ method: "PUT", url, headers, payload: { note } });
      expect(result.statusCode).toBe(422);
      expect(result.json().code).toBe("DAY_NOTE_VALIDATION");
    }
    for (const badUrl of [`${url}?userId=${userId}`, "/v1/diary/day-notes/2026-02-30"]) {
      expect(
        (await app.inject({ method: "PUT", url: badUrl, headers, payload: { note: raw } }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers: { ...headers, "x-expected-profile-time-zone": "US/Central" },
          payload: { note: raw },
        })
      ).statusCode,
    ).toBe(400);
    expect(service.putNote).not.toHaveBeenCalled();
  });
  it("maps only explicit definitive outcomes and hides unexpected persistence failures", async () => {
    const service = serviceStub();
    const app = createApp(service);
    const url = `/v1/diary/day-notes/${localDate}`;
    for (const [code, status] of [
      ["DAY_NOTE_NOT_FOUND", 404],
      ["DAY_NOTE_REVISION_CONFLICT", 412],
      ["DAY_NOTE_TIME_ZONE_CHANGED", 409],
      ["DAY_NOTE_IDEMPOTENCY_CONFLICT", 409],
      ["DAY_NOTE_VALIDATION", 422],
    ] as const) {
      vi.mocked(service.putNote).mockRejectedValueOnce(new DayNoteServiceError(code));
      const result = await app.inject({ method: "PUT", url, headers, payload: { note: raw } });
      expect(result.statusCode).toBe(status);
      expect(result.json().code).toBe(code === "DAY_NOTE_NOT_FOUND" ? "NOT_FOUND" : code);
    }
    vi.mocked(service.putNote).mockRejectedValueOnce(new Error(raw));
    const unknown = await app.inject({ method: "PUT", url, headers, payload: { note: raw } });
    expect(unknown.statusCode).toBe(503);
    expect(unknown.body).not.toContain(raw);
    expect(unknown.headers["cache-control"]).toBe("no-store");
    expect((await createApp().inject({ method: "GET", url, headers })).statusCode).toBe(503);
  });
  it("rejects inconsistent saved heads and mutation receipts before serializing private output", async () => {
    const service = serviceStub();
    const app = createApp(service);
    const url = `/v1/diary/day-notes/${localDate}`;
    for (const bad of [
      { ...virgin, ownerUserId: randomUUID() },
      { ...saved, localDate: "2026-11-02" },
      { ...saved, revision: "0" },
    ]) {
      vi.mocked(service.getNote).mockResolvedValueOnce(bad);
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(500);
    }
    for (const bad of [
      { ...mutation.data, receipt: { ...receipt, operationId: randomUUID() } },
      { ...mutation.data, receipt: { ...receipt, expectedRevision: "1" } },
      { ...mutation.data, note: { ...saved, note: "different" } },
    ]) {
      vi.mocked(service.putNote).mockResolvedValueOnce({ data: bad });
      expect(
        (await app.inject({ method: "PUT", url, headers, payload: { note: raw } })).statusCode,
      ).toBe(500);
    }
  });
});
