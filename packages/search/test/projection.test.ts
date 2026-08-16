import { describe, expect, it } from "vitest";
import { type FoodSearchProjectionDocumentInput, toFoodSearchDocument } from "../src/index.js";

function projection(
  overrides: Partial<FoodSearchProjectionDocumentInput> = {},
): FoodSearchProjectionDocumentInput {
  return {
    foodId: "123",
    foodVersionId: "456",
    kind: "branded",
    name: "Example oats",
    normalizedName: "example oats",
    brandName: "Example",
    marketCode: "us",
    languageTag: "EN-us",
    dataQuality: "verified",
    sourceCode: "USDA_FDC",
    sourceDisplayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    attributionRequired: false,
    attributionText: "USDA FoodData Central",
    barcodes: [
      { gtin14: "00036000291452" },
      { gtin14: "00036000291452" },
      { gtin14: "00036000291453" },
    ],
    servings: [
      {
        id: "2",
        label: "1 package",
        quantity: "1.000000",
        unit: "package",
        gramWeight: null,
        milliliterVolume: null,
        isDefault: true,
        displayOrder: 10,
      },
      {
        id: "1",
        label: "100 g",
        quantity: "100.000000",
        unit: "g",
        gramWeight: "100.000000",
        milliliterVolume: null,
        isDefault: false,
        displayOrder: 0,
      },
    ],
    ...overrides,
  };
}

describe("PostgreSQL projection conversion", () => {
  it("canonicalizes locale/market, de-duplicates barcodes, and chooses a default serving", () => {
    const document = toFoodSearchDocument(projection());
    expect(document.id).toBe("123");
    expect(document.languageTag).toBe("en-US");
    expect(document.marketCode).toBe("US");
    expect(document.aliases).toEqual([]);
    expect(document.barcodes).toEqual(["00036000291452"]);
    expect(document.servingLabels).toEqual(["1 package", "100 g"]);
    expect(document.source).toEqual({
      code: "USDA_FDC",
      displayName: "USDA FoodData Central",
      licenseExpression: "CC0-1.0",
      attributionRequired: false,
      attributionText: "USDA FoodData Central",
    });
    expect(document.defaultServing).toEqual({
      servingId: "2",
      label: "1 package",
      quantity: "1.000000",
      unit: "package",
      gramWeight: null,
      milliliterVolume: null,
    });
  });

  it("removes an accidental brand from a generic document and tolerates no servings", () => {
    const document = toFoodSearchDocument(
      projection({ kind: "generic", brandName: "Should not be indexed", servings: [] }),
    );
    expect(document.brandName).toBeNull();
    expect(document.defaultServing).toBeNull();
    expect(document.servingLabels).toEqual([]);
  });

  it("caps externally searchable barcode and serving arrays", () => {
    const barcodes = Array.from({ length: 40 }, (_, index) => ({
      gtin14: makeGtin14(index + 1),
    }));
    const servings = Array.from({ length: 80 }, (_, index) => ({
      id: String(index + 1),
      label: `Serving ${index}`,
      quantity: "1.000000",
      unit: "serving",
      gramWeight: null,
      milliliterVolume: null,
      isDefault: index === 0,
      displayOrder: index,
    }));
    const document = toFoodSearchDocument(projection({ barcodes, servings }));
    expect(document.barcodes).toHaveLength(32);
    expect(document.servingLabels).toHaveLength(64);
  });
});

function makeGtin14(value: number): string {
  const data = String(value).padStart(13, "0");
  let sum = 0;
  for (let index = data.length - 1, position = 0; index >= 0; index -= 1, position += 1) {
    sum += Number(data[index]) * (position % 2 === 0 ? 3 : 1);
  }
  return `${data}${(10 - (sum % 10)) % 10}`;
}
