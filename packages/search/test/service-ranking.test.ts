import { describe, expect, it } from "vitest";
import {
  type FoodSearchBackend,
  type FoodSearchDocument,
  FoodSearchService,
  InvalidCursorError,
  rerankFoodCandidates,
  type SearchBackendRequest,
  type SearchBackendResponse,
} from "../src/index.js";
import { foodDocument } from "./fixtures.js";

class RecordingBackend implements FoodSearchBackend {
  readonly requests: SearchBackendRequest[] = [];
  readonly documents: readonly FoodSearchDocument[];
  generation = "foods__generation__one";

  constructor(documents: readonly FoodSearchDocument[]) {
    this.documents = documents;
  }

  async search(request: SearchBackendRequest): Promise<SearchBackendResponse> {
    this.requests.push(request);
    return {
      hits: this.documents.slice(request.offset, request.offset + request.limit),
      estimatedTotalHits: this.documents.length,
      generation: this.generation,
    };
  }
}

function service(backend: FoodSearchBackend, candidateWindow = 50): FoodSearchService {
  return new FoodSearchService({
    backend,
    candidateWindow,
    cursorSecret: "service-test-secret-with-more-than-thirty-two-bytes",
  });
}

function manyDocuments(count: number): FoodSearchDocument[] {
  return Array.from({ length: count }, (_, index) =>
    foodDocument({
      id: `food_${index}`,
      foodId: String(index),
      foodVersionId: `${index}1`,
      name: `Oats ${String(index).padStart(3, "0")}`,
      normalizedName: `oats ${String(index).padStart(3, "0")}`,
    }),
  );
}

describe("local food ranking", () => {
  it("dynamically resolves the generic/branded tie-break from a brand-bearing query", () => {
    const generic = foodDocument({ foodId: "1", id: "food_1", name: "Oats" });
    const branded = foodDocument({
      foodId: "2",
      id: "food_2",
      foodVersionId: "21",
      kind: "branded",
      name: "Oats",
      normalizedName: "oats",
      brandName: "Acme",
    });
    const allQuery = {
      query: "Acme oats",
      intent: "all",
      marketCode: null,
      languageTag: null,
      limit: 10,
      barcode: null,
    } as const;
    expect(rerankFoodCandidates([generic, branded], allQuery, undefined)[0]?.foodId).toBe("2");
    expect(
      rerankFoodCandidates([branded, generic], { ...allQuery, query: "oats raw" }, undefined)[0]
        ?.foodId,
    ).toBe("1");
  });

  it("promotes relevant favorites and recents deterministically with identity as the final tie-break", () => {
    const documents = manyDocuments(50);
    const query = {
      query: "oats",
      intent: "all",
      marketCode: null,
      languageTag: null,
      limit: 10,
      barcode: null,
    } as const;
    const preferences = {
      favoriteFoodIds: ["40"],
      recentFoods: [
        { foodId: "20", lastUsedAt: "2026-08-15T10:00:00Z" },
        { foodId: "19", lastUsedAt: "2026-08-15T11:00:00Z" },
      ],
    } as const;
    const first = rerankFoodCandidates(documents, query, preferences);
    const second = rerankFoodCandidates(documents, query, preferences);
    expect(first.slice(0, 10).map(({ foodId }) => foodId)).toContain("40");
    expect(first.slice(0, 10).map(({ foodId }) => foodId)).toContain("19");
    expect(first.map(({ foodId }) => foodId)).toEqual(second.map(({ foodId }) => foodId));
  });
});

describe("FoodSearchService", () => {
  it("over-fetches one bounded fixed window and paginates the fully reranked candidates", async () => {
    const backend = new RecordingBackend(manyDocuments(80));
    const search = service(backend, 50);
    const first = await search.search({ query: "oats", limit: 10 });
    if (first.nextCursor === null) throw new Error("expected a second page");
    const second = await search.search({
      query: "oats",
      limit: 10,
      cursor: first.nextCursor,
    });
    expect(first.hits).toHaveLength(10);
    expect(second.hits).toHaveLength(10);
    expect(new Set([...first.hits, ...second.hits].map(({ foodId }) => foodId))).toHaveLength(20);
    expect(backend.requests).toEqual([
      expect.objectContaining({ limit: 50, offset: 0 }),
      expect.objectContaining({ limit: 50, offset: 0 }),
    ]);
    expect(first.estimatedTotalHits).toBe(80);
    expect(first.hasMore).toBe(true);
  });

  it("continues into disjoint bounded windows without cross-window duplicates", async () => {
    const backend = new RecordingBackend(manyDocuments(80));
    const search = service(backend, 50);
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
      const page = await search.search({
        query: "oats",
        limit: 10,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const hit of page.hits) {
        expect(seen.has(hit.foodId)).toBe(false);
        seen.add(hit.foodId);
      }
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toHaveLength(60);
    expect(backend.requests.slice(0, 5).every(({ offset }) => offset === 0)).toBe(true);
    expect(backend.requests[5]?.offset).toBe(50);
  });

  it("invalidates a cursor when intent, filters, limit, or preference state changes", async () => {
    const backend = new RecordingBackend(manyDocuments(50));
    const search = service(backend);
    const first = await search.search({
      query: "oats",
      intent: "all",
      marketCode: "US",
      limit: 5,
      preferences: { favoriteFoodIds: ["40"] },
    });
    if (first.nextCursor === null) throw new Error("expected a second page");
    await expect(
      search.search({
        query: "oats",
        intent: "all",
        marketCode: "US",
        limit: 5,
        cursor: first.nextCursor,
        preferences: { favoriteFoodIds: ["41"] },
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      search.search({
        query: "oats",
        intent: "generic",
        marketCode: "US",
        limit: 5,
        cursor: first.nextCursor,
        preferences: { favoriteFoodIds: ["40"] },
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects a cursor after an atomic catalogue generation change", async () => {
    const backend = new RecordingBackend(manyDocuments(80));
    const search = service(backend);
    const first = await search.search({ query: "oats", limit: 10 });
    if (first.nextCursor === null) throw new Error("expected a continuation cursor");

    backend.generation = "foods__generation__two";
    await expect(
      search.search({ query: "oats", limit: 10, cursor: first.nextCursor }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("uses enumerated intent/locale filters and never passes preferences to the shared backend", async () => {
    const backend = new RecordingBackend(manyDocuments(10));
    await service(backend).search({
      query: "oats",
      intent: "generic",
      marketCode: "us",
      languageTag: "EN-us",
      preferences: { favoriteFoodIds: ["private-preference"] },
    });
    expect(backend.requests[0]).toEqual({
      query: "oats",
      filter: [
        'kind = "generic"',
        '(marketCode = "US" OR marketCode = "001")',
        'languageTag = "en-US"',
      ],
      limit: 50,
      offset: 0,
    });
    expect(JSON.stringify(backend.requests[0])).not.toContain("private-preference");
  });

  it("provides safe, bounded, de-duplicated autocomplete without markup fields", async () => {
    const backend = new RecordingBackend([
      foodDocument({ foodId: "1", id: "food_1", name: "Apple" }),
      foodDocument({ foodId: "2", id: "food_2", foodVersionId: "21", name: "Apple" }),
      foodDocument({ foodId: "3", id: "food_3", foodVersionId: "31", name: "Applesauce" }),
    ]);
    const search = service(backend);
    await expect(search.autocomplete({ query: "a" })).resolves.toEqual({ suggestions: [] });
    const result = await search.autocomplete({ query: "ap", limit: 5 });
    expect(result.suggestions.map(({ label }) => label)).toEqual(["Apple", "Applesauce"]);
    expect(result.suggestions[0]).toEqual({
      foodId: "1",
      foodVersionId: "11",
      kind: "generic",
      label: "Apple",
      brandName: null,
      source: {
        code: "USDA_FDC",
        displayName: "USDA FoodData Central",
        licenseExpression: "CC0-1.0",
        attributionRequired: false,
        attributionText: "USDA FoodData Central",
      },
    });
    expect(JSON.stringify(result)).not.toContain("_formatted");
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]?.limit).toBe(25);
  });

  it("performs exact GTIN lookup and keeps serving precision as strings", async () => {
    const matching = foodDocument({
      foodId: "88",
      id: "food_88",
      foodVersionId: "881",
      kind: "branded",
      name: "Exact cereal",
      normalizedName: "exact cereal",
      brandName: "Exact",
      barcodes: ["00036000291452"],
      defaultServing: {
        servingId: "991",
        label: "1 cup",
        quantity: "1.000000",
        unit: "cup",
        gramWeight: "37.125000",
        milliliterVolume: null,
      },
    });
    const backend = new RecordingBackend([
      foodDocument({ foodId: "1", id: "food_1", barcodes: [] }),
      matching,
    ]);
    const result = await service(backend).lookupBarcode({ gtin: "0360-0029-1452" });
    expect(result?.foodId).toBe("88");
    expect(result?.defaultServing?.gramWeight).toBe("37.125000");
    expect(backend.requests[0]?.filter).toContain('barcodes = "00036000291452"');
  });

  it("prefers the requested barcode market before global quality and identity ties", async () => {
    const gtin = "00036000291452";
    const global = foodDocument({
      foodId: "1",
      id: "food_1",
      kind: "branded",
      brandName: "Global",
      barcodes: [gtin],
      marketCode: "001",
      dataQuality: "verified",
    });
    const local = foodDocument({
      foodId: "99",
      foodVersionId: "991",
      id: "food_99",
      kind: "branded",
      brandName: "Local",
      barcodes: [gtin],
      marketCode: "US",
      dataQuality: "provisional",
    });
    const search = service(new RecordingBackend([global, local]));

    await expect(search.lookupBarcode({ gtin, marketCode: "US" })).resolves.toMatchObject({
      foodId: "99",
      marketCode: "US",
    });
    await expect(search.lookupBarcode({ gtin })).resolves.toMatchObject({
      foodId: "1",
      marketCode: "001",
    });
  });

  it("canonicalizes formatted barcode search text before sending it to Meilisearch", async () => {
    const backend = new RecordingBackend([]);
    await service(backend).search({ query: "0360-0029-1452" });
    expect(backend.requests[0]).toMatchObject({
      query: "00036000291452",
      filter: ['barcodes = "00036000291452"'],
    });
  });
});
