const SYNONYM_GROUPS = [
  ["arugula", "rocket"],
  ["aubergine", "eggplant"],
  ["bell pepper", "capsicum"],
  ["chickpea", "chickpeas", "garbanzo bean", "garbanzo beans"],
  ["cilantro", "coriander"],
  ["courgette", "zucchini"],
  ["green onion", "scallion", "spring onion"],
  ["yoghurt", "yogurt"],
] as const;

function buildCuratedSynonyms(): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    SYNONYM_GROUPS.flatMap((group) =>
      group.map((term) => [term, group.filter((candidate) => candidate !== term)]),
    ),
  );
}

export const CURATED_FOOD_SYNONYMS = buildCuratedSynonyms();

/**
 * Shared-index settings. Barcode attributes and all numeric tokens have typo tolerance disabled so
 * one product identifier cannot silently become another.
 */
export const FOOD_SEARCH_INDEX_SETTINGS = Object.freeze({
  displayedAttributes: [
    "id",
    "foodId",
    "foodVersionId",
    "kind",
    "name",
    "normalizedName",
    "brandName",
    "aliases",
    "barcodes",
    "servingLabels",
    "marketCode",
    "languageTag",
    "source",
    "dataQuality",
    "defaultServing",
    "searchGeneration",
  ],
  searchableAttributes: [
    "name",
    "brandName",
    "aliases",
    "servingLabels",
    "source.displayName",
    "barcodes",
  ],
  filterableAttributes: ["kind", "marketCode", "languageTag", "barcodes", "dataQuality"],
  sortableAttributes: [],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  stopWords: [],
  synonyms: CURATED_FOOD_SYNONYMS,
  distinctAttribute: "foodId",
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: {
      oneTypo: 5,
      twoTypos: 9,
    },
    disableOnWords: [],
    disableOnAttributes: ["barcodes"],
    disableOnNumbers: true,
  },
  pagination: {
    maxTotalHits: 1000,
  },
});
