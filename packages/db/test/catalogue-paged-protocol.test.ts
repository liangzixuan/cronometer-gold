import { describe, expect, it } from "vitest";
import {
  assertCatalogueSha256V2,
  assertCatalogueTextV2,
  catalogueDocumentSha256V2,
  catalogueFramedSha256V2,
  catalogueUnsignedIntegerV2,
} from "../src/catalogue-paged-protocol.js";

// Independently generated using Python UTF-8 encoding/byte framing, September21.
// The actual PostgreSQL rehearsal must run the same vectors against the SQL helper.
const vectors = [
  {
    domain: "empty",
    fields: [],
    hash: "12dd818858742f5569d674d580a7c991593f486e9bec55b95b62c8e2b77beb6a",
  },
  {
    domain: "record",
    fields: ["0", "USDA_FDC:1", "a".repeat(64)],
    hash: "632e236a80f0b19343c1c7982925bb0a124b3700af7ac5654760310c3cdd0159",
  },
  {
    domain: "unicode",
    fields: ["é", "𐐀", "a:b", "line\nnext"],
    hash: "1d3589e459b2708f0e3692093a9fd7ef4266d1293b79c32fba6a2980cd8ed287",
  },
  {
    domain: "ambiguity",
    fields: ["ab", "c"],
    hash: "df3ab98a4040aef1b5e290692ce6d5434831d920e13eee3fc331a6c2869db7fb",
  },
  {
    domain: "ambiguity",
    fields: ["a", "bc"],
    hash: "b878cb1a7e391504d0a1aaceb148f77a5bbc4472b35c972a2a56534a3c210e57",
  },
];

describe("versioned catalogue byte commitments", () => {
  it.each(vectors)("matches independent $domain byte vector", ({ domain, fields, hash }) => {
    expect(catalogueFramedSha256V2(domain, fields)).toBe(hash);
  });
  it("separates field count, order, domain, and empty fields", () => {
    const hashes = [
      catalogueFramedSha256V2("page", []),
      catalogueFramedSha256V2("page", [""]),
      catalogueFramedSha256V2("page", ["a", "b"]),
      catalogueFramedSha256V2("page", ["b", "a"]),
      catalogueFramedSha256V2("terminal", ["a", "b"]),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });
  it.each(["a\0b", "\ud800", "\udc00", "\ud800x"])("rejects non-preservable text %j", (text) => {
    expect(() => catalogueFramedSha256V2("record", [text])).toThrow();
    expect(() => assertCatalogueTextV2(text, "value")).toThrow();
  });
  it("enforces both field and byte admission before returning a digest", () => {
    expect(() => catalogueFramedSha256V2("page", Array(65).fill(""))).toThrow(/field count/u);
    expect(() => catalogueFramedSha256V2("page", ["x".repeat(17 * 1024 * 1024)])).toThrow(
      /byte budget/u,
    );
    expect(() => catalogueFramedSha256V2("bad/domain", [])).toThrow(/domain/u);
  });
  it("retains exact document bytes rather than relabelling parsed JSON", () => {
    const first = '{"a":1}';
    const second = '{ "a": 1 }';
    expect(JSON.parse(first)).toEqual(JSON.parse(second));
    expect(catalogueDocumentSha256V2(first, 20)).not.toBe(catalogueDocumentSha256V2(second, 20));
    expect(() => catalogueDocumentSha256V2("é", 1)).toThrow(/byte budget/u);
    expect(() => catalogueDocumentSha256V2("", 20)).toThrow(/byte budget/u);
  });
});

describe("catalogue V2 exact wire primitives", () => {
  it("preserves integers beyond JavaScript's safe numeric range as decimal text", () => {
    expect(catalogueUnsignedIntegerV2(9_223_372_036_854_775_807n, "count")).toBe(
      "9223372036854775807",
    );
    expect(catalogueUnsignedIntegerV2("9007199254740993", "count")).toBe("9007199254740993");
    expect(catalogueUnsignedIntegerV2(0, "count")).toBe("0");
  });
  it.each([
    "01",
    "-0",
    -0,
    "1e2",
    " 1",
    "1.0",
    -1,
    Number.NaN,
    9_007_199_254_740_992,
    "9223372036854775808",
    null,
  ])("rejects ambiguous/out-of-range count %j", (value) => {
    expect(() => catalogueUnsignedIntegerV2(value, "count")).toThrow();
  });
  it("requires exact lowercase SHA identities", () => {
    expect(() => assertCatalogueSha256V2("a".repeat(64), "digest")).not.toThrow();
    expect(() => assertCatalogueSha256V2("A".repeat(64), "digest")).toThrow();
    expect(() => assertCatalogueSha256V2("a".repeat(63), "digest")).toThrow();
  });
});
