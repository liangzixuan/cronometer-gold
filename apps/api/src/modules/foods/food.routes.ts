import {
  type FoodAutocompleteResponse,
  type FoodBarcodeResponse,
  type FoodSearchHit,
  type FoodSearchIntent,
  type FoodSearchPage,
  foodAutocompleteResponseSchema,
  foodBarcodeNotFoundSchema,
  foodBarcodeResponseSchema,
  foodSearchIntents,
  foodSearchPageSchema,
  problemDetailsSchema,
} from "@nutrition-tracker/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { HttpProblem } from "../../http/problem.js";

// A source-rights change must take effect at the next request. Until responses are
// revision-keyed and actively purgeable, shared or client caching is unsafe.
const PUBLIC_FOOD_CACHE_CONTROL = "no-store";
const MAX_QUERY_LENGTH = 128;

export interface SearchFoodsInput {
  readonly query: string;
  readonly intent: FoodSearchIntent;
  readonly marketCode?: string;
  readonly languageTag?: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface AutocompleteFoodsInput {
  readonly query: string;
  readonly intent: FoodSearchIntent;
  readonly marketCode?: string;
  readonly languageTag?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface LookupFoodBarcodeInput {
  readonly gtin: string;
  readonly marketCode?: string;
  readonly signal?: AbortSignal;
}

/**
 * Application port for the rebuildable food-search projection. The HTTP layer
 * has no dependency on a particular search engine or database adapter.
 */
export interface FoodSearchService {
  search(input: SearchFoodsInput): Promise<FoodSearchPage>;
  autocomplete(input: AutocompleteFoodsInput): Promise<FoodAutocompleteResponse>;
  lookupBarcode(input: LookupFoodBarcodeInput): Promise<FoodSearchHit | null>;
}

export interface FoodRoutesOptions {
  foodSearchService?: FoodSearchService;
}

interface SearchQuerystring {
  query: string;
  intent?: FoodSearchIntent;
  market?: string;
  language?: string;
  limit?: number;
  cursor?: string;
}

interface AutocompleteQuerystring {
  query: string;
  intent?: FoodSearchIntent;
  market?: string;
  language?: string;
  limit?: number;
}

interface BarcodeParams {
  gtin: string;
}

interface BarcodeQuerystring {
  market?: string;
}

const queryTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_QUERY_LENGTH,
} as const;

const intentSchema = {
  type: "string",
  enum: foodSearchIntents,
  default: "all",
} as const;

const marketSchema = {
  type: "string",
  minLength: 2,
  maxLength: 3,
  pattern: "^[A-Za-z0-9]{2,3}$",
} as const;

const languageSchema = {
  type: "string",
  minLength: 2,
  maxLength: 35,
  pattern: "^[A-Za-z0-9-]+$",
} as const;

const searchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: queryTextSchema,
    intent: intentSchema,
    market: marketSchema,
    language: languageSchema,
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)?$",
    },
  },
} as const;

const autocompleteQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: queryTextSchema,
    intent: intentSchema,
    market: marketSchema,
    language: languageSchema,
    limit: { type: "integer", minimum: 1, maximum: 10, default: 8 },
  },
} as const;

const barcodeParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["gtin"],
  properties: {
    gtin: { type: "string", pattern: "^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$" },
  },
} as const;

const barcodeQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    market: marketSchema,
  },
} as const;

function validationProblem(path: string): HttpProblem {
  return new HttpProblem({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    title: "Bad Request",
    detail: "One or more request fields are invalid.",
    issues: [{ path, code: "invalid", message: "Invalid value." }],
    expose: true,
  });
}

function rejectUnexpectedQueryKeys(allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return async (request: FastifyRequest): Promise<void> => {
    const query = request.query as Readonly<Record<string, unknown>>;
    const hasUnexpectedKey = Object.keys(query).some((key) => !allowed.has(key));
    if (hasUnexpectedKey) throw validationProblem("/");
  };
}

function normalizeQuery(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (normalized.length === 0 || [...normalized].length > MAX_QUERY_LENGTH || hasControlCharacter) {
    throw validationProblem("/query");
  }
  return normalized;
}

function normalizeMarket(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.toUpperCase();
}

function normalizeLanguage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical || canonical.length > 35) throw validationProblem("/language");
    return canonical;
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw validationProblem("/language");
  }
}

function unavailable(cause?: unknown): HttpProblem {
  return new HttpProblem({
    statusCode: 503,
    code: "SERVICE_NOT_READY",
    title: "Service Unavailable",
    detail: "Food search is temporarily unavailable.",
    expose: true,
    cause,
  });
}

async function callSearchBackend<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw unavailable(error);
  }
}

async function withRequestSignal<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort("request-aborted");
  if (request.raw.aborted) abort();
  else request.raw.once("aborted", abort);

  try {
    return await operation(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
  }
}

function optionalFilters(query: { readonly market?: string; readonly language?: string }): {
  readonly marketCode?: string;
  readonly languageTag?: string;
} {
  const market = normalizeMarket(query.market);
  const language = normalizeLanguage(query.language);
  return {
    ...(market === undefined ? {} : { marketCode: market }),
    ...(language === undefined ? {} : { languageTag: language }),
  };
}

export const foodRoutes: FastifyPluginAsync<FoodRoutesOptions> = async (app, options) => {
  app.get<{ Querystring: SearchQuerystring }>(
    "/search",
    {
      preValidation: rejectUnexpectedQueryKeys([
        "query",
        "intent",
        "market",
        "language",
        "limit",
        "cursor",
      ]),
      schema: {
        querystring: searchQuerySchema,
        response: {
          200: foodSearchPageSchema,
          400: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<FoodSearchPage> => {
      const service = options.foodSearchService;
      if (!service) throw unavailable();

      const filters = optionalFilters(request.query);
      const input: SearchFoodsInput = {
        query: normalizeQuery(request.query.query),
        intent: request.query.intent ?? "all",
        limit: request.query.limit ?? 20,
        ...filters,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      };
      const result = await withRequestSignal(request, (signal) =>
        callSearchBackend(() => service.search({ ...input, signal })),
      );
      reply.header("cache-control", PUBLIC_FOOD_CACHE_CONTROL);
      return result;
    },
  );

  app.get<{ Querystring: AutocompleteQuerystring }>(
    "/autocomplete",
    {
      preValidation: rejectUnexpectedQueryKeys(["query", "intent", "market", "language", "limit"]),
      schema: {
        querystring: autocompleteQuerySchema,
        response: {
          200: foodAutocompleteResponseSchema,
          400: problemDetailsSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<FoodAutocompleteResponse> => {
      const service = options.foodSearchService;
      if (!service) throw unavailable();

      const filters = optionalFilters(request.query);
      const result = await withRequestSignal(request, (signal) =>
        callSearchBackend(() =>
          service.autocomplete({
            query: normalizeQuery(request.query.query),
            intent: request.query.intent ?? "all",
            limit: request.query.limit ?? 8,
            ...filters,
            signal,
          }),
        ),
      );
      reply.header("cache-control", PUBLIC_FOOD_CACHE_CONTROL);
      return result;
    },
  );

  app.get<{ Params: BarcodeParams; Querystring: BarcodeQuerystring }>(
    "/barcodes/:gtin",
    {
      preValidation: rejectUnexpectedQueryKeys(["market"]),
      schema: {
        params: barcodeParamsSchema,
        querystring: barcodeQuerySchema,
        response: {
          200: foodBarcodeResponseSchema,
          400: problemDetailsSchema,
          404: foodBarcodeNotFoundSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (request, reply): Promise<FoodBarcodeResponse> => {
      const service = options.foodSearchService;
      if (!service) throw unavailable();
      const market = normalizeMarket(request.query.market);
      const hit = await withRequestSignal(request, (signal) =>
        callSearchBackend(() =>
          service.lookupBarcode({
            gtin: request.params.gtin,
            ...(market === undefined ? {} : { marketCode: market }),
            signal,
          }),
        ),
      );

      if (!hit) {
        throw new HttpProblem({
          statusCode: 404,
          code: "NOT_FOUND",
          title: "Not Found",
          detail: "No current public food matches this barcode.",
          expose: true,
        });
      }

      reply.header("cache-control", PUBLIC_FOOD_CACHE_CONTROL);
      return { data: hit };
    },
  );
};
