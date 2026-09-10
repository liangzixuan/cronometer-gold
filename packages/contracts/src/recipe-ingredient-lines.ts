export const MAX_PASTED_INGREDIENTS = 50;
export const MAX_PASTED_INGREDIENT_TEXT = 25_050;
export const MAX_PASTED_INGREDIENT_LINE = 500;

export interface PastedIngredientLine {
  readonly lineNumber: number;
  readonly originalText: string;
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
