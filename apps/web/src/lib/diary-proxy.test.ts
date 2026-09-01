import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyDiaryChange, proxyDiaryRepeat } from "../app/api/diary/proxy";
import { SESSION_COOKIE } from "./private-api";

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

describe("web diary mutation proxy", () => {
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
        "https://app.example.test/api/diary/entries/75d7fa63-4e26-42de-a1f8-0683ce268f62?date=2026-08-15",
        {
          method: "PATCH",
          headers: {
            cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
            "content-type": "application/json",
            "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc",
            "if-match": '"3"',
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify(body),
        },
      ),
      entry.id,
      "PATCH",
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4000/v1/diary/entries/75d7fa63-4e26-42de-a1f8-0683ce268f62",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("if-match")).toBe('"3"');
    expect(headers.get("idempotency-key")).toBe("61eec75e-fe16-47e4-9f7b-efb6914ad9dc");
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
            entry: { ...entry, id: "018f6f58-4e2c-7b62-8f0b-3d75491713b5", revision: "1" },
            affectedDays: [{ localDate: "2026-08-16", revision: "1" }],
          },
        });
      }),
    );
    const body = { occurredAt: "2026-08-16T13:30:00.000Z", mealSlot: "breakfast" };
    const response = await proxyDiaryRepeat(
      new Request(`https://app.example.test/api/diary/entries/${entry.id}/repeat`, {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
          "content-type": "application/json",
          "idempotency-key": "61eec75e-fe16-47e4-9f7b-efb6914ad9dc", // gitleaks:allow -- deterministic UUID fixture
          "if-match": '"4"',
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(body),
      }),
      entry.id,
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:4000/v1/diary/entries/${entry.id}/repeat`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("if-match")).toBe('"4"');
    expect(headers.get("idempotency-key")).toBe("61eec75e-fe16-47e4-9f7b-efb6914ad9dc");
  });
});
