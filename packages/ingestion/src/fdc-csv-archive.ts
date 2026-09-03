import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ArchiveSafetyLimits } from "./archive.js";
import { safeArchivePath } from "./archive.js";
import { parseDelimitedObjects } from "./delimited.js";
import { canonicalJson, compareCodePoints, sha256CanonicalJson } from "./deterministic.js";
import { abortError, IngestionError, type IngestionErrorCode, invariant } from "./errors.js";
import {
  type ExcludedFdcAttribute,
  type ExcludedFdcChildRecord,
  type FdcAdapterContext,
  stageFdcCsvRecordDetailed,
} from "./fdc.js";
import {
  type ExactArchiveExpectation,
  type ExtractedZipFile,
  type ExtractedZipFileIdentity,
  extractZipArchive,
} from "./zip.js";

export const FDC_CSV_ADAPTER_ROLES = Object.freeze([
  "food",
  "branded-food",
  "food-nutrient",
  "nutrient",
  "food-nutrient-derivation",
  "food-portion",
  "measure-unit",
] as const);

export type FdcCsvAdapterRole = (typeof FDC_CSV_ADAPTER_ROLES)[number];
export type FdcCsvFileRole = FdcCsvAdapterRole | "guide" | "reference-only";
export type FdcCsvReferenceOnlyReason =
  | "publisher-documentation-v1"
  | "unmaterialized-supporting-table-v1";

export interface FdcCsvFileContract {
  readonly archivePath: string;
  readonly role: FdcCsvFileRole;
  readonly referenceOnlyReason: FdcCsvReferenceOnlyReason | null;
}

export interface FdcCsvDelimitedSafetyLimits {
  readonly maxColumns?: number;
  readonly maxFieldCharacters?: number;
  /** Maximum logical rows in any CSV, including its header and blank rows. */
  readonly maxRows?: number;
  readonly maxRowCharacters?: number;
}

export interface FdcCsvProcessingLimits {
  readonly maxCombinedPartitionBytes?: number;
  readonly maxCombinedPartitionRows?: number;
  readonly maxDefinitionBytes?: number;
  readonly maxDefinitionRows?: number;
  readonly maxGtinAssignmentsPerKey?: number;
  readonly maxNutrientsPerFood?: number;
  readonly maxPartitionBytes?: number;
  readonly maxPartitionRows?: number;
  readonly maxPortionsPerFood?: number;
  readonly maxSpoolBytes?: number;
  readonly partitionCount?: number;
}

export interface FdcCsvArchiveContext extends FdcAdapterContext {
  readonly allowedDataTypes: readonly string[];
  readonly allowedMarketCodes: readonly string[];
  /** Exact reviewed upstream `food.data_type` text to manifest data type. */
  readonly dataTypeMappings: Readonly<Record<string, string>>;
  readonly defaultMarketCode: string;
  /** Exact reviewed upstream `market_country` text to ISO alpha-2 market code. */
  readonly marketMappings: Readonly<Record<string, string>>;
}

export interface FdcCsvArchiveParseInput {
  readonly archiveExpectation: ExactArchiveExpectation;
  readonly archiveLimits?: ArchiveSafetyLimits;
  readonly archivePath: string;
  readonly context: FdcCsvArchiveContext;
  readonly delimitedLimits?: FdcCsvDelimitedSafetyLimits;
  readonly destinationDirectory: string;
  readonly expectedFiles: readonly string[];
  readonly fileContracts: readonly FdcCsvFileContract[];
  readonly processingLimits?: FdcCsvProcessingLimits;
  readonly signal?: AbortSignal;
}

export interface FdcCsvArchiveEvidence {
  readonly contractSha256: string;
  readonly expectedFiles: readonly string[];
  readonly inventoryCount: number;
  readonly inventorySha256: string;
}

export interface FdcCsvTableEvidence {
  readonly adapterRole: FdcCsvAdapterRole | null;
  readonly archivePath: string;
  readonly byteSize: number;
  readonly disposition: "adapter-input" | "reference-only";
  readonly headerSha256: string;
  readonly headers: readonly string[];
  readonly rawSha256: string;
  readonly referenceOnlyReason: FdcCsvReferenceOnlyReason | null;
  readonly rowCount: number;
  /** Ordered canonical row JSON, each followed by one LF. */
  readonly rowsSha256: string;
}

export interface FdcCsvDigestEvidence {
  readonly count: number;
  readonly sha256: string;
}

export interface FdcCsvSemanticEvidence {
  readonly canonicalAcceptedRecords: FdcCsvDigestEvidence;
  readonly ordering: "sha256-partition-then-fdc-id-v1";
  readonly orderedDispositions: {
    readonly excludedAttributes: FdcCsvDigestEvidence;
    readonly excludedNutrients: FdcCsvDigestEvidence;
    readonly excludedPortions: FdcCsvDigestEvidence;
    readonly quarantinedFoods: FdcCsvDigestEvidence;
  };
  readonly schemaVersion: 1;
  readonly sha256: string;
}

export interface FdcCsvConservationEvidence {
  readonly brandedFoods: {
    readonly acceptedParentCount: number;
    readonly quarantinedParentCount: number;
    readonly sourceCount: number;
  };
  readonly foodNutrients: {
    readonly emittedCount: number;
    readonly excludedCount: number;
    readonly quarantinedParentCount: number;
    readonly sourceCount: number;
  };
  readonly foodPortions: {
    readonly emittedCount: number;
    readonly excludedCount: number;
    readonly quarantinedParentCount: number;
    readonly sourceCount: number;
  };
  readonly foods: {
    readonly acceptedCount: number;
    readonly quarantinedCount: number;
    readonly sourceCount: number;
  };
  readonly foodNutrientDerivations: {
    readonly referencedCount: number;
    readonly sourceCount: number;
    readonly unreferencedCount: number;
  };
  readonly measureUnits: {
    readonly referencedCount: number;
    readonly sourceCount: number;
    readonly unreferencedCount: number;
  };
  readonly nutrients: {
    readonly referencedCount: number;
    readonly sourceCount: number;
    readonly unreferencedCount: number;
  };
}

export interface FdcCsvArchiveMetrics {
  readonly acceptedFoodCount: number;
  readonly adapterInputDataRowCount: number;
  readonly derivedLabelServingCount: number;
  readonly excludedAttributeCount: number;
  readonly excludedNutrientCount: number;
  readonly excludedPortionCount: number;
  readonly guideCount: number;
  readonly parsedCsvRowCount: number;
  readonly quarantinedFoodCount: number;
  readonly referenceOnlyDataRowCount: number;
  readonly stagedNutrientCount: number;
  readonly stagedPortionCount: number;
}

export interface FdcCsvGtinEvidence {
  readonly assignmentCount: number;
  readonly assignmentsSha256: string;
  readonly collisionAssignmentCount: number;
  readonly collisionCount: number;
  readonly collisionsSha256: string;
  readonly ordering: "sha256-partition-then-market-gtin-fdc-id-v1";
  readonly uniqueCount: number;
}

export interface FdcCsvSourceMixEvidence {
  readonly acceptedDataTypeCounts: Readonly<Record<string, number>>;
  readonly acceptedMarketCounts: Readonly<Record<string, number>>;
  readonly mappedDataTypeCounts: Readonly<Record<string, number>>;
  readonly mappedMarketCounts: Readonly<Record<string, number>>;
  readonly rawDataTypeCounts: Readonly<Record<string, number>>;
  readonly rawMarketCounts: Readonly<Record<string, number>>;
  readonly sha256: string;
}

export interface FdcCsvProcessingEvidence {
  readonly algorithm: "sha256-prefix-mod-v1";
  readonly limits: Required<FdcCsvProcessingLimits>;
  readonly limitsSha256: string;
  readonly maximumObservedCombinedPartitionBytes: number;
  readonly maximumObservedCombinedPartitionRows: number;
  readonly maximumObservedPartitionBytes: number;
  readonly maximumObservedPartitionRows: number;
  readonly partitionCount: number;
  readonly spoolByteSize: number;
}

export interface FdcCsvArchiveParseResult {
  readonly archive: FdcCsvArchiveEvidence;
  readonly conservation: FdcCsvConservationEvidence;
  readonly contextSha256: string;
  readonly exclusionReasonCounts: Readonly<Record<string, number>>;
  readonly gtinEvidence: FdcCsvGtinEvidence;
  readonly metrics: FdcCsvArchiveMetrics;
  readonly processing: FdcCsvProcessingEvidence;
  readonly semanticEvidence: FdcCsvSemanticEvidence;
  readonly sourceMixEvidence: FdcCsvSourceMixEvidence;
  readonly tableEvidenceSha256: string;
  readonly tables: readonly FdcCsvTableEvidence[];
}

export function assertFdcCsvArchiveContract(
  expectedFiles: readonly string[],
  fileContracts: readonly FdcCsvFileContract[],
): void {
  validateContracts(expectedFiles, fileContracts);
}

export function assertFdcCsvArchiveContext(context: FdcCsvArchiveContext): void {
  validateContext(context);
}

export function assertFdcCsvSpoolIdentityContinuity(
  initial: Pick<
    ExtractedZipFileIdentity,
    "birthtimeMs" | "device" | "inode" | "mode" | "nlink" | "uid"
  >,
  sealed: Pick<
    ExtractedZipFileIdentity,
    "birthtimeMs" | "device" | "inode" | "mode" | "nlink" | "uid"
  >,
): void {
  invariant(
    sealed.birthtimeMs === initial.birthtimeMs &&
      sealed.device === initial.device &&
      sealed.inode === initial.inode &&
      sealed.uid === initial.uid &&
      sealed.mode === initial.mode &&
      sealed.nlink === initial.nlink,
    "INVALID_ARCHIVE_ENTRY",
    "FDC spool file identity changed between creation and sealing",
  );
}

type SourceRow = Readonly<Record<string, string>>;
interface SpoolEnvelope {
  readonly record: SourceRow;
  readonly sourceLine: number;
}
type PartitionedRole = "branded-food" | "food" | "food-nutrient" | "food-portion";
type SpoolRole = PartitionedRole | "accepted-gtin";
type LookupRole = "food-nutrient-derivation" | "measure-unit" | "nutrient";

interface ValidatedContracts {
  readonly contracts: readonly FdcCsvFileContract[];
  readonly expectedFiles: readonly string[];
  readonly guideCount: number;
}

interface PartitionMetadata {
  readonly byteSize: number;
  readonly identity: ExtractedZipFileIdentity | null;
  readonly path: string | null;
  readonly rowCount: number;
}

interface PartitionedTable {
  readonly partitions: readonly PartitionMetadata[];
  readonly role: SpoolRole;
}

interface SpoolPathIdentity {
  readonly birthtimeMs: number;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
}

interface SpoolDirectoryIdentity {
  readonly birthtimeMs: number;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly uid: number;
}

interface TableScanResult {
  readonly evidence: FdcCsvTableEvidence;
}

interface MutableCounters {
  acceptedFoodCount: number;
  acceptedParentBrandedCount: number;
  derivedLabelServingCount: number;
  excludedAttributeCount: number;
  excludedNutrientCount: number;
  excludedPortionCount: number;
  quarantinedFoodCount: number;
  quarantinedParentBrandedCount: number;
  quarantinedParentNutrientCount: number;
  quarantinedParentPortionCount: number;
  stagedNutrientCount: number;
  stagedPortionCount: number;
}

const REQUIRED_HEADERS: Readonly<Record<FdcCsvAdapterRole, readonly string[]>> = Object.freeze({
  food: Object.freeze(["fdc_id", "data_type", "description", "publication_date"]),
  "branded-food": Object.freeze([
    "fdc_id",
    "brand_owner",
    "gtin_upc",
    "serving_size",
    "serving_size_unit",
    "household_serving_fulltext",
    "market_country",
  ]),
  "food-nutrient": Object.freeze([
    "id",
    "fdc_id",
    "nutrient_id",
    "amount",
    "data_points",
    "derivation_id",
  ]),
  nutrient: Object.freeze(["id", "name", "unit_name"]),
  "food-nutrient-derivation": Object.freeze(["id", "code", "description", "source_id"]),
  "food-portion": Object.freeze([
    "id",
    "fdc_id",
    "amount",
    "measure_unit_id",
    "portion_description",
    "modifier",
    "gram_weight",
  ]),
  "measure-unit": Object.freeze(["id", "name"]),
});

const MAX_DELIMITED_LIMITS = Object.freeze({
  maxColumns: 1_024,
  maxFieldCharacters: 1_000_000,
  maxRows: 50_000_000,
  maxRowCharacters: 4_000_000,
});

const MAX_ARCHIVE_LIMITS = Object.freeze({
  maxCompressionRatio: 250,
  maxEntries: 256,
  maxFileBytes: 4_000_000_000,
  maxTotalBytes: 5_000_000_000,
});

const MAX_PROCESSING_LIMITS = Object.freeze({
  maxCombinedPartitionBytes: 1_500_000_000,
  maxCombinedPartitionRows: 10_000_000,
  maxDefinitionBytes: 256_000_000,
  maxDefinitionRows: 1_000_000,
  maxGtinAssignmentsPerKey: 10_000,
  maxNutrientsPerFood: 5_000,
  maxPartitionBytes: 1_000_000_000,
  maxPartitionRows: 5_000_000,
  maxPortionsPerFood: 5_000,
  maxSpoolBytes: 8_000_000_000,
  partitionCount: 128,
});

const DEFAULT_PROCESSING_LIMITS: Required<FdcCsvProcessingLimits> = Object.freeze({
  maxCombinedPartitionBytes: 512_000_000,
  maxCombinedPartitionRows: 2_000_000,
  maxDefinitionBytes: 64_000_000,
  maxDefinitionRows: 100_000,
  maxGtinAssignmentsPerKey: 100,
  maxNutrientsPerFood: 2_000,
  maxPartitionBytes: 256_000_000,
  maxPartitionRows: 1_000_000,
  maxPortionsPerFood: 1_000,
  maxSpoolBytes: 6_000_000_000,
  partitionCount: 128,
});

/**
 * Inspects a full FDC CSV archive without network or database access. Large
 * parent/child tables spill to private deterministic partitions and records are
 * consumed with explicit backpressure rather than retained as one release array.
 */
export async function parseFdcCsvArchive(
  input: FdcCsvArchiveParseInput,
): Promise<FdcCsvArchiveParseResult> {
  const validated = validateContracts(input.expectedFiles, input.fileContracts);
  const context = validateContext(input.context);
  const archiveLimits = resolveArchiveLimits(input.archiveLimits);
  const delimitedLimits = resolveDelimitedLimits(input.delimitedLimits);
  const processingLimits = resolveProcessingLimits(input.processingLimits);
  const selectedFiles = validated.contracts
    .filter((contract) => contract.role !== "guide")
    .map((contract) => contract.archivePath);
  const extracted = await extractZipArchive({
    archiveExpectation: input.archiveExpectation,
    archivePath: input.archivePath,
    destinationDirectory: input.destinationDirectory,
    expectedFiles: validated.expectedFiles,
    limits: archiveLimits,
    selectedFiles,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const identities = new Map(extracted.map((file) => [file.path, file.identity]));
  let spool: SpoolWorkspace | undefined;
  try {
    throwIfAborted(input.signal);
    await assertExtractedFileIdentities(extracted, identities, "before parsing");
    spool = await SpoolWorkspace.create(input.destinationDirectory, processingLimits);
    const result = await parseExtractedArchive({
      ...input,
      context,
      delimitedLimits,
      processingLimits,
      validated,
      extracted,
      identities,
      spool,
    });
    await assertExtractedFileIdentities(extracted, identities, "after parsing");
    await spool.cleanup();
    await assertExtractedFileIdentities(extracted, identities, "after spool cleanup");
    return result;
  } catch (operationError) {
    const cleanupErrors: unknown[] = [];
    if (spool) {
      try {
        await spool.cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    cleanupErrors.push(...(await cleanupExtractedFiles(extracted, identities)));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "FDC CSV archive parsing failed and cleanup was incomplete",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

async function parseExtractedArchive(input: {
  readonly context: FdcCsvArchiveContext;
  readonly delimitedLimits: Required<FdcCsvDelimitedSafetyLimits>;
  readonly expectedFiles: readonly string[];
  readonly extracted: readonly ExtractedZipFile[];
  readonly identities: ReadonlyMap<string, ExtractedZipFileIdentity>;
  readonly processingLimits: Required<FdcCsvProcessingLimits>;
  readonly signal?: AbortSignal;
  readonly spool: SpoolWorkspace;
  readonly validated: ValidatedContracts;
}): Promise<FdcCsvArchiveParseResult> {
  const extractedByPath = new Map(input.extracted.map((file) => [file.archivePath, file]));
  const lookupRows: Record<LookupRole, Map<string, SourceRow>> = {
    nutrient: new Map(),
    "food-nutrient-derivation": new Map(),
    "measure-unit": new Map(),
  };
  let definitionBytes = 0;
  let definitionRows = 0;
  const partitioned = new Map<PartitionedRole, PartitionedTable>();
  const tableEvidence: FdcCsvTableEvidence[] = [];

  for (const contract of input.validated.contracts) {
    throwIfAborted(input.signal);
    if (contract.role === "guide") continue;
    const file = extractedByPath.get(contract.archivePath);
    invariant(file, "INVALID_ARCHIVE_ENTRY", "FDC CSV extraction omitted a selected member", {
      path: contract.archivePath,
    });
    const identity = input.identities.get(file.path);
    invariant(identity, "INVALID_ARCHIVE_ENTRY", "FDC CSV member identity is unavailable", {
      path: contract.archivePath,
    });

    if (isPartitionedRole(contract.role)) {
      const writer = input.spool.writer(contract.role);
      try {
        const scanned = await scanCsvTable(
          file,
          identity,
          contract,
          input.delimitedLimits,
          input.signal,
          async (row, sourceLine) =>
            writer.write(fdcId(row.fdc_id, contract.role), row, sourceLine),
        );
        tableEvidence.push(scanned.evidence);
        partitioned.set(contract.role, await writer.finish());
      } catch (error) {
        await writer.abort();
        throw error;
      }
      continue;
    }

    if (isLookupRole(contract.role)) {
      const rows = lookupRows[contract.role];
      const scanned = await scanCsvTable(
        file,
        identity,
        contract,
        input.delimitedLimits,
        input.signal,
        async (row) => {
          const id = positiveIdentifier(row.id, `${contract.role} ID`);
          invariant(!rows.has(id), "DUPLICATE_KEY", `Duplicate FDC ${contract.role} ID`, {
            id,
          });
          const serializedBytes = Buffer.byteLength(canonicalJson(row));
          definitionRows += 1;
          definitionBytes += serializedBytes;
          invariant(
            definitionRows <= input.processingLimits.maxDefinitionRows &&
              definitionBytes <= input.processingLimits.maxDefinitionBytes,
            "ARCHIVE_LIMIT_EXCEEDED",
            "FDC definition tables exceed the bounded in-memory budget",
            { definitionRows, definitionBytes },
          );
          rows.set(id, row);
        },
      );
      tableEvidence.push(scanned.evidence);
      continue;
    }

    const scanned = await scanCsvTable(
      file,
      identity,
      contract,
      input.delimitedLimits,
      input.signal,
      async () => undefined,
    );
    tableEvidence.push(scanned.evidence);
  }

  for (const role of ["food", "food-nutrient", "food-portion", "branded-food"] as const) {
    invariant(partitioned.has(role), "INVALID_RECORD", "FDC partitioned table is unavailable", {
      role,
    });
  }

  const accepted = new DigestCounter();
  const quarantined = new DigestCounter();
  const excludedNutrients = new DigestCounter();
  const excludedPortions = new DigestCounter();
  const excludedAttributes = new DigestCounter();
  const reasonCounts = new Map<string, number>();
  const referencedNutrients = new Set<string>();
  const referencedDerivations = new Set<string>();
  const referencedMeasureUnits = new Set<string>();
  const rawDataTypeCounts = new Map<string, number>();
  const mappedDataTypeCounts = new Map<string, number>();
  const acceptedDataTypeCounts = new Map<string, number>();
  const acceptedMarketCounts = new Map<string, number>();
  const rawMarketCounts = new Map<string, number>();
  const mappedMarketCounts = new Map<string, number>();
  const gtinWriter = input.spool.writer("accepted-gtin");
  const counters: MutableCounters = {
    acceptedFoodCount: 0,
    acceptedParentBrandedCount: 0,
    derivedLabelServingCount: 0,
    excludedAttributeCount: 0,
    excludedNutrientCount: 0,
    excludedPortionCount: 0,
    quarantinedFoodCount: 0,
    quarantinedParentBrandedCount: 0,
    quarantinedParentNutrientCount: 0,
    quarantinedParentPortionCount: 0,
    stagedNutrientCount: 0,
    stagedPortionCount: 0,
  };

  for (let partition = 0; partition < input.processingLimits.partitionCount; partition += 1) {
    throwIfAborted(input.signal);
    const foodTable = requiredPartitionedTable(partitioned, "food");
    const brandedTable = requiredPartitionedTable(partitioned, "branded-food");
    const nutrientTable = requiredPartitionedTable(partitioned, "food-nutrient");
    const portionTable = requiredPartitionedTable(partitioned, "food-portion");
    const activeMetadata = [foodTable, brandedTable, nutrientTable, portionTable].map((table) =>
      requiredPartitionMetadata(table, partition),
    );
    const combinedPartitionBytes = activeMetadata.reduce(
      (total, metadata) => total + metadata.byteSize,
      0,
    );
    const combinedPartitionRows = activeMetadata.reduce(
      (total, metadata) => total + metadata.rowCount,
      0,
    );
    invariant(
      Number.isSafeInteger(combinedPartitionBytes) &&
        combinedPartitionBytes <= input.processingLimits.maxCombinedPartitionBytes &&
        Number.isSafeInteger(combinedPartitionRows) &&
        combinedPartitionRows <= input.processingLimits.maxCombinedPartitionRows,
      "ARCHIVE_LIMIT_EXCEEDED",
      "FDC combined active partition exceeds its bounded in-memory budget",
      { combinedPartitionBytes, combinedPartitionRows, partition },
    );
    input.spool.observeCombinedPartition(combinedPartitionBytes, combinedPartitionRows);
    const foods = await loadUniquePartition(foodTable, partition, "food", input.signal);
    const branded = await loadUniquePartition(
      brandedTable,
      partition,
      "branded-food",
      input.signal,
    );
    const nutrientRows = await loadChildPartition(
      nutrientTable,
      partition,
      "food-nutrient",
      input.processingLimits.maxNutrientsPerFood,
      input.signal,
    );
    const portionRows = await loadChildPartition(
      portionTable,
      partition,
      "food-portion",
      input.processingLimits.maxPortionsPerFood,
      input.signal,
    );
    assertNoOrphans(foods, branded, "branded-food");
    assertNoOrphans(foods, nutrientRows, "food-nutrient");
    assertNoOrphans(foods, portionRows, "food-portion");

    for (const id of [...foods.keys()].sort(compareCodePoints)) {
      throwIfAborted(input.signal);
      const foodEnvelope = foods.get(id);
      invariant(foodEnvelope, "INVALID_RECORD", "FDC food partition lookup failed", { id });
      const food = foodEnvelope.record;
      const rawNutrients = nutrientRows.get(id) ?? [];
      const rawPortions = portionRows.get(id) ?? [];
      const brandedRow = branded.get(id)?.record ?? null;
      incrementReason(rawDataTypeCounts, rawDataTypeBucket(food.data_type, input.context));
      incrementReason(
        rawMarketCounts,
        brandedRow === null
          ? "<non-branded-default>"
          : rawMarketBucket(brandedRow.market_country, input.context),
      );
      try {
        const dataType = mappedDataType(food.data_type, input.context);
        incrementReason(mappedDataTypeCounts, dataType);
        const isBranded = dataType === "Branded";
        invariant(
          isBranded === (brandedRow !== null),
          "INVALID_RECORD",
          isBranded
            ? "FDC branded food is missing its branded detail row"
            : "FDC non-branded food has an unexpected branded detail row",
          { fdcId: id },
        );
        const marketCode = isBranded
          ? mappedMarket(brandedRow?.market_country, input.context)
          : input.context.defaultMarketCode;
        incrementReason(mappedMarketCounts, marketCode);
        const joinedFood = Object.freeze({
          ...food,
          ...(brandedRow === null
            ? {}
            : {
                brand_owner: brandedRow.brand_owner,
                gtin_upc: brandedRow.gtin_upc,
                household_serving_fulltext: brandedRow.household_serving_fulltext,
                serving_size: brandedRow.serving_size,
                serving_size_unit: brandedRow.serving_size_unit,
              }),
          data_type: dataType,
          fdc_id: id,
        });
        const joinedNutrients: SourceRow[] = [];
        const nutrientSourceIndexes: number[] = [];
        const joinExcludedNutrients: ExcludedFdcChildRecord[] = [];
        for (const [sourceIndex, row] of rawNutrients.entries()) {
          try {
            const nutrientId = positiveIdentifier(row.nutrient_id, "FDC nutrient definition ID");
            const definition = lookupRows.nutrient.get(nutrientId);
            invariant(definition, "INVALID_RECORD", "FDC nutrient row has no nutrient definition", {
              fdcId: id,
              nutrientId,
            });
            referencedNutrients.add(nutrientId);
            const derivationId = optionalPositiveIdentifier(
              row.derivation_id,
              "FDC nutrient derivation ID",
            );
            let derivationCode: string | undefined;
            if (derivationId !== null) {
              const derivation = lookupRows["food-nutrient-derivation"].get(derivationId);
              invariant(
                derivation,
                "INVALID_RECORD",
                "FDC nutrient row has no derivation definition",
                { fdcId: id, derivationId },
              );
              referencedDerivations.add(derivationId);
              derivationCode = derivation.code;
            }
            joinedNutrients.push(
              Object.freeze({
                ...row,
                nutrient_name: definition.name ?? "",
                unit_name: definition.unit_name ?? "",
                ...(derivationCode === undefined ? {} : { derivation_code: derivationCode }),
              }),
            );
            nutrientSourceIndexes.push(sourceIndex);
          } catch (error) {
            if (!isFdcRowDispositionError(error)) throw error;
            joinExcludedNutrients.push(excludedJoinChild(id, sourceIndex, row, error));
          }
        }
        const joinedPortions: SourceRow[] = [];
        const portionSourceIndexes: number[] = [];
        const joinExcludedPortions: ExcludedFdcChildRecord[] = [];
        for (const [sourceIndex, row] of rawPortions.entries()) {
          try {
            const measureUnitId = positiveIdentifier(row.measure_unit_id, "FDC measure unit ID");
            const definition = lookupRows["measure-unit"].get(measureUnitId);
            invariant(
              definition,
              "INVALID_RECORD",
              "FDC portion row has no measure-unit definition",
              { fdcId: id, measureUnitId },
            );
            referencedMeasureUnits.add(measureUnitId);
            joinedPortions.push(
              Object.freeze({ ...row, measure_unit_name: definition.name ?? "" }),
            );
            portionSourceIndexes.push(sourceIndex);
          } catch (error) {
            if (!isFdcRowDispositionError(error)) throw error;
            joinExcludedPortions.push(excludedJoinChild(id, sourceIndex, row, error));
          }
        }
        const staged = stageFdcCsvRecordDetailed(joinedFood, joinedNutrients, joinedPortions, {
          releaseKey: input.context.releaseKey,
          marketCode,
          ...(input.context.mappingResolver === undefined
            ? {}
            : { mappingResolver: input.context.mappingResolver }),
        });
        const adapterExcludedNutrients = remapChildExclusions(
          staged.excludedNutrients,
          nutrientSourceIndexes,
          rawNutrients.length,
        );
        const adapterExcludedPortions = remapChildExclusions(
          staged.excludedPortions,
          portionSourceIndexes,
          rawPortions.length,
        );
        const allExcludedNutrients = [...joinExcludedNutrients, ...adapterExcludedNutrients];
        const allExcludedPortions = [...joinExcludedPortions, ...adapterExcludedPortions];
        const sourcePortionExclusions = allExcludedPortions.filter(
          (exclusion) => exclusion.sourceIndex < rawPortions.length,
        ).length;
        const emittedSourcePortions = rawPortions.length - sourcePortionExclusions;
        if (staged.record.identity.gtin !== null) {
          await writeGtinEvidenceRow(
            gtinWriter,
            `${staged.record.source.marketCode}\0${staged.record.identity.gtin}`,
            Object.freeze({
              fdc_id: id,
              gtin: staged.record.identity.gtin,
              market_code: staged.record.source.marketCode,
            }),
            foodEnvelope.sourceLine,
          );
        }
        counters.acceptedFoodCount += 1;
        counters.acceptedParentBrandedCount += brandedRow ? 1 : 0;
        counters.excludedAttributeCount += staged.excludedAttributes.length;
        counters.excludedNutrientCount += allExcludedNutrients.length;
        counters.excludedPortionCount += sourcePortionExclusions;
        counters.stagedNutrientCount += rawNutrients.length - allExcludedNutrients.length;
        counters.stagedPortionCount += emittedSourcePortions;
        counters.derivedLabelServingCount += staged.record.servings.length - emittedSourcePortions;
        incrementReason(acceptedDataTypeCounts, staged.record.source.sourceDataType);
        incrementReason(acceptedMarketCounts, staged.record.source.marketCode);
        accepted.add(staged.record);
        addDispositions(excludedNutrients, allExcludedNutrients, reasonCounts);
        addDispositions(excludedPortions, allExcludedPortions, reasonCounts);
        addDispositions(excludedAttributes, staged.excludedAttributes, reasonCounts);
      } catch (error) {
        if (!isFdcRowDispositionError(error)) throw error;
        const disposition = quarantineDisposition(
          id,
          foodEnvelope.sourceLine,
          food,
          rawNutrients,
          rawPortions,
          brandedRow,
          error,
        );
        counters.quarantinedFoodCount += 1;
        counters.quarantinedParentBrandedCount += brandedRow ? 1 : 0;
        counters.quarantinedParentNutrientCount += rawNutrients.length;
        counters.quarantinedParentPortionCount += rawPortions.length;
        quarantined.add(disposition);
        incrementReason(reasonCounts, disposition.code);
      }
    }
  }

  const gtinEvidence = await analyzeGtinAssignments(
    await gtinWriter.finish(),
    input.processingLimits.maxGtinAssignmentsPerKey,
    input.signal,
  );
  const observedFoodCount = counters.acceptedFoodCount + counters.quarantinedFoodCount;
  assertHistogramCount(rawDataTypeCounts, observedFoodCount, "raw data-type");
  assertHistogramCount(rawMarketCounts, observedFoodCount, "raw market");
  assertHistogramCount(acceptedDataTypeCounts, counters.acceptedFoodCount, "accepted data-type");
  assertHistogramCount(acceptedMarketCounts, counters.acceptedFoodCount, "accepted market");
  const sourceMixCore = Object.freeze({
    acceptedDataTypeCounts: sortedCountRecord(acceptedDataTypeCounts),
    acceptedMarketCounts: sortedCountRecord(acceptedMarketCounts),
    mappedDataTypeCounts: sortedCountRecord(mappedDataTypeCounts),
    mappedMarketCounts: sortedCountRecord(mappedMarketCounts),
    rawDataTypeCounts: sortedCountRecord(rawDataTypeCounts),
    rawMarketCounts: sortedCountRecord(rawMarketCounts),
  });
  const sourceMixEvidence: FdcCsvSourceMixEvidence = Object.freeze({
    ...sourceMixCore,
    sha256: sha256CanonicalJson(sourceMixCore),
  });

  const tables = Object.freeze(
    [...tableEvidence].sort((left, right) =>
      compareCodePoints(left.archivePath, right.archivePath),
    ),
  );
  const sourceCounts = new Map(
    tables
      .filter((table) => table.adapterRole !== null)
      .map((table) => [table.adapterRole as FdcCsvAdapterRole, table.rowCount]),
  );
  const conservation = buildConservation(
    sourceCounts,
    counters,
    lookupRows,
    referencedNutrients,
    referencedDerivations,
    referencedMeasureUnits,
  );
  const referenceOnlyDataRowCount = tables
    .filter((table) => table.disposition === "reference-only")
    .reduce((sum, table) => sum + table.rowCount, 0);
  const adapterInputDataRowCount = tables
    .filter((table) => table.disposition === "adapter-input")
    .reduce((sum, table) => sum + table.rowCount, 0);
  const metrics: FdcCsvArchiveMetrics = Object.freeze({
    acceptedFoodCount: counters.acceptedFoodCount,
    adapterInputDataRowCount,
    derivedLabelServingCount: counters.derivedLabelServingCount,
    excludedAttributeCount: counters.excludedAttributeCount,
    excludedNutrientCount: counters.excludedNutrientCount,
    excludedPortionCount: counters.excludedPortionCount,
    guideCount: input.validated.guideCount,
    parsedCsvRowCount: adapterInputDataRowCount + referenceOnlyDataRowCount,
    quarantinedFoodCount: counters.quarantinedFoodCount,
    referenceOnlyDataRowCount,
    stagedNutrientCount: counters.stagedNutrientCount,
    stagedPortionCount: counters.stagedPortionCount,
  });
  const semanticCore = Object.freeze({
    canonicalAcceptedRecords: accepted.finish(),
    ordering: "sha256-partition-then-fdc-id-v1" as const,
    orderedDispositions: Object.freeze({
      excludedAttributes: excludedAttributes.finish(),
      excludedNutrients: excludedNutrients.finish(),
      excludedPortions: excludedPortions.finish(),
      quarantinedFoods: quarantined.finish(),
    }),
    schemaVersion: 1 as const,
  });
  const semanticEvidence: FdcCsvSemanticEvidence = Object.freeze({
    ...semanticCore,
    sha256: sha256CanonicalJson(semanticCore),
  });
  const processing = input.spool.evidence();
  return Object.freeze({
    archive: Object.freeze({
      contractSha256: sha256CanonicalJson(input.validated.contracts),
      expectedFiles: input.validated.expectedFiles,
      inventoryCount: input.validated.expectedFiles.length,
      inventorySha256: sha256CanonicalJson(input.validated.expectedFiles),
    }),
    conservation,
    contextSha256: sha256CanonicalJson(contextEvidence(input.context)),
    exclusionReasonCounts: sortedCountRecord(reasonCounts),
    gtinEvidence,
    metrics,
    processing,
    semanticEvidence,
    sourceMixEvidence,
    tableEvidenceSha256: sha256CanonicalJson(tables),
    tables,
  });
}

async function scanCsvTable(
  file: ExtractedZipFile,
  identity: ExtractedZipFileIdentity,
  contract: FdcCsvFileContract,
  limits: Required<FdcCsvDelimitedSafetyLimits>,
  signal: AbortSignal | undefined,
  consume: (row: SourceRow, sourceLine: number) => Promise<void>,
): Promise<TableScanResult> {
  const rawHash = createHash("sha256");
  const rowsHash = createHash("sha256");
  let byteSize = 0;
  let rowCount = 0;
  let headers: readonly string[] | null = null;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to open the exact extracted FDC CSV member",
      { path: contract.archivePath },
      { cause: error },
    );
  }
  let operationError: unknown;
  try {
    await assertExactOpenFile(handle, file.path, identity, contract.archivePath, "before parsing");
    const observed = (async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of readExactHandle(handle, signal)) {
        byteSize += chunk.byteLength;
        invariant(Number.isSafeInteger(byteSize), "INVALID_RECORD", "FDC CSV byte count overflow");
        rawHash.update(chunk);
        yield chunk;
      }
    })();
    for await (const item of parseDelimitedObjects(observed, {
      delimiter: ",",
      headerMode: "exact",
      ...limits,
      onHeaders: (value) => {
        headers = value;
        enforceRequiredHeaders(contract, value);
      },
    })) {
      throwIfAborted(signal);
      rowCount += 1;
      rowsHash.update(canonicalJson(item.record));
      rowsHash.update("\n");
      await consume(item.record, item.line);
    }
    await assertExactOpenFile(handle, file.path, identity, contract.archivePath, "after parsing");
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (operationError !== undefined) {
      throw new AggregateError(
        [operationError, error],
        "FDC CSV parsing and exact-file handle cleanup both failed",
        { cause: operationError },
      );
    }
    throw error;
  }
  if (operationError !== undefined) throw operationError;
  invariant(headers !== null, "INVALID_RECORD", "FDC CSV table has no header", {
    path: contract.archivePath,
  });
  invariant(byteSize === file.byteSize, "INVALID_ARCHIVE_ENTRY", "FDC CSV size changed", {
    path: contract.archivePath,
  });
  const rawSha256 = rawHash.digest("hex");
  invariant(
    rawSha256 === identity.sha256,
    "INVALID_ARCHIVE_ENTRY",
    "FDC CSV content differs from extractor evidence",
    { path: contract.archivePath },
  );
  return Object.freeze({
    evidence: Object.freeze({
      adapterRole: isAdapterRole(contract.role) ? contract.role : null,
      archivePath: contract.archivePath,
      byteSize,
      disposition: contract.role === "reference-only" ? "reference-only" : "adapter-input",
      headerSha256: sha256CanonicalJson(headers),
      headers,
      rawSha256,
      referenceOnlyReason: contract.referenceOnlyReason,
      rowCount,
      rowsSha256: rowsHash.digest("hex"),
    }),
  });
}

class DigestCounter {
  readonly #hash = createHash("sha256");
  #count = 0;

  add(value: unknown): void {
    this.#hash.update(canonicalJson(value));
    this.#hash.update("\n");
    this.#count += 1;
  }

  finish(): FdcCsvDigestEvidence {
    return Object.freeze({ count: this.#count, sha256: this.#hash.digest("hex") });
  }
}

async function writeGtinEvidenceRow(
  writer: PartitionWriter,
  key: string,
  row: SourceRow,
  sourceLine: number,
): Promise<void> {
  try {
    await writer.write(key, row, sourceLine);
  } catch (error) {
    if (!isFdcRowDispositionError(error)) throw error;
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "FDC GTIN evidence spool rejected an internally generated row",
      {},
      { cause: error },
    );
  }
}

class PartitionWriter {
  readonly #buffers: string[];
  readonly #byteSizes: number[];
  readonly #handles = new Map<number, Awaited<ReturnType<typeof open>>>();
  readonly #hashes: ReturnType<typeof createHash>[];
  readonly #paths: (string | null)[];
  readonly #rowCounts: number[];
  #closed = false;
  #finished: PartitionedTable | null = null;
  #released = false;

  constructor(
    readonly role: SpoolRole,
    readonly limits: Required<FdcCsvProcessingLimits>,
    readonly owner: SpoolWorkspace,
  ) {
    this.#buffers = Array.from({ length: limits.partitionCount }, () => "");
    this.#byteSizes = Array.from({ length: limits.partitionCount }, () => 0);
    this.#hashes = Array.from({ length: limits.partitionCount }, () => createHash("sha256"));
    this.#paths = Array.from({ length: limits.partitionCount }, () => null);
    this.#rowCounts = Array.from({ length: limits.partitionCount }, () => 0);
  }

  async write(id: string, row: SourceRow, sourceLine: number): Promise<void> {
    invariant(!this.#closed, "INVALID_RECORD", "FDC spool writer is already closed");
    invariant(
      Number.isSafeInteger(sourceLine) && sourceLine > 0,
      "INVALID_RECORD",
      "FDC spool source line must be a positive safe integer",
    );
    const partition = partitionFor(id, this.limits.partitionCount);
    const serialized = `${canonicalJson({ record: row, sourceLine })}\n`;
    const bytes = Buffer.byteLength(serialized);
    const nextRows = (this.#rowCounts[partition] ?? 0) + 1;
    const nextBytes = (this.#byteSizes[partition] ?? 0) + bytes;
    invariant(
      nextRows <= this.limits.maxPartitionRows && nextBytes <= this.limits.maxPartitionBytes,
      "ARCHIVE_LIMIT_EXCEEDED",
      "FDC spool partition exceeds its bounded budget",
      { role: this.role, partition, nextRows, nextBytes },
    );
    this.owner.addBytes(bytes);
    this.#rowCounts[partition] = nextRows;
    this.#byteSizes[partition] = nextBytes;
    this.#hashes[partition]?.update(serialized);
    this.#buffers[partition] = `${this.#buffers[partition] ?? ""}${serialized}`;
    if ((this.#buffers[partition]?.length ?? 0) >= 64 * 1024) {
      await this.flush(partition);
    }
  }

  async finish(): Promise<PartitionedTable> {
    if (this.#finished) return this.#finished;
    invariant(!this.#closed, "INVALID_RECORD", "FDC spool writer was aborted before finish");
    if (!this.#closed) {
      for (let partition = 0; partition < this.limits.partitionCount; partition += 1) {
        await this.flush(partition);
      }
      await this.syncHandles();
    }
    const partitions: PartitionMetadata[] = [];
    for (let index = 0; index < this.limits.partitionCount; index += 1) {
      const rowCount = this.#rowCounts[index] ?? 0;
      const byteSize = this.#byteSizes[index] ?? 0;
      const path = this.#paths[index] ?? null;
      const expectedSha256 = this.#hashes[index]?.digest("hex");
      invariant(expectedSha256, "INVALID_RECORD", "FDC spool partition hash is unavailable");
      const handle = this.#handles.get(index);
      invariant(
        path === null ? handle === undefined : handle !== undefined,
        "INVALID_RECORD",
        "FDC spool partition descriptor does not match its path evidence",
      );
      const identity =
        path === null || handle === undefined
          ? null
          : await captureSealedSpoolFile(handle, path, byteSize, expectedSha256);
      if (path !== null && identity !== null) this.owner.sealPath(path, identity);
      invariant(
        path !== null || (rowCount === 0 && byteSize === 0),
        "INVALID_RECORD",
        "FDC empty spool path has non-empty evidence",
      );
      const metadata = Object.freeze({ byteSize, identity, path, rowCount });
      this.owner.observePartition(metadata);
      partitions.push(metadata);
    }
    this.#closed = true;
    this.#finished = Object.freeze({
      role: this.role,
      partitions: Object.freeze(partitions),
    });
    return this.#finished;
  }

  async abort(): Promise<void> {
    this.#closed = true;
    this.#buffers.fill("");
  }

  async releaseHandles(): Promise<void> {
    if (this.#released) return;
    this.#closed = true;
    this.#released = true;
    const errors: unknown[] = [];
    for (const handle of this.#handles.values()) {
      try {
        await handle.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#handles.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Unable to close FDC spool files");
  }

  private async flush(partition: number): Promise<void> {
    const buffered = this.#buffers[partition] ?? "";
    if (buffered.length === 0) return;
    let handle = this.#handles.get(partition);
    if (!handle) {
      const path = this.owner.pathFor(`${this.role}-${String(partition).padStart(3, "0")}.jsonl`);
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      this.#handles.set(partition, handle);
      const pathIdentity = await captureOpenSpoolDescriptor(handle, path);
      this.#paths[partition] = path;
      this.owner.registerPath(path, pathIdentity);
      await assertOpenSpoolPath(path, pathIdentity);
    }
    await handle.writeFile(buffered, "utf8");
    this.#buffers[partition] = "";
  }

  private async syncHandles(): Promise<void> {
    for (const handle of this.#handles.values()) {
      await handle.sync();
    }
  }
}

class SpoolWorkspace {
  readonly #paths = new Map<string, SpoolPathIdentity>();
  readonly #sealedPaths = new Map<string, ExtractedZipFileIdentity>();
  readonly #parentHandle: Awaited<ReturnType<typeof open>>;
  readonly #parentIdentity: SpoolDirectoryIdentity;
  readonly #rootHandle: Awaited<ReturnType<typeof open>>;
  readonly #rootIdentity: SpoolDirectoryIdentity;
  readonly #writers = new Map<SpoolRole, PartitionWriter>();
  #cleaned = false;
  #cleanupFailure: unknown | null = null;
  #maximumCombinedPartitionBytes = 0;
  #maximumCombinedPartitionRows = 0;
  #maximumPartitionBytes = 0;
  #maximumPartitionRows = 0;
  #spoolBytes = 0;

  private constructor(
    readonly parent: string,
    readonly rootName: string,
    readonly limits: Required<FdcCsvProcessingLimits>,
    parentHandle: Awaited<ReturnType<typeof open>>,
    parentIdentity: SpoolDirectoryIdentity,
    rootHandle: Awaited<ReturnType<typeof open>>,
    rootIdentity: SpoolDirectoryIdentity,
  ) {
    this.#parentHandle = parentHandle;
    this.#parentIdentity = parentIdentity;
    this.#rootHandle = rootHandle;
    this.#rootIdentity = rootIdentity;
  }

  static async create(
    destinationDirectory: string,
    limits: Required<FdcCsvProcessingLimits>,
  ): Promise<SpoolWorkspace> {
    const parentHandle = await open(
      destinationDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
    let operationError: unknown;
    try {
      const parentDescriptor = await parentHandle.stat();
      const parentPath = await lstat(destinationDirectory);
      const parentIdentity = spoolDirectoryIdentityFromMetadata(parentDescriptor);
      invariant(
        matchesSpoolDirectoryIdentity(parentDescriptor, parentIdentity) &&
          matchesSpoolDirectoryIdentity(parentPath, parentIdentity) &&
          parentIdentity.uid === currentUserId() &&
          parentIdentity.mode === 0o700,
        "INVALID_ARCHIVE_ENTRY",
        "FDC spool parent must remain a private current-user-owned directory",
      );
      const rootName = `.fdc-csv-spool-${randomUUID()}`;
      const root = join(destinationDirectory, rootName);
      const boundRoot = join(`/proc/self/fd/${parentHandle.fd}`, rootName);
      await mkdir(boundRoot, { mode: 0o700 });
      const createdRoot = await lstat(boundRoot);
      const rootIdentity = spoolDirectoryIdentityFromMetadata(createdRoot);
      invariant(
        matchesSpoolDirectoryIdentity(createdRoot, rootIdentity) &&
          rootIdentity.uid === currentUserId() &&
          rootIdentity.mode === 0o700,
        "INVALID_ARCHIVE_ENTRY",
        "New FDC spool workspace does not have a private directory identity",
      );
      rootHandle = await open(
        boundRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const rootDescriptor = await rootHandle.stat();
      const rootPath = await lstat(root);
      invariant(
        matchesSpoolDirectoryIdentity(rootDescriptor, rootIdentity) &&
          matchesSpoolDirectoryIdentity(rootPath, rootIdentity) &&
          rootIdentity.uid === currentUserId() &&
          rootIdentity.mode === 0o700,
        "INVALID_ARCHIVE_ENTRY",
        "FDC spool workspace must be a private current-user-owned directory",
      );
      return new SpoolWorkspace(
        destinationDirectory,
        rootName,
        limits,
        parentHandle,
        parentIdentity,
        rootHandle,
        rootIdentity,
      );
    } catch (error) {
      operationError = error;
    }
    const closeErrors: unknown[] = [];
    if (rootHandle) {
      try {
        await rootHandle.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    try {
      await parentHandle.close();
    } catch (error) {
      closeErrors.push(error);
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...closeErrors],
        "FDC spool creation and descriptor cleanup both failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }

  writer(role: SpoolRole): PartitionWriter {
    invariant(!this.#writers.has(role), "DUPLICATE_KEY", "FDC spool role was opened twice", {
      role,
    });
    const writer = new PartitionWriter(role, this.limits, this);
    this.#writers.set(role, writer);
    return writer;
  }

  pathFor(name: string): string {
    invariant(
      basename(name) === name && name !== "." && name !== "..",
      "INVALID_RECORD",
      "FDC spool file name must be a single canonical path segment",
    );
    return join(`/proc/self/fd/${this.#rootHandle.fd}`, name);
  }

  registerPath(path: string, identity: SpoolPathIdentity): void {
    invariant(!this.#paths.has(path), "DUPLICATE_KEY", "FDC spool path was reused", { path });
    this.#paths.set(path, identity);
  }

  sealPath(path: string, identity: ExtractedZipFileIdentity): void {
    const initialIdentity = this.#paths.get(path);
    invariant(initialIdentity, "INVALID_RECORD", "FDC spool path was not registered", { path });
    assertFdcCsvSpoolIdentityContinuity(initialIdentity, identity);
    invariant(!this.#sealedPaths.has(path), "DUPLICATE_KEY", "FDC spool path was sealed twice", {
      path,
    });
    this.#sealedPaths.set(path, identity);
  }

  addBytes(bytes: number): void {
    this.#spoolBytes += bytes;
    invariant(
      Number.isSafeInteger(this.#spoolBytes) && this.#spoolBytes <= this.limits.maxSpoolBytes,
      "ARCHIVE_LIMIT_EXCEEDED",
      "FDC spool exceeds its total byte budget",
      { spoolBytes: this.#spoolBytes },
    );
  }

  evidence(): FdcCsvProcessingEvidence {
    return Object.freeze({
      algorithm: "sha256-prefix-mod-v1",
      limits: this.limits,
      limitsSha256: sha256CanonicalJson(this.limits),
      maximumObservedCombinedPartitionBytes: this.#maximumCombinedPartitionBytes,
      maximumObservedCombinedPartitionRows: this.#maximumCombinedPartitionRows,
      maximumObservedPartitionBytes: this.#maximumPartitionBytes,
      maximumObservedPartitionRows: this.#maximumPartitionRows,
      partitionCount: this.limits.partitionCount,
      spoolByteSize: this.#spoolBytes,
    });
  }

  observePartition(metadata: PartitionMetadata): void {
    this.#maximumPartitionBytes = Math.max(this.#maximumPartitionBytes, metadata.byteSize);
    this.#maximumPartitionRows = Math.max(this.#maximumPartitionRows, metadata.rowCount);
  }

  observeCombinedPartition(byteSize: number, rowCount: number): void {
    this.#maximumCombinedPartitionBytes = Math.max(this.#maximumCombinedPartitionBytes, byteSize);
    this.#maximumCombinedPartitionRows = Math.max(this.#maximumCombinedPartitionRows, rowCount);
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    if (this.#cleanupFailure !== null) throw this.#cleanupFailure;
    let operationError: unknown;
    try {
      for (const writer of this.#writers.values()) await writer.abort();
      await this.assertBoundDirectories();
      const expectedNames = new Set([...this.#paths.keys()].map((path) => basename(path)));
      const actualNames = await readdir(`/proc/self/fd/${this.#rootHandle.fd}`);
      invariant(
        actualNames.length === expectedNames.size &&
          actualNames.every((name) => expectedNames.has(name)),
        "INVALID_ARCHIVE_ENTRY",
        "Refusing to clean an FDC spool workspace containing unexpected entries",
      );
      for (const [path, identity] of [...this.#paths.entries()].sort(([left], [right]) =>
        compareCodePoints(left, right),
      )) {
        await removeExactSpoolFile(
          path,
          identity,
          this.#sealedPaths.get(path) ?? null,
          this.#rootHandle,
          this.#rootIdentity,
        );
      }
      await this.removeBoundRoot();
    } catch (error) {
      operationError = error;
    }

    const closeErrors: unknown[] = [];
    for (const writer of this.#writers.values()) {
      try {
        await writer.releaseHandles();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    for (const handle of [this.#rootHandle, this.#parentHandle]) {
      try {
        await handle.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (operationError !== undefined || closeErrors.length > 0) {
      const failure =
        operationError !== undefined && closeErrors.length === 0
          ? operationError
          : new AggregateError(
              [...(operationError === undefined ? [] : [operationError]), ...closeErrors],
              "FDC spool cleanup or descriptor release failed",
              operationError === undefined ? undefined : { cause: operationError },
            );
      this.#cleanupFailure = failure;
      throw failure;
    }
    this.#cleaned = true;
  }

  private async assertBoundDirectories(): Promise<void> {
    const parentDescriptor = await this.#parentHandle.stat();
    const parentPath = await lstat(this.parent);
    const rootDescriptor = await this.#rootHandle.stat();
    const rootPath = await lstat(join(`/proc/self/fd/${this.#parentHandle.fd}`, this.rootName));
    invariant(
      matchesSpoolDirectoryIdentity(parentDescriptor, this.#parentIdentity) &&
        matchesSpoolDirectoryIdentity(parentPath, this.#parentIdentity) &&
        matchesSpoolDirectoryIdentity(rootDescriptor, this.#rootIdentity) &&
        matchesSpoolDirectoryIdentity(rootPath, this.#rootIdentity),
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to clean a replaced FDC spool workspace",
    );
  }

  private async removeBoundRoot(): Promise<void> {
    await this.assertBoundDirectories();
    invariant(
      (await readdir(`/proc/self/fd/${this.#rootHandle.fd}`)).length === 0,
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to remove a non-empty FDC spool workspace",
    );
    const boundRoot = join(`/proc/self/fd/${this.#parentHandle.fd}`, this.rootName);
    const quarantine = join(
      `/proc/self/fd/${this.#parentHandle.fd}`,
      `.${this.rootName}.${randomUUID()}.quarantine`,
    );
    await rename(boundRoot, quarantine);
    try {
      const quarantined = await lstat(quarantine);
      const descriptor = await this.#rootHandle.stat();
      invariant(
        matchesSpoolDirectoryIdentity(quarantined, this.#rootIdentity) &&
          matchesSpoolDirectoryIdentity(descriptor, this.#rootIdentity) &&
          (await readdir(`/proc/self/fd/${this.#rootHandle.fd}`)).length === 0,
        "INVALID_ARCHIVE_ENTRY",
        "FDC spool workspace quarantine identity changed",
      );
      await rmdir(quarantine);
    } catch (error) {
      throw new IngestionError(
        "INVALID_ARCHIVE_ENTRY",
        "FDC spool workspace quarantine could not be removed safely and was retained",
        { quarantine: basename(quarantine) },
        { cause: error },
      );
    }
  }
}

async function captureOpenSpoolDescriptor(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<SpoolPathIdentity> {
  const descriptor = await handle.stat();
  invariant(
    descriptor.isFile() &&
      !descriptor.isSymbolicLink() &&
      descriptor.uid === currentUserId() &&
      (descriptor.mode & 0o777) === 0o600 &&
      descriptor.nlink === 1 &&
      descriptor.size === 0,
    "INVALID_ARCHIVE_ENTRY",
    "New FDC spool file does not have a private empty regular-file identity",
    { path: basename(path) },
  );
  return spoolPathIdentityFromMetadata(descriptor);
}

async function assertOpenSpoolPath(path: string, identity: SpoolPathIdentity): Promise<void> {
  const pathname = await lstat(path);
  invariant(
    matchesSpoolPathIdentity(pathname, identity),
    "INVALID_ARCHIVE_ENTRY",
    "New FDC spool path does not name its opened inode",
    { path: basename(path) },
  );
}

async function captureSealedSpoolFile(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  expectedByteSize: number,
  expectedSha256: string,
): Promise<ExtractedZipFileIdentity> {
  const hash = createHash("sha256");
  const before = await handle.stat();
  invariant(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === currentUserId() &&
      (before.mode & 0o777) === 0o600 &&
      before.nlink === 1 &&
      before.size === expectedByteSize,
    "INVALID_ARCHIVE_ENTRY",
    "FDC spool file cannot be sealed with its expected identity",
    { path: basename(path) },
  );
  const identity = identityFromMetadata(before, expectedSha256);
  const pathBefore = await lstat(path);
  invariant(
    matchesExtractedIdentity(pathBefore, identity),
    "INVALID_ARCHIVE_ENTRY",
    "FDC spool path changed before sealing",
    { path: basename(path) },
  );
  for await (const chunk of readExactHandle(handle)) hash.update(chunk);
  const after = await handle.stat();
  const pathAfter = await lstat(path);
  invariant(
    matchesExtractedIdentity(after, identity) && matchesExtractedIdentity(pathAfter, identity),
    "INVALID_ARCHIVE_ENTRY",
    "FDC spool file changed while sealing",
    { path: basename(path) },
  );
  const actualSha256 = hash.digest("hex");
  invariant(
    actualSha256 === expectedSha256,
    "INVALID_ARCHIVE_ENTRY",
    "FDC spool file content differs from the bytes written by the parser",
    { path: basename(path) },
  );
  return identityFromMetadata(before, actualSha256);
}

async function removeExactSpoolFile(
  path: string,
  initialIdentity: SpoolPathIdentity,
  sealedIdentity: ExtractedZipFileIdentity | null,
  rootHandle: Awaited<ReturnType<typeof open>>,
  rootIdentity: SpoolDirectoryIdentity,
): Promise<void> {
  const rootMetadata = await rootHandle.stat();
  invariant(
    matchesSpoolDirectoryIdentity(rootMetadata, rootIdentity),
    "INVALID_ARCHIVE_ENTRY",
    "Cannot clean an FDC spool file outside its bound private directory",
    { path: basename(path) },
  );
  const boundPath = join(`/proc/self/fd/${rootHandle.fd}`, basename(path));
  const before = await lstat(boundPath);
  invariant(
    sealedIdentity
      ? matchesExtractedIdentity(before, sealedIdentity)
      : matchesSpoolPathIdentity(before, initialIdentity),
    "INVALID_ARCHIVE_ENTRY",
    "Refusing to remove a replaced FDC spool file",
    { path: basename(path) },
  );
  if (sealedIdentity) {
    invariant(
      (await hashExactPath(boundPath, sealedIdentity)) === sealedIdentity.sha256,
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to remove a changed FDC spool file",
      { path: basename(path) },
    );
  }
  const quarantine = join(
    `/proc/self/fd/${rootHandle.fd}`,
    `.${basename(path)}.${randomUUID()}.quarantine`,
  );
  await rename(boundPath, quarantine);
  try {
    const quarantined = await lstat(quarantine);
    invariant(
      sealedIdentity
        ? matchesIdentityAfterRename(quarantined, sealedIdentity)
        : matchesSpoolPathIdentity(quarantined, initialIdentity),
      "INVALID_ARCHIVE_ENTRY",
      "FDC spool cleanup quarantine identity changed",
      { path: basename(path) },
    );
    if (sealedIdentity) {
      const renamedIdentity = identityFromMetadata(quarantined, sealedIdentity.sha256);
      invariant(
        (await hashExactPath(quarantine, renamedIdentity)) === sealedIdentity.sha256,
        "INVALID_ARCHIVE_ENTRY",
        "FDC spool cleanup quarantine content changed",
        { path: basename(path) },
      );
      const immediatelyBeforeUnlink = await lstat(quarantine);
      invariant(
        matchesExtractedIdentity(immediatelyBeforeUnlink, renamedIdentity),
        "INVALID_ARCHIVE_ENTRY",
        "Refusing to remove a replaced FDC spool cleanup quarantine",
        { path: basename(path) },
      );
    } else {
      const immediatelyBeforeUnlink = await lstat(quarantine);
      invariant(
        matchesSpoolPathIdentity(immediatelyBeforeUnlink, initialIdentity),
        "INVALID_ARCHIVE_ENTRY",
        "Refusing to remove a replaced FDC empty spool cleanup quarantine",
        { path: basename(path) },
      );
    }
    await unlink(quarantine);
  } catch (error) {
    try {
      await restoreQuarantine(quarantine, boundPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "FDC spool cleanup quarantine failed and could not be restored",
        { cause: error },
      );
    }
    throw error;
  }
}

function spoolDirectoryIdentityFromMetadata(metadata: Stats): SpoolDirectoryIdentity {
  return Object.freeze({
    birthtimeMs: metadata.birthtimeMs,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode & 0o777,
    uid: metadata.uid,
  });
}

function matchesSpoolDirectoryIdentity(metadata: Stats, identity: SpoolDirectoryIdentity): boolean {
  return (
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    metadata.birthtimeMs === identity.birthtimeMs &&
    metadata.dev === identity.device &&
    metadata.ino === identity.inode &&
    metadata.uid === identity.uid &&
    (metadata.mode & 0o777) === identity.mode
  );
}

function spoolPathIdentityFromMetadata(metadata: Stats): SpoolPathIdentity {
  return Object.freeze({
    birthtimeMs: metadata.birthtimeMs,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode & 0o777,
    nlink: metadata.nlink,
    uid: metadata.uid,
  });
}

function matchesSpoolPathIdentity(metadata: Stats, identity: SpoolPathIdentity): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.birthtimeMs === identity.birthtimeMs &&
    metadata.dev === identity.device &&
    metadata.ino === identity.inode &&
    metadata.uid === identity.uid &&
    (metadata.mode & 0o777) === identity.mode &&
    metadata.nlink === identity.nlink
  );
}

function requiredPartitionedTable(
  tables: ReadonlyMap<PartitionedRole, PartitionedTable>,
  role: PartitionedRole,
): PartitionedTable {
  const table = tables.get(role);
  invariant(table, "INVALID_RECORD", "FDC partitioned table is unavailable", { role });
  return table;
}

function requiredPartitionMetadata(table: PartitionedTable, partition: number): PartitionMetadata {
  const metadata = table.partitions[partition];
  invariant(metadata, "INVALID_RECORD", "FDC spool partition metadata is unavailable", {
    role: table.role,
    partition,
  });
  return metadata;
}

async function loadUniquePartition(
  table: PartitionedTable | undefined,
  partition: number,
  role: "branded-food" | "food",
  signal?: AbortSignal,
): Promise<Map<string, SpoolEnvelope>> {
  invariant(table, "INVALID_RECORD", "FDC partitioned table is unavailable", { role });
  const result = new Map<string, SpoolEnvelope>();
  for await (const envelope of readPartition(table, partition, signal)) {
    throwIfAborted(signal);
    const row = envelope.record;
    const id = fdcId(row.fdc_id, role);
    invariant(!result.has(id), "DUPLICATE_KEY", `Duplicate FDC ${role} parent`, { id });
    result.set(id, envelope);
  }
  return result;
}

async function loadChildPartition(
  table: PartitionedTable | undefined,
  partition: number,
  role: "food-nutrient" | "food-portion",
  maxFanout: number,
  signal?: AbortSignal,
): Promise<Map<string, SourceRow[]>> {
  invariant(table, "INVALID_RECORD", "FDC partitioned table is unavailable", { role });
  const result = new Map<string, SourceRow[]>();
  for await (const envelope of readPartition(table, partition, signal)) {
    throwIfAborted(signal);
    const row = envelope.record;
    const id = fdcId(row.fdc_id, role);
    const rows = result.get(id) ?? [];
    invariant(rows.length < maxFanout, "ARCHIVE_LIMIT_EXCEEDED", "FDC parent fanout exceeded", {
      role,
      fdcId: id,
      maxFanout,
    });
    rows.push(row);
    result.set(id, rows);
  }
  return result;
}

async function* readPartition(
  table: PartitionedTable,
  partition: number,
  signal?: AbortSignal,
): AsyncGenerator<SpoolEnvelope> {
  const metadata = table.partitions[partition];
  invariant(metadata, "INVALID_RECORD", "FDC spool partition metadata is unavailable", {
    role: table.role,
    partition,
  });
  if (metadata.path === null) {
    invariant(
      metadata.identity === null && metadata.rowCount === 0 && metadata.byteSize === 0,
      "INVALID_RECORD",
      "Empty FDC spool partition has data evidence",
    );
    return;
  }
  const identity = metadata.identity;
  invariant(identity, "INVALID_RECORD", "Non-empty FDC spool partition has no sealed identity");
  const handle = await open(metadata.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let operationError: unknown;
  let observedRows = 0;
  let observedBytes = 0;
  const observedHash = createHash("sha256");
  try {
    const before = await handle.stat();
    invariant(
      matchesExtractedIdentity(before, identity),
      "INVALID_ARCHIVE_ENTRY",
      "FDC spool partition identity is invalid",
      { role: table.role, partition },
    );
    const pathBefore = await lstat(metadata.path);
    invariant(
      matchesExtractedIdentity(pathBefore, identity),
      "INVALID_ARCHIVE_ENTRY",
      "FDC spool partition path no longer names its sealed inode",
      { role: table.role, partition },
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    for await (const chunk of readExactHandle(handle, signal)) {
      observedBytes += chunk.byteLength;
      observedHash.update(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        throwIfAborted(signal);
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        invariant(line.length > 0, "INVALID_RECORD", "FDC spool contains an empty row");
        const parsed = JSON.parse(line) as unknown;
        invariant(
          typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
          "INVALID_RECORD",
          "FDC spool envelope is not an object",
        );
        const envelope = parsed as { readonly record?: unknown; readonly sourceLine?: unknown };
        invariant(
          typeof envelope.record === "object" &&
            envelope.record !== null &&
            !Array.isArray(envelope.record) &&
            Number.isSafeInteger(envelope.sourceLine) &&
            Number(envelope.sourceLine) > 0,
          "INVALID_RECORD",
          "FDC spool envelope has an invalid record or source line",
        );
        observedRows += 1;
        yield Object.freeze({
          record: Object.freeze(envelope.record as Record<string, string>),
          sourceLine: Number(envelope.sourceLine),
        });
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    invariant(pending.length === 0, "INVALID_RECORD", "FDC spool has an unterminated row");
    const after = await handle.stat();
    invariant(
      matchesExtractedIdentity(after, identity),
      "INVALID_ARCHIVE_ENTRY",
      "FDC spool partition changed while reading",
      { role: table.role, partition },
    );
    const pathAfter = await lstat(metadata.path);
    invariant(
      matchesExtractedIdentity(pathAfter, identity),
      "INVALID_ARCHIVE_ENTRY",
      "FDC spool partition path changed while reading",
      { role: table.role, partition },
    );
  } catch (error) {
    operationError = error;
  } finally {
    await closeSpoolReadHandle(handle, operationError);
  }
  if (operationError !== undefined) throw operationError;
  invariant(
    observedRows === metadata.rowCount &&
      observedBytes === metadata.byteSize &&
      observedHash.digest("hex") === identity.sha256,
    "INVALID_RECORD",
    "FDC spool partition evidence does not conserve rows, bytes, and content",
    { role: table.role, partition },
  );
}

async function closeSpoolReadHandle(
  handle: Awaited<ReturnType<typeof open>>,
  operationError: unknown,
): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if (operationError !== undefined) {
      throw new AggregateError([operationError, error], "FDC spool read and close both failed", {
        cause: operationError,
      });
    }
    throw error;
  }
}

async function analyzeGtinAssignments(
  table: PartitionedTable,
  maxAssignmentsPerKey: number,
  signal?: AbortSignal,
): Promise<FdcCsvGtinEvidence> {
  const assignments = new DigestCounter();
  const collisions = new DigestCounter();
  let collisionAssignmentCount = 0;
  let uniqueCount = 0;
  for (let partition = 0; partition < table.partitions.length; partition += 1) {
    const grouped = new Map<string, SourceRow[]>();
    throwIfAborted(signal);
    for await (const envelope of readPartition(table, partition, signal)) {
      throwIfAborted(signal);
      const row = envelope.record;
      const fdcIdentifier = fdcId(row.fdc_id, "GTIN assignment");
      invariant(
        typeof row.gtin === "string" && /^\d{14}$/u.test(row.gtin),
        "INVALID_RECORD",
        "FDC GTIN spool row is not a canonical GTIN-14",
      );
      invariant(
        typeof row.market_code === "string" && /^[A-Z]{2}$/u.test(row.market_code),
        "INVALID_RECORD",
        "FDC GTIN spool market is invalid",
      );
      const key = `${row.market_code}\0${row.gtin}`;
      invariant(
        partitionFor(key, table.partitions.length) === partition,
        "INVALID_RECORD",
        "FDC GTIN spool row is in the wrong partition",
      );
      const rows = grouped.get(key) ?? [];
      invariant(
        rows.length < maxAssignmentsPerKey,
        "ARCHIVE_LIMIT_EXCEEDED",
        "FDC GTIN assignment fanout exceeded",
        { gtin: row.gtin, marketCode: row.market_code, maxAssignmentsPerKey },
      );
      rows.push(Object.freeze({ ...row, fdc_id: fdcIdentifier }));
      grouped.set(key, rows);
    }
    for (const key of [...grouped.keys()].sort(compareCodePoints)) {
      const rows = grouped.get(key);
      invariant(rows, "INVALID_RECORD", "FDC GTIN assignment group is unavailable");
      rows.sort((left, right) => compareCodePoints(left.fdc_id ?? "", right.fdc_id ?? ""));
      uniqueCount += 1;
      for (const row of rows) assignments.add(row);
      if (rows.length > 1) {
        collisionAssignmentCount += rows.length;
        const first = rows[0];
        invariant(first, "INVALID_RECORD", "FDC GTIN collision group is empty");
        collisions.add(
          Object.freeze({
            foodSourceRecordIds: Object.freeze(rows.map((row) => row.fdc_id)),
            gtin: first.gtin,
            marketCode: first.market_code,
          }),
        );
      }
    }
  }
  const assignmentEvidence = assignments.finish();
  const collisionEvidence = collisions.finish();
  return Object.freeze({
    assignmentCount: assignmentEvidence.count,
    assignmentsSha256: assignmentEvidence.sha256,
    collisionAssignmentCount,
    collisionCount: collisionEvidence.count,
    collisionsSha256: collisionEvidence.sha256,
    ordering: "sha256-partition-then-market-gtin-fdc-id-v1" as const,
    uniqueCount,
  });
}

function buildConservation(
  sourceCounts: ReadonlyMap<FdcCsvAdapterRole, number>,
  counters: MutableCounters,
  lookups: Readonly<Record<LookupRole, ReadonlyMap<string, SourceRow>>>,
  referencedNutrients: ReadonlySet<string>,
  referencedDerivations: ReadonlySet<string>,
  referencedMeasureUnits: ReadonlySet<string>,
): FdcCsvConservationEvidence {
  const foodSourceCount = requiredSourceCount(sourceCounts, "food");
  const nutrientSourceCount = requiredSourceCount(sourceCounts, "food-nutrient");
  const portionSourceCount = requiredSourceCount(sourceCounts, "food-portion");
  const brandedSourceCount = requiredSourceCount(sourceCounts, "branded-food");
  invariant(
    foodSourceCount === counters.acceptedFoodCount + counters.quarantinedFoodCount,
    "INVALID_RECORD",
    "FDC food conservation failed",
  );
  invariant(
    nutrientSourceCount ===
      counters.stagedNutrientCount +
        counters.excludedNutrientCount +
        counters.quarantinedParentNutrientCount,
    "INVALID_RECORD",
    "FDC nutrient conservation failed",
  );
  invariant(
    portionSourceCount ===
      counters.stagedPortionCount +
        counters.excludedPortionCount +
        counters.quarantinedParentPortionCount,
    "INVALID_RECORD",
    "FDC portion conservation failed",
  );
  invariant(
    brandedSourceCount ===
      counters.acceptedParentBrandedCount + counters.quarantinedParentBrandedCount,
    "INVALID_RECORD",
    "FDC branded-food conservation failed",
  );
  return Object.freeze({
    brandedFoods: Object.freeze({
      acceptedParentCount: counters.acceptedParentBrandedCount,
      quarantinedParentCount: counters.quarantinedParentBrandedCount,
      sourceCount: brandedSourceCount,
    }),
    foodNutrients: Object.freeze({
      emittedCount: counters.stagedNutrientCount,
      excludedCount: counters.excludedNutrientCount,
      quarantinedParentCount: counters.quarantinedParentNutrientCount,
      sourceCount: nutrientSourceCount,
    }),
    foodPortions: Object.freeze({
      emittedCount: counters.stagedPortionCount,
      excludedCount: counters.excludedPortionCount,
      quarantinedParentCount: counters.quarantinedParentPortionCount,
      sourceCount: portionSourceCount,
    }),
    foods: Object.freeze({
      acceptedCount: counters.acceptedFoodCount,
      quarantinedCount: counters.quarantinedFoodCount,
      sourceCount: foodSourceCount,
    }),
    foodNutrientDerivations: definitionConservation(
      lookups["food-nutrient-derivation"].size,
      referencedDerivations.size,
    ),
    measureUnits: definitionConservation(lookups["measure-unit"].size, referencedMeasureUnits.size),
    nutrients: definitionConservation(lookups.nutrient.size, referencedNutrients.size),
  });
}

function definitionConservation(sourceCount: number, referencedCount: number) {
  invariant(referencedCount <= sourceCount, "INVALID_RECORD", "FDC definition conservation failed");
  return Object.freeze({
    sourceCount,
    referencedCount,
    unreferencedCount: sourceCount - referencedCount,
  });
}

function isFdcRowDispositionError(error: unknown): error is IngestionError {
  return (
    error instanceof IngestionError &&
    (error.code === "DUPLICATE_KEY" || error.code === "INVALID_RECORD")
  );
}

function excludedJoinChild(
  foodSourceRecordId: string,
  sourceIndex: number,
  row: SourceRow,
  error: unknown,
): ExcludedFdcChildRecord {
  return Object.freeze({
    code: error instanceof IngestionError ? error.code : "INVALID_RECORD",
    foodSourceRecordId,
    message: error instanceof Error ? error.message : "Unknown FDC relational join error",
    sourceIndex,
    sourcePayloadHash: sha256CanonicalJson(row),
  });
}

function remapChildExclusions(
  exclusions: readonly ExcludedFdcChildRecord[],
  sourceIndexes: readonly number[],
  sourceRowCount: number,
): readonly ExcludedFdcChildRecord[] {
  return exclusions.map((exclusion) => {
    const mappedIndex =
      exclusion.sourceIndex < sourceIndexes.length
        ? sourceIndexes[exclusion.sourceIndex]
        : sourceRowCount + exclusion.sourceIndex - sourceIndexes.length;
    invariant(
      mappedIndex !== undefined && Number.isSafeInteger(mappedIndex) && mappedIndex >= 0,
      "INVALID_RECORD",
      "FDC child exclusion source index cannot be restored",
    );
    return Object.freeze({ ...exclusion, sourceIndex: mappedIndex });
  });
}

function quarantineDisposition(
  id: string,
  sourceLine: number,
  food: SourceRow,
  nutrientRows: readonly SourceRow[],
  portionRows: readonly SourceRow[],
  brandedRow: SourceRow | null,
  error: unknown,
): {
  readonly code: IngestionErrorCode;
  readonly message: string;
  readonly sourceLine: number;
  readonly sourcePayloadHash: string;
  readonly sourceRecordId: string;
} {
  return Object.freeze({
    sourceRecordId: id,
    code: error instanceof IngestionError ? error.code : "INVALID_RECORD",
    message: error instanceof Error ? error.message : "Unknown FDC parent adapter error",
    sourceLine,
    sourcePayloadHash: sha256CanonicalJson({ brandedRow, food, nutrientRows, portionRows }),
  });
}

function addDispositions(
  digest: DigestCounter,
  values: readonly (ExcludedFdcAttribute | ExcludedFdcChildRecord)[],
  reasons: Map<string, number>,
): void {
  for (const value of values) {
    digest.add(value);
    incrementReason(reasons, value.code);
  }
}

function incrementReason(reasons: Map<string, number>, key: string): void {
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}

function assertHistogramCount(
  counts: ReadonlyMap<string, number>,
  expected: number,
  label: string,
): void {
  const actual = [...counts.values()].reduce((total, count) => total + count, 0);
  invariant(
    Number.isSafeInteger(actual) && actual === expected,
    "INVALID_RECORD",
    `FDC ${label} histogram does not conserve food rows`,
    { actual, expected },
  );
}

function sortedCountRecord(values: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      [...values.entries()].sort(([left], [right]) => compareCodePoints(left, right)),
    ),
  );
}

function assertNoOrphans(
  foods: ReadonlyMap<string, unknown>,
  children: ReadonlyMap<string, unknown>,
  role: PartitionedRole,
): void {
  for (const id of children.keys()) {
    invariant(foods.has(id), "INVALID_RECORD", `FDC ${role} row has no food parent`, { id });
  }
}

function validateContracts(
  rawExpectedFiles: readonly string[],
  rawContracts: readonly FdcCsvFileContract[],
): ValidatedContracts {
  invariant(rawExpectedFiles.length > 0, "INVALID_ARCHIVE_ENTRY", "FDC CSV inventory is empty");
  const expectedFiles = rawExpectedFiles.map((path) => safeArchivePath(path, false));
  const expected = new Set(expectedFiles);
  invariant(
    expected.size === expectedFiles.length,
    "INVALID_ARCHIVE_ENTRY",
    "FDC CSV inventory contains duplicate members",
  );
  invariant(
    rawContracts.length === expectedFiles.length,
    "INVALID_ARCHIVE_ENTRY",
    "Every FDC CSV inventory member requires one explicit file contract",
  );
  const roles = new Map<FdcCsvAdapterRole, string>();
  const contracts: FdcCsvFileContract[] = [];
  const paths = new Set<string>();
  let guideCount = 0;
  for (const raw of rawContracts) {
    const archivePath = safeArchivePath(raw.archivePath, false);
    invariant(
      expected.has(archivePath),
      "INVALID_ARCHIVE_ENTRY",
      "FDC CSV file contract is outside the expected inventory",
      { path: archivePath },
    );
    invariant(
      !paths.has(archivePath),
      "DUPLICATE_KEY",
      "FDC CSV file contract path is duplicated",
      { path: archivePath },
    );
    paths.add(archivePath);
    invariant(isFileRole(raw.role), "INVALID_ARCHIVE_ENTRY", "Unknown FDC CSV file role", {
      path: archivePath,
    });
    if (isAdapterRole(raw.role)) {
      invariant(
        /\.csv$/u.test(archivePath),
        "INVALID_ARCHIVE_ENTRY",
        "FDC adapter input must be a lowercase .csv member",
        { path: archivePath },
      );
      invariant(
        raw.referenceOnlyReason === null,
        "INVALID_ARCHIVE_ENTRY",
        "FDC adapter input cannot have a reference-only reason",
        { path: archivePath },
      );
      invariant(
        !roles.has(raw.role),
        "DUPLICATE_KEY",
        "FDC adapter role is assigned more than once",
        { role: raw.role },
      );
      roles.set(raw.role, archivePath);
    } else if (raw.role === "reference-only") {
      invariant(
        /\.csv$/u.test(archivePath),
        "INVALID_ARCHIVE_ENTRY",
        "FDC reference-only table must be a lowercase .csv member",
        { path: archivePath },
      );
      invariant(
        raw.referenceOnlyReason === "unmaterialized-supporting-table-v1",
        "INVALID_ARCHIVE_ENTRY",
        "FDC reference-only CSV requires its versioned disposition reason",
        { path: archivePath },
      );
    } else {
      guideCount += 1;
      invariant(
        !/\.csv$/iu.test(archivePath),
        "INVALID_ARCHIVE_ENTRY",
        "FDC CSV cannot be classified as a guide",
        { path: archivePath },
      );
      invariant(
        raw.referenceOnlyReason === "publisher-documentation-v1",
        "INVALID_ARCHIVE_ENTRY",
        "FDC guide requires its versioned disposition reason",
        { path: archivePath },
      );
    }
    contracts.push(
      Object.freeze({
        archivePath,
        role: raw.role,
        referenceOnlyReason: raw.referenceOnlyReason,
      }),
    );
  }
  for (const role of FDC_CSV_ADAPTER_ROLES) {
    invariant(
      roles.has(role),
      "INVALID_ARCHIVE_ENTRY",
      "FDC CSV inventory is missing an adapter role",
      { role },
    );
  }
  invariant(
    paths.size === expected.size,
    "INVALID_ARCHIVE_ENTRY",
    "FDC CSV contracts do not cover the exact inventory",
  );
  return Object.freeze({
    contracts: Object.freeze(
      contracts.sort((left, right) => compareCodePoints(left.archivePath, right.archivePath)),
    ),
    expectedFiles: Object.freeze([...expected].sort(compareCodePoints)),
    guideCount,
  });
}

function validateContext(context: FdcCsvArchiveContext): FdcCsvArchiveContext {
  const allowedDataTypes = new Set(context.allowedDataTypes);
  invariant(
    allowedDataTypes.size === context.allowedDataTypes.length && allowedDataTypes.size > 0,
    "INVALID_RECORD",
    "FDC allowed data types must be a unique non-empty list",
  );
  for (const dataType of allowedDataTypes) {
    invariant(
      typeof dataType === "string" && dataType.trim() === dataType && dataType.length > 0,
      "INVALID_RECORD",
      "FDC allowed data type is invalid",
    );
  }
  const allowed = new Set(context.allowedMarketCodes);
  invariant(
    allowed.size === context.allowedMarketCodes.length && allowed.size > 0,
    "INVALID_RECORD",
    "FDC allowed markets must be a unique non-empty list",
  );
  for (const code of allowed) {
    invariant(/^[A-Z]{2}$/u.test(code), "INVALID_RECORD", "FDC allowed market code is invalid", {
      code,
    });
  }
  invariant(
    allowed.has(context.defaultMarketCode),
    "INVALID_RECORD",
    "FDC default market is not allowed",
  );
  const normalizedDataTypeMappings = Object.create(null) as Record<string, string>;
  for (const [raw, target] of Object.entries(context.dataTypeMappings)) {
    const source = raw.normalize("NFKC").trim();
    invariant(
      source.length > 0 && source === raw,
      "INVALID_RECORD",
      "FDC data-type mapping source must be normalized non-blank text",
    );
    invariant(
      allowedDataTypes.has(target),
      "INVALID_RECORD",
      "FDC data-type mapping target is not allowed",
      { target },
    );
    invariant(
      !Object.hasOwn(normalizedDataTypeMappings, source),
      "DUPLICATE_KEY",
      "FDC data-type mapping source is duplicated",
      { source },
    );
    normalizedDataTypeMappings[source] = target;
  }
  invariant(
    Object.keys(normalizedDataTypeMappings).length > 0,
    "INVALID_RECORD",
    "FDC data-type mappings are empty",
  );
  const mappedDataTypes = new Set(Object.values(normalizedDataTypeMappings));
  invariant(
    mappedDataTypes.size === allowedDataTypes.size &&
      [...allowedDataTypes].every((dataType) => mappedDataTypes.has(dataType)),
    "INVALID_RECORD",
    "FDC data-type mappings must cover every reviewed manifest data type",
  );
  const normalizedMappings = Object.create(null) as Record<string, string>;
  for (const [raw, target] of Object.entries(context.marketMappings)) {
    const source = raw.normalize("NFKC").trim();
    invariant(
      source.length > 0 && source === raw,
      "INVALID_RECORD",
      "FDC market mapping source must be normalized non-blank text",
    );
    invariant(allowed.has(target), "INVALID_RECORD", "FDC market mapping target is not allowed", {
      target,
    });
    invariant(
      !Object.hasOwn(normalizedMappings, source),
      "DUPLICATE_KEY",
      "FDC market mapping source is duplicated",
      { source },
    );
    normalizedMappings[source] = target;
  }
  invariant(
    Object.keys(normalizedMappings).length > 0,
    "INVALID_RECORD",
    "FDC branded market mappings are empty",
  );
  const mappedMarkets = new Set([context.defaultMarketCode, ...Object.values(normalizedMappings)]);
  invariant(
    mappedMarkets.size === allowed.size &&
      [...allowed].every((market) => mappedMarkets.has(market)),
    "INVALID_RECORD",
    "FDC market mappings and default must cover every reviewed manifest market",
  );
  return Object.freeze({
    releaseKey: context.releaseKey,
    ...(context.mappingResolver === undefined ? {} : { mappingResolver: context.mappingResolver }),
    allowedDataTypes: Object.freeze([...allowedDataTypes]),
    allowedMarketCodes: Object.freeze([...allowed]),
    dataTypeMappings: Object.freeze(normalizedDataTypeMappings),
    defaultMarketCode: context.defaultMarketCode,
    marketMappings: Object.freeze(normalizedMappings),
  });
}

function mappedDataType(raw: unknown, context: FdcCsvArchiveContext): string {
  invariant(typeof raw === "string", "INVALID_RECORD", "FDC food data type must be text");
  const source = raw.normalize("NFKC").trim();
  invariant(
    source.length > 0 && source === raw,
    "INVALID_RECORD",
    "FDC food data type must exactly match reviewed normalized text",
  );
  invariant(
    Object.hasOwn(context.dataTypeMappings, source),
    "INVALID_RECORD",
    "FDC food data type has no reviewed mapping",
    { source },
  );
  const dataType = context.dataTypeMappings[source];
  invariant(dataType, "INVALID_RECORD", "FDC food data-type mapping is invalid", { source });
  return dataType;
}

function rawDataTypeBucket(raw: unknown, context: FdcCsvArchiveContext): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.normalize("NFKC").trim() !== raw) {
    return "<invalid-or-unmapped>";
  }
  return Object.hasOwn(context.dataTypeMappings, raw) ? raw : "<invalid-or-unmapped>";
}

function rawMarketBucket(raw: unknown, context: FdcCsvArchiveContext): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.normalize("NFKC").trim() !== raw) {
    return "<invalid-or-unmapped>";
  }
  return Object.hasOwn(context.marketMappings, raw) ? raw : "<invalid-or-unmapped>";
}

function mappedMarket(raw: unknown, context: FdcCsvArchiveContext): string {
  invariant(typeof raw === "string", "INVALID_RECORD", "FDC branded market must be text");
  const source = raw.normalize("NFKC").trim();
  invariant(
    source.length > 0 && source === raw,
    "INVALID_RECORD",
    "FDC branded market must exactly match reviewed normalized text",
  );
  invariant(
    Object.hasOwn(context.marketMappings, source),
    "INVALID_RECORD",
    "FDC branded market has no reviewed mapping",
    { source },
  );
  const market = context.marketMappings[source];
  invariant(market, "INVALID_RECORD", "FDC branded market mapping is invalid", { source });
  return market;
}

function contextEvidence(context: FdcCsvArchiveContext) {
  return Object.freeze({
    allowedDataTypes: Object.freeze([...context.allowedDataTypes]),
    allowedMarketCodes: Object.freeze([...context.allowedMarketCodes]),
    dataTypeMappings: sortedStringRecord(context.dataTypeMappings),
    defaultMarketCode: context.defaultMarketCode,
    marketMappings: sortedStringRecord(context.marketMappings),
    releaseKey: context.releaseKey,
  });
}

function sortedStringRecord(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).sort(([left], [right]) => compareCodePoints(left, right)),
    ),
  );
}

function enforceRequiredHeaders(contract: FdcCsvFileContract, headers: readonly string[]): void {
  if (!isAdapterRole(contract.role)) return;
  const actual = new Set(headers);
  for (const required of REQUIRED_HEADERS[contract.role]) {
    invariant(
      actual.has(required),
      "INVALID_RECORD",
      "FDC CSV table is missing a required header",
      {
        path: contract.archivePath,
        required,
      },
    );
  }
}

function resolveArchiveLimits(
  input: ArchiveSafetyLimits | undefined,
): Required<Omit<ArchiveSafetyLimits, "expectedFiles">> {
  invariant(
    input?.expectedFiles === undefined,
    "INVALID_RECORD",
    "FDC archive limits cannot override the reviewed archive inventory",
  );
  return Object.freeze({
    maxCompressionRatio: boundedPositiveNumber(
      input?.maxCompressionRatio,
      MAX_ARCHIVE_LIMITS.maxCompressionRatio,
      "maxCompressionRatio",
    ),
    maxEntries: bounded(input?.maxEntries, MAX_ARCHIVE_LIMITS.maxEntries, "maxEntries"),
    maxFileBytes: bounded(input?.maxFileBytes, MAX_ARCHIVE_LIMITS.maxFileBytes, "maxFileBytes"),
    maxTotalBytes: bounded(input?.maxTotalBytes, MAX_ARCHIVE_LIMITS.maxTotalBytes, "maxTotalBytes"),
  });
}

function resolveDelimitedLimits(
  input: FdcCsvDelimitedSafetyLimits | undefined,
): Required<FdcCsvDelimitedSafetyLimits> {
  return Object.freeze({
    maxColumns: bounded(input?.maxColumns, MAX_DELIMITED_LIMITS.maxColumns, "maxColumns"),
    maxFieldCharacters: bounded(
      input?.maxFieldCharacters,
      MAX_DELIMITED_LIMITS.maxFieldCharacters,
      "maxFieldCharacters",
    ),
    maxRows: bounded(input?.maxRows, MAX_DELIMITED_LIMITS.maxRows, "maxRows"),
    maxRowCharacters: bounded(
      input?.maxRowCharacters,
      MAX_DELIMITED_LIMITS.maxRowCharacters,
      "maxRowCharacters",
    ),
  });
}

function resolveProcessingLimits(
  input: FdcCsvProcessingLimits | undefined,
): Required<FdcCsvProcessingLimits> {
  const result = Object.freeze({
    maxCombinedPartitionBytes: bounded(
      input?.maxCombinedPartitionBytes,
      MAX_PROCESSING_LIMITS.maxCombinedPartitionBytes,
      "maxCombinedPartitionBytes",
      DEFAULT_PROCESSING_LIMITS.maxCombinedPartitionBytes,
    ),
    maxCombinedPartitionRows: bounded(
      input?.maxCombinedPartitionRows,
      MAX_PROCESSING_LIMITS.maxCombinedPartitionRows,
      "maxCombinedPartitionRows",
      DEFAULT_PROCESSING_LIMITS.maxCombinedPartitionRows,
    ),
    maxDefinitionBytes: bounded(
      input?.maxDefinitionBytes,
      MAX_PROCESSING_LIMITS.maxDefinitionBytes,
      "maxDefinitionBytes",
      DEFAULT_PROCESSING_LIMITS.maxDefinitionBytes,
    ),
    maxDefinitionRows: bounded(
      input?.maxDefinitionRows,
      MAX_PROCESSING_LIMITS.maxDefinitionRows,
      "maxDefinitionRows",
      DEFAULT_PROCESSING_LIMITS.maxDefinitionRows,
    ),
    maxGtinAssignmentsPerKey: bounded(
      input?.maxGtinAssignmentsPerKey,
      MAX_PROCESSING_LIMITS.maxGtinAssignmentsPerKey,
      "maxGtinAssignmentsPerKey",
      DEFAULT_PROCESSING_LIMITS.maxGtinAssignmentsPerKey,
    ),
    maxNutrientsPerFood: bounded(
      input?.maxNutrientsPerFood,
      MAX_PROCESSING_LIMITS.maxNutrientsPerFood,
      "maxNutrientsPerFood",
      DEFAULT_PROCESSING_LIMITS.maxNutrientsPerFood,
    ),
    maxPartitionBytes: bounded(
      input?.maxPartitionBytes,
      MAX_PROCESSING_LIMITS.maxPartitionBytes,
      "maxPartitionBytes",
      DEFAULT_PROCESSING_LIMITS.maxPartitionBytes,
    ),
    maxPartitionRows: bounded(
      input?.maxPartitionRows,
      MAX_PROCESSING_LIMITS.maxPartitionRows,
      "maxPartitionRows",
      DEFAULT_PROCESSING_LIMITS.maxPartitionRows,
    ),
    maxPortionsPerFood: bounded(
      input?.maxPortionsPerFood,
      MAX_PROCESSING_LIMITS.maxPortionsPerFood,
      "maxPortionsPerFood",
      DEFAULT_PROCESSING_LIMITS.maxPortionsPerFood,
    ),
    maxSpoolBytes: bounded(
      input?.maxSpoolBytes,
      MAX_PROCESSING_LIMITS.maxSpoolBytes,
      "maxSpoolBytes",
      DEFAULT_PROCESSING_LIMITS.maxSpoolBytes,
    ),
    partitionCount: bounded(
      input?.partitionCount,
      MAX_PROCESSING_LIMITS.partitionCount,
      "partitionCount",
      DEFAULT_PROCESSING_LIMITS.partitionCount,
    ),
  });
  invariant(
    result.partitionCount >= 2 && (result.partitionCount & (result.partitionCount - 1)) === 0,
    "INVALID_RECORD",
    "FDC partitionCount must be a power of two between 2 and 128",
  );
  return result;
}

function bounded(
  value: number | undefined,
  maximum: number,
  field: string,
  fallback = maximum,
): number {
  const resolved = value ?? fallback;
  invariant(
    Number.isSafeInteger(resolved) && resolved > 0 && resolved <= maximum,
    "INVALID_RECORD",
    `FDC ${field} must be a positive integer no greater than ${maximum}`,
    { field },
  );
  return resolved;
}

function boundedPositiveNumber(
  value: number | undefined,
  maximum: number,
  field: string,
  fallback = maximum,
): number {
  const resolved = value ?? fallback;
  invariant(
    Number.isFinite(resolved) && resolved > 0 && resolved <= maximum,
    "INVALID_RECORD",
    `FDC ${field} must be a positive finite number no greater than ${maximum}`,
    { field },
  );
  return resolved;
}

function partitionFor(id: string, count: number): number {
  return createHash("sha256").update(id).digest().readUInt32BE(0) % count;
}

function fdcId(value: unknown, role: string): string {
  return positiveIdentifier(value, `FDC ${role} fdc_id`);
}

function positiveIdentifier(value: unknown, field: string): string {
  invariant(
    typeof value === "string" && /^[1-9]\d*$/u.test(value),
    "INVALID_RECORD",
    `${field} must be a canonical positive integer string`,
    { field },
  );
  return value;
}

function optionalPositiveIdentifier(value: unknown, field: string): string | null {
  if (value === "" || value === null || value === undefined) return null;
  return positiveIdentifier(value, field);
}

function requiredSourceCount(
  sourceCounts: ReadonlyMap<FdcCsvAdapterRole, number>,
  role: FdcCsvAdapterRole,
): number {
  const value = sourceCounts.get(role);
  invariant(value !== undefined, "INVALID_RECORD", "FDC source table count is unavailable", {
    role,
  });
  return value;
}

function isFileRole(value: unknown): value is FdcCsvFileRole {
  return value === "guide" || value === "reference-only" || isAdapterRole(value);
}

function isAdapterRole(value: unknown): value is FdcCsvAdapterRole {
  return (FDC_CSV_ADAPTER_ROLES as readonly unknown[]).includes(value);
}

function isPartitionedRole(value: FdcCsvFileRole): value is PartitionedRole {
  return (
    value === "food" ||
    value === "branded-food" ||
    value === "food-nutrient" ||
    value === "food-portion"
  );
}

function isLookupRole(value: FdcCsvFileRole): value is LookupRole {
  return value === "nutrient" || value === "food-nutrient-derivation" || value === "measure-unit";
}

async function assertExtractedFileIdentities(
  files: readonly ExtractedZipFile[],
  identities: Map<string, ExtractedZipFileIdentity>,
  phase: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const file of files) {
    try {
      const identity = identities.get(file.path);
      invariant(identity, "INVALID_ARCHIVE_ENTRY", "Extracted FDC CSV identity is missing", {
        path: file.archivePath,
      });
      const metadata = await lstat(file.path);
      invariant(
        metadata.uid === currentUserId() && matchesExtractedIdentity(metadata, identity),
        "INVALID_ARCHIVE_ENTRY",
        `Extracted FDC CSV member changed ${phase}`,
        { path: file.archivePath, phase },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `Multiple FDC CSV members changed ${phase}`, {
      cause: errors[0],
    });
  }
}

async function assertExactOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  identity: ExtractedZipFileIdentity,
  archivePath: string,
  phase: string,
): Promise<void> {
  const descriptor = await handle.stat();
  const pathname = await lstat(path);
  invariant(
    matchesExtractedIdentity(descriptor, identity) && matchesExtractedIdentity(pathname, identity),
    "INVALID_ARCHIVE_ENTRY",
    `Extracted FDC CSV member changed ${phase}`,
    { path: archivePath },
  );
}

async function cleanupExtractedFiles(
  files: readonly ExtractedZipFile[],
  identities: ReadonlyMap<string, ExtractedZipFileIdentity>,
): Promise<readonly Error[]> {
  const errors: Error[] = [];
  for (const file of files) {
    const identity = identities.get(file.path);
    if (!identity) {
      errors.push(
        new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "Cannot safely remove an FDC CSV member without its identity",
          { path: file.archivePath },
        ),
      );
      continue;
    }
    try {
      await removeExactExtractedFile(file, identity);
    } catch (error) {
      if (isNotFound(error)) continue;
      errors.push(
        new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "Unable to remove an exact extracted FDC CSV member",
          { path: file.archivePath },
          { cause: error },
        ),
      );
    }
  }
  return Object.freeze(errors);
}

async function removeExactExtractedFile(
  file: ExtractedZipFile,
  identity: ExtractedZipFileIdentity,
): Promise<void> {
  const parent = await open(
    dirname(file.path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let operationError: unknown;
  try {
    const parentMetadata = await parent.stat();
    invariant(
      parentMetadata.isDirectory() &&
        parentMetadata.uid === currentUserId() &&
        (parentMetadata.mode & 0o777) === 0o700,
      "INVALID_ARCHIVE_ENTRY",
      "Cannot clean FDC CSV output outside its private directory",
      { path: file.archivePath },
    );
    const boundPath = join(`/proc/self/fd/${parent.fd}`, basename(file.path));
    const before = await lstat(boundPath);
    invariant(
      matchesExtractedIdentity(before, identity),
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to remove a replaced FDC CSV member",
      { path: file.archivePath },
    );
    invariant(
      (await hashExactPath(boundPath, identity)) === identity.sha256,
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to remove a changed FDC CSV member",
      { path: file.archivePath },
    );
    const quarantine = join(
      `/proc/self/fd/${parent.fd}`,
      `.${basename(file.path)}.${randomUUID()}.quarantine`,
    );
    await rename(boundPath, quarantine);
    try {
      const quarantined = await lstat(quarantine);
      invariant(
        matchesIdentityAfterRename(quarantined, identity),
        "INVALID_ARCHIVE_ENTRY",
        "FDC CSV cleanup quarantine identity changed",
        { path: file.archivePath },
      );
      const renamedIdentity = identityFromMetadata(quarantined, identity.sha256);
      invariant(
        (await hashExactPath(quarantine, renamedIdentity)) === identity.sha256,
        "INVALID_ARCHIVE_ENTRY",
        "FDC CSV cleanup quarantine content changed",
        { path: file.archivePath },
      );
      const immediatelyBeforeUnlink = await lstat(quarantine);
      invariant(
        matchesExtractedIdentity(immediatelyBeforeUnlink, renamedIdentity),
        "INVALID_ARCHIVE_ENTRY",
        "Refusing to remove a replaced FDC CSV cleanup quarantine",
        { path: file.archivePath },
      );
      await unlink(quarantine);
    } catch (error) {
      try {
        await restoreQuarantine(quarantine, boundPath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "FDC CSV cleanup quarantine failed and could not be restored",
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    operationError = error;
  }
  try {
    await parent.close();
  } catch (error) {
    if (operationError !== undefined)
      throw new AggregateError(
        [operationError, error],
        "FDC CSV cleanup and directory close both failed",
        { cause: operationError },
      );
    throw error;
  }
  if (operationError !== undefined) throw operationError;
}

async function restoreQuarantine(quarantine: string, original: string): Promise<void> {
  try {
    const source = await open(quarantine, constants.O_RDONLY | constants.O_NOFOLLOW);
    await source.close();
    await link(quarantine, original);
    await unlink(quarantine);
  } catch (error) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to restore an FDC CSV member from cleanup quarantine",
      {},
      { cause: error },
    );
  }
}

async function hashExactPath(path: string, identity: ExtractedZipFileIdentity): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let operationError: unknown;
  try {
    const before = await handle.stat();
    const pathBefore = await lstat(path);
    invariant(
      matchesExtractedIdentity(before, identity) && matchesExtractedIdentity(pathBefore, identity),
      "INVALID_ARCHIVE_ENTRY",
      "FDC CSV cleanup member changed before hashing",
    );
    for await (const chunk of readExactHandle(handle)) hash.update(chunk);
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    invariant(
      matchesExtractedIdentity(after, identity) && matchesExtractedIdentity(pathAfter, identity),
      "INVALID_ARCHIVE_ENTRY",
      "FDC CSV cleanup member changed while hashing",
    );
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (operationError !== undefined)
      throw new AggregateError(
        [operationError, error],
        "FDC CSV cleanup hash and close both failed",
        { cause: operationError },
      );
    throw error;
  }
  if (operationError !== undefined) throw operationError;
  return hash.digest("hex");
}

async function* readExactHandle(
  handle: Awaited<ReturnType<typeof open>>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let position = 0;
  while (true) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    invariant(Number.isSafeInteger(position), "INVALID_RECORD", "FDC CSV read position overflow");
    yield buffer.subarray(0, bytesRead);
  }
  throwIfAborted(signal);
}

function matchesExtractedIdentity(metadata: Stats, identity: ExtractedZipFileIdentity): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.birthtimeMs === identity.birthtimeMs &&
    metadata.ctimeMs === identity.ctimeMs &&
    metadata.dev === identity.device &&
    metadata.ino === identity.inode &&
    metadata.uid === identity.uid &&
    (metadata.mode & 0o777) === identity.mode &&
    metadata.mtimeMs === identity.mtimeMs &&
    metadata.nlink === identity.nlink &&
    metadata.size === identity.size
  );
}

function matchesIdentityAfterRename(metadata: Stats, identity: ExtractedZipFileIdentity): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.birthtimeMs === identity.birthtimeMs &&
    metadata.dev === identity.device &&
    metadata.ino === identity.inode &&
    metadata.uid === identity.uid &&
    (metadata.mode & 0o777) === identity.mode &&
    metadata.mtimeMs === identity.mtimeMs &&
    metadata.nlink === identity.nlink &&
    metadata.size === identity.size
  );
}

function identityFromMetadata(metadata: Stats, sha256: string): ExtractedZipFileIdentity {
  return Object.freeze({
    birthtimeMs: metadata.birthtimeMs,
    ctimeMs: metadata.ctimeMs,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode & 0o777,
    mtimeMs: metadata.mtimeMs,
    nlink: metadata.nlink,
    sha256,
    size: metadata.size,
    uid: metadata.uid,
  });
}

function currentUserId(): number {
  invariant(
    typeof process.getuid === "function",
    "INVALID_ARCHIVE_ENTRY",
    "FDC CSV inspection requires POSIX ownership verification",
  );
  return process.getuid();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
