import type {
  FoodAutocompleteResponse,
  FoodSearchHit,
  FoodSearchPage,
} from "@nutrition-tracker/contracts";
import {
  type FoodSearchProjectionPublicationState,
  getFoodSearchProjectionPublicationState,
  isValidGtin,
  lookupPromotedFoodByBarcode,
  searchPromotedFoodsPostgres,
} from "@nutrition-tracker/db";
import {
  FoodSearchError,
  type FoodSearchPort,
  InvalidCursorError,
  InvalidSearchQueryError,
  toFoodSearchDocument,
  toFoodSearchHit,
} from "@nutrition-tracker/search";

import { HttpProblem } from "../../http/problem.js";
import type {
  AutocompleteFoodsInput,
  FoodSearchService,
  LookupFoodBarcodeInput,
  SearchFoodsInput,
} from "./food.routes.js";

type FoodSearchDatabase = Parameters<typeof lookupPromotedFoodByBarcode>[0];

export interface DatabaseBackedFoodSearchServiceOptions {
  readonly core: FoodSearchPort;
  readonly database: FoodSearchDatabase;
  readonly maxConcurrentDatabaseOperations?: number;
  readonly maxQueuedDatabaseOperations?: number;
}

interface DatabaseWaiter {
  readonly grant: () => void;
  readonly reject: (error: unknown) => void;
  abort?: () => void;
}

class DatabaseSearchCapacityError extends Error {
  constructor() {
    super("Food-search database capacity is temporarily exhausted");
    this.name = "DatabaseSearchCapacityError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The request was aborted.", "AbortError");
}

/**
 * Process-local bulkhead for degraded search and barcode reads. PostgreSQL still
 * owns its pool and statement timeouts; this prevents an unbounded API waiter
 * queue from consuming request memory while that pool is saturated.
 */
class DatabaseSearchBulkhead {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  #active = 0;
  readonly #queue: DatabaseWaiter[] = [];

  constructor(maxConcurrent: number, maxQueued: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 20) {
      throw new TypeError("maxConcurrentDatabaseOperations must be between 1 and 20");
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 100) {
      throw new TypeError("maxQueuedDatabaseOperations must be between 0 and 100");
    }
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueued = maxQueued;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await this.#acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #acquire(signal?: AbortSignal): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return;
    }
    if (this.#queue.length >= this.#maxQueued) {
      throw new DatabaseSearchCapacityError();
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: DatabaseWaiter = {
        grant: () => {
          if (waiter.abort) signal?.removeEventListener("abort", waiter.abort);
          resolve();
        },
        reject,
      };
      if (signal) {
        waiter.abort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#queue.push(waiter);
      if (signal?.aborted === true) waiter.abort?.();
    });
  }

  #release(): void {
    const waiter = this.#queue.shift();
    if (waiter) {
      waiter.grant();
      return;
    }
    this.#active -= 1;
  }
}

function invalidInput(path: string): HttpProblem {
  return new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    issues: [{ path, code: "invalid", message: "Invalid value." }],
    expose: true,
  });
}

function rethrowClientError(error: unknown): void {
  if (error instanceof InvalidCursorError) throw invalidInput("/cursor");
  if (error instanceof InvalidSearchQueryError) throw invalidInput("/query");
}

function isSearchProjectionFailure(error: unknown): boolean {
  return error instanceof FoodSearchError;
}

function contractHit(document: Parameters<typeof toFoodSearchDocument>[0]): FoodSearchHit {
  return toFoodSearchHit(toFoodSearchDocument(document));
}

function publicationStateUnchanged(
  before: FoodSearchProjectionPublicationState,
  after: FoodSearchProjectionPublicationState,
): boolean {
  return (
    before.isCurrent &&
    after.isCurrent &&
    before.currentRevision === after.currentRevision &&
    before.publishedRevision === after.publishedRevision
  );
}

/**
 * Public API adapter. PostgreSQL owns barcode identity and bounded degradation;
 * Meilisearch owns normal keyword relevance and cursors.
 */
export class DatabaseBackedFoodSearchService implements FoodSearchService {
  readonly #bulkhead: DatabaseSearchBulkhead;
  readonly #core: FoodSearchPort;
  readonly #database: FoodSearchDatabase;

  constructor(options: DatabaseBackedFoodSearchServiceOptions) {
    this.#bulkhead = new DatabaseSearchBulkhead(
      options.maxConcurrentDatabaseOperations ?? 4,
      options.maxQueuedDatabaseOperations ?? 16,
    );
    this.#core = options.core;
    this.#database = options.database;
  }

  async search(input: SearchFoodsInput): Promise<FoodSearchPage> {
    const before = await this.#publicationState(input.signal);
    if (!before.isCurrent) {
      if (input.cursor !== undefined) throw invalidInput("/cursor");
      return this.#fallbackSearch(input);
    }

    let result: Awaited<ReturnType<FoodSearchPort["search"]>>;
    try {
      result = await this.#core.search(input);
    } catch (error) {
      rethrowClientError(error);
      if (input.cursor !== undefined || !isSearchProjectionFailure(error)) throw error;
      return this.#fallbackSearch(input);
    }

    const after = await this.#publicationState(input.signal);
    if (!publicationStateUnchanged(before, after)) {
      if (input.cursor !== undefined) throw invalidInput("/cursor");
      return this.#fallbackSearch(input);
    }
    return { data: result.hits, page: { nextCursor: result.nextCursor } };
  }

  async autocomplete(input: AutocompleteFoodsInput): Promise<FoodAutocompleteResponse> {
    const before = await this.#publicationState(input.signal);
    if (!before.isCurrent) return this.#fallbackAutocomplete(input);

    let result: Awaited<ReturnType<FoodSearchPort["autocomplete"]>>;
    try {
      result = await this.#core.autocomplete(input);
    } catch (error) {
      rethrowClientError(error);
      if (!isSearchProjectionFailure(error)) throw error;
      return this.#fallbackAutocomplete(input);
    }

    const after = await this.#publicationState(input.signal);
    if (!publicationStateUnchanged(before, after)) return this.#fallbackAutocomplete(input);
    return { data: result.suggestions };
  }

  async #publicationState(signal?: AbortSignal): Promise<FoodSearchProjectionPublicationState> {
    return this.#bulkhead.run(
      () => getFoodSearchProjectionPublicationState(this.#database),
      signal,
    );
  }

  async #fallbackSearch(input: SearchFoodsInput): Promise<FoodSearchPage> {
    const candidates = await this.#fallbackCandidates(input);
    const data = candidates
      .map(({ document }) => document)
      .filter((document) => input.intent === "all" || document.kind === input.intent)
      .filter(
        (document) => input.languageTag === undefined || document.languageTag === input.languageTag,
      )
      .slice(0, input.limit)
      .map(contractHit);
    return { data, page: { nextCursor: null } };
  }

  async #fallbackAutocomplete(input: AutocompleteFoodsInput): Promise<FoodAutocompleteResponse> {
    const candidates = await this.#fallbackCandidates(input);
    const seen = new Set<string>();
    const data: FoodAutocompleteResponse["data"][number][] = [];
    for (const { document } of candidates) {
      if (input.intent !== "all" && document.kind !== input.intent) continue;
      if (input.languageTag !== undefined && document.languageTag !== input.languageTag) continue;
      const key = `${document.name.normalize("NFKC").toLocaleLowerCase("und")}\u0000${
        document.brandName?.normalize("NFKC").toLocaleLowerCase("und") ?? ""
      }`;
      if (seen.has(key)) continue;
      seen.add(key);
      data.push({
        foodId: document.foodId,
        foodVersionId: document.foodVersionId,
        kind: document.kind,
        label: document.name,
        brandName: document.brandName,
        source: {
          code: document.sourceCode,
          displayName: document.sourceDisplayName,
          licenseExpression: document.licenseExpression,
          attributionRequired: document.attributionRequired,
          attributionText: document.attributionText,
        },
      });
      if (data.length === input.limit) break;
    }
    return { data };
  }

  async #fallbackCandidates(input: SearchFoodsInput | AutocompleteFoodsInput) {
    return this.#bulkhead.run(
      () =>
        searchPromotedFoodsPostgres(this.#database, {
          query: input.query,
          limit: 50,
          ...(input.intent === "all" ? {} : { kind: input.intent }),
          ...(input.languageTag === undefined ? {} : { languageTag: input.languageTag }),
          ...(input.marketCode === undefined ? {} : { marketCode: input.marketCode }),
        }),
      input.signal,
    );
  }

  async lookupBarcode(input: LookupFoodBarcodeInput): Promise<FoodSearchHit | null> {
    if (!isValidGtin(input.gtin)) throw invalidInput("/gtin");
    const document = await this.#bulkhead.run(
      () =>
        lookupPromotedFoodByBarcode(this.#database, {
          barcode: input.gtin,
          ...(input.marketCode === undefined ? {} : { marketCode: input.marketCode }),
        }),
      input.signal,
    );
    return document === null ? null : contractHit(document);
  }
}
