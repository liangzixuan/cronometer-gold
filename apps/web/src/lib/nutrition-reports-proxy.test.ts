import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyNutritionReport } from "../app/api/reports/proxy";
import { emptyNutritionReportFixture } from "../test/nutrition-report-fixture";
import { SESSION_COOKIE } from "./private-api";

const token = "t".repeat(43);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function request(query: string): Request {
  return new Request(`https://app.example.test/api/reports/nutrition?${query}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

describe("web nutrition-report read proxy", () => {
  it("forwards only the exact validated range with bearer auth and no-store handling", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json(emptyNutritionReportFixture("2026-09-01", "2026-09-02"));
      }),
    );
    const response = await proxyNutritionReport(request("from=2026-09-01&to=2026-09-02"));
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:4000/v1/reports/nutrition?from=2026-09-01&to=2026-09-02",
    );
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    "from=2026-09-01&to=2026-09-02&score=true",
    "from=2026-09-01&from=2026-09-02&to=2026-09-03",
    "from=2026-09-02&to=2026-09-01",
    "from=2026-08-01&to=2026-09-01",
  ])("rejects unreviewed or invalid query semantics: %s", async (query) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await proxyNutritionReport(request(query));
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the private API returns another range or expanded semantics", async () => {
    const fixture = emptyNutritionReportFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { ...fixture.data, to: "2026-09-02", score: 95 } })),
    );
    const response = await proxyNutritionReport(request("from=2026-09-01&to=2026-09-01"));
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not call the private API without a valid host-only session", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await proxyNutritionReport(
      new Request("https://app.example.test/api/reports/nutrition?from=2026-09-01&to=2026-09-01"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
