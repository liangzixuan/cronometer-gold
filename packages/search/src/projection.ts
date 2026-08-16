import { compareDeterministicText } from "./deterministic.js";
import { assertFoodSearchDocument } from "./document.js";
import { normalizeGtin, normalizeLanguageTag, normalizeMarketCode } from "./query.js";
import type {
  FoodDataQuality,
  FoodSearchDocument,
  FoodSearchServing,
  PublicFoodKind,
} from "./types.js";

const MAX_DOCUMENT_BARCODES = 32;
const MAX_SERVING_LABELS = 64;

export interface FoodSearchProjectionBarcodeInput {
  readonly gtin14: string;
}

export interface FoodSearchProjectionServingInput {
  readonly id: string;
  readonly label: string;
  readonly quantity: string;
  readonly unit: string;
  readonly gramWeight: string | null;
  readonly milliliterVolume: string | null;
  readonly isDefault: boolean;
  readonly displayOrder: number;
}

/** Structural subset accepted from the PostgreSQL public catalogue projection. */
export interface FoodSearchProjectionDocumentInput {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly kind: PublicFoodKind;
  readonly name: string;
  readonly normalizedName: string;
  readonly brandName: string | null;
  readonly marketCode: string;
  readonly languageTag: string;
  readonly dataQuality: FoodDataQuality;
  readonly sourceCode: string;
  readonly sourceDisplayName: string;
  readonly licenseExpression: string;
  readonly attributionRequired: boolean;
  readonly attributionText: string;
  readonly barcodes: readonly FoodSearchProjectionBarcodeInput[];
  readonly servings: readonly FoodSearchProjectionServingInput[];
}

function uniqueNonBlank(values: readonly string[], maximum: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.normalize("NFKC").trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length === maximum) {
      break;
    }
  }
  return result;
}

function compareServings(
  left: FoodSearchProjectionServingInput,
  right: FoodSearchProjectionServingInput,
): number {
  return (
    Number(right.isDefault) - Number(left.isDefault) ||
    left.displayOrder - right.displayOrder ||
    compareDeterministicText(left.label, right.label) ||
    compareDeterministicText(left.id, right.id)
  );
}

function toDefaultServing(
  servings: readonly FoodSearchProjectionServingInput[],
): FoodSearchServing | null {
  const selected = [...servings].sort(compareServings)[0];
  if (selected === undefined) {
    return null;
  }
  return {
    servingId: selected.id,
    label: selected.label,
    quantity: selected.quantity,
    unit: selected.unit,
    gramWeight: selected.gramWeight,
    milliliterVolume: selected.milliliterVolume,
  };
}

/** Convert the DB projection once, at the worker boundary, and validate before external indexing. */
export function toFoodSearchDocument(input: FoodSearchProjectionDocumentInput): FoodSearchDocument {
  const barcodes = uniqueNonBlank(
    input.barcodes.flatMap(({ gtin14 }) => (normalizeGtin(gtin14) === gtin14 ? [gtin14] : [])),
    MAX_DOCUMENT_BARCODES,
  );
  const document: FoodSearchDocument = {
    id: input.foodId,
    foodId: input.foodId,
    foodVersionId: input.foodVersionId,
    kind: input.kind,
    name: input.name,
    normalizedName: input.normalizedName,
    brandName: input.kind === "generic" ? null : input.brandName,
    aliases: [],
    barcodes,
    servingLabels: uniqueNonBlank(
      [...input.servings].sort(compareServings).map(({ label }) => label),
      MAX_SERVING_LABELS,
    ),
    marketCode: normalizeMarketCode(input.marketCode) ?? "001",
    languageTag: normalizeLanguageTag(input.languageTag) ?? "und",
    source: {
      code: input.sourceCode,
      displayName: input.sourceDisplayName,
      licenseExpression: input.licenseExpression,
      attributionRequired: input.attributionRequired,
      attributionText: input.attributionText,
    },
    dataQuality: input.dataQuality,
    defaultServing: toDefaultServing(input.servings),
  };
  assertFoodSearchDocument(document);
  return document;
}
