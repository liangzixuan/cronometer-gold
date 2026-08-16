import { describe, expect, it } from "vitest";

import {
  buildAllowedUpstreamUrl,
  buildAutocompleteRequestPath,
  buildBarcodeRequestPath,
  buildSearchRequestPath,
  isInvalidBarcodeResponse,
  isInvalidContinuationResponse,
  mergeFoodSearchResults,
  normalizeBarcodeInput,
  normalizeSearchText,
  parseFoodAutocompleteResponse,
  parseFoodBarcodeResponse,
  parseFoodSearchPage,
  resolveInternalApiBase,
} from "./food-search";

const hit = {
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
} as const;

describe("web food-search request construction", () => {
  it("normalizes text and retains an opaque cursor", () => {
    expect(normalizeSearchText("  Ａpple   pie  ")).toBe("Apple pie");
    expect(
      buildSearchRequestPath({
        query: "  Ａpple   pie  ",
        intent: "branded",
        cursor: "payload.signature",
      }),
    ).toBe("/api/foods/search?query=Apple+pie&intent=branded&cursor=payload.signature&limit=20");
    expect(buildAutocompleteRequestPath({ query: "apple", intent: "all" })).toBe(
      "/api/foods/autocomplete?query=apple&intent=all&limit=8",
    );
    expect(buildBarcodeRequestPath(" 012345678905 ")).toBe("/api/foods/barcodes/012345678905");
    expect(normalizeBarcodeInput("01 234-5678905")).toBe("012345678905");
    expect(normalizeBarcodeInput("012345678905123")).toBe("012345678905123");
    expect(normalizeBarcodeInput("012345678905abc")).toBe("012345678905abc");
  });

  it("rejects partial barcodes, malformed cursors, and unsafe internal API origins", () => {
    expect(() => buildBarcodeRequestPath("1234")).toThrow(RangeError);
    expect(() =>
      buildSearchRequestPath({ query: "apple", intent: "all", cursor: "not$opaque" }),
    ).toThrow(RangeError);
    expect(() => resolveInternalApiBase("http://catalogue.example.test")).toThrow(TypeError);
    expect(() => resolveInternalApiBase("https://user:secret@example.test")).toThrow(TypeError);
    expect(resolveInternalApiBase().href).toBe("http://127.0.0.1:4000/");
  });

  it("copies only allowlisted, single-valued query fields to the upstream API", () => {
    const target = buildAllowedUpstreamUrl(
      "https://app.example.test/api/foods/search?query=apple&intent=generic&limit=20",
      "/v1/foods/search",
      ["query", "intent", "limit"],
      "https://api.example.test",
    );
    expect(target.href).toBe(
      "https://api.example.test/v1/foods/search?query=apple&intent=generic&limit=20",
    );
    expect(() =>
      buildAllowedUpstreamUrl(
        "https://app.example.test/api/foods/search?query=apple&privateFoodIds=3",
        "/v1/foods/search",
        ["query"],
        "https://api.example.test",
      ),
    ).toThrow(TypeError);
    expect(() =>
      buildAllowedUpstreamUrl(
        "https://app.example.test/api/foods/search?query=apple&query=pear",
        "/v1/foods/search",
        ["query"],
        "https://api.example.test",
      ),
    ).toThrow(TypeError);
    expect(() =>
      buildAllowedUpstreamUrl(
        "https://app.example.test/api/foods/search?query=apple",
        "/v1/foods/../private",
        ["query"],
        "https://api.example.test",
      ),
    ).toThrow(TypeError);
  });

  it("appends cursor pages without repeating a food version", () => {
    const next = { ...hit, foodId: "102", foodVersionId: "203", name: "Apple Tart" };
    expect(mergeFoodSearchResults([hit], [hit, next], true)).toEqual([hit, next]);
    expect(mergeFoodSearchResults([hit], [next], false)).toEqual([next]);
  });

  it("classifies only safe client failures used by the interactive recovery states", () => {
    expect(isInvalidContinuationResponse(400, "signed.cursor")).toBe(true);
    expect(isInvalidContinuationResponse(400)).toBe(false);
    expect(isInvalidContinuationResponse(503, "signed.cursor")).toBe(false);
    expect(isInvalidBarcodeResponse(400)).toBe(true);
    expect(isInvalidBarcodeResponse(404)).toBe(false);
  });
});

describe("web food-search response guards", () => {
  it("accepts the bounded public response shapes", () => {
    expect(
      parseFoodSearchPage({ data: [hit], page: { nextCursor: "next_cursor" } }).data,
    ).toHaveLength(1);
    expect(
      parseFoodAutocompleteResponse({
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
      }).data,
    ).toHaveLength(1);
    expect(parseFoodBarcodeResponse({ data: hit }).data.name).toBe("Apple Pie");
  });

  it("rejects extra fields and malformed nested serving data", () => {
    expect(() =>
      parseFoodSearchPage({ data: [hit], page: { nextCursor: null }, privateRanking: true }),
    ).toThrow(TypeError);
    expect(() =>
      parseFoodBarcodeResponse({
        data: { ...hit, defaultServing: { ...hit.defaultServing, gramWeight: -125.5 } },
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseFoodAutocompleteResponse({
        data: [
          {
            foodId: "101",
            foodVersionId: "202",
            kind: "private",
            label: "x",
            brandName: null,
            source: hit.source,
          },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseFoodBarcodeResponse({
        data: {
          ...hit,
          source: { ...hit.source, attributionText: "" },
        },
      }),
    ).toThrow(TypeError);
  });
});
