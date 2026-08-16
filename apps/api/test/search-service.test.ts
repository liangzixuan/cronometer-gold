import { SearchBackendError } from "@nutrition-tracker/search";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  getFoodSearchProjectionPublicationState: vi.fn(),
  isValidGtin: vi.fn(),
  lookupPromotedFoodByBarcode: vi.fn(),
  searchPromotedFoodsPostgres: vi.fn(),
}));

vi.mock("@nutrition-tracker/db", () => databaseMocks);

import type { HttpProblem } from "../src/http/problem.js";
import { DatabaseBackedFoodSearchService } from "../src/modules/foods/search-service.js";

const projection = {
  foodId: "10",
  foodVersionId: "101",
  kind: "branded" as const,
  name: "Example Oatmeal",
  normalizedName: "example oatmeal",
  brandName: "Example",
  marketCode: "US",
  languageTag: "en-US",
  dataQuality: "verified" as const,
  sourceCode: "FDC",
  sourceDisplayName: "USDA FoodData Central",
  licenseExpression: "CC0-1.0",
  attributionRequired: true,
  attributionText: "Data source: USDA FoodData Central",
  barcodes: [{ gtin14: "00036000291452" }],
  servings: [
    {
      id: "1001",
      label: "1 bowl",
      quantity: "1.000000",
      unit: "bowl",
      gramWeight: "40.000000",
      milliliterVolume: null,
      isDefault: true,
      displayOrder: 0,
    },
  ],
};

function core() {
  return {
    search: vi.fn(),
    autocomplete: vi.fn(),
    lookupBarcode: vi.fn(),
  };
}

describe("database-backed food-search API adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.getFoodSearchProjectionPublicationState.mockResolvedValue({
      currentRevision: "7",
      publishedRevision: "7",
      isCurrent: true,
    });
    databaseMocks.isValidGtin.mockImplementation((value: string) => value === "036000291452");
  });

  it("maps normal Meilisearch pages to the public contract", async () => {
    const searchCore = core();
    searchCore.search.mockResolvedValue({
      hits: [
        {
          foodId: "10",
          foodVersionId: "101",
          kind: "branded",
          name: "Example Oatmeal",
          brandName: "Example",
          marketCode: "US",
          languageTag: "en-US",
          source: {
            code: "FDC",
            displayName: "USDA FoodData Central",
            licenseExpression: "CC0-1.0",
            attributionRequired: true,
            attributionText: "Data source: USDA FoodData Central",
          },
          defaultServing: null,
        },
      ],
      nextCursor: "cursor.signature",
      estimatedTotalHits: 1,
      hasMore: true,
    });
    const service = new DatabaseBackedFoodSearchService({
      core: searchCore,
      database: {} as never,
    });

    await expect(service.search({ query: "oatmeal", intent: "all", limit: 20 })).resolves.toEqual({
      data: [expect.objectContaining({ foodId: "10", name: "Example Oatmeal" })],
      page: { nextCursor: "cursor.signature" },
    });
    expect(databaseMocks.searchPromotedFoodsPostgres).not.toHaveBeenCalled();
  });

  it("uses a bounded PostgreSQL first-page fallback and never emits a mixed cursor", async () => {
    const searchCore = core();
    searchCore.search.mockRejectedValue(new SearchBackendError("backend unavailable"));
    databaseMocks.searchPromotedFoodsPostgres.mockResolvedValue([
      { document: projection, score: 0.9 },
    ]);
    const service = new DatabaseBackedFoodSearchService({
      core: searchCore,
      database: {} as never,
    });

    await expect(
      service.search({
        query: "oatmeal",
        intent: "branded",
        languageTag: "en-US",
        marketCode: "US",
        limit: 20,
      }),
    ).resolves.toEqual({
      data: [expect.objectContaining({ foodId: "10", name: "Example Oatmeal" })],
      page: { nextCursor: null },
    });
    expect(databaseMocks.searchPromotedFoodsPostgres).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "branded", languageTag: "en-US", marketCode: "US" }),
    );
    await expect(
      service.search({
        query: "oatmeal",
        intent: "all",
        limit: 20,
        cursor: "opaque.signature",
      }),
    ).rejects.toBeInstanceOf(SearchBackendError);
  });

  it("fails closed to PostgreSQL before first publication and across a revision change", async () => {
    const searchCore = core();
    searchCore.search.mockResolvedValue({
      hits: [{ foodId: "999" }],
      nextCursor: null,
      estimatedTotalHits: 1,
      hasMore: false,
    });
    databaseMocks.searchPromotedFoodsPostgres.mockResolvedValue([
      { document: projection, score: 0.9 },
    ]);
    const service = new DatabaseBackedFoodSearchService({
      core: searchCore,
      database: {} as never,
    });

    databaseMocks.getFoodSearchProjectionPublicationState.mockResolvedValueOnce({
      currentRevision: "0",
      publishedRevision: null,
      isCurrent: false,
    });
    await expect(service.search({ query: "oatmeal", intent: "all", limit: 20 })).resolves.toEqual({
      data: [expect.objectContaining({ foodId: "10" })],
      page: { nextCursor: null },
    });
    expect(searchCore.search).not.toHaveBeenCalled();

    searchCore.search.mockClear();
    databaseMocks.searchPromotedFoodsPostgres.mockClear();
    databaseMocks.getFoodSearchProjectionPublicationState
      .mockResolvedValueOnce({ currentRevision: "7", publishedRevision: "7", isCurrent: true })
      .mockResolvedValueOnce({ currentRevision: "8", publishedRevision: "8", isCurrent: true });
    await expect(service.search({ query: "oatmeal", intent: "all", limit: 20 })).resolves.toEqual({
      data: [expect.objectContaining({ foodId: "10" })],
      page: { nextCursor: null },
    });
    expect(searchCore.search).toHaveBeenCalledOnce();
    expect(databaseMocks.searchPromotedFoodsPostgres).toHaveBeenCalledOnce();
  });

  it("rejects a continuation when publication freshness changes", async () => {
    const searchCore = core();
    searchCore.search.mockResolvedValue({
      hits: [],
      nextCursor: null,
      estimatedTotalHits: 0,
      hasMore: false,
    });
    databaseMocks.getFoodSearchProjectionPublicationState
      .mockResolvedValueOnce({ currentRevision: "7", publishedRevision: "7", isCurrent: true })
      .mockResolvedValueOnce({ currentRevision: "8", publishedRevision: "8", isCurrent: true });
    const service = new DatabaseBackedFoodSearchService({
      core: searchCore,
      database: {} as never,
    });

    await expect(
      service.search({
        query: "oatmeal",
        intent: "all",
        limit: 20,
        cursor: "opaque.signature",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(databaseMocks.searchPromotedFoodsPostgres).not.toHaveBeenCalled();
  });

  it("preserves reviewed source attribution in degraded autocomplete", async () => {
    const searchCore = core();
    searchCore.autocomplete.mockRejectedValue(new SearchBackendError("backend unavailable"));
    databaseMocks.searchPromotedFoodsPostgres.mockResolvedValue([
      { document: projection, score: 0.9 },
    ]);
    const service = new DatabaseBackedFoodSearchService({
      core: searchCore,
      database: {} as never,
    });

    await expect(
      service.autocomplete({ query: "oatmeal", intent: "all", limit: 8 }),
    ).resolves.toEqual({
      data: [
        expect.objectContaining({
          label: "Example Oatmeal",
          source: {
            code: "FDC",
            displayName: "USDA FoodData Central",
            licenseExpression: "CC0-1.0",
            attributionRequired: true,
            attributionText: "Data source: USDA FoodData Central",
          },
        }),
      ],
    });
  });

  it("validates the GTIN before querying PostgreSQL", async () => {
    databaseMocks.lookupPromotedFoodByBarcode.mockResolvedValue(projection);
    const service = new DatabaseBackedFoodSearchService({
      core: core(),
      database: {} as never,
    });

    await expect(
      service.lookupBarcode({ gtin: "036000291452", marketCode: "US" }),
    ).resolves.toMatchObject({ foodId: "10", name: "Example Oatmeal" });
    await expect(service.lookupBarcode({ gtin: "036000291453" })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    } satisfies Partial<HttpProblem>);
    expect(databaseMocks.lookupPromotedFoodByBarcode).toHaveBeenCalledTimes(1);
  });

  it("never misclassifies an operational barcode database error as client input", async () => {
    const databaseFailure = new Error('relation "food_barcode" does not exist');
    databaseMocks.lookupPromotedFoodByBarcode.mockRejectedValue(databaseFailure);
    const service = new DatabaseBackedFoodSearchService({
      core: core(),
      database: {} as never,
    });

    await expect(service.lookupBarcode({ gtin: "036000291452" })).rejects.toBe(databaseFailure);
  });

  it("bounds active and queued barcode database operations", async () => {
    let releaseFirst!: (value: typeof projection) => void;
    const first = new Promise<typeof projection>((resolve) => {
      releaseFirst = resolve;
    });
    databaseMocks.lookupPromotedFoodByBarcode.mockImplementation(() => first);
    const service = new DatabaseBackedFoodSearchService({
      core: core(),
      database: {} as never,
      maxConcurrentDatabaseOperations: 1,
      maxQueuedDatabaseOperations: 1,
    });

    const active = service.lookupBarcode({ gtin: "036000291452" });
    await vi.waitFor(() =>
      expect(databaseMocks.lookupPromotedFoodByBarcode).toHaveBeenCalledTimes(1),
    );
    const queued = service.lookupBarcode({ gtin: "036000291452" });
    await Promise.resolve();
    expect(databaseMocks.lookupPromotedFoodByBarcode).toHaveBeenCalledTimes(1);
    await expect(service.lookupBarcode({ gtin: "036000291452" })).rejects.toMatchObject({
      name: "DatabaseSearchCapacityError",
    });

    releaseFirst(projection);
    await expect(active).resolves.toMatchObject({ foodId: "10" });
    await expect(queued).resolves.toMatchObject({ foodId: "10" });
    expect(databaseMocks.lookupPromotedFoodByBarcode).toHaveBeenCalledTimes(2);
  });

  it("removes an aborted waiter from the database bulkhead queue", async () => {
    let releaseFirst!: (value: typeof projection) => void;
    const first = new Promise<typeof projection>((resolve) => {
      releaseFirst = resolve;
    });
    databaseMocks.lookupPromotedFoodByBarcode.mockImplementation(() => first);
    const service = new DatabaseBackedFoodSearchService({
      core: core(),
      database: {} as never,
      maxConcurrentDatabaseOperations: 1,
      maxQueuedDatabaseOperations: 1,
    });

    const active = service.lookupBarcode({ gtin: "036000291452" });
    await vi.waitFor(() =>
      expect(databaseMocks.lookupPromotedFoodByBarcode).toHaveBeenCalledOnce(),
    );
    const controller = new AbortController();
    const aborted = service.lookupBarcode({ gtin: "036000291452", signal: controller.signal });
    controller.abort("test-request-aborted");
    await expect(aborted).rejects.toBe("test-request-aborted");

    const replacement = service.lookupBarcode({ gtin: "036000291452" });
    releaseFirst(projection);
    await expect(active).resolves.toMatchObject({ foodId: "10" });
    await expect(replacement).resolves.toMatchObject({ foodId: "10" });
  });

  it("shares one bulkhead between degraded keyword search and barcode lookup", async () => {
    const searchCore = core();
    searchCore.search.mockRejectedValue(new SearchBackendError("backend unavailable"));
    let releaseFallback!: (value: readonly []) => void;
    const fallback = new Promise<readonly []>((resolve) => {
      releaseFallback = resolve;
    });
    databaseMocks.searchPromotedFoodsPostgres.mockImplementation(() => fallback);
    const service = new DatabaseBackedFoodSearchService({
      core: searchCore,
      database: {} as never,
      maxConcurrentDatabaseOperations: 1,
      maxQueuedDatabaseOperations: 0,
    });

    const activeFallback = service.search({ query: "oatmeal", intent: "all", limit: 20 });
    await vi.waitFor(() =>
      expect(databaseMocks.searchPromotedFoodsPostgres).toHaveBeenCalledOnce(),
    );
    await expect(service.lookupBarcode({ gtin: "036000291452" })).rejects.toMatchObject({
      name: "DatabaseSearchCapacityError",
    });
    expect(databaseMocks.lookupPromotedFoodByBarcode).not.toHaveBeenCalled();

    releaseFallback([]);
    await expect(activeFallback).resolves.toEqual({ data: [], page: { nextCursor: null } });
  });
});
