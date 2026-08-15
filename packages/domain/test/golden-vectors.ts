import {
  CORE_NUTRIENTS,
  createNutrientProfile,
  knownNutrient,
  type NutrientDefinition,
  nutrientDatum,
  unknownNutrient,
} from "../src/index.js";

function requireCoreNutrient(id: string): NutrientDefinition {
  const nutrient = CORE_NUTRIENTS.find((candidate) => candidate.id === id);
  if (!nutrient) {
    throw new Error(`Missing core nutrient fixture: ${id}`);
  }
  return nutrient;
}

export const ENERGY = requireCoreNutrient("energy");
export const PROTEIN = requireCoreNutrient("protein");
export const IRON = requireCoreNutrient("iron");

export const PORRIDGE_GOLDEN_VECTOR = Object.freeze({
  nutrients: Object.freeze([ENERGY, PROTEIN, IRON]),
  ingredients: Object.freeze([
    Object.freeze({
      id: "oats-v1",
      name: "Rolled oats",
      grams: "80",
      nutrientProfile: createNutrientProfile("100", [
        nutrientDatum(ENERGY, knownNutrient("389", "measured")),
        nutrientDatum(PROTEIN, knownNutrient("16.9", "measured")),
        nutrientDatum(IRON, knownNutrient("4.72", "measured")),
      ]),
    }),
    Object.freeze({
      id: "milk-v1",
      name: "Whole milk",
      grams: "240",
      nutrientProfile: createNutrientProfile("100", [
        nutrientDatum(ENERGY, knownNutrient("61", "measured")),
        nutrientDatum(PROTEIN, knownNutrient("3.15", "measured")),
        nutrientDatum(IRON, unknownNutrient("not_analyzed")),
      ]),
    }),
    Object.freeze({
      id: "banana-v1",
      name: "Banana",
      grams: "120",
      nutrientProfile: createNutrientProfile("100", [
        nutrientDatum(ENERGY, knownNutrient("89", "measured")),
        nutrientDatum(PROTEIN, knownNutrient("1.09", "measured")),
        nutrientDatum(IRON, knownNutrient("0.26", "measured")),
      ]),
    }),
  ]),
  finalYield: Object.freeze({ grams: "400", source: "measured" as const }),
  servingCount: "2",
  expected: Object.freeze({
    total: Object.freeze({
      energy: "564.4",
      protein: "22.388",
      iron: "4.088",
    }),
    per100Grams: Object.freeze({
      energy: "141.1",
      protein: "5.597",
      iron: "1.022",
    }),
    perServing: Object.freeze({
      energy: "282.2",
      protein: "11.194",
      iron: "2.044",
    }),
  }),
});
