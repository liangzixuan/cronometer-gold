import { type FoodSearchHit, isFoodSearchHit } from "./food-search";
import { isRecipePositiveDecimal, type RecipeIngredientDraft } from "./recipes-goals";

export const MAX_PASTED_INGREDIENTS = 50;
export const MAX_PASTED_INGREDIENT_TEXT = 25_050;
export const MAX_PASTED_INGREDIENT_LINE = 500;

export interface PastedIngredientLine {
  readonly lineNumber: number;
  readonly originalText: string;
}

export type ReviewedFoodIngredient = Extract<RecipeIngredientDraft, { readonly kind: "food" }>;

export interface ReviewedIngredientLine extends PastedIngredientLine {
  readonly ingredient: ReviewedFoodIngredient | null;
}

/** Split only: quantities, names, URLs, and nutrition claims are never interpreted. */
export function parsePastedIngredientLines(text: string): readonly PastedIngredientLine[] {
  if (text.length > MAX_PASTED_INGREDIENT_TEXT) {
    throw new RangeError("Pasted ingredients must contain at most 25,050 characters.");
  }
  const lines: PastedIngredientLine[] = [];
  for (const [index, originalText] of text.split(/\r\n|\n|\r/u).entries()) {
    if (originalText.length > MAX_PASTED_INGREDIENT_LINE) {
      throw new RangeError(
        `Line ${index + 1} exceeds 500 characters. Shorten it before reviewing.`,
      );
    }
    if (originalText.trim().length === 0) continue;
    lines.push({ lineNumber: index + 1, originalText });
    if (lines.length > MAX_PASTED_INGREDIENTS) {
      throw new RangeError("Review at most 50 ingredient lines at a time.");
    }
  }
  if (lines.length === 0) throw new RangeError("Paste at least one ingredient line to review.");
  return lines;
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
  if (!isFoodSearchHit(food)) throw new TypeError("Select a valid food-search result.");
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
