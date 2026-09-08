import { afterEach, describe, expect, it, vi } from "vitest";

import {
  proxyDiaryChange,
  proxyDiaryCreate,
  proxyDiaryGet,
  proxyDiaryReorder,
  proxyDiaryRepeat,
} from "../app/api/diary/proxy";
import { diaryDayOrderDigest } from "./diary";
import { SESSION_COOKIE, validatedDiaryDate, validatedDiaryReadQuery } from "./private-api";

const entry = {
  id: "75d7fa63-4e26-42de-a1f8-0683ce268f62",
  revision: "4",
  entryKind: "food",
  foodVersionId: "202",
  recipeVersionId: null,
  portion: { kind: "serving", servingId: "303", amount: "2", servingLabel: "medium apple" },
  food: { name: "Apple", brandName: null },
  recipe: null,
  source: {
    code: "USDA_FDC",
    releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
  },
  foodProvenance: {
    kind: "public",
    source: {
      code: "USDA_FDC",
      releaseId: "ea8c79b4-49b0-4548-8ae6-c1b228317f19",
      displayName: "USDA FoodData Central",
      licenseExpression: "CC0-1.0",
      attributionRequired: true,
      attributionText: "Data source: USDA FoodData Central",
    },
  },
  mealSlot: "breakfast",
  resolvedGrams: "364",
  note: "  before meal\nafter meal  ",
  occurredAt: "2026-08-15T13:30:00.000Z",
  localDate: "2026-08-15",
  timeZone: "America/Chicago",
  localTime: "08:30:00.000",
  position: 0,
  nutrients: [],
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("web diary read query and proxy", () => {
  it("keeps legacy date-only reads while validating opt-in pagination separately", () => {
    const request = (query: string) => new Request(`https://app.example.test/api/diary?${query}`);
    expect(validatedDiaryReadQuery(request("date=2026-08-15"))).toEqual({
      date: "2026-08-15",
    });
    expect(
      validatedDiaryReadQuery(request("date=2026-08-15&limit=20&cursor=d1.page_2-next")),
    ).toEqual({ date: "2026-08-15", limit: 20, cursor: "d1.page_2-next" });
    expect(validatedDiaryReadQuery(request("date=2026-08-15&cursor=page_2"))).toBeNull();
    expect(
      validatedDiaryReadQuery(request("date=2026-08-15&limit=20&cursor=page_2.next")),
    ).toBeNull();
    expect(validatedDiaryReadQuery(request("date=2026-08-15&limit=21"))).toBeNull();
    expect(
      validatedDiaryReadQuery(request(`date=2026-08-15&limit=20&cursor=${"x".repeat(513)}`)),
    ).toBeNull();
    expect(validatedDiaryReadQuery(request("date=2026-08-15&limit=20&limit=20"))).toBeNull();
    expect(validatedDiaryReadQuery(request("date=2026-08-15&limit=20&extra=true"))).toBeNull();
    expect(validatedDiaryDate(request("date=2026-08-15&limit=20"))).toBeNull();
  });

  it("forwards only the reviewed paged keys and preserves page metadata, ETag, and no-store", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        calls.push(url.href);
        return Response.json(
          {
            data: {
              id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
              localDate: "2026-08-15",
              timeZone: "America/Chicago",
              status: "open",
              revision: "8",
              orderDigest: "a".repeat(64),
              entries: [entry],
              totals: [],
              updatedAt: "2026-08-15T13:30:01.000Z",
            },
            page: { nextCursor: null, totalEntries: 1 },
          },
          { headers: { etag: '"8"' } },
        );
      }),
    );
    const response = await proxyDiaryGet(
      new Request(
        "https://app.example.test/api/diary?date=2026-08-15&limit=20&cursor=d1.page_2-next",
        { headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` } },
      ),
    );
    expect(calls).toEqual([
      "http://127.0.0.1:4000/v1/diary?date=2026-08-15&limit=20&cursor=d1.page_2-next",
    ]);
    expect(await response.json()).toMatchObject({ page: { nextCursor: null, totalEntries: 1 } });
    expect(response.headers.get("etag")).toBe('"8"');
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("fails closed when paged upstream metadata contains a malformed cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            id: "7f2a4824-872e-4616-9cd1-d63cf1beae51",
            localDate: "2026-08-15",
            timeZone: "America/Chicago",
            status: "open",
            revision: "8",
            orderDigest: "a".repeat(64),
            entries: [entry],
            totals: [],
            updatedAt: "2026-08-15T13:30:01.000Z",
          },
          page: { nextCursor: "page_2.next", totalEntries: 2 },
        }),
      ),
    );
    const response = await proxyDiaryGet(
      new Request("https://app.example.test/api/diary?date=2026-08-15&limit=20", {
        headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` },
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The diary service returned an invalid response.",
    });
  });

  it("forwards a legacy date-only read unchanged and does not invent wire page metadata", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        calls.push(url.href);
        return Response.json({
          data: {
            id: null,
            localDate: "2026-08-15",
            timeZone: "America/Chicago",
            status: "open",
            revision: "0",
            orderDigest: "a".repeat(64),
            entries: [],
            totals: [],
            updatedAt: null,
          },
        });
      }),
    );
    const response = await proxyDiaryGet(
      new Request("https://app.example.test/api/diary?date=2026-08-15", {
        headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` },
      }),
    );
    expect(calls).toEqual(["http://127.0.0.1:4000/v1/diary?date=2026-08-15"]);
    expect(await response.json()).toEqual({
      data: {
        id: null,
        localDate: "2026-08-15",
        timeZone: "America/Chicago",
        status: "open",
        revision: "0",
        orderDigest: "a".repeat(64),
        entries: [],
        totals: [],
        updatedAt: null,
      },
    });
  });
});

describe("web diary mutation proxy", () => {
  it("forwards a guarded create marker and canonical expected profile time zone as one pair", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json(
          {
            data: {
              replayed: false,
              entry: {
                ...entry,
                revision: "1",
                portion: { kind: "grams", grams: "125.5" },
                resolvedGrams: "125.5",
              },
              affectedDays: [{ localDate: "2026-08-15", revision: "5" }],
            },
          },
          { status: 201 },
        );
      }),
    );
    const body = {
      foodVersionId: "202",
      portion: { kind: "grams", grams: "125.5" },
      mealSlot: "breakfast",
      occurredAt: "2026-08-15T13:30:00.000Z",
    };
    const response = await proxyDiaryCreate(
      new Request(
        "https://app.example.test/api/diary/entries?date=2026-08-15&profileTimeZonePrecondition=v1",
        {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
            "content-type": "application/json",
            "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc", // gitleaks:allow -- deterministic UUID fixture
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
            "x-expected-profile-time-zone": "America/Chicago",
          },
          body: JSON.stringify(body),
        },
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4000/v1/diary/entries?profileTimeZonePrecondition=v1",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
    expect(headers.get("idempotency-key")).toBe("61eec75e-fe16-47e4-9f7b-efb6914ad9dc");
    expect(headers.get("x-expected-profile-time-zone")).toBe("America/Chicago");
  });

  it("rejects missing, unpaired, duplicate, or unsupported create guards before upstream", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const create = (query: string, expectedTimeZone?: string) =>
      proxyDiaryCreate(
        new Request(`https://app.example.test/api/diary/entries${query}`, {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
            "content-type": "application/json",
            "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc", // gitleaks:allow -- deterministic UUID fixture
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
            ...(expectedTimeZone ? { "x-expected-profile-time-zone": expectedTimeZone } : {}),
          },
          body: JSON.stringify({
            foodVersionId: "202",
            portion: { kind: "grams", grams: "125.5" },
            mealSlot: "breakfast",
            occurredAt: "2026-08-15T13:30:00.000Z",
          }),
        }),
      );

    const rejected = await Promise.all([
      create("?date=2026-08-15"),
      create("?date=2026-08-15", "America/Chicago"),
      create("?date=2026-08-15&profileTimeZonePrecondition=v1"),
      create("?date=2026-08-15&profileTimeZonePrecondition=v2", "America/Chicago"),
      create("?date=2026-08-15&profileTimeZonePrecondition=v1", "Not/A-Time-Zone"),
      create(
        "?date=2026-08-15&profileTimeZonePrecondition=v1&profileTimeZonePrecondition=v1",
        "America/Chicago",
      ),
      create("?date=2026-08-15&profileTimeZonePrecondition=v1&extra=true", "America/Chicago"),
    ]);
    expect(rejected.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400, 400, 400,
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps guarded creates behind the trusted-origin and bounded-body checks", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const headers = {
      cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
      "content-type": "application/json",
      "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc", // gitleaks:allow -- deterministic UUID fixture
      "x-expected-profile-time-zone": "America/Chicago",
    };
    const crossOrigin = await proxyDiaryCreate(
      new Request(
        "https://app.example.test/api/diary/entries?date=2026-08-15&profileTimeZonePrecondition=v1",
        {
          method: "POST",
          headers: {
            ...headers,
            origin: "https://evil.example.test",
            "sec-fetch-site": "cross-site",
          },
          body: JSON.stringify({ foodVersionId: "202" }),
        },
      ),
    );
    expect(crossOrigin.status).toBe(403);

    const oversized = await proxyDiaryCreate(
      new Request(
        "https://app.example.test/api/diary/entries?date=2026-08-15&profileTimeZonePrecondition=v1",
        {
          method: "POST",
          headers: {
            ...headers,
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify({ value: "x".repeat(16_385) }),
        },
      ),
    );
    expect(oversized.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves a serving portion patch and forwards only reviewed concurrency headers", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({
          data: {
            replayed: false,
            entry,
            affectedDays: [{ localDate: "2026-08-15", revision: "5" }],
            receipt: {
              protocol: "v1",
              operationId: "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
              kind: "update",
              expectedSubjects: [{ entryId: entry.id, revision: "3" }],
              resultSubjects: [{ entryId: entry.id, revision: "4", state: "active" }],
              affectedDays: [{ localDate: "2026-08-15", revision: "5" }],
            },
          },
        });
      }),
    );
    const body = {
      portion: { kind: "serving", servingId: "303", amount: "2" },
      mealSlot: "breakfast",
      occurredAt: "2026-08-15T13:30:00.000Z",
      note: "  before meal\nafter meal  ",
    };
    const response = await proxyDiaryChange(
      new Request(
        "https://app.example.test/api/diary/entries/75d7fa63-4e26-42de-a1f8-0683ce268f62?date=2026-08-15&profileTimeZonePrecondition=v1",
        {
          method: "PATCH",
          headers: {
            cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
            "content-type": "application/json",
            "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
            "if-match": '"3"',
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
            "x-expected-profile-time-zone": "America/Chicago",
          },
          body: JSON.stringify(body),
        },
      ),
      entry.id,
      "PATCH",
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4000/v1/diary/entries/75d7fa63-4e26-42de-a1f8-0683ce268f62?diaryCorrectionProtocol=v1&profileTimeZonePrecondition=v1",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("if-match")).toBe('"3"');
    expect(headers.get("idempotency-key")).toBe("61eec75e-fe16-47e4-9f7b-efb6914ad9dc");
    expect(headers.get("x-expected-profile-time-zone")).toBe("America/Chicago");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("repeats through the immutable source revision with a stable operation key", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({
          data: {
            replayed: false,
            entry: {
              ...entry,
              id: "018f6f58-4e2c-7b62-8f0b-3d75491713b5",
              revision: "1",
              occurredAt: "2026-08-16T13:30:00.000Z",
              localDate: "2026-08-16",
            },
            affectedDays: [{ localDate: "2026-08-16", revision: "1" }],
            receipt: {
              protocol: "v1",
              operationId: "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
              kind: "repeat",
              expectedSubjects: [{ entryId: entry.id, revision: "4" }],
              resultSubjects: [
                {
                  entryId: "018f6f58-4e2c-7b62-8f0b-3d75491713b5",
                  revision: "1",
                  state: "active",
                },
              ],
              affectedDays: [{ localDate: "2026-08-16", revision: "1" }],
            },
          },
        });
      }),
    );
    const body = { occurredAt: "2026-08-16T13:30:00.000Z", mealSlot: "breakfast" };
    const response = await proxyDiaryRepeat(
      new Request(
        `https://app.example.test/api/diary/entries/${entry.id}/repeat?date=2026-08-15&profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
            "content-type": "application/json",
            "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc", // gitleaks:allow -- deterministic UUID fixture
            "if-match": '"4"',
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
            "x-expected-profile-time-zone": "America/Chicago",
          },
          body: JSON.stringify(body),
        },
      ),
      entry.id,
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:4000/v1/diary/corrections/entries/${entry.id}/repeat?profileTimeZonePrecondition=v1`,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("if-match")).toBe('"4"');
    expect(headers.get("idempotency-key")).toBe("61eec75e-fe16-47e4-9f7b-efb6914ad9dc");
    expect(headers.get("x-expected-profile-time-zone")).toBe("America/Chicago");
  });

  it("deletes through the durable correction protocol and verifies the exact subject", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({
          data: {
            replayed: false,
            entry: null,
            affectedDays: [{ localDate: "2026-08-15", revision: "6" }],
            receipt: {
              protocol: "v1",
              operationId: "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
              kind: "delete",
              expectedSubjects: [{ entryId: entry.id, revision: "4" }],
              resultSubjects: [{ entryId: entry.id, revision: "5", state: "deleted" }],
              affectedDays: [{ localDate: "2026-08-15", revision: "6" }],
            },
          },
        });
      }),
    );
    const response = await proxyDiaryChange(
      new Request(`https://app.example.test/api/diary/entries/${entry.id}?date=2026-08-15`, {
        method: "DELETE",
        headers: {
          cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
          "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc", // gitleaks:allow -- fixture UUID
          "if-match": '"4"',
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
      }),
      entry.id,
      "DELETE",
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:4000/v1/diary/entries/${entry.id}?diaryCorrectionProtocol=v1`,
    );
  });

  it("fails closed on internally coherent correction results that do not match the request", async () => {
    const operationId = "61eec75e-fe16-47e4-9f7b-efb6914ad9dc"; // gitleaks:allow -- fixture UUID
    let upstreamBody: unknown = {
      data: {
        replayed: false,
        entry,
        affectedDays: [{ localDate: "2026-08-15", revision: "5" }],
        receipt: {
          protocol: "v1",
          operationId,
          kind: "update",
          expectedSubjects: [{ entryId: entry.id, revision: "3" }],
          resultSubjects: [{ entryId: entry.id, revision: "4", state: "active" }],
          affectedDays: [{ localDate: "2026-08-15", revision: "5" }],
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(upstreamBody)),
    );
    const trustedHeaders = {
      cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
      "idempotency-key": operationId,
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
    };

    const wrongUpdate = await proxyDiaryChange(
      new Request(`https://app.example.test/api/diary/entries/${entry.id}?date=2026-08-15`, {
        method: "PATCH",
        headers: {
          ...trustedHeaders,
          "content-type": "application/json",
          "if-match": '"3"',
        },
        body: JSON.stringify({
          portion: { kind: "serving", servingId: "303", amount: "1" },
        }),
      }),
      entry.id,
      "PATCH",
    );
    expect(wrongUpdate.status).toBe(502);

    upstreamBody = {
      data: {
        replayed: false,
        entry: {
          ...entry,
          revision: "1",
          occurredAt: "2026-08-16T13:30:00.000Z",
          localDate: "2026-08-16",
        },
        affectedDays: [{ localDate: "2026-08-16", revision: "1" }],
        receipt: {
          protocol: "v1",
          operationId,
          kind: "repeat",
          expectedSubjects: [{ entryId: entry.id, revision: "4" }],
          resultSubjects: [{ entryId: entry.id, revision: "1", state: "active" }],
          affectedDays: [{ localDate: "2026-08-16", revision: "1" }],
        },
      },
    };
    const wrongRepeat = await proxyDiaryRepeat(
      new Request(
        `https://app.example.test/api/diary/entries/${entry.id}/repeat?date=2026-08-15&profileTimeZonePrecondition=v1`,
        {
          method: "POST",
          headers: {
            ...trustedHeaders,
            "content-type": "application/json",
            "if-match": '"4"',
            "x-expected-profile-time-zone": "America/Chicago",
          },
          body: JSON.stringify({
            occurredAt: "2026-08-16T13:30:00.000Z",
            mealSlot: "breakfast",
          }),
        },
      ),
      entry.id,
    );
    expect(wrongRepeat.status).toBe(502);

    upstreamBody = {
      data: {
        replayed: false,
        entry: null,
        affectedDays: [{ localDate: "2026-08-15", revision: "6" }],
        receipt: {
          protocol: "v1",
          operationId,
          kind: "delete",
          expectedSubjects: [{ entryId: entry.id, revision: "4" }],
          resultSubjects: [{ entryId: entry.id, revision: "6", state: "deleted" }],
          affectedDays: [{ localDate: "2026-08-15", revision: "6" }],
        },
      },
    };
    const wrongDelete = await proxyDiaryChange(
      new Request(`https://app.example.test/api/diary/entries/${entry.id}?date=2026-08-15`, {
        method: "DELETE",
        headers: { ...trustedHeaders, "if-match": '"4"' },
      }),
      entry.id,
      "DELETE",
    );
    expect(wrongDelete.status).toBe(502);
  });

  it("forwards one complete atomic reorder and verifies its canonical strong receipt", async () => {
    const resultGroups = [
      {
        mealSlot: "breakfast" as const,
        entries: [{ entryId: entry.id, entryRevision: "5", position: 0 }],
      },
      { mealSlot: "lunch" as const, entries: [] },
      { mealSlot: "dinner" as const, entries: [] },
      { mealSlot: "snacks" as const, entries: [] },
    ] as const;
    const orderDigest = await diaryDayOrderDigest("2026-08-15", "America/Chicago", resultGroups);
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({
          data: {
            replayed: false,
            receipt: {
              operationId: "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
              localDate: "2026-08-15",
              timeZone: "America/Chicago",
              expectedDayRevision: "8",
              resultingDayRevision: "9",
              previousOrderDigest: "a".repeat(64),
              orderDigest,
              groups: resultGroups,
            },
          },
        });
      }),
    );
    const body = {
      groups: { breakfast: [0], lunch: [], dinner: [], snacks: [] },
    };
    const response = await proxyDiaryReorder(
      new Request(
        "https://app.example.test/api/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
        {
          method: "PUT",
          headers: {
            cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
            "content-type": "application/json",
            "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc", // gitleaks:allow -- fixture UUID
            "if-match": '"8"',
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
            "x-expected-diary-order-digest": "a".repeat(64),
            "x-expected-profile-time-zone": "America/Denver",
          },
          body: JSON.stringify(body),
        },
      ),
      "2026-08-15",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"9"');
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4000/v1/diary/days/2026-08-15/order?profileTimeZonePrecondition=v1",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-expected-diary-order-digest")).toBe("a".repeat(64));
    expect(headers.get("x-expected-profile-time-zone")).toBe("America/Denver");
  });
});
