import { describe, expect, it } from "vitest";
import {
  buildFoodSearchFilters,
  FoodSearchCursorCodec,
  fingerprintPreferences,
  fingerprintSearchQuery,
  InvalidCursorError,
  InvalidSearchQueryError,
  normalizeFoodSearchQuery,
  normalizeGtin,
} from "../src/index.js";

const secret = "test-only-cursor-secret-that-is-at-least-32-bytes";

describe("search query normalization", () => {
  it("normalizes Unicode, whitespace, locale, intent, and barcode", () => {
    expect(
      normalizeFoodSearchQuery({
        query: " ９６３８-５０７４\n",
        intent: "branded",
        languageTag: "EN-us",
        marketCode: "us",
        limit: 7,
      }),
    ).toEqual({
      query: "9638-5074",
      intent: "branded",
      languageTag: "en-US",
      marketCode: "US",
      limit: 7,
      barcode: "00000096385074",
    });
  });

  it("rejects blank, oversized, invalid-market, invalid-locale, and invalid limits", () => {
    expect(() => normalizeFoodSearchQuery({ query: "\u202e\n" })).toThrow(InvalidSearchQueryError);
    expect(() => normalizeFoodSearchQuery({ query: "x".repeat(161) })).toThrow(
      InvalidSearchQueryError,
    );
    expect(() => normalizeFoodSearchQuery({ query: "apple", marketCode: "US' OR true" })).toThrow(
      InvalidSearchQueryError,
    );
    expect(() => normalizeFoodSearchQuery({ query: "apple", languageTag: "not_a_tag" })).toThrow(
      InvalidSearchQueryError,
    );
    expect(() => normalizeFoodSearchQuery({ query: "apple", limit: 51 })).toThrow(
      InvalidSearchQueryError,
    );
  });

  it("recognizes only complete GTIN lengths and builds injection-safe filters", () => {
    expect(normalizeGtin("0360 0029 1452")).toBe("00036000291452");
    expect(normalizeGtin("4006381333931")).toBe("04006381333931");
    expect(normalizeGtin("00036000291452")).toBe("00036000291452");
    expect(normalizeGtin("036000291453")).toBeNull();
    expect(normalizeGtin("123456789")).toBeNull();
    expect(normalizeGtin("1234x678")).toBeNull();
    const normalized = normalizeFoodSearchQuery({
      query: "036000291452",
      intent: "branded",
      marketCode: "CA",
      languageTag: "fr-CA",
    });
    expect(buildFoodSearchFilters(normalized)).toEqual([
      'kind = "branded"',
      '(marketCode = "CA" OR marketCode = "001")',
      'languageTag = "fr-CA"',
      'barcodes = "00036000291452"',
    ]);
  });
});

describe("opaque search cursor", () => {
  it("round-trips a bound offset and rejects tampering or a different query", () => {
    const codec = new FoodSearchCursorCodec({ secret });
    const apple = normalizeFoodSearchQuery({ query: "apple", limit: 10 });
    const pear = normalizeFoodSearchQuery({ query: "pear", limit: 10 });
    const appleFingerprint = fingerprintSearchQuery(apple, undefined);
    const token = codec.encode(10, appleFingerprint, "foods__generation__20260815");
    expect(codec.decode(token, appleFingerprint)).toEqual({
      generation: "foods__generation__20260815",
      offset: 10,
    });
    expect(() => codec.decode(`${token.slice(0, -1)}x`, appleFingerprint)).toThrow(
      InvalidCursorError,
    );
    expect(() => codec.decode(token, fingerprintSearchQuery(pear, undefined))).toThrow(
      InvalidCursorError,
    );
  });

  it("binds preference state without exposing raw favorite/recent IDs", () => {
    const codec = new FoodSearchCursorCodec({ secret });
    const query = normalizeFoodSearchQuery({ query: "oats", limit: 10 });
    const preferences = {
      favoriteFoodIds: ["sensitive-food-123"],
      recentFoods: [{ foodId: "sensitive-food-456", lastUsedAt: "2026-08-15T12:00:00Z" }],
    } as const;
    const fingerprint = fingerprintSearchQuery(query, preferences);
    const token = codec.encode(10, fingerprint, "foods__generation__20260815");
    const decodedEnvelope = Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8");
    expect(token).not.toContain("sensitive-food");
    expect(decodedEnvelope).not.toContain("sensitive-food");
    expect(() =>
      codec.decode(
        token,
        fingerprintSearchQuery(query, { ...preferences, favoriteFoodIds: ["different"] }),
      ),
    ).toThrow(InvalidCursorError);
    expect(fingerprintPreferences(preferences)).toHaveLength(43);
  });

  it("requires a strong cursor secret", () => {
    expect(() => new FoodSearchCursorCodec({ secret: "short" })).toThrow(/32 bytes/u);
  });
});
