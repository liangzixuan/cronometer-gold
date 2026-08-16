import { FoodSearchCursorCodec, fingerprintSearchQuery } from "./cursor.js";
import { compareDeterministicText } from "./deterministic.js";
import { toFoodSearchHit } from "./document.js";
import { InvalidCursorError, SearchBackendError } from "./errors.js";
import {
  buildFoodSearchFilters,
  normalizeAutocompleteQuery,
  normalizeFoodSearchQuery,
  normalizeMarketCode,
  requireGtin,
} from "./query.js";
import { MAX_PERSONALIZATION_CANDIDATES, rerankFoodCandidates } from "./ranking.js";
import type {
  BarcodeLookupQuery,
  FoodAutocompleteQuery,
  FoodAutocompleteResponse,
  FoodSearchBackend,
  FoodSearchDocument,
  FoodSearchHit,
  FoodSearchPage,
  FoodSearchPort,
  FoodSearchQuery,
  NormalizedFoodSearchQuery,
} from "./types.js";

export interface FoodSearchServiceOptions {
  readonly backend: FoodSearchBackend;
  readonly cursorSecret: string | Uint8Array;
  /** Fixed fetch window used on every cursor page so local reranking cannot create duplicates. */
  readonly candidateWindow?: number;
}

export const MAX_CURSOR_RESULTS = 1_000;

export class FoodSearchService implements FoodSearchPort {
  readonly #backend: FoodSearchBackend;
  readonly #candidateWindow: number;
  readonly #cursorCodec: FoodSearchCursorCodec;

  constructor(options: FoodSearchServiceOptions) {
    this.#backend = options.backend;
    this.#cursorCodec = new FoodSearchCursorCodec({ secret: options.cursorSecret });
    this.#candidateWindow = options.candidateWindow ?? MAX_PERSONALIZATION_CANDIDATES;
    if (
      !Number.isSafeInteger(this.#candidateWindow) ||
      this.#candidateWindow < 50 ||
      this.#candidateWindow > MAX_PERSONALIZATION_CANDIDATES
    ) {
      throw new TypeError(
        `candidateWindow must be an integer between 50 and ${MAX_PERSONALIZATION_CANDIDATES}`,
      );
    }
  }

  async search(input: FoodSearchQuery): Promise<FoodSearchPage> {
    const query = normalizeFoodSearchQuery(input);
    const fingerprint = fingerprintSearchQuery(query, input.preferences);
    const cursorState =
      input.cursor === undefined ? null : this.#cursorCodec.decode(input.cursor, fingerprint);
    const offset = cursorState?.offset ?? 0;
    if (offset >= MAX_CURSOR_RESULTS) {
      throw new InvalidCursorError("The search cursor exceeds the maximum result window");
    }

    const windowStart = Math.floor(offset / this.#candidateWindow) * this.#candidateWindow;
    const localOffset = offset - windowStart;

    const response = await this.#backend.search(
      {
        query: query.barcode ?? query.query,
        filter: buildFoodSearchFilters(query),
        limit: this.#candidateWindow,
        offset: windowStart,
      },
      input.signal,
    );
    if (cursorState !== null && response.generation !== cursorState.generation) {
      throw new InvalidCursorError("The search catalogue changed; restart from the first page");
    }
    const ranked = rerankFoodCandidates(response.hits, query, input.preferences);
    const localEnd = Math.min(localOffset + query.limit, ranked.length);
    const boundedTotal = Math.min(response.estimatedTotalHits, MAX_CURSOR_RESULTS);
    const nextOffset =
      localEnd < ranked.length
        ? windowStart + localEnd
        : windowStart + this.#candidateWindow < boundedTotal
          ? windowStart + this.#candidateWindow
          : null;
    if (nextOffset !== null && response.generation === null) {
      throw new SearchBackendError(
        "search backend did not identify the active catalogue generation",
      );
    }
    return {
      hits: ranked.slice(localOffset, localEnd).map(toFoodSearchHit),
      nextCursor:
        nextOffset === null || response.generation === null
          ? null
          : this.#cursorCodec.encode(nextOffset, fingerprint, response.generation),
      estimatedTotalHits: response.estimatedTotalHits,
      hasMore: nextOffset !== null,
    };
  }

  async autocomplete(input: FoodAutocompleteQuery): Promise<FoodAutocompleteResponse> {
    const query = normalizeAutocompleteQuery(input);
    if (query === null) {
      return { suggestions: [] };
    }
    const response = await this.#backend.search(
      {
        query: query.barcode ?? query.query,
        filter: buildFoodSearchFilters(query),
        limit: Math.min(Math.max(query.limit * 5, 25), 50),
        offset: 0,
      },
      input.signal,
    );
    const ranked = rerankFoodCandidates(response.hits, query, input.preferences);
    const seenLabels = new Set<string>();
    const suggestions: Array<FoodAutocompleteResponse["suggestions"][number]> = [];
    for (const document of ranked) {
      const key = `${document.name.normalize("NFKC").toLocaleLowerCase("und")}\u0000${
        document.brandName?.normalize("NFKC").toLocaleLowerCase("und") ?? ""
      }`;
      if (seenLabels.has(key)) {
        continue;
      }
      seenLabels.add(key);
      suggestions.push({
        foodId: document.foodId,
        foodVersionId: document.foodVersionId,
        kind: document.kind,
        label: document.name,
        brandName: document.brandName,
        source: { ...document.source },
      });
      if (suggestions.length === query.limit) {
        break;
      }
    }
    return { suggestions };
  }

  async lookupBarcode(input: BarcodeLookupQuery): Promise<FoodSearchHit | null> {
    const gtin = requireGtin(input.gtin);
    const query: NormalizedFoodSearchQuery = {
      query: gtin,
      intent: "all",
      marketCode: normalizeMarketCode(input.marketCode),
      languageTag: null,
      limit: 1,
      barcode: gtin,
    };
    const response = await this.#backend.search(
      {
        query: gtin,
        filter: buildFoodSearchFilters(query),
        limit: 20,
        offset: 0,
      },
      input.signal,
    );
    const exact = response.hits
      .filter((document) => document.barcodes.includes(gtin))
      .sort((left, right) => compareBarcodeHits(left, right, query.marketCode))[0];
    return exact === undefined ? null : toFoodSearchHit(exact);
  }
}

function compareBarcodeHits(
  left: FoodSearchDocument,
  right: FoodSearchDocument,
  requestedMarket: string | null,
): number {
  return (
    marketRank(left.marketCode, requestedMarket) - marketRank(right.marketCode, requestedMarket) ||
    qualityRank(right.dataQuality) - qualityRank(left.dataQuality) ||
    compareDeterministicText(left.foodId, right.foodId) ||
    compareDeterministicText(left.foodVersionId, right.foodVersionId)
  );
}

function marketRank(marketCode: string, requestedMarket: string | null): number {
  if (requestedMarket === null) return marketCode === "001" ? 0 : 1;
  if (marketCode === requestedMarket) return 0;
  return marketCode === "001" ? 1 : 2;
}

function qualityRank(quality: FoodSearchDocument["dataQuality"]): number {
  switch (quality) {
    case "verified":
      return 3;
    case "curated":
      return 2;
    case "provisional":
      return 1;
  }
}
