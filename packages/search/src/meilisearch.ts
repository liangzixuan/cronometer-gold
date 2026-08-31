import { assertFoodSearchDocument } from "./document.js";
import { SearchBackendError, SearchTaskError, SearchTimeoutError } from "./errors.js";
import type {
  FoodSearchBackend,
  FoodSearchDocument,
  SearchBackendRequest,
  SearchBackendResponse,
} from "./types.js";

type FetchImplementation = typeof globalThis.fetch;

interface MeilisearchTaskReference {
  readonly taskUid: number;
}

export interface MeilisearchTask {
  readonly uid: number;
  readonly status: "canceled" | "enqueued" | "failed" | "processing" | "succeeded";
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  } | null;
}

export interface MeilisearchIndexStats {
  readonly numberOfDocuments: number;
}

export interface WaitForSearchTaskOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal | undefined;
}

export interface MeilisearchHttpClientOptions {
  readonly host: string;
  readonly apiKey?: string;
  /** Used only to observe asynchronous task state; defaults to apiKey for legacy/master callers. */
  readonly taskApiKey?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchImplementation;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly method?: "DELETE" | "GET" | "PATCH" | "POST";
  readonly signal?: AbortSignal | undefined;
}

function validateHost(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Meilisearch host must use HTTP or HTTPS");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(
      "Meilisearch host must not contain credentials, query parameters, or fragments",
    );
  }
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:" && !local) {
    throw new TypeError("unencrypted Meilisearch HTTP is permitted only for localhost");
  }
  return url.toString().replace(/\/$/u, "");
}

function validateIndexUid(uid: string): string {
  if (!/^[A-Za-z0-9_-]{1,400}$/u.test(uid)) {
    throw new TypeError("Meilisearch index UID contains unsupported characters");
  }
  return uid;
}

function indexedSearchHit(value: unknown): {
  readonly document: FoodSearchDocument;
  readonly generation: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchBackendError("Meilisearch returned a malformed search document");
  }
  const { searchGeneration, ...document } = value as Record<string, unknown>;
  if (typeof searchGeneration !== "string" || !/^[A-Za-z0-9_-]{1,400}$/u.test(searchGeneration)) {
    throw new SearchBackendError("Meilisearch search document omitted its catalogue generation");
  }
  assertFoodSearchDocument(document);
  return { document, generation: searchGeneration };
}

function taskReference(value: unknown): MeilisearchTaskReference {
  if (
    typeof value !== "object" ||
    value === null ||
    !("taskUid" in value) ||
    !Number.isSafeInteger(value.taskUid) ||
    (value.taskUid as number) < 0
  ) {
    throw new SearchBackendError("Meilisearch returned an invalid task reference");
  }
  return { taskUid: value.taskUid as number };
}

function safeBackendCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "unknown_error";
}

function timeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
  readonly didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted === true) {
    controller.abort(parent.reason);
  } else {
    parent?.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new SearchTimeoutError(`Meilisearch request exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
    didTimeout: () => timedOut,
  };
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class MeilisearchHttpClient {
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchImplementation;
  readonly #host: string;
  readonly #requestTimeoutMs: number;
  readonly #taskApiKey: string | undefined;

  constructor(options: MeilisearchHttpClientOptions) {
    this.#host = validateHost(options.host);
    this.#apiKey = options.apiKey;
    this.#taskApiKey = options.taskApiKey ?? options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (typeof this.#fetch !== "function") {
      throw new TypeError("a Fetch implementation is required");
    }
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new TypeError("requestTimeoutMs must be a positive integer");
    }
  }

  async #request<T>(path: string, options: RequestOptions = {}, apiKey = this.#apiKey): Promise<T> {
    const timed = timeoutSignal(options.signal, this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#host}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: timed.signal,
      });
      const text = await response.text();
      let result: unknown = null;
      if (text.length > 0) {
        try {
          result = JSON.parse(text);
        } catch (cause) {
          throw new SearchBackendError("Meilisearch returned non-JSON data", response.status, {
            cause,
          });
        }
      }
      if (!response.ok) {
        const code =
          typeof result === "object" && result !== null && "code" in result
            ? safeBackendCode(result.code)
            : "unknown_error";
        throw new SearchBackendError(
          `Meilisearch request failed (${response.status}, ${code})`,
          response.status,
        );
      }
      return result as T;
    } catch (cause) {
      if (cause instanceof SearchBackendError) {
        throw cause;
      }
      if (timed.didTimeout()) {
        throw new SearchTimeoutError(`Meilisearch request exceeded ${this.#requestTimeoutMs}ms`);
      }
      if (options.signal?.aborted === true) {
        throw options.signal.reason;
      }
      throw new SearchBackendError("Meilisearch request failed", null, { cause });
    } finally {
      timed.dispose();
    }
  }

  async search(
    indexUid: string,
    request: SearchBackendRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendResponse> {
    const result = await this.#request<{
      hits?: unknown;
      estimatedTotalHits?: unknown;
      totalHits?: unknown;
    }>(`/indexes/${encodeURIComponent(validateIndexUid(indexUid))}/search`, {
      method: "POST",
      body: {
        q: request.query,
        filter: request.filter,
        limit: request.limit,
        offset: request.offset,
        attributesToRetrieve: [
          "id",
          "foodId",
          "foodVersionId",
          "kind",
          "name",
          "normalizedName",
          "brandName",
          "aliases",
          "barcodes",
          "servingLabels",
          "marketCode",
          "languageTag",
          "source",
          "dataQuality",
          "defaultServing",
          "searchGeneration",
        ],
        showRankingScore: false,
      },
      signal,
    });
    if (!Array.isArray(result.hits)) {
      throw new SearchBackendError("Meilisearch search response did not contain hits");
    }
    const hits: FoodSearchDocument[] = [];
    let generation: string | null = null;
    for (const hit of result.hits) {
      const indexed = indexedSearchHit(hit);
      if (generation !== null && indexed.generation !== generation) {
        throw new SearchBackendError("Meilisearch mixed catalogue generations in one response");
      }
      generation = indexed.generation;
      hits.push(indexed.document);
    }
    const total = result.estimatedTotalHits ?? result.totalHits ?? hits.length;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
      throw new SearchBackendError("Meilisearch search response contained an invalid total");
    }
    return { hits, estimatedTotalHits: total, generation };
  }

  async createIndex(uid: string, primaryKey = "id", signal?: AbortSignal): Promise<number> {
    const result = await this.#request<unknown>("/indexes", {
      method: "POST",
      body: { uid: validateIndexUid(uid), primaryKey },
      signal,
    });
    return taskReference(result).taskUid;
  }

  async indexExists(uid: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#request<unknown>(`/indexes/${encodeURIComponent(validateIndexUid(uid))}`, {
        signal,
      });
      return true;
    } catch (error) {
      if (error instanceof SearchBackendError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async updateSettings(uid: string, settings: unknown, signal?: AbortSignal): Promise<number> {
    const result = await this.#request<unknown>(
      `/indexes/${encodeURIComponent(validateIndexUid(uid))}/settings`,
      { method: "PATCH", body: settings, signal },
    );
    return taskReference(result).taskUid;
  }

  async addDocuments(
    uid: string,
    documents: readonly FoodSearchDocument[],
    signal?: AbortSignal,
  ): Promise<number> {
    const generation = validateIndexUid(uid);
    const result = await this.#request<unknown>(
      `/indexes/${encodeURIComponent(generation)}/documents?primaryKey=id`,
      {
        method: "POST",
        body: documents.map((document) => ({ ...document, searchGeneration: generation })),
        signal,
      },
    );
    return taskReference(result).taskUid;
  }

  async getIndexStats(uid: string, signal?: AbortSignal): Promise<MeilisearchIndexStats> {
    const result = await this.#request<MeilisearchIndexStats>(
      `/indexes/${encodeURIComponent(validateIndexUid(uid))}/stats`,
      { signal },
    );
    if (!Number.isSafeInteger(result.numberOfDocuments) || result.numberOfDocuments < 0) {
      throw new SearchBackendError("Meilisearch returned invalid index statistics");
    }
    return result;
  }

  async swapIndexes(leftUid: string, rightUid: string, signal?: AbortSignal): Promise<number> {
    const result = await this.#request<unknown>("/swap-indexes", {
      method: "POST",
      body: [{ indexes: [validateIndexUid(leftUid), validateIndexUid(rightUid)] }],
      signal,
    });
    return taskReference(result).taskUid;
  }

  async deleteIndex(uid: string, signal?: AbortSignal): Promise<number> {
    const result = await this.#request<unknown>(
      `/indexes/${encodeURIComponent(validateIndexUid(uid))}`,
      { method: "DELETE", signal },
    );
    return taskReference(result).taskUid;
  }

  async getTask(taskUid: number, signal?: AbortSignal): Promise<MeilisearchTask> {
    if (!Number.isSafeInteger(taskUid) || taskUid < 0) {
      throw new TypeError("taskUid must be a non-negative safe integer");
    }
    const task = await this.#request<MeilisearchTask>(
      `/tasks/${taskUid}`,
      { signal },
      this.#taskApiKey,
    );
    if (
      task.uid !== taskUid ||
      !["canceled", "enqueued", "failed", "processing", "succeeded"].includes(task.status)
    ) {
      throw new SearchBackendError("Meilisearch returned an invalid task status");
    }
    return task;
  }

  async waitForTask(taskUid: number, options: WaitForSearchTaskOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("task timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new TypeError("poll interval must be a positive integer");
    }
    const startedAt = Date.now();
    while (true) {
      options.signal?.throwIfAborted();
      const task = await this.getTask(taskUid, options.signal);
      if (task.status === "succeeded") {
        return;
      }
      if (task.status === "failed" || task.status === "canceled") {
        const code = safeBackendCode(task.error?.code);
        throw new SearchTaskError(taskUid, `Meilisearch task ${task.status} (${code})`);
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new SearchTimeoutError(`Meilisearch task ${taskUid} exceeded ${timeoutMs}ms`);
      }
      await abortableDelay(Math.min(pollIntervalMs, timeoutMs - elapsed), options.signal);
    }
  }
}

export interface MeilisearchFoodSearchBackendOptions {
  readonly client: MeilisearchHttpClient;
  readonly indexUid?: string;
}

export class MeilisearchFoodSearchBackend implements FoodSearchBackend {
  readonly #client: MeilisearchHttpClient;
  readonly #indexUid: string;

  constructor(options: MeilisearchFoodSearchBackendOptions) {
    this.#client = options.client;
    this.#indexUid = options.indexUid ?? "foods";
  }

  search(request: SearchBackendRequest, signal?: AbortSignal): Promise<SearchBackendResponse> {
    return this.#client.search(this.#indexUid, request, signal);
  }
}
