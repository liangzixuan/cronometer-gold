import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ArchiveSafetyLimits } from "./archive.js";
import { safeArchivePath } from "./archive.js";
import {
  adaptCnfTables,
  type CnfAdapterContext,
  type CnfReleaseParseResult,
  type SourceRow,
} from "./cnf.js";
import { parseDelimitedObjectTable } from "./delimited.js";
import { canonicalJson, compareCodePoints, sha256CanonicalJson } from "./deterministic.js";
import { abortError, IngestionError, invariant } from "./errors.js";
import { type ExtractedZipFile, type ExtractedZipFileIdentity, extractZipArchive } from "./zip.js";

export const CNF_ARCHIVE_CSV_PATHS = Object.freeze([
  "Food_Name.csv",
  "Food_Source.csv",
  "CNF_Food_Group.csv",
  "Nutrient_Amount.csv",
  "Nutrient_Name.csv",
  "Nutrient_Source.csv",
  "Measure_Weight_Conversion.csv",
  "Measure_Type.csv",
  "Measure_Name.csv",
] as const);

export type CnfArchiveCsvPath = (typeof CNF_ARCHIVE_CSV_PATHS)[number];

export type CnfReferenceOnlyReason =
  | "food_source_reference_not_materialized_v1"
  | "upstream_food_group_taxonomy_not_materialized_v1"
  | "nutrient_source_lookup_not_materialized_v1"
  | "measure_type_lookup_not_materialized_v1";

export interface CnfDelimitedSafetyLimits {
  readonly maxColumns?: number;
  readonly maxFieldCharacters?: number;
  /** Maximum logical rows per CSV, including its header and blank rows. */
  readonly maxRows?: number;
  readonly maxRowCharacters?: number;
}

export interface CnfArchiveParseInput {
  readonly archivePath: string;
  readonly destinationDirectory: string;
  /** Exact full regular-file inventory, including explicitly declared guides. */
  readonly expectedFiles: readonly string[];
  /** Additional expected non-CSV guide members. Guides are preflighted but not extracted. */
  readonly guideFiles?: readonly string[];
  readonly context: CnfAdapterContext;
  readonly archiveLimits?: ArchiveSafetyLimits;
  readonly delimitedLimits?: CnfDelimitedSafetyLimits;
  readonly signal?: AbortSignal;
}

export interface CnfArchiveEvidence {
  /** Canonically sorted exact regular-file inventory. */
  readonly expectedFiles: readonly string[];
  readonly inventoryCount: number;
  readonly inventorySha256: string;
}

export interface CnfTableEvidence {
  readonly archivePath: CnfArchiveCsvPath;
  /** Uncompressed member bytes observed by the parser. */
  readonly byteSize: number;
  readonly rawSha256: string;
  readonly headers: readonly string[];
  /** SHA-256 of canonical JSON for the ordered header array. */
  readonly headerSha256: string;
  readonly rowCount: number;
  /** SHA-256 of each canonical JSON data record followed by one LF, in source order. */
  readonly rowsSha256: string;
  readonly disposition: "adapter-input" | "reference-only";
  readonly referenceOnlyReason: CnfReferenceOnlyReason | null;
}

export interface CnfArchiveMetrics {
  readonly tableCount: 9;
  readonly adapterInputTableCount: 5;
  readonly referenceOnlyTableCount: 4;
  readonly parsedDataRowCount: number;
  readonly adapterInputDataRowCount: number;
  readonly referenceOnlyDataRowCount: number;
  readonly bilingualDescriptionCount: number;
  readonly englishOnlyDescriptionCount: number;
  readonly frenchOnlyDescriptionCount: number;
  readonly missingBothDescriptionCount: number;
}

export interface CnfArchiveParseResult {
  readonly archive: CnfArchiveEvidence;
  /** Official nine-member contract order, matching `CNF_ARCHIVE_CSV_PATHS`. */
  readonly tables: readonly CnfTableEvidence[];
  /** SHA-256 of canonical JSON for the ordered table-evidence array. */
  readonly tableEvidenceSha256: string;
  readonly metrics: CnfArchiveMetrics;
  readonly parsed: CnfReleaseParseResult;
}

interface CnfTableContract {
  readonly archivePath: CnfArchiveCsvPath;
  readonly disposition: CnfTableEvidence["disposition"];
  readonly referenceOnlyReason: CnfReferenceOnlyReason | null;
}

interface ParsedCnfTable {
  readonly evidence: CnfTableEvidence;
  readonly rows: readonly SourceRow[];
}

type ExtractedCnfFileIdentity = ExtractedZipFileIdentity;

const CNF_TABLE_CONTRACTS: readonly CnfTableContract[] = Object.freeze([
  adapterInput("Food_Name.csv"),
  referenceOnly("Food_Source.csv", "food_source_reference_not_materialized_v1"),
  referenceOnly("CNF_Food_Group.csv", "upstream_food_group_taxonomy_not_materialized_v1"),
  adapterInput("Nutrient_Amount.csv"),
  adapterInput("Nutrient_Name.csv"),
  referenceOnly("Nutrient_Source.csv", "nutrient_source_lookup_not_materialized_v1"),
  adapterInput("Measure_Weight_Conversion.csv"),
  referenceOnly("Measure_Type.csv", "measure_type_lookup_not_materialized_v1"),
  adapterInput("Measure_Name.csv"),
]);

const MAX_CNF_DELIMITED_LIMITS = Object.freeze({
  maxColumns: 512,
  maxFieldCharacters: 100_000,
  maxRows: 2_000_000,
  maxRowCharacters: 1_000_000,
});

/**
 * Preflights the exact archive inventory, extracts only the nine relational CSVs,
 * parses them as bounded fatal UTF-8 RFC 4180 streams, and adapts the five inputs.
 */
export async function parseCnfArchive(input: CnfArchiveParseInput): Promise<CnfArchiveParseResult> {
  const expectedFiles = validateInventory(input.expectedFiles, input.guideFiles ?? []);
  const extracted = await extractZipArchive({
    archivePath: input.archivePath,
    destinationDirectory: input.destinationDirectory,
    expectedFiles,
    selectedFiles: CNF_ARCHIVE_CSV_PATHS,
    ...(input.archiveLimits === undefined ? {} : { limits: input.archiveLimits }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const identities = new Map<string, ExtractedCnfFileIdentity>(
    extracted.map((file) => [file.path, file.identity]),
  );
  try {
    throwIfAborted(input.signal);
    await captureExtractedFileIdentities(extracted, identities);
    return await parseExtractedCnfArchive(input, expectedFiles, extracted, identities);
  } catch (operationError) {
    const cleanupErrors = await cleanupExtractedCnfFiles(extracted, identities);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "CNF archive parsing failed and extracted-member cleanup was incomplete",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

async function parseExtractedCnfArchive(
  input: CnfArchiveParseInput,
  expectedFiles: readonly string[],
  extracted: readonly ExtractedZipFile[],
  identities: ReadonlyMap<string, ExtractedCnfFileIdentity>,
): Promise<CnfArchiveParseResult> {
  const extractedByPath = new Map(extracted.map((file) => [file.archivePath, file]));
  invariant(
    extractedByPath.size === CNF_ARCHIVE_CSV_PATHS.length,
    "INVALID_ARCHIVE_ENTRY",
    "CNF extraction did not return the exact selected table set",
    { expected: CNF_ARCHIVE_CSV_PATHS.length, actual: extractedByPath.size },
  );

  const limits = resolveDelimitedLimits(input.delimitedLimits);
  const parsedByPath = new Map<CnfArchiveCsvPath, ParsedCnfTable>();
  for (const contract of CNF_TABLE_CONTRACTS) {
    throwIfAborted(input.signal);
    const file = extractedByPath.get(contract.archivePath);
    invariant(file, "INVALID_ARCHIVE_ENTRY", "CNF extraction omitted a selected table", {
      path: contract.archivePath,
    });
    const identity = identities.get(file.path);
    invariant(identity, "INVALID_ARCHIVE_ENTRY", "CNF extracted-file identity is unavailable", {
      path: contract.archivePath,
    });
    parsedByPath.set(
      contract.archivePath,
      await parseTable(file, identity, contract, limits, input.signal),
    );
  }
  throwIfAborted(input.signal);

  const tableEvidence = Object.freeze(
    CNF_ARCHIVE_CSV_PATHS.map((path) => requiredTable(parsedByPath, path).evidence),
  );
  const foodNames = requiredTable(parsedByPath, "Food_Name.csv").rows;
  const metrics = createMetrics(tableEvidence, foodNames);
  const parsed = adaptCnfTables(
    {
      foodNames,
      nutrientAmounts: requiredTable(parsedByPath, "Nutrient_Amount.csv").rows,
      nutrientNames: requiredTable(parsedByPath, "Nutrient_Name.csv").rows,
      measureWeightConversions: requiredTable(parsedByPath, "Measure_Weight_Conversion.csv").rows,
      measureNames: requiredTable(parsedByPath, "Measure_Name.csv").rows,
    },
    input.context,
  );

  return Object.freeze({
    archive: Object.freeze({
      expectedFiles,
      inventoryCount: expectedFiles.length,
      inventorySha256: sha256CanonicalJson(expectedFiles),
    }),
    tables: tableEvidence,
    tableEvidenceSha256: sha256CanonicalJson(tableEvidence),
    metrics,
    parsed,
  });
}

async function captureExtractedFileIdentities(
  files: readonly ExtractedZipFile[],
  identities: Map<string, ExtractedCnfFileIdentity>,
): Promise<void> {
  const uid = currentUserId();
  const errors: unknown[] = [];
  for (const file of files) {
    identities.set(file.path, file.identity);
    try {
      const metadata = await lstat(file.path);
      invariant(
        metadata.uid === uid && matchesExtractedIdentity(metadata, file.identity),
        "INVALID_ARCHIVE_ENTRY",
        "Extracted CNF member changed after extraction and before parsing",
        { path: file.archivePath },
      );
      invariant(
        metadata.size === file.byteSize,
        "INVALID_ARCHIVE_ENTRY",
        "Extracted CNF member size differs from extractor evidence",
        { path: file.archivePath, expected: file.byteSize, actual: metadata.size },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple extracted CNF members changed before parsing", {
      cause: errors[0],
    });
  }
}

async function cleanupExtractedCnfFiles(
  files: readonly ExtractedZipFile[],
  identities: ReadonlyMap<string, ExtractedCnfFileIdentity>,
): Promise<readonly Error[]> {
  const errors: Error[] = [];
  for (const file of files) {
    const identity = identities.get(file.path);
    if (!identity) {
      errors.push(
        new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "Cannot safely remove an extracted CNF member without its identity",
          { path: file.archivePath },
        ),
      );
      continue;
    }
    try {
      await removeExactExtractedCnfFile(file, identity);
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      errors.push(
        new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "Unable to remove an exact extracted CNF member after parsing failed",
          { path: file.archivePath },
          { cause: error },
        ),
      );
    }
  }
  return Object.freeze(errors);
}

async function parseTable(
  file: ExtractedZipFile,
  identity: ExtractedCnfFileIdentity,
  contract: CnfTableContract,
  limits: Required<CnfDelimitedSafetyLimits>,
  signal?: AbortSignal,
): Promise<ParsedCnfTable> {
  const rawHash = createHash("sha256");
  let byteSize = 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to open the exact extracted CNF member for parsing",
      { path: contract.archivePath },
      { cause: error },
    );
  }
  let operationFailed = false;
  let operationError: unknown;
  let table: Awaited<ReturnType<typeof parseDelimitedObjectTable>> | undefined;
  let identityEstablished = false;
  try {
    const before = await handle.stat();
    invariant(
      matchesExtractedIdentity(before, identity),
      "INVALID_ARCHIVE_ENTRY",
      "Extracted CNF member changed before parsing",
      { path: contract.archivePath },
    );
    const pathBefore = await lstat(file.path);
    invariant(
      matchesExtractedIdentity(pathBefore, identity),
      "INVALID_ARCHIVE_ENTRY",
      "Extracted CNF member path changed before parsing",
      { path: contract.archivePath },
    );
    identityEstablished = true;
    const observedBytes = (async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of readExactHandle(handle, signal)) {
        byteSize += chunk.byteLength;
        invariant(
          Number.isSafeInteger(byteSize),
          "INVALID_RECORD",
          "CNF table byte size overflow",
          { path: contract.archivePath },
        );
        rawHash.update(chunk);
        yield chunk;
      }
    })();
    table = await parseDelimitedObjectTable(observedBytes, {
      delimiter: ",",
      headerMode: "exact",
      ...limits,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const finalizationErrors: unknown[] = [];
  if (identityEstablished) {
    try {
      const after = await handle.stat();
      invariant(
        matchesExtractedIdentity(after, identity),
        "INVALID_ARCHIVE_ENTRY",
        "Extracted CNF member changed while parsing",
        { path: contract.archivePath },
      );
      const pathAfter = await lstat(file.path);
      invariant(
        matchesExtractedIdentity(pathAfter, identity),
        "INVALID_ARCHIVE_ENTRY",
        "Extracted CNF member path changed while parsing",
        { path: contract.archivePath },
      );
    } catch (error) {
      finalizationErrors.push(error);
    }
  }
  try {
    await handle.close();
  } catch (error) {
    finalizationErrors.push(error);
  }
  if (operationFailed) {
    if (finalizationErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...finalizationErrors],
        "CNF table parsing failed and exact-file finalization was incomplete",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (finalizationErrors.length > 0) {
    if (finalizationErrors.length === 1) {
      throw finalizationErrors[0];
    }
    throw new AggregateError(finalizationErrors, "CNF exact-file finalization failed", {
      cause: finalizationErrors[0],
    });
  }
  invariant(table, "INVALID_RECORD", "CNF table parsing produced no result", {
    path: contract.archivePath,
  });
  invariant(
    byteSize === file.byteSize,
    "INVALID_ARCHIVE_ENTRY",
    "Parsed CNF table size differs from extracted evidence",
    { path: contract.archivePath, expected: file.byteSize, actual: byteSize },
  );
  const rows = Object.freeze(table.rows.map((row) => row.record));
  const rowsHash = createHash("sha256");
  for (const row of rows) {
    rowsHash.update(canonicalJson(row));
    rowsHash.update("\n");
  }
  const rawSha256 = rawHash.digest("hex");
  invariant(
    rawSha256 === identity.sha256,
    "INVALID_ARCHIVE_ENTRY",
    "Parsed CNF table content differs from extractor evidence",
    { path: contract.archivePath },
  );
  return Object.freeze({
    evidence: Object.freeze({
      archivePath: contract.archivePath,
      byteSize,
      rawSha256,
      headers: table.headers,
      headerSha256: sha256CanonicalJson(table.headers),
      rowCount: rows.length,
      rowsSha256: rowsHash.digest("hex"),
      disposition: contract.disposition,
      referenceOnlyReason: contract.referenceOnlyReason,
    }),
    rows,
  });
}

function validateInventory(
  rawExpectedFiles: readonly string[],
  rawGuideFiles: readonly string[],
): readonly string[] {
  invariant(
    rawExpectedFiles.length >= CNF_ARCHIVE_CSV_PATHS.length,
    "INVALID_ARCHIVE_ENTRY",
    "CNF expected inventory must contain all nine relational CSV members",
  );
  const expectedFiles = rawExpectedFiles.map((path) => safeArchivePath(path, false));
  const expected = new Set(expectedFiles);
  invariant(
    expected.size === expectedFiles.length,
    "INVALID_ARCHIVE_ENTRY",
    "CNF expected inventory contains duplicate members",
  );
  const guideFiles = rawGuideFiles.map((path) => safeArchivePath(path, false));
  const guides = new Set(guideFiles);
  invariant(
    guides.size === guideFiles.length,
    "INVALID_ARCHIVE_ENTRY",
    "CNF guide inventory contains duplicate members",
  );

  const official = new Set<string>(CNF_ARCHIVE_CSV_PATHS);
  for (const path of CNF_ARCHIVE_CSV_PATHS) {
    invariant(
      expected.has(path),
      "INVALID_ARCHIVE_ENTRY",
      "CNF archive is missing a required CSV",
      {
        path,
      },
    );
  }
  for (const guide of guideFiles) {
    invariant(!official.has(guide), "INVALID_ARCHIVE_ENTRY", "CNF CSV cannot be a guide member", {
      path: guide,
    });
    invariant(
      !/\.csv$/iu.test(guide),
      "INVALID_ARCHIVE_ENTRY",
      "Additional CNF guide members must be non-CSV files",
      { path: guide },
    );
    invariant(expected.has(guide), "INVALID_ARCHIVE_ENTRY", "CNF guide is absent from inventory", {
      path: guide,
    });
  }
  for (const path of expectedFiles) {
    invariant(
      official.has(path) || guides.has(path),
      "INVALID_ARCHIVE_ENTRY",
      "Additional CNF members must be explicitly declared non-CSV guides",
      { path },
    );
  }
  invariant(
    expected.size === official.size + guides.size,
    "INVALID_ARCHIVE_ENTRY",
    "CNF inventory and explicit guide set do not match",
  );
  return Object.freeze([...expected].sort(compareCodePoints));
}

function resolveDelimitedLimits(
  input: CnfDelimitedSafetyLimits | undefined,
): Required<CnfDelimitedSafetyLimits> {
  return Object.freeze({
    maxColumns: boundedOverride(input?.maxColumns, "maxColumns"),
    maxFieldCharacters: boundedOverride(input?.maxFieldCharacters, "maxFieldCharacters"),
    maxRows: boundedOverride(input?.maxRows, "maxRows"),
    maxRowCharacters: boundedOverride(input?.maxRowCharacters, "maxRowCharacters"),
  });
}

function boundedOverride(value: number | undefined, field: keyof CnfDelimitedSafetyLimits): number {
  const maximum = MAX_CNF_DELIMITED_LIMITS[field];
  const resolved = value ?? maximum;
  invariant(
    Number.isSafeInteger(resolved) && resolved > 0 && resolved <= maximum,
    "INVALID_RECORD",
    `CNF ${field} must be a positive integer no greater than ${maximum}`,
    { field },
  );
  return resolved;
}

function createMetrics(
  evidence: readonly CnfTableEvidence[],
  foodNames: readonly SourceRow[],
): CnfArchiveMetrics {
  let bilingualDescriptionCount = 0;
  let englishOnlyDescriptionCount = 0;
  let frenchOnlyDescriptionCount = 0;
  let missingBothDescriptionCount = 0;
  for (const row of foodNames) {
    const hasEnglish = nonemptyDescription(row.Food_Description_EN);
    const hasFrench = nonemptyDescription(row.Food_Description_FR);
    if (hasEnglish && hasFrench) {
      bilingualDescriptionCount += 1;
    } else if (hasEnglish) {
      englishOnlyDescriptionCount += 1;
    } else if (hasFrench) {
      frenchOnlyDescriptionCount += 1;
    } else {
      missingBothDescriptionCount += 1;
    }
  }
  invariant(
    bilingualDescriptionCount +
      englishOnlyDescriptionCount +
      frenchOnlyDescriptionCount +
      missingBothDescriptionCount ===
      foodNames.length,
    "INVALID_RECORD",
    "CNF description metrics do not partition Food_Name rows",
  );
  const parsedDataRowCount = evidence.reduce((sum, table) => sum + table.rowCount, 0);
  const adapterInputDataRowCount = evidence
    .filter((table) => table.disposition === "adapter-input")
    .reduce((sum, table) => sum + table.rowCount, 0);
  return Object.freeze({
    tableCount: 9,
    adapterInputTableCount: 5,
    referenceOnlyTableCount: 4,
    parsedDataRowCount,
    adapterInputDataRowCount,
    referenceOnlyDataRowCount: parsedDataRowCount - adapterInputDataRowCount,
    bilingualDescriptionCount,
    englishOnlyDescriptionCount,
    frenchOnlyDescriptionCount,
    missingBothDescriptionCount,
  });
}

function nonemptyDescription(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredTable(
  tables: ReadonlyMap<CnfArchiveCsvPath, ParsedCnfTable>,
  path: CnfArchiveCsvPath,
): ParsedCnfTable {
  const table = tables.get(path);
  invariant(table, "INVALID_RECORD", "Parsed CNF table is unavailable", { path });
  return table;
}

function adapterInput(archivePath: CnfArchiveCsvPath): CnfTableContract {
  return Object.freeze({ archivePath, disposition: "adapter-input", referenceOnlyReason: null });
}

function referenceOnly(
  archivePath: CnfArchiveCsvPath,
  referenceOnlyReason: CnfReferenceOnlyReason,
): CnfTableContract {
  return Object.freeze({ archivePath, disposition: "reference-only", referenceOnlyReason });
}

async function removeExactExtractedCnfFile(
  file: ExtractedZipFile,
  identity: ExtractedCnfFileIdentity,
): Promise<void> {
  const parentPath = dirname(file.path);
  const parent = await open(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let operationFailed = false;
  let operationError: unknown;
  try {
    const parentMetadata = await parent.stat();
    const publicParentMetadata = await lstat(parentPath);
    invariant(
      parentMetadata.isDirectory() &&
        !parentMetadata.isSymbolicLink() &&
        parentMetadata.uid === currentUserId() &&
        (parentMetadata.mode & 0o777) === 0o700 &&
        publicParentMetadata.isDirectory() &&
        !publicParentMetadata.isSymbolicLink() &&
        publicParentMetadata.dev === parentMetadata.dev &&
        publicParentMetadata.ino === parentMetadata.ino,
      "INVALID_ARCHIVE_ENTRY",
      "Cannot safely clean CNF output outside its private bound directory",
      { path: file.archivePath },
    );
    const boundPath = join(`/proc/self/fd/${parent.fd}`, basename(file.path));
    const before = await lstat(boundPath);
    invariant(
      matchesExtractedIdentity(before, identity),
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to remove a replaced extracted CNF member",
      { path: file.archivePath },
    );
    invariant(
      (await hashExactCnfPath(boundPath, identity)) === identity.sha256,
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to remove an extracted CNF member whose content changed",
      { path: file.archivePath },
    );
    const quarantinePath = join(
      `/proc/self/fd/${parent.fd}`,
      `.${basename(file.path)}.${randomUUID()}.quarantine`,
    );
    await rename(boundPath, quarantinePath);
    try {
      const quarantinedMetadata = await lstat(quarantinePath);
      if (!matchesExtractedIdentityAfterRename(quarantinedMetadata, identity)) {
        throw new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "Extracted CNF member identity changed while entering cleanup quarantine",
          { path: file.archivePath },
        );
      }
      const quarantinedIdentity = identityFromMetadata(quarantinedMetadata, identity.sha256);
      if ((await hashExactCnfPath(quarantinePath, quarantinedIdentity)) !== identity.sha256) {
        throw new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "Extracted CNF member content changed while entering cleanup quarantine",
          { path: file.archivePath },
        );
      }
      const immediatelyBeforeUnlink = await lstat(quarantinePath);
      invariant(
        matchesExtractedIdentity(immediatelyBeforeUnlink, quarantinedIdentity),
        "INVALID_ARCHIVE_ENTRY",
        "Extracted CNF cleanup quarantine changed before removal",
        { path: file.archivePath },
      );
      await unlink(quarantinePath);
    } catch (error) {
      try {
        await restoreCnfQuarantine(quarantinePath, boundPath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "CNF cleanup quarantine verification failed and the original path could not be restored",
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await parent.close();
  } catch (error) {
    const closeError = new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to close the bound CNF cleanup directory",
      { path: file.archivePath },
      { cause: error },
    );
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        "CNF cleanup and bound-directory handle cleanup both failed",
        { cause: operationError },
      );
    }
    throw closeError;
  }
  if (operationFailed) {
    throw operationError;
  }
}

async function restoreCnfQuarantine(quarantinePath: string, originalPath: string): Promise<void> {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
  } catch (error) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to restore a replaced CNF member from cleanup quarantine",
      { quarantinePath },
      { cause: error },
    );
  }
}

async function hashExactCnfPath(path: string, identity: ExtractedCnfFileIdentity): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let digest: string | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const before = await handle.stat();
    invariant(
      matchesExtractedIdentity(before, identity),
      "INVALID_ARCHIVE_ENTRY",
      "Extracted CNF member changed before cleanup content verification",
      { path },
    );
    const hash = createHash("sha256");
    let position = 0;
    while (position < identity.size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, identity.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      invariant(
        bytesRead > 0,
        "INVALID_ARCHIVE_ENTRY",
        "CNF cleanup content verification made no progress",
      );
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(trailing, 0, 1, position);
    invariant(bytesRead === 0, "INVALID_ARCHIVE_ENTRY", "CNF cleanup member grew");
    const after = await handle.stat();
    invariant(
      matchesExtractedIdentity(after, identity),
      "INVALID_ARCHIVE_ENTRY",
      "Extracted CNF member changed during cleanup content verification",
      { path },
    );
    digest = hash.digest("hex");
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    const closeError = new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to close an extracted CNF member after content verification",
      { path },
      { cause: error },
    );
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        "CNF member content verification and handle cleanup both failed",
        { cause: operationError },
      );
    }
    throw closeError;
  }
  if (operationFailed) {
    throw operationError;
  }
  invariant(digest !== undefined, "INVALID_ARCHIVE_ENTRY", "CNF content hash is unavailable");
  return digest;
}

function matchesExtractedIdentityAfterRename(
  metadata: Stats,
  identity: ExtractedCnfFileIdentity,
): boolean {
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

function identityFromMetadata(metadata: Stats, sha256: string): ExtractedCnfFileIdentity {
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

async function* readExactHandle(
  handle: Awaited<ReturnType<typeof open>>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let position = 0;
  while (true) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) {
      break;
    }
    position += bytesRead;
    invariant(Number.isSafeInteger(position), "INVALID_RECORD", "CNF read position overflow");
    yield buffer.subarray(0, bytesRead);
  }
  throwIfAborted(signal);
}

function matchesExtractedIdentity(metadata: Stats, identity: ExtractedCnfFileIdentity): boolean {
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

function currentUserId(): number {
  invariant(
    typeof process.getuid === "function",
    "INVALID_ARCHIVE_ENTRY",
    "CNF parsing requires POSIX ownership verification",
  );
  return process.getuid();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
