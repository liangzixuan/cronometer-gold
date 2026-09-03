import { sha256CanonicalJson } from "./deterministic.js";
import { IngestionError, type IngestionErrorCode, invariant } from "./errors.js";
import {
  arrayValue,
  asRecord,
  createStagedFood,
  createStagedNutrient,
  createStagedServing,
  firstDefined,
  hasValidGs1CheckDigit,
  identifier,
  type NutrientMappingResolver,
  parseSourceNutrientValue,
  type StagedFoodRecord,
  type StagedKnownQuality,
  type StagedNutrientRecord,
  type StagedServingRecord,
} from "./model.js";

export interface FdcAdapterContext {
  readonly releaseKey: string;
  /** Defaults to no canonical mapping; reviewed mapping is injected by the caller. */
  readonly mappingResolver?: NutrientMappingResolver;
}

export interface FdcCsvAdapterContext extends FdcAdapterContext {
  /** Reviewed ISO 3166-1 alpha-2 market retained from the joined CSV source row. */
  readonly marketCode: string;
}

export interface QuarantinedSourceRecord {
  readonly sourceIndex: number;
  readonly sourceRecordId: string | null;
  readonly code: IngestionErrorCode;
  readonly message: string;
  readonly sourcePayloadHash: string;
}

export interface FdcReleaseParseResult {
  readonly records: readonly StagedFoodRecord[];
  readonly quarantined: readonly QuarantinedSourceRecord[];
  readonly excludedNutrients: readonly ExcludedFdcChildRecord[];
  readonly excludedPortions: readonly ExcludedFdcChildRecord[];
  readonly excludedAttributes: readonly ExcludedFdcAttribute[];
}

export interface ExcludedFdcChildRecord {
  readonly foodSourceRecordId: string;
  readonly sourceIndex: number;
  readonly code: IngestionErrorCode;
  readonly message: string;
  readonly sourcePayloadHash: string;
}

export interface FdcStagedRecordResult {
  readonly record: StagedFoodRecord;
  readonly excludedNutrients: readonly ExcludedFdcChildRecord[];
  readonly excludedPortions: readonly ExcludedFdcChildRecord[];
  readonly excludedAttributes: readonly ExcludedFdcAttribute[];
}

export interface ExcludedFdcAttribute {
  readonly foodSourceRecordId: string;
  readonly attribute: "gtin";
  readonly code: IngestionErrorCode;
  readonly message: string;
  readonly sourcePayloadHash: string;
}

const RELEASE_ARRAYS = [
  ["FoundationFoods", "Foundation"],
  ["SurveyFoods", "FNDDS"],
  ["SRLegacyFoods", "SR Legacy"],
  ["BrandedFoods", "Branded"],
  ["foods", "Unknown"],
] as const;

export function adaptFdcJsonRelease(
  input: unknown,
  context: FdcAdapterContext,
): FdcReleaseParseResult {
  const candidates: { readonly value: unknown; readonly dataType: string }[] = [];
  if (Array.isArray(input)) {
    for (const value of input) {
      candidates.push({ value, dataType: "Unknown" });
    }
  } else {
    const release = asRecord(input, "FDC JSON release");
    for (const [key, dataType] of RELEASE_ARRAYS) {
      const value = release[key];
      if (value !== undefined) {
        for (const food of arrayValue(value, `FDC ${key}`)) {
          candidates.push({ value: food, dataType });
        }
      }
    }
    invariant(
      candidates.length > 0,
      "INVALID_RECORD",
      "FDC JSON release has no recognized food array",
    );
  }

  const records: StagedFoodRecord[] = [];
  const quarantined: QuarantinedSourceRecord[] = [];
  const excludedNutrients: ExcludedFdcChildRecord[] = [];
  const excludedPortions: ExcludedFdcChildRecord[] = [];
  const excludedAttributes: ExcludedFdcAttribute[] = [];
  const seen = new Set<string>();
  for (const [sourceIndex, candidate] of candidates.entries()) {
    try {
      if (candidate.value === null) {
        throw new IngestionError(
          "INVALID_RECORD",
          "FDC release contains a literal null food entry",
        );
      }
      const staged = stageFdcJsonRecordDetailed(candidate.value, context, candidate.dataType);
      const record = staged.record;
      if (seen.has(record.idempotencyKey)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate FDC food key: ${record.idempotencyKey}`,
        );
      }
      seen.add(record.idempotencyKey);
      records.push(record);
      excludedNutrients.push(...staged.excludedNutrients);
      excludedPortions.push(...staged.excludedPortions);
      excludedAttributes.push(...staged.excludedAttributes);
    } catch (error) {
      if (!isFdcRowDispositionError(error)) throw error;
      const record =
        candidate.value && typeof candidate.value === "object" ? candidate.value : null;
      const sourceRecordId = record
        ? optionalIdentifier(
            firstDefined(record as Readonly<Record<string, unknown>>, "fdcId", "fdc_id"),
          )
        : null;
      quarantined.push(
        Object.freeze({
          sourceIndex,
          sourceRecordId,
          code: error instanceof IngestionError ? error.code : "INVALID_RECORD",
          message: error instanceof Error ? error.message : "Unknown FDC adapter error",
          sourcePayloadHash: sha256CanonicalJson(candidate.value),
        }),
      );
    }
  }
  return Object.freeze({
    records: Object.freeze(records),
    quarantined: Object.freeze(quarantined),
    excludedNutrients: Object.freeze(excludedNutrients),
    excludedPortions: Object.freeze(excludedPortions),
    excludedAttributes: Object.freeze(excludedAttributes),
  });
}

export function stageFdcJsonRecord(
  input: unknown,
  context: FdcAdapterContext,
  fallbackDataType = "Unknown",
): StagedFoodRecord {
  return stageFdcJsonRecordDetailed(input, context, fallbackDataType).record;
}

export function stageFdcJsonRecordDetailed(
  input: unknown,
  context: FdcAdapterContext,
  fallbackDataType = "Unknown",
): FdcStagedRecordResult {
  const food = asRecord(input, "FDC food");
  const foodSourceRecordId = identifier(firstDefined(food, "fdcId", "fdc_id"), "FDC food ID");
  const dataType = firstDefined(food, "dataType", "data_type") ?? fallbackDataType;
  const quality: StagedKnownQuality = String(dataType).toLowerCase().includes("branded")
    ? "label"
    : "measured";
  const rawNutrients = decodeArray(
    firstDefined(food, "foodNutrients", "food_nutrients") ?? [],
    "FDC nutrients",
  );
  const nutrients: StagedNutrientRecord[] = [];
  const excludedNutrients: ExcludedFdcChildRecord[] = [];
  const seenNutrients = new Set<string>();
  for (const [index, raw] of rawNutrients.entries()) {
    try {
      const nutrient = stageFdcNutrient(raw, quality, context, index);
      if (seenNutrients.has(nutrient.sourceNutrientId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate FDC nutrient key: ${nutrient.sourceNutrientId}`,
        );
      }
      seenNutrients.add(nutrient.sourceNutrientId);
      nutrients.push(nutrient);
    } catch (error) {
      if (!isFdcRowDispositionError(error)) throw error;
      excludedNutrients.push(excludedChild(foodSourceRecordId, index, raw, error));
    }
  }
  const rawPortions = decodeArray(
    firstDefined(food, "foodPortions", "food_portions") ?? [],
    "FDC portions",
  );
  const servings: StagedServingRecord[] = [];
  const excludedPortions: ExcludedFdcChildRecord[] = [];
  const seenPortions = new Set<string>();
  for (const [index, raw] of rawPortions.entries()) {
    try {
      const serving = stageFdcPortion(raw, index);
      if (seenPortions.has(serving.sourceServingId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate FDC portion key: ${serving.sourceServingId}`,
        );
      }
      seenPortions.add(serving.sourceServingId);
      servings.push(serving);
    } catch (error) {
      if (!isFdcRowDispositionError(error)) throw error;
      excludedPortions.push(excludedChild(foodSourceRecordId, index, raw, error));
    }
  }
  appendFdcLabelServing(
    food,
    foodSourceRecordId,
    rawPortions.length,
    servings,
    seenPortions,
    excludedPortions,
  );
  const gtin = fdcGtin(firstDefined(food, "gtinUpc", "gtin_upc"), foodSourceRecordId);

  const record = createStagedFood({
    sourceCode: "USDA_FDC",
    releaseKey: context.releaseKey,
    sourceRecordId: foodSourceRecordId,
    sourceDataType: dataType,
    languageTag: "en",
    marketCode: "US",
    sourceModifiedAt: normalizeFdcDate(
      firstDefined(food, "publicationDate", "publication_date", "modifiedDate"),
    ),
    description: firstDefined(food, "description", "lowercaseDescription", "lowercase_description"),
    brandOwner: firstDefined(food, "brandOwner", "brand_owner", "brandName", "brand_name"),
    gtin: gtin.value,
    nutrients,
    servings,
    rawSourceRecord: input,
  });
  return Object.freeze({
    record,
    excludedNutrients: Object.freeze(excludedNutrients),
    excludedPortions: Object.freeze(excludedPortions),
    excludedAttributes: gtin.exclusion ? Object.freeze([gtin.exclusion]) : Object.freeze([]),
  });
}

export function stageFdcCsvRecord(
  foodRow: Readonly<Record<string, unknown>>,
  nutrientRows: readonly Readonly<Record<string, unknown>>[],
  portionRows: readonly Readonly<Record<string, unknown>>[],
  context: FdcCsvAdapterContext,
): StagedFoodRecord {
  return stageFdcCsvRecordDetailed(foodRow, nutrientRows, portionRows, context).record;
}

export function stageFdcCsvRecordDetailed(
  foodRow: Readonly<Record<string, unknown>>,
  nutrientRows: readonly Readonly<Record<string, unknown>>[],
  portionRows: readonly Readonly<Record<string, unknown>>[],
  context: FdcCsvAdapterContext,
): FdcStagedRecordResult {
  const fdcId = firstDefined(foodRow, "fdc_id", "fdcId");
  for (const [index, row] of nutrientRows.entries()) {
    invariant(
      String(firstDefined(row, "fdc_id", "fdcId")) === String(fdcId),
      "INVALID_RECORD",
      "FDC nutrient row belongs to a different food",
      { index },
    );
  }
  for (const [index, row] of portionRows.entries()) {
    invariant(
      String(firstDefined(row, "fdc_id", "fdcId")) === String(fdcId),
      "INVALID_RECORD",
      "FDC portion row belongs to a different food",
      { index },
    );
  }
  const sourceDataType = firstDefined(foodRow, "data_type", "dataType");
  const quality: StagedKnownQuality = String(sourceDataType).toLowerCase().includes("branded")
    ? "label"
    : "measured";
  const foodSourceRecordId = identifier(fdcId, "FDC food ID");
  const gtin = fdcGtin(firstDefined(foodRow, "gtin_upc", "gtinUpc"), foodSourceRecordId);
  const nutrients: StagedNutrientRecord[] = [];
  const excludedNutrients: ExcludedFdcChildRecord[] = [];
  const seenNutrients = new Set<string>();
  for (const [index, row] of nutrientRows.entries()) {
    try {
      const nutrient = stageFdcCsvNutrient(row, quality, context, index);
      if (seenNutrients.has(nutrient.sourceNutrientId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate FDC nutrient key: ${nutrient.sourceNutrientId}`,
        );
      }
      seenNutrients.add(nutrient.sourceNutrientId);
      nutrients.push(nutrient);
    } catch (error) {
      if (!isFdcRowDispositionError(error)) throw error;
      excludedNutrients.push(excludedChild(foodSourceRecordId, index, row, error));
    }
  }
  const servings: StagedServingRecord[] = [];
  const excludedPortions: ExcludedFdcChildRecord[] = [];
  const seenPortions = new Set<string>();
  for (const [index, row] of portionRows.entries()) {
    try {
      const serving = stageFdcCsvPortion(row, index, sourceDataType === "FNDDS");
      if (seenPortions.has(serving.sourceServingId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate FDC portion key: ${serving.sourceServingId}`,
        );
      }
      seenPortions.add(serving.sourceServingId);
      servings.push(serving);
    } catch (error) {
      if (!isFdcRowDispositionError(error)) throw error;
      excludedPortions.push(excludedChild(foodSourceRecordId, index, row, error));
    }
  }
  appendFdcLabelServing(
    foodRow,
    foodSourceRecordId,
    portionRows.length,
    servings,
    seenPortions,
    excludedPortions,
  );
  const record = createStagedFood({
    sourceCode: "USDA_FDC",
    releaseKey: context.releaseKey,
    sourceRecordId: fdcId,
    sourceDataType,
    languageTag: "en",
    marketCode: context.marketCode,
    sourceModifiedAt: normalizeFdcDate(
      firstDefined(foodRow, "publication_date", "publicationDate"),
    ),
    description: firstDefined(foodRow, "description"),
    brandOwner: firstDefined(foodRow, "brand_owner", "brandOwner", "brand_name"),
    gtin: gtin.value,
    nutrients,
    servings,
    rawSourceRecord: { foodRow, nutrientRows, portionRows },
  });
  return Object.freeze({
    record,
    excludedNutrients: Object.freeze(excludedNutrients),
    excludedPortions: Object.freeze(excludedPortions),
    excludedAttributes: gtin.exclusion ? Object.freeze([gtin.exclusion]) : Object.freeze([]),
  });
}

function stageFdcNutrient(
  input: unknown,
  quality: StagedKnownQuality,
  context: FdcAdapterContext,
  index: number,
): StagedNutrientRecord {
  const row = asRecord(input, `FDC nutrient ${index}`);
  const nestedCandidate = row.nutrient;
  const nutrient =
    nestedCandidate === undefined
      ? row
      : asRecord(nestedCandidate, `FDC nutrient definition ${index}`);
  const sourceNutrientId = identifier(
    firstDefined(nutrient, "id", "nutrientId", "nutrient_id") ??
      firstDefined(row, "nutrientId", "nutrient_id"),
    "FDC nutrient ID",
  );
  const sourceName =
    firstDefined(nutrient, "name", "nutrientName", "nutrient_name") ??
    firstDefined(row, "nutrientName", "nutrient_name") ??
    `FDC nutrient ${sourceNutrientId}`;
  const originalUnit =
    firstDefined(nutrient, "unitName", "unit_name", "unit") ??
    firstDefined(row, "unitName", "unit_name", "unit");
  const unit = identifier(originalUnit, "FDC nutrient unit");
  const mapping =
    context.mappingResolver?.({
      source: "FDC",
      sourceNutrientId,
      sourceSymbol: null,
      sourceTagname: null,
      originalUnit: unit,
    }) ?? null;
  const derivationCandidate = firstDefined(
    row,
    "foodNutrientDerivation",
    "food_nutrient_derivation",
  );
  const derivation =
    derivationCandidate &&
    typeof derivationCandidate === "object" &&
    !Array.isArray(derivationCandidate)
      ? (derivationCandidate as Readonly<Record<string, unknown>>)
      : {};
  return createStagedNutrient({
    sourceNutrientId,
    sourceName,
    originalUnit: unit,
    mapping,
    derivationCode:
      firstDefined(derivation, "code", "id") ??
      firstDefined(row, "derivationCode", "derivation_code", "derivation_id"),
    dataPoints: firstDefined(row, "dataPoints", "data_points"),
    value: parseSourceNutrientValue(
      firstDefined(row, "amount", "value", "nutrientAmount", "nutrient_amount"),
      quality,
      `FDC nutrient ${sourceNutrientId} amount`,
    ),
  });
}

function stageFdcCsvNutrient(
  row: Readonly<Record<string, unknown>>,
  quality: StagedKnownQuality,
  context: FdcAdapterContext,
  index: number,
): StagedNutrientRecord {
  const nested: Record<string, unknown> = {
    nutrientId: firstDefined(row, "nutrient_id", "nutrientId"),
    nutrientName:
      firstDefined(row, "nutrient_name", "nutrientName", "name") ??
      `FDC nutrient ${String(firstDefined(row, "nutrient_id", "nutrientId"))}`,
    unitName: firstDefined(row, "unit_name", "unitName", "unit"),
    amount: fdcCsvNutrientAmount(row),
    derivation_code: firstDefined(row, "derivation_code", "derivationCode"),
    data_points: firstDefined(row, "data_points", "dataPoints"),
  };
  return stageFdcNutrient(nested, quality, context, index);
}

function fdcCsvNutrientAmount(row: Readonly<Record<string, unknown>>): unknown {
  const amount = firstDefined(row, "amount", "value");
  const loq = firstDefined(row, "loq", "limit_of_quantitation");
  const amountIsMissingOrZero =
    amount === null ||
    amount === undefined ||
    amount === "" ||
    (typeof amount === "string" && /^\+?0+(?:\.0+)?$/u.test(amount.trim())) ||
    amount === 0;
  const loqText = typeof loq === "string" ? loq.trim() : typeof loq === "number" ? String(loq) : "";
  if (amountIsMissingOrZero && loqText.length > 0) {
    const numericLoq = Number(loqText);
    if (numericLoq === 0) return amount;
    return `<${loqText}`;
  }
  return amount;
}

function stageFdcPortion(input: unknown, index: number): StagedServingRecord {
  const portion = asRecord(input, `FDC portion ${index}`);
  const measureCandidate = portion.measureUnit;
  const measure =
    measureCandidate === undefined
      ? {}
      : asRecord(measureCandidate, `FDC portion measure ${index}`);
  const unit =
    firstDefined(measure, "abbreviation", "name") ?? firstDefined(portion, "measure_unit", "unit");
  const rawDescription = firstDefined(portion, "modifier", "portionDescription");
  const description =
    typeof rawDescription === "string" && rawDescription.trim().length > 0 ? rawDescription : unit;
  return createStagedServing({
    sourceServingId: firstDefined(portion, "id", "food_portion_id") ?? index,
    description,
    amount: firstDefined(portion, "amount") ?? 1,
    unit,
    gramWeight: firstDefined(portion, "gramWeight", "gram_weight"),
  });
}

function stageFdcCsvPortion(
  row: Readonly<Record<string, unknown>>,
  index: number,
  allowBlankAmount: boolean,
): StagedServingRecord {
  const rawAmount = firstDefined(row, "amount");
  const amount =
    allowBlankAmount && (rawAmount === "" || rawAmount === null || rawAmount === undefined)
      ? 1
      : rawAmount;
  return createStagedServing({
    sourceServingId: firstDefined(row, "id", "food_portion_id") ?? index,
    description: firstNonblankText(
      row,
      "portion_description",
      "modifier",
      "measure_unit_name",
      "unit",
    ),
    amount,
    unit: firstDefined(row, "measure_unit_name", "measure_unit", "unit"),
    gramWeight: firstDefined(row, "gram_weight", "gramWeight"),
  });
}

function firstNonblankText(
  record: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function appendFdcLabelServing(
  food: Readonly<Record<string, unknown>>,
  foodSourceRecordId: string,
  sourceIndex: number,
  servings: StagedServingRecord[],
  seenPortions: Set<string>,
  exclusions: ExcludedFdcChildRecord[],
): void {
  try {
    const labelServing = fdcLabelServing(food);
    if (!labelServing) return;
    if (seenPortions.has(labelServing.sourceServingId)) {
      throw new IngestionError("DUPLICATE_KEY", "Duplicate FDC label serving key");
    }
    seenPortions.add(labelServing.sourceServingId);
    servings.push(labelServing);
  } catch (error) {
    if (!isFdcRowDispositionError(error)) throw error;
    exclusions.push(excludedChild(foodSourceRecordId, sourceIndex, food, error));
  }
}

function fdcLabelServing(food: Readonly<Record<string, unknown>>): StagedServingRecord | null {
  const size = firstDefined(food, "servingSize", "serving_size");
  const unit = firstDefined(food, "servingSizeUnit", "serving_size_unit");
  if (
    size === undefined ||
    size === null ||
    size === "" ||
    unit === undefined ||
    unit === null ||
    unit === ""
  ) {
    return null;
  }
  const normalizedUnit = String(unit).trim();
  const descriptionCandidate = firstDefined(
    food,
    "householdServingFullText",
    "household_serving_full_text",
    "household_serving_fulltext",
  );
  const description =
    typeof descriptionCandidate === "string" && descriptionCandidate.trim().length > 0
      ? descriptionCandidate
      : `${String(size)} ${normalizedUnit}`;
  return createStagedServing({
    sourceServingId: "label-serving",
    description,
    amount: 1,
    unit: "serving",
    gramWeight: /^g(?:ram)?s?$/i.test(normalizedUnit) ? size : null,
  });
}

function decodeArray(value: unknown, field: string): readonly unknown[] {
  if (typeof value === "string") {
    try {
      return arrayValue(JSON.parse(value), field);
    } catch (error) {
      if (error instanceof IngestionError) {
        throw error;
      }
      throw new IngestionError(
        "INVALID_RECORD",
        `${field} is not valid JSON`,
        {},
        { cause: error },
      );
    }
  }
  return arrayValue(value, field);
}

function optionalIdentifier(value: unknown): string | null {
  try {
    return value === undefined || value === null ? null : identifier(value, "FDC food ID");
  } catch {
    return null;
  }
}

function excludedChild(
  foodSourceRecordId: string,
  sourceIndex: number,
  raw: unknown,
  error: unknown,
): ExcludedFdcChildRecord {
  return Object.freeze({
    foodSourceRecordId,
    sourceIndex,
    code: error instanceof IngestionError ? error.code : "INVALID_RECORD",
    message: error instanceof Error ? error.message : "Unknown FDC child adapter error",
    sourcePayloadHash: safeSourceHash(raw),
  });
}

function safeSourceHash(raw: unknown): string {
  try {
    return sha256CanonicalJson(raw);
  } catch {
    return sha256CanonicalJson({ invalidJsonValueType: typeof raw });
  }
}

function fdcGtin(
  raw: unknown,
  foodSourceRecordId: string,
): { readonly value: string | null; readonly exclusion: ExcludedFdcAttribute | null } {
  if (raw === null || raw === undefined || raw === "") {
    return Object.freeze({ value: null, exclusion: null });
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  if (/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value) && hasValidGs1CheckDigit(value)) {
    return Object.freeze({ value: value.padStart(14, "0"), exclusion: null });
  }
  return Object.freeze({
    value: null,
    exclusion: Object.freeze({
      foodSourceRecordId,
      attribute: "gtin",
      code: "INVALID_RECORD",
      message: "FDC GTIN has an invalid length, representation, or GS1 check digit",
      sourcePayloadHash: safeSourceHash(raw),
    }),
  });
}

function isFdcRowDispositionError(error: unknown): error is IngestionError {
  return (
    error instanceof IngestionError &&
    (error.code === "DUPLICATE_KEY" || error.code === "INVALID_RECORD")
  );
}

export function normalizeFdcDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  invariant(typeof value === "string", "INVALID_RECORD", "FDC publication date must be text");
  const input = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
  const year = Number(iso?.[1] ?? us?.[3]);
  const month = Number(iso?.[2] ?? us?.[1]);
  const day = Number(iso?.[3] ?? us?.[2]);
  invariant(
    (iso !== null || us !== null) && year >= 1 && month >= 1 && month <= 12,
    "INVALID_RECORD",
    "FDC publication date has an unsupported format",
    { value: input },
  );
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  invariant(
    day >= 1 && day <= daysInMonth,
    "INVALID_RECORD",
    "FDC publication date is not a real calendar date",
    { value: input },
  );
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
