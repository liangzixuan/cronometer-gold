import { describe, expect, it, vi } from "vitest";
import {
  MeilisearchFoodSearchBackend,
  MeilisearchHttpClient,
  SearchBackendError,
  SearchTaskError,
  SearchTimeoutError,
} from "../src/index.js";
import { foodDocument } from "./fixtures.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function indexedHit(generation = "foods__generation__test") {
  return { ...foodDocument(), searchGeneration: generation };
}

describe("Meilisearch HTTP adapter", () => {
  it("rejects unsafe hosts and malformed index UIDs", async () => {
    expect(() => new MeilisearchHttpClient({ host: "http://search.example.com" })).toThrow(
      /localhost/u,
    );
    expect(() => new MeilisearchHttpClient({ host: "https://key@example.com" })).toThrow(
      /credentials/u,
    );
    const client = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      fetch: vi.fn(async () => jsonResponse({ hits: [], estimatedTotalHits: 0 })),
    });
    await expect(
      client.search("invalid/index", { query: "oats", filter: [], limit: 10, offset: 0 }),
    ).rejects.toThrow(/index UID/u);
  });

  it("sends a bounded JSON search, authenticates, and validates public documents", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ hits: [indexedHit()], estimatedTotalHits: 1 });
    });
    const client = new MeilisearchHttpClient({
      host: "http://localhost:7700/",
      apiKey: "test-master-key",
      fetch,
    });
    const backend = new MeilisearchFoodSearchBackend({ client });
    const response = await backend.search({
      query: "bananna",
      filter: ['kind = "generic"'],
      limit: 25,
      offset: 0,
    });
    expect(response.hits[0]?.defaultServing?.quantity).toBe("100.000000");
    expect(response.generation).toBe("foods__generation__test");
    expect(calls[0]?.url).toBe("http://localhost:7700/indexes/foods/search");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
      "Bearer test-master-key",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      q: "bananna",
      filter: ['kind = "generic"'],
      limit: 25,
      offset: 0,
      showRankingScore: false,
    });
  });

  it("writes a private generation marker with every indexed document", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ taskUid: 9 });
      }),
    });
    await expect(client.addDocuments("foods__generation__test", [foodDocument()])).resolves.toBe(9);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Array<Record<string, unknown>>;
    expect(body[0]?.searchGeneration).toBe("foods__generation__test");
    expect(foodDocument()).not.toHaveProperty("searchGeneration");
  });

  it("rejects mixed or missing catalogue generation markers", async () => {
    const missing = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      fetch: vi.fn(async () => jsonResponse({ hits: [foodDocument()], estimatedTotalHits: 1 })),
    });
    await expect(
      missing.search("foods", { query: "oats", filter: [], limit: 10, offset: 0 }),
    ).rejects.toBeInstanceOf(SearchBackendError);

    const mixed = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      fetch: vi.fn(async () =>
        jsonResponse({
          hits: [indexedHit("generation_one"), indexedHit("generation_two")],
          estimatedTotalHits: 2,
        }),
      ),
    });
    await expect(
      mixed.search("foods", { query: "oats", filter: [], limit: 10, offset: 0 }),
    ).rejects.toBeInstanceOf(SearchBackendError);
  });

  it("does not leak backend messages or API keys in failures", async () => {
    const client = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      apiKey: "super-secret-key",
      fetch: vi.fn(async () =>
        jsonResponse(
          { code: "invalid_search_filter", message: "sensitive backend implementation detail" },
          400,
        ),
      ),
    });
    const error = await client
      .search("foods", { query: "oats", filter: [], limit: 10, offset: 0 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchBackendError);
    expect(String(error)).toContain("invalid_search_filter");
    expect(String(error)).not.toContain("sensitive backend");
    expect(String(error)).not.toContain("super-secret-key");
  });

  it("polls tasks to completion and reports a failed task without its raw message", async () => {
    let call = 0;
    const succeeding = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      fetch: vi.fn(async () => {
        call += 1;
        return jsonResponse({ uid: 7, status: call === 1 ? "processing" : "succeeded" });
      }),
    });
    await expect(
      succeeding.waitForTask(7, { timeoutMs: 100, pollIntervalMs: 1 }),
    ).resolves.toBeUndefined();
    expect(call).toBe(2);

    const failing = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      fetch: vi.fn(async () =>
        jsonResponse({
          uid: 8,
          status: "failed",
          error: { code: "invalid_document", message: "private backend details" },
        }),
      ),
    });
    const error = await failing.waitForTask(8).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchTaskError);
    expect(String(error)).toContain("invalid_document");
    expect(String(error)).not.toContain("private backend details");
  });

  it("aborts both an in-flight request and task polling with bounded timeouts", async () => {
    const hangingFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const timed = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      requestTimeoutMs: 5,
      fetch: hangingFetch,
    });
    await expect(timed.getTask(1)).rejects.toBeInstanceOf(SearchTimeoutError);

    const processing = new MeilisearchHttpClient({
      host: "http://localhost:7700",
      fetch: vi.fn(async () => jsonResponse({ uid: 2, status: "processing" })),
    });
    await expect(
      processing.waitForTask(2, { timeoutMs: 5, pollIntervalMs: 1 }),
    ).rejects.toBeInstanceOf(SearchTimeoutError);

    const controller = new AbortController();
    const reason = new Error("operator canceled");
    const polling = processing.waitForTask(2, {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(polling).rejects.toBe(reason);
  });
});
