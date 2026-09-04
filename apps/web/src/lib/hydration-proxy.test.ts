import { afterEach, describe, expect, it, vi } from "vitest";

import {
  proxyHydrationChange,
  proxyHydrationCreate,
  proxyHydrationGet,
} from "../app/api/hydration/proxy";
import { SESSION_COOKIE } from "./private-api";

const token = "t".repeat(43);
const hydrationDayEtag = `"h-${"a".repeat(43)}"`;
const changedTimeZoneHydrationDayEtag = `"h-${"b".repeat(43)}"`;
const hydrationOperationId = globalThis.crypto.randomUUID();
const entry = {
  id: "3bcfa2bf-4950-43f7-9f24-b983ac803012",
  revision: "2",
  amountMilliliters: 375,
  occurredAt: "2026-08-15T13:05:01.000Z",
  localDate: "2026-08-15",
  localTime: "08:05:01.000",
  timeZone: "America/Chicago",
  createdAt: "2026-08-15T13:05:02.000Z",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function privateHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${token}`, ...extra };
}

describe("web hydration read proxy", () => {
  it("forwards one validated local date with bearer auth and returns exact no-store data", async () => {
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
              totalMilliliters: 375,
              updatedAt: "2026-08-15T13:05:02.000Z",
            },
          },
          {
            headers: { etag: hydrationDayEtag },
          },
        );
      }),
    );
    const response = await proxyHydrationGet(
      new Request("https://app.example.test/api/hydration?date=2026-08-15", {
        headers: privateHeaders(),
      }),
    );
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/hydration?date=2026-08-15");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("etag")).toBe(hydrationDayEtag);
    expect(await response.json()).toMatchObject({ data: { totalMilliliters: 375 } });
  });

  it("rejects extra query keys and mismatched upstream local dates", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: {
          localDate: "2026-08-16",
          timeZone: "America/Chicago",
          revision: "0",
          entries: [],
          totalMilliliters: 0,
          updatedAt: null,
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const invalid = await proxyHydrationGet(
      new Request("https://app.example.test/api/hydration?date=2026-08-15&target=2000", {
        headers: privateHeaders(),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();

    const mismatched = await proxyHydrationGet(
      new Request("https://app.example.test/api/hydration?date=2026-08-15", {
        headers: privateHeaders(),
      }),
    );
    expect(mismatched.status).toBe(502);
    expect(mismatched.headers.get("cache-control")).toContain("no-store");
  });

  it("preserves distinct exact-response ETags when an empty day's profile zone changes", async () => {
    const variants = [
      { timeZone: "America/Chicago", etag: hydrationDayEtag },
      { timeZone: "America/Los_Angeles", etag: changedTimeZoneHydrationDayEtag },
    ] as const;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const variant = variants[call];
        call += 1;
        if (!variant) throw new Error("Unexpected hydration fetch");
        return Response.json(
          {
            data: {
              localDate: "2026-08-15",
              timeZone: variant.timeZone,
              revision: "0",
              entries: [],
              totalMilliliters: 0,
              updatedAt: null,
            },
          },
          { headers: { etag: variant.etag } },
        );
      }),
    );

    const read = () =>
      proxyHydrationGet(
        new Request("https://app.example.test/api/hydration?date=2026-08-15", {
          headers: privateHeaders(),
        }),
      );
    const first = await read();
    const second = await read();

    expect(first.headers.get("etag")).toBe(hydrationDayEtag);
    expect(second.headers.get("etag")).toBe(changedTimeZoneHydrationDayEtag);
    expect(await first.json()).toMatchObject({
      data: { revision: "0", timeZone: "America/Chicago" },
    });
    expect(await second.json()).toMatchObject({
      data: { revision: "0", timeZone: "America/Los_Angeles" },
    });
  });

  it.each([
    ["missing", null],
    ["weak", `W/${hydrationDayEtag}`],
    ["numeric revision", '"0"'],
    ["malformed hash", '"h-short"'],
  ] as const)("rejects a %s hydration day ETag", async (_case, etag) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            data: {
              localDate: "2026-08-15",
              timeZone: "America/Chicago",
              revision: "0",
              entries: [],
              totalMilliliters: 0,
              updatedAt: null,
            },
          },
          { headers: etag === null ? {} : { etag } },
        ),
      ),
    );
    const response = await proxyHydrationGet(
      new Request("https://app.example.test/api/hydration?date=2026-08-15", {
        headers: privateHeaders(),
      }),
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("etag")).toBeNull();
  });
});

describe("web hydration mutation proxy", () => {
  it("forwards a bounded create with only reviewed auth and idempotency fields", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json(
          {
            data: {
              replayed: false,
              entry,
              affectedDays: [{ localDate: "2026-08-15", revision: "3" }],
            },
          },
          { status: 201 },
        );
      }),
    );
    const body = { amountMilliliters: 375, occurredAt: "2026-08-15T13:05:01.000Z" };
    const response = await proxyHydrationCreate(
      new Request("https://app.example.test/api/hydration/entries?profileTimeZonePrecondition=v1", {
        method: "POST",
        headers: privateHeaders({
          "content-type": "application/json",
          "idempotency-key": hydrationOperationId,
          "x-expected-profile-time-zone": "America/Chicago",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        }),
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4000/v1/hydration/entries?profileTimeZonePrecondition=v1",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("idempotency-key")).toBe(hydrationOperationId);
    expect(headers.get("x-expected-profile-time-zone")).toBe("America/Chicago");
  });

  it("rejects cross-origin and expanded request bodies before reaching the private API", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const rejectedOrigin = await proxyHydrationCreate(
      new Request("https://app.example.test/api/hydration/entries?profileTimeZonePrecondition=v1", {
        method: "POST",
        headers: privateHeaders({
          "content-type": "application/json",
          "idempotency-key": hydrationOperationId,
          "x-expected-profile-time-zone": "America/Chicago",
          origin: "https://evil.example.test",
          "sec-fetch-site": "cross-site",
        }),
        body: JSON.stringify({
          amountMilliliters: 375,
          occurredAt: "2026-08-15T13:05:01.000Z",
        }),
      }),
    );
    expect(rejectedOrigin.status).toBe(403);

    const expanded = await proxyHydrationCreate(
      new Request("https://app.example.test/api/hydration/entries?profileTimeZonePrecondition=v1", {
        method: "POST",
        headers: privateHeaders({
          "content-type": "application/json",
          "idempotency-key": hydrationOperationId,
          "x-expected-profile-time-zone": "America/Chicago",
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        }),
        body: JSON.stringify({
          amountMilliliters: 375,
          occurredAt: "2026-08-15T13:05:01.000Z",
          targetMilliliters: 2_000,
        }),
      }),
    );
    expect(expanded.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the profile-time-zone create marker and header as a pair", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const request = (url: string, expectedTimeZone?: string) =>
      proxyHydrationCreate(
        new Request(url, {
          method: "POST",
          headers: privateHeaders({
            "content-type": "application/json",
            "idempotency-key": hydrationOperationId,
            ...(expectedTimeZone ? { "x-expected-profile-time-zone": expectedTimeZone } : {}),
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
          }),
          body: JSON.stringify({
            amountMilliliters: 375,
            occurredAt: "2026-08-15T13:05:01.000Z",
          }),
        }),
      );
    expect(await request("https://app.example.test/api/hydration/entries")).toHaveProperty(
      "status",
      400,
    );
    expect(
      await request(
        "https://app.example.test/api/hydration/entries?profileTimeZonePrecondition=v1",
      ),
    ).toHaveProperty("status", 400);
    expect(
      await request(
        "https://app.example.test/api/hydration/entries?profileTimeZonePrecondition=v1",
        "Not/A-Time-Zone",
      ),
    ).toHaveProperty("status", 400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards a strong-revision amount update without changing its bytes", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({
          data: {
            replayed: false,
            entry: { ...entry, revision: "3", amountMilliliters: 500 },
            affectedDays: [{ localDate: "2026-08-15", revision: "4" }],
          },
        });
      }),
    );
    const response = await proxyHydrationChange(
      new Request(`https://app.example.test/api/hydration/entries/${entry.id}`, {
        method: "PATCH",
        headers: privateHeaders({
          "content-type": "application/json",
          "idempotency-key": hydrationOperationId,
          "if-match": '"2"',
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        }),
        body: JSON.stringify({ amountMilliliters: 500 }),
      }),
      entry.id,
      "PATCH",
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:4000/v1/hydration/entries/${entry.id}`);
    expect(calls[0]?.init?.body).toBe('{"amountMilliliters":500}');
    expect(new Headers(calls[0]?.init?.headers).get("if-match")).toBe('"2"');
  });

  it.each([
    ["arbitrary", JSON.stringify({ unexpected: true })],
    ["oversized", JSON.stringify({ padding: "x".repeat(4_096) })],
  ] as const)("rejects %s DELETE bodies before an upstream mutation", async (_case, body) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await proxyHydrationChange(
      new Request(`https://app.example.test/api/hydration/entries/${entry.id}`, {
        method: "DELETE",
        headers: privateHeaders({
          "content-type": "application/json",
          "idempotency-key": hydrationOperationId,
          "if-match": '"2"',
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        }),
        body,
      }),
      entry.id,
      "DELETE",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
