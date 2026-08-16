import { afterAll, describe, expect, it } from "vitest";
import {
  type FoodSearchDocument,
  type FoodSearchProjectionRow,
  type FoodSearchProjectionSource,
  FoodSearchService,
  InvalidCursorError,
  MeilisearchFoodSearchBackend,
  MeilisearchHttpClient,
  rebuildFoodSearchIndex,
} from "../src/index.js";
import { foodDocument } from "./fixtures.js";

const testMeiliUrl = process.env.TEST_MEILI_URL;
const describeWithMeili = testMeiliUrl === undefined ? describe.skip : describe;
let cleanupClient: MeilisearchHttpClient | undefined;

function sourceFromRows(rows: readonly FoodSearchProjectionRow[]): FoodSearchProjectionSource {
  return {
    async openSnapshot() {
      return {
        expectedIncludedCount: rows.filter(({ eligibility }) => eligibility === "include").length,
        projectionRevision: "42",
        async *stream() {
          for (const row of rows) yield row;
        },
        async close() {},
      };
    },
  };
}

function fixtureDocuments(marker: "new" | "old"): FoodSearchDocument[] {
  const fixtures = Array.from({ length: 500 }, (_, index) => {
    const foodId = String(index + 100);
    return foodDocument({
      id: foodId,
      foodId,
      foodVersionId: `${foodId}1`,
      name: `Fixture food ${index.toString().padStart(3, "0")} oats`,
      normalizedName: `fixture food ${index.toString().padStart(3, "0")} oats`,
      aliases: ["fixture oats"],
    });
  });
  fixtures.push(
    foodDocument({
      id: "1",
      foodId: "1",
      foodVersionId: "11",
      name: "Banana, raw",
      normalizedName: "banana raw",
      aliases: ["banana"],
    }),
    foodDocument({
      id: "2",
      foodId: "2",
      foodVersionId: "21",
      name: "Chickpea, cooked",
      normalizedName: "chickpea cooked",
      aliases: ["chickpea"],
    }),
    foodDocument({
      id: "3",
      foodId: "3",
      foodVersionId: "31",
      name: "Oats",
      normalizedName: "oats",
    }),
    foodDocument({
      id: "4",
      foodId: "4",
      foodVersionId: "41",
      kind: "branded",
      name: "Oats",
      normalizedName: "oats",
      brandName: "Acme",
    }),
    foodDocument({
      id: "5",
      foodId: "5",
      foodVersionId: "51",
      kind: "branded",
      name: "Acme cereal",
      normalizedName: "acme cereal",
      brandName: "Acme",
      barcodes: ["00036000291452"],
    }),
    foodDocument({
      id: marker === "old" ? "6" : "7",
      foodId: marker === "old" ? "6" : "7",
      foodVersionId: marker === "old" ? "61" : "71",
      name: `${marker}-generation-sentinel`,
      normalizedName: `${marker} generation sentinel`,
      aliases: [`${marker}-generation-sentinel`],
    }),
  );
  return fixtures;
}

afterAll(async () => {
  if (cleanupClient !== undefined && (await cleanupClient.indexExists("foods"))) {
    const task = await cleanupClient.deleteIndex("foods");
    await cleanupClient.waitForTask(task, { timeoutMs: 30_000 });
  }
});

describeWithMeili("real Meilisearch behavior", () => {
  it("proves relevance, safety, personalization, atomic replacement, and a latency guardrail", async () => {
    if (testMeiliUrl === undefined) throw new Error("TEST_MEILI_URL is required");
    const client = new MeilisearchHttpClient({
      host: testMeiliUrl,
      ...(process.env.TEST_MEILI_API_KEY === undefined
        ? {}
        : { apiKey: process.env.TEST_MEILI_API_KEY }),
      requestTimeoutMs: 10_000,
    });
    cleanupClient = client;
    if (await client.indexExists("foods")) {
      const task = await client.deleteIndex("foods");
      await client.waitForTask(task, { timeoutMs: 30_000 });
    }

    const oldDocuments = fixtureDocuments("old");
    const firstRows: FoodSearchProjectionRow[] = [
      ...oldDocuments.map(
        (document): FoodSearchProjectionRow => ({
          eligibility: "include",
          document,
        }),
      ),
      { eligibility: "exclude", foodId: "private-777", reason: "private" },
      { eligibility: "exclude", foodId: "quarantined-778", reason: "quarantined" },
    ];
    const firstBuild = await rebuildFoodSearchIndex({
      client,
      source: sourceFromRows(firstRows),
      generationId: `integration_old_${Date.now()}`,
      batchSize: 75,
    });
    expect(firstBuild.includedCount).toBe(oldDocuments.length);
    expect(firstBuild.excludedCount).toBe(2);

    const service = new FoodSearchService({
      backend: new MeilisearchFoodSearchBackend({ client }),
      cursorSecret: "integration-cursor-secret-with-at-least-thirty-two-bytes",
    });
    expect((await service.search({ query: "bananna" })).hits[0]?.foodId).toBe("1");
    expect((await service.search({ query: "garbanzo bean" })).hits[0]?.foodId).toBe("2");
    expect((await service.search({ query: "Acme oats" })).hits[0]?.kind).toBe("branded");
    expect((await service.search({ query: "oats", intent: "generic" })).hits).toSatisfy(
      (hits: readonly { kind: string }[]) => hits.every(({ kind }) => kind === "generic"),
    );
    expect((await service.search({ query: "oats", intent: "branded" })).hits).toSatisfy(
      (hits: readonly { kind: string }[]) => hits.every(({ kind }) => kind === "branded"),
    );
    expect((await service.autocomplete({ query: "ban" })).suggestions[0]?.label).toBe(
      "Banana, raw",
    );
    expect((await service.lookupBarcode({ gtin: "036000291452" }))?.foodId).toBe("5");
    expect((await service.search({ query: "secret-private-marker" })).hits).toHaveLength(0);

    const personalized = await service.search({
      query: "fixture oats",
      limit: 10,
      preferences: {
        favoriteFoodIds: ["129"],
        recentFoods: [{ foodId: "124", lastUsedAt: "2026-08-15T12:00:00Z" }],
      },
    });
    expect(personalized.hits.slice(0, 10).map(({ foodId }) => foodId)).toContain("129");
    expect(personalized.hits.slice(0, 10).map(({ foodId }) => foodId)).toContain("124");
    const pageBeforeSwap = await service.search({ query: "fixture oats", limit: 10 });
    if (pageBeforeSwap.nextCursor === null) throw new Error("expected a pre-swap cursor");

    const newDocuments = fixtureDocuments("new");
    await rebuildFoodSearchIndex({
      client,
      source: sourceFromRows(
        newDocuments.map((document) => ({ eligibility: "include", document })),
      ),
      generationId: `integration_new_${Date.now()}`,
      batchSize: 75,
    });
    expect((await service.search({ query: "new-generation-sentinel" })).hits[0]?.foodId).toBe("7");
    expect((await service.search({ query: "old-generation-sentinel" })).hits).toHaveLength(0);
    await expect(
      service.search({
        query: "fixture oats",
        limit: 10,
        cursor: pageBeforeSwap.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidCursorError);

    for (let index = 0; index < 5; index += 1) {
      await service.search({ query: "fixture oats", limit: 20 });
    }
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const startedAt = performance.now();
      await service.search({ query: `fixture oats ${index % 10}`, limit: 20 });
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    expect(p95).toBeDefined();
    expect(p95).toBeLessThanOrEqual(500);
  }, 120_000);
});
