import { describe, expect, it } from "vitest";

import {
  buildAutocompleteUrl,
  buildBarcodeUrl,
  buildSearchUrl,
  isExactBarcode,
  isInvalidBarcodeResponse,
  isInvalidContinuationResponse,
  mergeSearchResults,
  normalizeBarcodeInput,
  parseBarcodeResult,
  parseSearchPage,
  parseSuggestions,
  resolveMobileApiBase,
} from "./food-search";

const hit = {
  foodId: "101",
  foodVersionId: "202",
  kind: "generic",
  name: "Apple, raw",
  brandName: null,
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
    label: "1 medium",
    quantity: "1",
    unit: "apple",
    gramWeight: "182",
    milliliterVolume: null,
  },
} as const;

describe("mobile food-search URL construction", () => {
  it("uses platform-safe local defaults and encodes public query fields", () => {
    expect(resolveMobileApiBase(undefined, "ios").href).toBe("http://127.0.0.1:4000/");
    expect(resolveMobileApiBase(undefined, "android").href).toBe("http://10.0.2.2:4000/");
    const base = resolveMobileApiBase("https://api.example.test", "ios");
    expect(buildSearchUrl(base, "  apple   pie ", "branded", "next_cursor").href).toBe(
      "https://api.example.test/v1/foods/search?query=apple+pie&intent=branded&limit=20&cursor=next_cursor",
    );
    expect(buildAutocompleteUrl(base, "apple", "all").href).toBe(
      "https://api.example.test/v1/foods/autocomplete?query=apple&intent=all&limit=8",
    );
  });

  it("accepts exact barcode lengths and never builds a partial lookup", () => {
    const base = resolveMobileApiBase("https://api.example.test", "ios");
    expect(normalizeBarcodeInput("01 234-5678905")).toBe("012345678905");
    expect(normalizeBarcodeInput("012345678905123")).toBe("012345678905123");
    expect(normalizeBarcodeInput("012345678905abc")).toBe("012345678905abc");
    expect(isExactBarcode("012345678905")).toBe(true);
    expect(isExactBarcode(normalizeBarcodeInput("012345678905123"))).toBe(false);
    expect(isExactBarcode("1234")).toBe(false);
    expect(buildBarcodeUrl(base, "012345678905").href).toBe(
      "https://api.example.test/v1/foods/barcodes/012345678905",
    );
    expect(() => buildBarcodeUrl(base, "1234")).toThrow(RangeError);
  });

  it("rejects unsafe configured origins and malformed opaque cursors", () => {
    expect(() => resolveMobileApiBase("http://api.example.test", "ios")).toThrow(TypeError);
    expect(() => resolveMobileApiBase("https://name:secret@api.example.test", "ios")).toThrow(
      TypeError,
    );
    const base = resolveMobileApiBase("https://api.example.test", "ios");
    expect(() => buildSearchUrl(base, "apple", "all", "not$opaque")).toThrow(RangeError);
  });
});

describe("mobile food-search response and state helpers", () => {
  it("accepts public contract responses", () => {
    expect(parseSearchPage({ data: [hit], page: { nextCursor: null } }).data).toHaveLength(1);
    expect(parseBarcodeResult({ data: hit }).name).toBe("Apple, raw");
    expect(
      parseSuggestions({
        data: [
          {
            foodId: "101",
            foodVersionId: "202",
            kind: "generic",
            label: "Apple, raw",
            brandName: null,
            source: hit.source,
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it("rejects unexpected response fields and malformed decimals", () => {
    expect(() => parseSearchPage({ data: [hit], page: { nextCursor: null, offset: 1 } })).toThrow(
      TypeError,
    );
    expect(() =>
      parseBarcodeResult({
        data: { ...hit, defaultServing: { ...hit.defaultServing, gramWeight: "-1" } },
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseSuggestions({
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
  });

  it("appends cursor pages without duplicating a repeated version", () => {
    const second = { ...hit, foodId: "102", foodVersionId: "203", name: "Apple, baked" };
    expect(mergeSearchResults([hit], [hit, second], true)).toEqual([hit, second]);
    expect(mergeSearchResults([hit], [second], false)).toEqual([second]);
  });

  it("classifies safe invalid barcode and continuation responses", () => {
    expect(isInvalidContinuationResponse(400, "signed.cursor")).toBe(true);
    expect(isInvalidContinuationResponse(400)).toBe(false);
    expect(isInvalidContinuationResponse(503, "signed.cursor")).toBe(false);
    expect(isInvalidBarcodeResponse(400)).toBe(true);
    expect(isInvalidBarcodeResponse(404)).toBe(false);
  });

  it("rejects missing reviewed attribution metadata", () => {
    expect(() =>
      parseBarcodeResult({
        data: { ...hit, source: { code: hit.source.code, displayName: hit.source.displayName } },
      }),
    ).toThrow(TypeError);
  });
});
