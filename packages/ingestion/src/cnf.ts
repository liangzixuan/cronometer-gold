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
  readonly sourceIndex: number;
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
  readonly conservation: CnfRowConservation;
  readonly rowDispositions: CnfRowDispositions;
}

export interface CnfSourceRowDisposition<
  Disposition extends "emitted" | "excluded" | "quarantined" | "skipped",
> {
  readonly disposition: Disposition;
  readonly sourceIndex: number;
}

export interface CnfRowDispositions {
  readonly foodNames: readonly CnfSourceRowDisposition<"emitted" | "quarantined">[];
  readonly nutrientAmounts: readonly CnfSourceRowDisposition<"emitted" | "excluded">[];
  readonly measureWeightConversions: readonly CnfSourceRowDisposition<
    "emitted" | "excluded" | "skipped"
  >[];
}

export interface CnfRowConservation {
  readonly foodNames: {
    readonly sourceCount: number;
    readonly emittedCount: number;
    readonly quarantinedCount: number;
  };
  readonly nutrientAmounts: {
    readonly sourceCount: number;
    readonly emittedCount: number;
    readonly excludedCount: number;
  };
  readonly measureWeightConversions: {
    readonly sourceCount: number;
    readonly emittedCount: number;
    readonly excludedCount: number;
    readonly skippedCount: number;
  };
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
  readonly nutrientDispositions: readonly CnfSourceRowDisposition<"emitted" | "excluded">[];
  readonly measureDispositions: readonly CnfSourceRowDisposition<
    "emitted" | "excluded" | "skipped"
  >[];
}

interface IndexedCnfSourceRow {
  readonly sourceIndex: number;
  readonly row: SourceRow;
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
  const knownFoodCodes = new Set(
    tables.foodNames
      .map((row) => optionalIdentifier(firstDefined(row, "Food_Code", "food_code")))
      .filter((foodCode): foodCode is string => foodCode !== null),
  );
  assertKnownFoodParents(nutrientAmounts, knownFoodCodes, "CNF nutrient amount");
  assertKnownFoodParents(measureWeights, knownFoodCodes, "CNF measure weight");
  const records: StagedFoodRecord[] = [];
  const quarantined: CnfQuarantinedRecord[] = [];
  const skippedMeasures: SkippedCnfMeasure[] = [];
  const excludedNutrients: ExcludedCnfChildRecord[] = [];
  const excludedMeasures: ExcludedCnfChildRecord[] = [];
  const foodNameDispositions: CnfSourceRowDisposition<"emitted" | "quarantined">[] = [];
  const nutrientDispositions: CnfSourceRowDisposition<"emitted" | "excluded">[] = [];
  const measureDispositions: CnfSourceRowDisposition<"emitted" | "excluded" | "skipped">[] = [];
  const seenFoods = new Set<string>();

  for (const [sourceIndex, food] of tables.foodNames.entries()) {
    const sourceId = optionalIdentifier(firstDefined(food, "Food_Code", "food_code"));
    let ownsChildren = false;
    try {
      invariant(sourceId !== null, "INVALID_RECORD", "CNF food is missing Food_Code");
      if (seenFoods.has(sourceId)) {
        throw new IngestionError("DUPLICATE_KEY", `Duplicate CNF Food_Code: ${sourceId}`);
      }
      seenFoods.add(sourceId);
      ownsChildren = true;
      const result = stageCnfRecordDetailedFromIndexedRows(
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
      foodNameDispositions.push(Object.freeze({ disposition: "emitted", sourceIndex }));
      nutrientDispositions.push(...result.nutrientDispositions);
      measureDispositions.push(...result.measureDispositions);
    } catch (error) {
      const code = error instanceof IngestionError ? error.code : "INVALID_RECORD";
      quarantined.push(
        Object.freeze({
          sourceIndex,
          sourceRecordId: sourceId,
          code,
          message: error instanceof Error ? error.message : "Unknown CNF adapter error",
          sourcePayloadHash: sha256CanonicalJson(food),
        }),
      );
      foodNameDispositions.push(Object.freeze({ disposition: "quarantined", sourceIndex }));
      if (sourceId !== null && ownsChildren) {
        const parentNutrients = excludeChildrenOfQuarantinedParent(
          sourceId,
          nutrientAmounts.get(sourceId) ?? [],
          "nutrient amount",
          code,
        );
        const parentMeasures = excludeChildrenOfQuarantinedParent(
          sourceId,
          measureWeights.get(sourceId) ?? [],
          "measure weight conversion",
          code,
        );
        excludedNutrients.push(...parentNutrients);
        excludedMeasures.push(...parentMeasures);
        nutrientDispositions.push(
          ...parentNutrients.map(({ sourceIndex: childSourceIndex }) =>
            Object.freeze({ disposition: "excluded" as const, sourceIndex: childSourceIndex }),
          ),
        );
        measureDispositions.push(
          ...parentMeasures.map(({ sourceIndex: childSourceIndex }) =>
            Object.freeze({ disposition: "excluded" as const, sourceIndex: childSourceIndex }),
          ),
        );
      }
    }
  }
  const conservation = createCnfRowConservation(
    tables,
    records,
    quarantined,
    excludedNutrients,
    excludedMeasures,
    skippedMeasures,
  );
  const rowDispositions = createCnfRowDispositions(tables, {
    foodNames: foodNameDispositions,
    measureWeightConversions: measureDispositions,
    nutrientAmounts: nutrientDispositions,
  });
  return Object.freeze({
    records: Object.freeze(records),
    quarantined: Object.freeze(quarantined),
    skippedMeasures: Object.freeze(skippedMeasures),
    excludedNutrients: Object.freeze(excludedNutrients),
    excludedMeasures: Object.freeze(excludedMeasures),
    conservation,
    rowDispositions,
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
  return stageCnfRecordDetailedFromIndexedRows(
    foodRow,
    nutrientAmountRows.map((row, sourceIndex) => ({ sourceIndex, row })),
    nutrientDefinitions,
    measureRows.map((row, sourceIndex) => ({ sourceIndex, row })),
    measureDefinitions,
    context,
  );
}

function stageCnfRecordDetailedFromIndexedRows(
  foodRow: SourceRow,
  nutrientAmountRows: readonly IndexedCnfSourceRow[],
  nutrientDefinitions: ReadonlyMap<string, SourceRow>,
  measureRows: readonly IndexedCnfSourceRow[],
  measureDefinitions: ReadonlyMap<string, SourceRow>,
  context: CnfAdapterContext,
): CnfStagedRecordResult {
  const foodCode = identifier(firstDefined(foodRow, "Food_Code", "food_code"), "CNF Food_Code");
  const nutrients: StagedNutrientRecord[] = [];
  const excludedNutrients: ExcludedCnfChildRecord[] = [];
  const nutrientDispositions: CnfSourceRowDisposition<"emitted" | "excluded">[] = [];
  const seenNutrients = new Set<string>();
  for (const { sourceIndex, row } of nutrientAmountRows) {
    try {
      invariant(
        String(firstDefined(row, "Food_Code", "food_code")) === foodCode,
        "INVALID_RECORD",
        "CNF nutrient amount belongs to a different food",
        { sourceIndex, foodCode },
      );
      const nutrient = stageCnfNutrient(row, nutrientDefinitions, context, sourceIndex);
      if (seenNutrients.has(nutrient.sourceNutrientId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate CNF nutrient key: ${nutrient.sourceNutrientId}`,
        );
      }
      seenNutrients.add(nutrient.sourceNutrientId);
      nutrients.push(nutrient);
      nutrientDispositions.push(Object.freeze({ disposition: "emitted", sourceIndex }));
    } catch (error) {
      excludedNutrients.push(excludedCnfChild(foodCode, sourceIndex, row, error));
      nutrientDispositions.push(Object.freeze({ disposition: "excluded", sourceIndex }));
    }
  }
  const servings: StagedServingRecord[] = [];
  const skippedMeasures: SkippedCnfMeasure[] = [];
  const excludedMeasures: ExcludedCnfChildRecord[] = [];
  const measureDispositions: CnfSourceRowDisposition<"emitted" | "excluded" | "skipped">[] = [];
  const seenMeasures = new Set<string>();
  for (const { sourceIndex, row } of measureRows) {
    try {
      invariant(
        String(firstDefined(row, "Food_Code", "food_code")) === foodCode,
        "INVALID_RECORD",
        "CNF measure weight belongs to a different food",
        { sourceIndex, foodCode },
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
            sourceIndex,
            measureTypeCode,
            measureCode,
            reason,
            sourcePayloadHash: sha256CanonicalJson(row),
          }),
        );
        measureDispositions.push(Object.freeze({ disposition: "skipped", sourceIndex }));
        continue;
      }
      const serving = stageCnfMeasure(row, measureDefinitions, sourceIndex);
      if (seenMeasures.has(serving.sourceServingId)) {
        throw new IngestionError(
          "DUPLICATE_KEY",
          `Duplicate CNF measure key: ${serving.sourceServingId}`,
        );
      }
      seenMeasures.add(serving.sourceServingId);
      servings.push(serving);
      measureDispositions.push(Object.freeze({ disposition: "emitted", sourceIndex }));
    } catch (error) {
      excludedMeasures.push(excludedCnfChild(foodCode, sourceIndex, row, error));
      measureDispositions.push(Object.freeze({ disposition: "excluded", sourceIndex }));
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
      rawSourceRecord: {
        foodRow,
        nutrientAmountRows: nutrientAmountRows.map(({ row }) => row),
        measureRows: measureRows.map(({ row }) => row),
      },
    }),
    skippedMeasures: Object.freeze(skippedMeasures),
    excludedNutrients: Object.freeze(excludedNutrients),
    excludedMeasures: Object.freeze(excludedMeasures),
    nutrientDispositions: Object.freeze(nutrientDispositions),
    measureDispositions: Object.freeze(measureDispositions),
  });
}

function stageCnfNutrient(
  row: SourceRow,
  definitions: ReadonlyMap<string, SourceRow>,
  context: CnfAdapterContext,
  sourceIndex: number,
): StagedNutrientRecord {
  const sourceNutrientId = identifier(
    firstDefined(row, "Nutrient_Code", "nutrient_code"),
    "CNF Nutrient_Code",
  );
  const definition = definitions.get(sourceNutrientId);
  invariant(definition, "INVALID_RECORD", "CNF nutrient amount has no nutrient definition", {
    sourceIndex,
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
  sourceIndex: number,
): StagedServingRecord {
  const measureCode = identifier(
    firstDefined(row, "Measure_Code", "measure_code"),
    "CNF Measure_Code",
  );
  const definition = definitions.get(measureCode);
  invariant(definition, "INVALID_RECORD", "CNF measure conversion has no measure definition", {
    sourceIndex,
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
): ReadonlyMap<string, readonly IndexedCnfSourceRow[]> {
  const groups = new Map<string, IndexedCnfSourceRow[]>();
  for (const [sourceIndex, row] of rows.entries()) {
    const foodCode = identifier(firstDefined(row, "Food_Code", "food_code"), `${label} Food_Code`);
    const existing = groups.get(foodCode) ?? [];
    existing.push({ sourceIndex, row });
    groups.set(foodCode, existing);
    invariant(existing.length <= 10_000, "INVALID_RECORD", `${label} group is implausibly large`, {
      foodCode,
      sourceIndex,
    });
  }
  return groups;
}

function assertKnownFoodParents(
  groups: ReadonlyMap<string, readonly IndexedCnfSourceRow[]>,
  knownFoodCodes: ReadonlySet<string>,
  label: string,
): void {
  for (const foodCode of groups.keys()) {
    invariant(
      knownFoodCodes.has(foodCode),
      "INVALID_RECORD",
      `${label} references unknown CNF Food_Code: ${foodCode}`,
      { foodCode },
    );
  }
}

function excludeChildrenOfQuarantinedParent(
  foodCode: string,
  rows: readonly IndexedCnfSourceRow[],
  label: string,
  parentCode: IngestionErrorCode,
): readonly ExcludedCnfChildRecord[] {
  const error = new IngestionError(
    parentCode,
    `CNF ${label} excluded because parent Food_Code ${foodCode} was quarantined (${parentCode})`,
    { foodCode, parentCode },
  );
  return rows.map(({ sourceIndex, row }) => excludedCnfChild(foodCode, sourceIndex, row, error));
}

function createCnfRowConservation(
  tables: CnfTables,
  records: readonly StagedFoodRecord[],
  quarantined: readonly CnfQuarantinedRecord[],
  excludedNutrients: readonly ExcludedCnfChildRecord[],
  excludedMeasures: readonly ExcludedCnfChildRecord[],
  skippedMeasures: readonly SkippedCnfMeasure[],
): CnfRowConservation {
  const emittedNutrientCount = records.reduce(
    (total, record) => total + record.nutrients.length,
    0,
  );
  const emittedMeasureCount = records.reduce((total, record) => total + record.servings.length, 0);
  const conservation: CnfRowConservation = Object.freeze({
    foodNames: Object.freeze({
      sourceCount: tables.foodNames.length,
      emittedCount: records.length,
      quarantinedCount: quarantined.length,
    }),
    nutrientAmounts: Object.freeze({
      sourceCount: tables.nutrientAmounts.length,
      emittedCount: emittedNutrientCount,
      excludedCount: excludedNutrients.length,
    }),
    measureWeightConversions: Object.freeze({
      sourceCount: tables.measureWeightConversions.length,
      emittedCount: emittedMeasureCount,
      excludedCount: excludedMeasures.length,
      skippedCount: skippedMeasures.length,
    }),
  });
  invariant(
    conservation.foodNames.sourceCount ===
      conservation.foodNames.emittedCount + conservation.foodNames.quarantinedCount,
    "INVALID_RECORD",
    "CNF Food_Name row conservation failed",
    conservation.foodNames,
  );
  invariant(
    conservation.nutrientAmounts.sourceCount ===
      conservation.nutrientAmounts.emittedCount + conservation.nutrientAmounts.excludedCount,
    "INVALID_RECORD",
    "CNF Nutrient_Amount row conservation failed",
    conservation.nutrientAmounts,
  );
  invariant(
    conservation.measureWeightConversions.sourceCount ===
      conservation.measureWeightConversions.emittedCount +
        conservation.measureWeightConversions.excludedCount +
        conservation.measureWeightConversions.skippedCount,
    "INVALID_RECORD",
    "CNF Measure_Weight_Conversion row conservation failed",
    conservation.measureWeightConversions,
  );
  return conservation;
}

function createCnfRowDispositions(
  tables: CnfTables,
  dispositions: {
    readonly foodNames: readonly CnfSourceRowDisposition<"emitted" | "quarantined">[];
    readonly measureWeightConversions: readonly CnfSourceRowDisposition<
      "emitted" | "excluded" | "skipped"
    >[];
    readonly nutrientAmounts: readonly CnfSourceRowDisposition<"emitted" | "excluded">[];
  },
): CnfRowDispositions {
  return Object.freeze({
    foodNames: exactSourceRowDispositionPartition(
      dispositions.foodNames,
      tables.foodNames.length,
      "Food_Name",
    ),
    measureWeightConversions: exactSourceRowDispositionPartition(
      dispositions.measureWeightConversions,
      tables.measureWeightConversions.length,
      "Measure_Weight_Conversion",
    ),
    nutrientAmounts: exactSourceRowDispositionPartition(
      dispositions.nutrientAmounts,
      tables.nutrientAmounts.length,
      "Nutrient_Amount",
    ),
  });
}

function exactSourceRowDispositionPartition<
  Disposition extends "emitted" | "excluded" | "quarantined" | "skipped",
>(
  entries: readonly CnfSourceRowDisposition<Disposition>[],
  sourceCount: number,
  label: string,
): readonly CnfSourceRowDisposition<Disposition>[] {
  const sorted = [...entries].sort((left, right) => left.sourceIndex - right.sourceIndex);
  invariant(
    sorted.length === sourceCount && sorted.every((entry, index) => entry.sourceIndex === index),
    "INVALID_RECORD",
    `CNF ${label} dispositions must exactly partition source indexes`,
    { sourceCount, dispositionCount: sorted.length },
  );
  return Object.freeze(sorted);
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
