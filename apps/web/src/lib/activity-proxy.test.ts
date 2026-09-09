import { afterEach, describe, expect, it, vi } from "vitest";

import {
  proxyActivityChange,
  proxyActivityCreate,
  proxyActivityGet,
} from "../app/api/activities/proxy";
import { SESSION_COOKIE } from "./private-api";

const token = "t".repeat(43);
const ownerUserId = "10000000-0000-4000-8000-000000000001";
const activityDayEtag = `"a-${"a".repeat(43)}"`;
const operationId = globalThis.crypto.randomUUID();
const entry = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  name: "Trail run",
  durationMinutes: 35,
  selfReportedEnergyKilocalories: "248.5",
  occurredAt: "2026-08-15T13:05:01.000Z",
  localDate: "2026-08-15",
  localTime: "08:05:01",
  timeZone: "America/Chicago",
  createdAt: "2026-08-15T13:05:02.000Z",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function privateHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE}=${token}`,
    "x-expected-owner-user-id": ownerUserId,
    ...extra,
  };
}

function mutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return privateHeaders({
    "content-type": "application/json",
    "idempotency-key": operationId,
    origin: "https://app.example.test",
    "sec-fetch-site": "same-origin",
    ...extra,
  });
}

function mutationData(changedEntry = entry) {
  return {
    data: {
      replayed: false,
      entry: changedEntry,
      affectedDays: [{ localDate: changedEntry.localDate, revision: "3" }],
    },
  };
}

describe("web activity read proxy", () => {
  it("forwards one local date to the plural route and preserves the exact ETag", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json(
          {
            data: {
              localDate: "2026-08-15",
              timeZone: "America/Chicago",
              revision: "3",
              entries: [entry],
              totalDurationMinutes: 35,
              updatedAt: "2026-08-15T13:05:02.000Z",
            },
          },
          { headers: { etag: activityDayEtag } },
        );
      }),
    );
    const response = await proxyActivityGet(
      new Request("https://app.example.test/api/activities?date=2026-08-15", {
        headers: privateHeaders(),
      }),
    );
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/activities?date=2026-08-15");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(calls[0]?.init?.headers).get("x-expected-owner-user-id")).toBe(ownerUserId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("etag")).toBe(activityDayEtag);
    expect(await response.json()).toMatchObject({ data: { totalDurationMinutes: 35 } });
  });

  it("rejects extra query keys, mismatched days, and malformed ETags", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          data: {
            localDate: "2026-08-16",
            timeZone: "America/Chicago",
            revision: "0",
            entries: [],
            totalDurationMinutes: 0,
            updatedAt: null,
          },
        },
        { headers: { etag: '"0"' } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const invalid = await proxyActivityGet(
      new Request("https://app.example.test/api/activities?date=2026-08-15&goal=30", {
        headers: privateHeaders(),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const malformed = await proxyActivityGet(
      new Request("https://app.example.test/api/activities?date=2026-08-15", {
        headers: privateHeaders(),
      }),
    );
    expect(malformed.status).toBe(502);
    expect(malformed.headers.get("etag")).toBeNull();
  });
});

describe("web activity mutation proxy", () => {
  it("forwards a strict create with the required nullable energy and zone guard", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json(mutationData(), { status: 201 });
      }),
    );
    const body = {
      name: "Trail run",
      durationMinutes: 35,
      selfReportedEnergyKilocalories: null,
      occurredAt: "2026-08-15T13:05:01.000Z",
    };
    const response = await proxyActivityCreate(
      new Request(
        "https://app.example.test/api/activities/entries?profileTimeZonePrecondition=v1",
        {
          method: "POST",
          headers: mutationHeaders({ "x-expected-profile-time-zone": "America/Chicago" }),
          body: JSON.stringify(body),
        },
      ),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"2"');
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4000/v1/activities/entries?profileTimeZonePrecondition=v1",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("idempotency-key")).toBe(operationId);
    expect(headers.get("x-expected-owner-user-id")).toBe(ownerUserId);
    expect(headers.get("x-expected-profile-time-zone")).toBe("America/Chicago");
  });

  it("rejects cross-origin, expanded, and missing-zone create requests before fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const body = {
      name: "Trail run",
      durationMinutes: 35,
      selfReportedEnergyKilocalories: null,
      occurredAt: "2026-08-15T13:05:01.000Z",
    };
    const make = (headers: Record<string, string>, requestBody: unknown = body) =>
      proxyActivityCreate(
        new Request(
          "https://app.example.test/api/activities/entries?profileTimeZonePrecondition=v1",
          { method: "POST", headers, body: JSON.stringify(requestBody) },
        ),
      );
    expect(
      await make(
        mutationHeaders({
          origin: "https://evil.example.test",
          "sec-fetch-site": "cross-site",
          "x-expected-profile-time-zone": "America/Chicago",
        }),
      ),
    ).toHaveProperty("status", 403);
    expect(
      await make(mutationHeaders({ "x-expected-profile-time-zone": "America/Chicago" }), {
        ...body,
        goal: 30,
      }),
    ).toHaveProperty("status", 400);
    expect(await make(mutationHeaders())).toHaveProperty("status", 400);
    expect(
      await make(
        mutationHeaders({
          "x-expected-owner-user-id": "not-an-owner-id",
          "x-expected-profile-time-zone": "America/Chicago",
        }),
      ),
    ).toHaveProperty("status", 400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards an occurredAt PATCH only with the paired zone precondition", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json(mutationData(entry));
      }),
    );
    const response = await proxyActivityChange(
      new Request(
        `https://app.example.test/api/activities/entries/${entry.id}?profileTimeZonePrecondition=v1`,
        {
          method: "PATCH",
          headers: mutationHeaders({
            "if-match": '"2"',
            "x-expected-profile-time-zone": "America/Chicago",
          }),
          body: JSON.stringify({ occurredAt: "2026-08-15T14:00:00.000Z" }),
        },
      ),
      entry.id,
      "PATCH",
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:4000/v1/activities/entries/${entry.id}?profileTimeZonePrecondition=v1`,
    );
    expect(new Headers(calls[0]?.init?.headers).get("x-expected-profile-time-zone")).toBe(
      "America/Chicago",
    );
    expect(new Headers(calls[0]?.init?.headers).get("x-expected-owner-user-id")).toBe(ownerUserId);
  });

  it("rejects a zone guard on a field-only PATCH and every query or body on DELETE", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const patch = await proxyActivityChange(
      new Request(
        `https://app.example.test/api/activities/entries/${entry.id}?profileTimeZonePrecondition=v1`,
        {
          method: "PATCH",
          headers: mutationHeaders({
            "if-match": '"2"',
            "x-expected-profile-time-zone": "America/Chicago",
          }),
          body: JSON.stringify({ durationMinutes: 45 }),
        },
      ),
      entry.id,
      "PATCH",
    );
    expect(patch.status).toBe(400);
    const remove = await proxyActivityChange(
      new Request(`https://app.example.test/api/activities/entries/${entry.id}?force=1`, {
        method: "DELETE",
        headers: mutationHeaders({ "if-match": '"2"' }),
      }),
      entry.id,
      "DELETE",
    );
    expect(remove.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
