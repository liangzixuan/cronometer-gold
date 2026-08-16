import { describe, expect, it } from "vitest";

import { isValidGtin, normalizeGtin14 } from "../src/food-search.js";

describe("GTIN normalization", () => {
  it("validates each GS1 length and canonicalizes equivalent identities", () => {
    expect(normalizeGtin14("96385074")).toBe("00000096385074");
    expect(normalizeGtin14("036000291452")).toBe("00036000291452");
    expect(normalizeGtin14("4006381333931")).toBe("04006381333931");
    expect(normalizeGtin14("10012345000017")).toBe("10012345000017");
    expect(normalizeGtin14("00036000291452")).toBe(normalizeGtin14("036000291452"));
  });

  it("rejects bad check digits, unsupported lengths, and formatted text", () => {
    for (const invalid of [
      "96385075",
      "036000291453",
      "123456789",
      "03600-0291452",
      "not-a-barcode",
    ]) {
      expect(isValidGtin(invalid)).toBe(false);
      expect(() => normalizeGtin14(invalid)).toThrow();
    }
  });
});
