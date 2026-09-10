import { MAX_PASTED_INGREDIENTS, type PastedIngredientLine } from "@nutrition-tracker/contracts";

import { type FoodSearchHit, parseBarcodeResult } from "../search/food-search";
import { isRecipePositiveDecimal, type RecipeIngredientDraft } from "./recipes-goals";

export {
  MAX_PASTED_INGREDIENT_LINE,
  MAX_PASTED_INGREDIENT_TEXT,
  MAX_PASTED_INGREDIENTS,
  type PastedIngredientLine,
  parsePastedIngredientLines,
} from "@nutrition-tracker/contracts";

export type ReviewedFoodIngredient = Extract<RecipeIngredientDraft, { readonly kind: "food" }>;

export interface ReviewedIngredientLine extends PastedIngredientLine {
  readonly ingredient: ReviewedFoodIngredient | null;
}

export function hasReviewedGramServing(food: FoodSearchHit): boolean {
  const grams = food.defaultServing?.gramWeight;
  return typeof grams === "string" && /[1-9]/u.test(grams);
}

/** Accept only a selected catalogue identity and an explicitly entered exact quantity. */
export function reviewedFoodIngredient(
  food: FoodSearchHit,
  kind: "grams" | "serving",
  quantity: string,
  clientKey: string,
): ReviewedFoodIngredient {
  parseBarcodeResult({ data: food });
  if (!isRecipePositiveDecimal(quantity)) {
    throw new RangeError("Enter a positive decimal quantity with at most six decimal places.");
  }
  if (clientKey.length === 0) throw new TypeError("The ingredient review identity is missing.");
  if (kind !== "grams" && kind !== "serving") throw new TypeError("Select grams or servings.");
  const serving = food.defaultServing;
  if (kind === "serving" && (!serving || !hasReviewedGramServing(food))) {
    throw new RangeError("This food has no positive gram-resolved serving. Enter explicit grams.");
  }
  const source = Object.freeze({ ...food.source });
  return Object.freeze({
    kind: "food",
    clientKey,
    foodVersionId: food.foodVersionId,
    name: food.name,
    brandName: food.brandName,
    portion: Object.freeze(
      kind === "serving" && serving
        ? {
            kind: "serving" as const,
            servingId: serving.servingId,
            servingLabel: serving.label,
            amount: quantity,
          }
        : { kind: "grams" as const, grams: quantity },
    ),
    source,
    foodProvenance: Object.freeze({ kind: "public", source }),
    note: null,
  });
}

/** The original lines deliberately cannot enter the recipe builder's request shape. */
export function collectReviewedIngredients(
  lines: readonly ReviewedIngredientLine[],
  remainingCapacity: number,
): readonly ReviewedFoodIngredient[] {
  if (
    !Number.isInteger(remainingCapacity) ||
    remainingCapacity < 0 ||
    remainingCapacity > MAX_PASTED_INGREDIENTS
  ) {
    throw new RangeError("The recipe's remaining ingredient capacity is unavailable.");
  }
  if (lines.length === 0 || lines.length > MAX_PASTED_INGREDIENTS) {
    throw new RangeError("Review between 1 and 50 ingredient lines before adding them.");
  }
  if (lines.length > remainingCapacity) {
    throw new RangeError(`This recipe has room for ${remainingCapacity} more ingredients.`);
  }
  const ingredients = lines.map((line) => {
    if (line.ingredient === null) {
      throw new RangeError(`Review and confirm line ${line.lineNumber} before adding ingredients.`);
    }
    return line.ingredient;
  });
  if (new Set(ingredients.map((ingredient) => ingredient.clientKey)).size !== ingredients.length) {
    throw new TypeError("Each reviewed line needs its own ingredient identity.");
  }
  return Object.freeze(ingredients);
}
