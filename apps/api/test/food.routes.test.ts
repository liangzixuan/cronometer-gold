import { Writable } from "node:stream";

import type { FoodSearchHit } from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HttpProblem } from "../src/http/problem.js";
import { createLoggerOptions } from "../src/logging.js";
import type { FoodSearchService } from "../src/modules/foods/food.routes.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

const hit: FoodSearchHit = {
  foodId: "101",
  foodVersionId: "202",
  kind: "branded",
  name: "Apple Pie",
  brandName: "Orchard Kitchen",
  marketCode: "US",
  languageTag: "en-US",
  source: {
    code: "USDA_FDC",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
  },
  defaultServing: {
    servingId: "303",
    label: "1 slice",
    quantity: "1",
    unit: "slice",
    gramWeight: "125.5",
    milliliterVolume: null,
  },
};

function serviceStub(overrides: Partial<FoodSearchService> = {}): FoodSearchService {
  return {
    search: vi.fn(async () => ({ data: [hit], page: { nextCursor: "next_cursor" } })),
    autocomplete: vi.fn(async () => ({
      data: [
        {
          foodId: hit.foodId,
          foodVersionId: hit.foodVersionId,
          kind: hit.kind,
          label: hit.name,
          brandName: hit.brandName,
          source: hit.source,
        },
      ],
    })),
    lookupBarcode: vi.fn(async () => hit),
    ...overrides,
  };
}

function createTestApp(service?: FoodSearchService): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    ...(service === undefined ? {} : { foodSearchService: service }),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("public food search routes", () => {
  it("canonicalizes filters and forwards the opaque search cursor", async () => {
    const service = serviceStub();
    const app = createTestApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/v1/foods/search?query=%20%EF%BC%A1pple%20%20pie%20&intent=branded&market=us&language=EN-us&limit=5&cursor=cursor_payload.cursor_signature",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [hit], page: { nextCursor: "next_cursor" } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.search).toHaveBeenCalledOnce();
    const input = vi.mocked(service.search).mock.calls[0]?.[0];
    expect(input).toMatchObject({
      query: "Apple pie",
      intent: "branded",
      marketCode: "US",
      languageTag: "en-US",
      limit: 5,
      cursor: "cursor_payload.cursor_signature",
    });
    expect(input?.signal).toBeInstanceOf(AbortSignal);
  });

  it("serves bounded autocomplete suggestions without rights-stale caching", async () => {
    const service = serviceStub();
    const app = createTestApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/v1/foods/autocomplete?query=apple&intent=generic&limit=4",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        {
          foodId: "101",
          foodVersionId: "202",
          kind: "branded",
          label: "Apple Pie",
          brandName: "Orchard Kitchen",
          source: hit.source,
        },
      ],
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({ query: "apple", intent: "generic", limit: 4 }),
    );
  });

  it("performs deterministic barcode lookup and canonicalizes market", async () => {
    const service = serviceStub();
    const app = createTestApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/v1/foods/barcodes/012345678905?market=us",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: hit });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.lookupBarcode).toHaveBeenCalledWith(
      expect.objectContaining({ gtin: "012345678905", marketCode: "US" }),
    );
  });

  it.each([
    "/v1/foods/search?query=apple&intent=private",
    `/v1/foods/search?query=${"a".repeat(129)}`,
    "/v1/foods/search?query=apple&limit=51",
    "/v1/foods/search?query=apple&language=en--US",
    "/v1/foods/search?query=apple&cursor=not%24opaque",
    "/v1/foods/search?query=apple&favoriteFoodIds=101",
    "/v1/foods/autocomplete?query=apple&recentFoodIds=101",
    "/v1/foods/barcodes/1234",
  ])(
    "rejects bounded or caller-personalized input without calling the backend: %s",
    async (url) => {
      const service = serviceStub();
      const app = createTestApp(service);
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
      expect(service.search).not.toHaveBeenCalled();
      expect(service.autocomplete).not.toHaveBeenCalled();
      expect(service.lookupBarcode).not.toHaveBeenCalled();
    },
  );

  it("returns a safe 503 when the food-search backend is not wired", async () => {
    const app = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/foods/search?query=apple",
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      status: 503,
      code: "SERVICE_NOT_READY",
      detail: "Food search is temporarily unavailable.",
    });
  });

  it("does not leak backend failure details", async () => {
    const privateFailure = "private-search-cluster-host-must-not-leak";
    const service = serviceStub({
      search: vi.fn(async () => {
        throw new Error(privateFailure);
      }),
    });
    const app = createTestApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/v1/foods/search?query=apple",
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(privateFailure);
    expect(response.json()).toMatchObject({
      code: "SERVICE_NOT_READY",
      detail: "Food search is temporarily unavailable.",
    });
  });

  it("preserves deliberate adapter problems such as an invalid opaque cursor", async () => {
    const service = serviceStub({
      search: vi.fn(async () => {
        throw new HttpProblem({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          title: "Bad Request",
          detail: "The pagination cursor is invalid or expired.",
          issues: [{ path: "/cursor", code: "invalid", message: "Invalid value." }],
          expose: true,
        });
      }),
    });
    const app = createTestApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/v1/foods/search?query=apple&cursor=syntactically_valid",
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      detail: "The pagination cursor is invalid or expired.",
      issues: [{ path: "/cursor", code: "invalid", message: "Invalid value." }],
    });
  });

  it("returns the same safe barcode miss contract without echoing the GTIN", async () => {
    const service = serviceStub({ lookupBarcode: vi.fn(async () => null) });
    const app = createTestApp(service);
    const first = await app.inject({ method: "GET", url: "/v1/foods/barcodes/012345678905" });
    const second = await app.inject({ method: "GET", url: "/v1/foods/barcodes/012345678905" });

    for (const response of [first, second]) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("012345678905");
      expect(response.json()).toMatchObject({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        code: "NOT_FOUND",
        detail: "No current public food matches this barcode.",
      });
    }
  });

  it("never writes raw food queries, request bodies, or backend messages to logs", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const logger = { ...createLoggerOptions(config), stream };
    const service = serviceStub({
      search: vi.fn(async () => {
        throw new Error("private-backend-body-value");
      }),
    });
    const app = buildApp({ config, logger, foodSearchService: service });
    apps.push(app);

    await app.inject({
      method: "GET",
      url: "/v1/foods/search?query=private-diet-query",
    });

    expect(output).toContain("/v1/foods/search");
    expect(output).not.toContain("private-diet-query");
    expect(output).not.toContain("private-backend-body-value");
    expect(output).not.toContain('"body"');
  });
});
