import { sha256CanonicalJson } from "./deterministic.js";
import { IngestionError, type IngestionErrorCode, invariant } from "./errors.js";
import {
  createStagedFood,
  createStagedNutrient,
  createStagedServing,
  firstDefined,
  identifier,
  type NutrientMappingResolver,
  parseSourceNutrientValue,
  type StagedFoodRecord,
  type StagedNutrientRecord,
  type StagedServingRecord,
} from "./model.js";

export type SourceRow = Readonly<Record<string, unknown>>;

export interface CnfAdapterContext {
  readonly releaseKey: string;
  /** Defaults to no canonical mapping; reviewed mapping is injected by the caller. */
  readonly mappingResolver?: NutrientMappingResolver;
}

export interface CnfTables {
  readonly foodNames: readonly SourceRow[];
  readonly nutrientNames: readonly SourceRow[];
  readonly nutrientAmounts: readonly SourceRow[];
  readonly measureNames: readonly SourceRow[];
  readonly measureWeightConversions: readonly SourceRow[];
}

export interface SkippedCnfMeasure {
  readonly foodCode: string;
  readonly measureTypeCode: string;
  readonly measureCode: string;
  readonly reason: "non_user_facing_refuse" | "non_user_facing_yield" | "unsupported_measure_type";
  readonly sourcePayloadHash: string;
}

export interface CnfQuarantinedRecord {
  readonly sourceIndex: number;
  readonly sourceRecordId: string | null;
  readonly code: IngestionErrorCode;
  readonly message: string;
  readonly sourcePayloadHash: string;
}

export interface CnfReleaseParseResult {
  readonly records: readonly StagedFoodRecord[];
  readonly quarantined: readonly CnfQuarantinedRecord[];
  readonly skippedMeasures: readonly SkippedCnfMeasure[];
  readonly excludedNutrients: readonly ExcludedCnfChildRecord[];
  readonly excludedMeasures: readonly ExcludedCnfChildRecord[];
}

export interface ExcludedCnfChildRecord {
  readonly foodCode: string;
  readonly sourceIndex: number;
  readonly code: IngestionErrorCode;
  readonly message: string;
  readonly sourcePayloadHash: string;
}

export interface CnfStagedRecordResult {
  readonly record: StagedFoodRecord;
  readonly skippedMeasures: readonly SkippedCnfMeasure[];
  readonly excludedNutrients: readonly ExcludedCnfChildRecord[];
  readonly excludedMeasures: readonly ExcludedCnfChildRecord[];
}

export function adaptCnfTables(
  tables: CnfTables,
  context: CnfAdapterContext,
): CnfReleaseParseResult {
  const nutrientNames = indexUnique(
    tables.nutrientNames,
    ["Nutrient_Code", "nutrient_code"],
    "CNF nutrient",
  );
  const measureNames = indexUnique(
    tables.measureNames,
    ["Measure_Code", "measure_code"],
    "CNF measure",
  );
  const nutrientAmounts = groupByFood(tables.nutrientAmounts, "CNF nutrient amount");
  const measureWeights = groupByFood(tables.measureWeightConversions, "CNF measure weight");
  const records: StagedFoodRecord[] = [];
  const quarantined: CnfQuarantinedRecord[] = [];
  const skippedMeasures: SkippedCnfMeasure[] = [];
  const excludedNutrients: ExcludedCnfChildRecord[] = [];
  const excludedMeasures: ExcludedCnfChildRecord[] = [];
  const seenFoods = new Set<string>();

  for (const [sourceIndex, food] of tables.foodNames.entries()) {
    const sourceId = optionalIdentifier(firstDefined(food, "Food_Code", "food_code"));
    try {
      invariant(sourceId !== null, "INVALID_RECORD", "CNF food is missing Food_Code");
      if (seenFoods.has(sourceId)) {
        throw new IngestionError("DUPLICATE_KEY", `Duplicate CNF Food_Code: ${sourceId}`);
      }
      seenFoods.add(sourceId);
      const result = stageCnfRecordDetailed(
        food,
        nutrientAmounts.get(sourceId) ?? [],
        nutrientNames,
        measureWeights.get(sourceId) ?? [],
        measureNames,
        context,
      );
      records.push(result.record);
      skippedMeasures.push(...result.skippedMeasures);
      excludedNutrients.push(...result.excludedNutrients);
      excludedMeasures.push(...result.excludedMeasures);
    } catch (error) {
      quarantined.push(
        Object.freeze({
          sourceIndex,
          sourceRecordId: sourceId,
          code: error instanceof IngestionError ? error.code : "INVALID_RECORD",
          message: error instanceof Error ? error.message : "Unknown CNF adapter error",
          sourcePayloadHash: sha256CanonicalJson(food),
        }),
      );
    }
  }
  return Object.freeze({
    records: Object.freeze(records),
    quarantined: Object.freeze(quarantined),
    skippedMeasures: Object.freeze(skippedMeasures),
    excludedNutrients: Object.freeze(excludedNutrients),
    excludedMeasures: Object.freeze(excludedMeasures),
  });
}

export function stageCnfRecord(
  foodRow: SourceRow,
  nutrientAmountRows: readonly SourceRow[],
  nutrientDefinitions: ReadonlyMap<string, SourceRow> | readonly SourceRow[],
  measureRows: readonly SourceRow[],
  measureDefinitions: ReadonlyMap<string, SourceRow> | readonly SourceRow[],
  context: CnfAdapterContext,
): StagedFoodRecord {
  return stageCnfRecordDetailed(
    foodRow,
    nutrientAmountRows,
    asDefinitionMap(nutrientDefinitions, ["Nutrient_Code", "nutrient_code"], "CNF nutrient"),
    measureRows,
    asDefinitionMap(measureDefinitions, ["Measure_Code", "measure_code"], "CNF measure"),
    context,
  ).record;
}

export function stageCnfRecordDetailed(
  foodRow: SourceRow,
  nutrientAmountRows: readonly SourceRow[],
  nutrientDefinitions: ReadonlyMap<string, SourceRow>,
  measureRows: readonly SourceRow[],
  measureDefinitions: ReadonlyMap<string, SourceRow>,
  context: CnfAdapterContext,
): CnfStagedRecordResult {
  const foodCode = identifier(firstDefined(foodRow, "Food_Code", "food_code"), "CNF Food_Code");
  const nutrients: StagedNutrientRecord[] = [];
  const excludedNutrients: ExcludedCnfChildRecord[] = [];
  const seenNutrients = new Set<string>();
  for (const [index, row] of nutrientAmountRows.entries()) {
    try {
      invariant(
        String(firstDefined(row, "Food_Code", "food_code")) === foodCode,
        "INVALID_RECORD",
        "CNF nutrient amount belongs to a different food",
        { index, foodCode },
      );
      const nutrient = stageCnfNutrient(row, nutrientDefinitions, context, index);
      if (seenNutrients.has(nutrient.sourceNutrientId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate CNF nutrient key: ${nutrient.sourceNutrientId}`,
        );
      }
      seenNutrients.add(nutrient.sourceNutrientId);
      nutrients.push(nutrient);
    } catch (error) {
      excludedNutrients.push(excludedCnfChild(foodCode, index, row, error));
    }
  }
  const servings: StagedServingRecord[] = [];
  const skippedMeasures: SkippedCnfMeasure[] = [];
  const excludedMeasures: ExcludedCnfChildRecord[] = [];
  const seenMeasures = new Set<string>();
  for (const [index, row] of measureRows.entries()) {
    invariant(
      String(firstDefined(row, "Food_Code", "food_code")) === foodCode,
      "INVALID_RECORD",
      "CNF measure weight belongs to a different food",
      { index, foodCode },
    );
    const measureTypeCode = identifier(
      firstDefined(row, "Measure_Type_Code", "measure_type_code"),
      "CNF Measure_Type_Code",
    );
    const measureCode = identifier(
      firstDefined(row, "Measure_Code", "measure_code"),
      "CNF Measure_Code",
    );
    if (measureTypeCode !== "6") {
      const reason =
        measureTypeCode === "3"
          ? "non_user_facing_refuse"
          : measureTypeCode === "9"
            ? "non_user_facing_yield"
            : "unsupported_measure_type";
      skippedMeasures.push(
        Object.freeze({
          foodCode,
          measureTypeCode,
          measureCode,
          reason,
          sourcePayloadHash: sha256CanonicalJson(row),
        }),
      );
      continue;
    }
    try {
      const serving = stageCnfMeasure(row, measureDefinitions, index);
      if (seenMeasures.has(serving.sourceServingId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate CNF measure key: ${serving.sourceServingId}`,
        );
      }
      seenMeasures.add(serving.sourceServingId);
      servings.push(serving);
    } catch (error) {
      excludedMeasures.push(excludedCnfChild(foodCode, index, row, error));
    }
  }

  return Object.freeze({
    record: createStagedFood({
      sourceCode: "HEALTH_CANADA_CNF",
      releaseKey: context.releaseKey,
      sourceRecordId: foodCode,
      sourceDataType: "CNF",
      languageTag: "en",
      marketCode: "CA",
      sourceModifiedAt: firstDefined(foodRow, "Food_Last_Updated_Date", "food_last_updated_date"),
      description: firstDefined(
        foodRow,
        "Food_Description_EN",
        "Food_Description",
        "food_description",
      ),
      descriptionFr: firstDefined(
        foodRow,
        "Food_Description_FR",
        "Food_Description_F",
        "Food_Description_Fr",
        "food_description_f",
      ),
      nutrients,
      servings,
      rawSourceRecord: { foodRow, nutrientAmountRows, measureRows },
    }),
    skippedMeasures: Object.freeze(skippedMeasures),
    excludedNutrients: Object.freeze(excludedNutrients),
    excludedMeasures: Object.freeze(excludedMeasures),
  });
}

function stageCnfNutrient(
  row: SourceRow,
  definitions: ReadonlyMap<string, SourceRow>,
  context: CnfAdapterContext,
  index: number,
): StagedNutrientRecord {
  const sourceNutrientId = identifier(
    firstDefined(row, "Nutrient_Code", "nutrient_code"),
    "CNF Nutrient_Code",
  );
  const definition = definitions.get(sourceNutrientId);
  invariant(definition, "INVALID_RECORD", "CNF nutrient amount has no nutrient definition", {
    index,
    sourceNutrientId,
  });
  const sourceSymbol = optionalIdentifier(
    firstDefined(definition, "Nutrient_Symbol", "nutrient_symbol"),
  );
  const sourceTagname = optionalIdentifier(firstDefined(definition, "Tagname", "tagname"));
  const originalUnit = identifier(
    firstDefined(definition, "Nutrient_Unit", "nutrient_unit"),
    "CNF nutrient unit",
  );
  const mapping =
    context.mappingResolver?.({
      source: "CNF",
      sourceNutrientId,
      sourceSymbol,
      sourceTagname,
      originalUnit,
    }) ?? null;
  return createStagedNutrient({
    sourceNutrientId,
    sourceName:
      firstDefined(definition, "Nutrient_Name_EN", "Nutrient_Name", "nutrient_name") ??
      sourceSymbol ??
      `CNF nutrient ${sourceNutrientId}`,
    originalUnit,
    mapping,
    derivationCode: firstDefined(
      row,
      "Nutrient_Source_ID",
      "Nutrient_Source_Code",
      "nutrient_source_id",
    ),
    dataPoints: firstDefined(
      row,
      "Number_Of_Observations",
      "Number_of_Observations",
      "Observations",
      "number_of_observations",
    ),
    value: parseSourceNutrientValue(
      firstDefined(row, "Nutrient_Amount", "nutrient_amount", "amount"),
      "measured",
      `CNF nutrient ${sourceNutrientId} amount`,
    ),
  });
}

function stageCnfMeasure(
  row: SourceRow,
  definitions: ReadonlyMap<string, SourceRow>,
  index: number,
): StagedServingRecord {
  const measureCode = identifier(
    firstDefined(row, "Measure_Code", "measure_code"),
    "CNF Measure_Code",
  );
  const definition = definitions.get(measureCode);
  invariant(definition, "INVALID_RECORD", "CNF measure conversion has no measure definition", {
    index,
    measureCode,
  });
  const description =
    firstDefined(
      definition,
      "Measure_Description_and_Unit_EN",
      "Measure_Description",
      "Measure_Name",
      "measure_description",
      "measure_name",
    ) ?? `CNF measure ${measureCode}`;
  return createStagedServing({
    sourceServingId: `6:${measureCode}`,
    description,
    amount: 1,
    unit: description,
    gramWeight: firstDefined(
      row,
      "Measure_Weight_Conversion",
      "measure_weight_conversion",
      "Conversion_Factor",
    ),
  });
}

function groupByFood(
  rows: readonly SourceRow[],
  label: string,
): ReadonlyMap<string, readonly SourceRow[]> {
  const groups = new Map<string, SourceRow[]>();
  for (const [index, row] of rows.entries()) {
    const foodCode = identifier(firstDefined(row, "Food_Code", "food_code"), `${label} Food_Code`);
    const existing = groups.get(foodCode) ?? [];
    existing.push(row);
    groups.set(foodCode, existing);
    invariant(existing.length <= 10_000, "INVALID_RECORD", `${label} group is implausibly large`, {
      foodCode,
      index,
    });
  }
  return groups;
}

function indexUnique(
  rows: readonly SourceRow[],
  keys: readonly string[],
  label: string,
): ReadonlyMap<string, SourceRow> {
  const result = new Map<string, SourceRow>();
  for (const row of rows) {
    const key = identifier(firstDefined(row, ...keys), `${label} code`);
    if (result.has(key)) {
      throw new IngestionError("DUPLICATE_KEY", `Duplicate ${label} code: ${key}`, { key });
    }
    result.set(key, row);
  }
  return result;
}

function asDefinitionMap(
  definitions: ReadonlyMap<string, SourceRow> | readonly SourceRow[],
  keys: readonly string[],
  label: string,
): ReadonlyMap<string, SourceRow> {
  return Array.isArray(definitions)
    ? indexUnique(definitions, keys, label)
    : (definitions as ReadonlyMap<string, SourceRow>);
}

function optionalIdentifier(value: unknown): string | null {
  try {
    return value === undefined || value === null || value === ""
      ? null
      : identifier(value, "source ID");
  } catch {
    return null;
  }
}

function excludedCnfChild(
  foodCode: string,
  sourceIndex: number,
  row: SourceRow,
  error: unknown,
): ExcludedCnfChildRecord {
  return Object.freeze({
    foodCode,
    sourceIndex,
    code: error instanceof IngestionError ? error.code : "INVALID_RECORD",
    message: error instanceof Error ? error.message : "Unknown CNF child adapter error",
    sourcePayloadHash: sha256CanonicalJson(row),
  });
}
