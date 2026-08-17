import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyExportArtifact, proxyRetentionRequest } from "../app/api/retention/proxy";
import { SESSION_COOKIE } from "./private-api";

const operationId = "61eec75e-fe16-47e4-9f7b-efb6914ad9dc";
const exportId = "018f6f58-4e2c-7b62-8f0b-3d75491713b5";
const reauthenticationToken = "r".repeat(43);
const customFoodId = "118f6f58-4e2c-7b62-8f0b-3d75491713b5";
const erasureId = "318f6f58-4e2c-7b62-8f0b-3d75491713b5";
const erasureToken = "s".repeat(43);

function erasure(status: "queued" | "completed" = "queued") {
  const instant = "2026-08-16T08:00:00.000Z";
  return {
    id: erasureId,
    status,
    requestedAt: instant,
    startedAt: status === "completed" ? instant : null,
    completedAt: status === "completed" ? instant : null,
    executeAfter: "2026-08-17T08:00:00.000Z",
    recentAuthenticationSatisfied: true,
    consequences: ["ACCOUNT_ACCESS_REVOKED", "PRIVATE_HEALTH_DATA_DELETED", "EXPORT_LINKS_REVOKED"],
    failureCode: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

function mutationRequest(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new Request(`https://app.example.test/api/retention/${path}`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${"t".repeat(43)}`,
      "content-type": "application/json",
      "idempotency-key": operationId,
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

describe("retention same-origin adapter", () => {
  it("accepts the non-mutation custom-food detail envelope for GET", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            customFood: {
              id: customFoodId,
              status: "active",
              revision: "1",
              currentVersion: {
                id: "218f6f58-4e2c-7b62-8f0b-3d75491713b5",
                versionNumber: 1,
                name: "Private oats",
                brandName: null,
                notes: null,
                serving: { id: "31", label: "1 bowl", grams: "40" },
                nutrients: [
                  {
                    nutrient: { id: "1", code: "energy", name: "Energy", unit: "kcal" },
                    state: "quantified",
                    amountPer100Grams: "375",
                  },
                ],
                provenance: { kind: "user_entered", statement: "Entered by account owner." },
                createdAt: "2026-08-16T08:00:00.000Z",
              },
              createdAt: "2026-08-16T08:00:00.000Z",
              updatedAt: "2026-08-16T08:00:00.000Z",
            },
          },
        }),
      ),
    );
    const response = await proxyRetentionRequest(
      new Request(`https://app.example.test/api/retention/custom-foods/${customFoodId}`, {
        headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` },
      }),
      ["custom-foods", customFoodId],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { customFood: { id: customFoodId } } });
  });

  it("rejects unreviewed queries before an upstream request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyRetentionRequest(
      new Request(
        "https://app.example.test/api/retention/trends/nutrients?nutrientId=1&from=2026-08-01&to=2026-08-07&debug=1",
        { headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` } },
      ),
      ["trends", "nutrients"],
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a single-use recent-auth proof only to the export request", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({
          data: {
            replayed: false,
            export: {
              id: exportId,
              status: "queued",
              formats: ["json", "csv"],
              requestedAt: "2026-08-16T08:00:00.000Z",
              startedAt: null,
              completedAt: null,
              expiresAt: null,
              artifacts: [],
              manifestSha256: null,
              reconciliation: null,
              failureCode: null,
            },
          },
        });
      }),
    );
    const response = await proxyRetentionRequest(
      mutationRequest(
        "exports",
        { formats: ["json", "csv"] },
        {
          "x-reauthentication-token": reauthenticationToken,
          "x-device-signature": "must-not-forward",
        },
      ),
      ["exports"],
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/exports");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-reauthentication-token")).toBe(reauthenticationToken);
    expect(headers.get("x-device-signature")).toBeNull();
    expect(headers.get("idempotency-key")).toBe(operationId);
  });

  it("requires recent authentication without consuming the stable retry key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxyRetentionRequest(
      mutationRequest("account/erasure", { confirmation: "DELETE_MY_ACCOUNT" }),
      ["account", "erasure"],
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ code: "RECENT_AUTH_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores an erasure status capability only in a path-scoped HttpOnly cookie", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            replayed: false,
            erasure: erasure(),
            statusCapability: { token: erasureToken, expiresAt },
          },
        }),
      ),
    );
    const response = await proxyRetentionRequest(
      mutationRequest(
        "account/erasure",
        { confirmation: "DELETE_MY_ACCOUNT" },
        { "x-reauthentication-token": reauthenticationToken },
      ),
      ["account", "erasure"],
    );
    expect(response.status).toBe(200);
    const browserBody = await response.json();
    expect(browserBody).toEqual({ data: { replayed: false, erasure: erasure() } });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Secure-nutrition_erasure_status=");
    expect(cookie).toContain("Path=/api/retention/account/erasure/status");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(JSON.stringify(browserBody)).not.toContain(erasureToken);
  });

  it("stages and replays an exact HttpOnly erasure envelope after a lost response", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const staged = await proxyRetentionRequest(
      mutationRequest(
        "account/erasure/stage",
        { confirmation: "DELETE_MY_ACCOUNT" },
        { "x-reauthentication-token": reauthenticationToken },
      ),
      ["account", "erasure", "stage"],
    );
    expect(staged.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
    const pendingCookie = staged.headers.get("set-cookie") ?? "";
    expect(pendingCookie).toContain("__Secure-nutrition_erasure_pending=");
    expect(pendingCookie).toContain("Path=/api/retention/account/erasure");
    expect(pendingCookie).toContain("HttpOnly");
    expect(pendingCookie).not.toContain("DELETE_MY_ACCOUNT");

    const requestCookie = pendingCookie.split(";", 1)[0] ?? "";
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        calls.push({ url: url.href, ...(init ? { init } : {}) });
        return Response.json({
          data: {
            replayed: true,
            erasure: erasure(),
            statusCapability: { token: erasureToken, expiresAt },
          },
        });
      }),
    );
    const recovered = await proxyRetentionRequest(
      new Request("https://app.example.test/api/retention/account/erasure/recover", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${"t".repeat(43)}; ${requestCookie}`,
          origin: "https://app.example.test",
          "sec-fetch-site": "same-origin",
        },
      }),
      ["account", "erasure", "recover"],
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ data: { replayed: true, erasure: erasure() } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/v1/account/erasure");
    expect(calls[0]?.init?.body).toBe('{"confirmation":"DELETE_MY_ACCOUNT"}');
    const forwarded = new Headers(calls[0]?.init?.headers);
    expect(forwarded.get("idempotency-key")).toBe(operationId);
    expect(forwarded.get("x-reauthentication-token")).toBe(reauthenticationToken);
    expect(forwarded.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
    const cookies = recovered.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("__Secure-nutrition_erasure_status=");
    expect(cookies).toContain("__Secure-nutrition_erasure_pending=;");
  });

  it("uses only the bound cookie capability after session revocation and rejects duplicates", async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    const cookie = `__Secure-nutrition_erasure_status=${erasureId}.${erasureToken}.${expiresAt}`;
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        calls.push(init ?? {});
        return Response.json({ data: { replayed: false, erasure: erasure() } });
      }),
    );
    const response = await proxyRetentionRequest(
      new Request("https://app.example.test/api/retention/account/erasure/status", {
        headers: { cookie, "x-erasure-status-token": "attacker-controlled" },
      }),
      ["account", "erasure", "status"],
    );
    expect(response.status).toBe(200);
    const forwarded = new Headers(calls[0]?.headers);
    expect(forwarded.get("x-erasure-status-token")).toBe(erasureToken);
    expect(forwarded.get("authorization")).toBeNull();

    const duplicate = await proxyRetentionRequest(
      new Request("https://app.example.test/api/retention/account/erasure/status", {
        headers: { cookie: `${cookie}; ${cookie}` },
      }),
      ["account", "erasure", "status"],
    );
    expect(duplicate.status).toBe(400);
    expect(duplicate.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(calls).toHaveLength(1);
  });

  it("clears the exact erasure capability cookie at terminal status", async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: { replayed: false, erasure: erasure("completed") } }),
      ),
    );
    const response = await proxyRetentionRequest(
      new Request("https://app.example.test/api/retention/account/erasure/status", {
        headers: {
          cookie: `__Secure-nutrition_erasure_status=${erasureId}.${erasureToken}.${expiresAt}`,
        },
      }),
      ["account", "erasure", "status"],
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain(
      "Path=/api/retention/account/erasure/status",
    );
  });

  it("streams reviewed artifacts above 100 MiB and cancels upstream on abort", async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(upstreamBody, {
            headers: {
              "content-type": "application/zip",
              "content-length": String(200 * 1_024 * 1_024),
            },
          }),
      ),
    );
    const controller = new AbortController();
    const response = await proxyExportArtifact(
      new Request(`https://app.example.test/api/retention/exports/${exportId}/artifacts/csv`, {
        headers: { cookie: `${SESSION_COOKIE}=${"t".repeat(43)}` },
        signal: controller.signal,
      }),
      exportId,
      "csv",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(200 * 1_024 * 1_024));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("rejects cross-origin mutations", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = mutationRequest("reminders", {
      label: "Check in",
      localTime: "20:00",
      daysOfWeek: [1],
      timeZone: "America/Chicago",
      channel: "local",
      consentGranted: true,
    });
    const headers = new Headers(request.headers);
    headers.set("origin", "https://attacker.example");
    const response = await proxyRetentionRequest(
      new Request(request.url, { method: request.method, headers, body: await request.text() }),
      ["reminders"],
    );
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
