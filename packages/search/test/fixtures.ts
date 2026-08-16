import type { FoodSearchDocument } from "../src/index.js";

export function foodDocument(overrides: Partial<FoodSearchDocument> = {}): FoodSearchDocument {
  const foodId = overrides.foodId ?? "100";
  return {
    id: overrides.id ?? `food_${foodId}`,
    foodId,
    foodVersionId: overrides.foodVersionId ?? `${foodId}1`,
    kind: overrides.kind ?? "generic",
    name: overrides.name ?? "Banana, raw",
    normalizedName: overrides.normalizedName ?? "banana raw",
    brandName: overrides.brandName ?? null,
    aliases: overrides.aliases ?? ["banana"],
    barcodes: overrides.barcodes ?? [],
    servingLabels: overrides.servingLabels ?? ["100 g"],
    marketCode: overrides.marketCode ?? "001",
    languageTag: overrides.languageTag ?? "en-US",
    source: overrides.source ?? {
      code: "USDA_FDC",
      displayName: "USDA FoodData Central",
      licenseExpression: "CC0-1.0",
      attributionRequired: false,
      attributionText: "USDA FoodData Central",
    },
    dataQuality: overrides.dataQuality ?? "verified",
    defaultServing: overrides.defaultServing ?? {
      servingId: `${foodId}01`,
      label: "100 g",
      quantity: "100.000000",
      unit: "g",
      gramWeight: "100.000000",
      milliliterVolume: null,
    },
  };
}
