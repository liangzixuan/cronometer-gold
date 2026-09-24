import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import { describe, expect, it } from "vitest";
import { prepareCatalogueValidation } from "../../../packages/db/src/catalogue-capability-validation.js";
import {
  getSourceNutrientMappingDigest,
  nutrientMappingRevisionDigest,
  registerFoodSourceFromReviewedManifest,
  registerSourceNutrientMappings,
  type StagedCatalogueRecordInput,
  supersedeSourceNutrientMapping,
} from "../../../packages/db/src/catalogue-ingestion.js";
import { catalogueFramedSha256V2 } from "../../../packages/db/src/catalogue-paged-protocol.js";
import {
  type RetainedCatalogueValidationPageV2,
  readCataloguePagedReconciliationPage,
  reconcileCataloguePagedBatch,
  submitCataloguePagedApproval,
} from "../../../packages/db/src/catalogue-paged-reconciliation.js";
import {
  admitCataloguePreparationV2,
  beginCataloguePreparationSealV2,
  beginCataloguePreparationV2,
  encodeCataloguePreparationAdmissionV2,
  encodeCataloguePreparationParserReportV2,
  encodeCataloguePreparationSealTerminalV2,
  encodeCataloguePreparationStageIdentityV2,
  encodeCataloguePreparationStagePageV2,
  finishCataloguePreparationSealV2,
  submitCataloguePreparationStagePageV2,
  verifyCataloguePreparationSealPageV2,
} from "../../../packages/db/src/catalogue-paged-stage.js";
import {
  advanceCatalogueValidationContextV2,
  beginCatalogueValidationV2,
  type CatalogueValidationContextV2,
  parsePreparedCatalogueValidationPageV2,
  prepareCatalogueValidationPageV2,
  prepareCatalogueValidationTerminalV2,
  submitCatalogueValidationPageV2,
  submitCatalogueValidationTerminalV2,
} from "../../../packages/db/src/catalogue-paged-validation.js";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "../../../packages/db/src/catalogue-validation.js";
import { createDatabase } from "../../../packages/db/src/client.js";
import { runMigrations } from "../../../packages/db/src/migrator.js";
import type { Database, JsonObject, JsonValue } from "../../../packages/db/src/types.js";
import {
  collectPagedCatalogueSourceAuthority,
  readPagedRestoreTableInventory,
  rehearsePagedCatalogueLogicalRestore,
  runPagedRestoreProofAfterCleanup,
  validatePagedFingerprintCommand,
  validatePagedRestoreFixtureTarget,
} from "../../../packages/db/test/catalogue-paged-restore-fixture.js";
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  postgresTypes,
  type QueryResult,
  sql,
} from "../../../packages/db/test/catalogue-paged-test-runtime.js";
import {
  acknowledgeCatalogueValidationPageV2,
  createCatalogueValidationJournalV2,
  finishCatalogueValidationJournalV2,
  readCatalogueValidationJournalV2,
  retainCatalogueValidationRequestV2,
} from "../src/catalogue-paged-journal.js";
import {
  createBaseline,
  MAPPING,
  POLICY,
  parserReport,
  stageIdentity,
  syntheticRecord,
} from "./catalogue-paged-fixtures.js";

// This dedicated opt-in never starts an engine, installs dependencies or acquires data.
// The guarded launcher runs each workload in its own process and records OS resources.
const ADMIN = process.env.CATALOGUE_PAGED_TEST_DATABASE_ADMIN_URL;
const databaseDescribe = ADMIN ? describe : describe.skip;
const HASH = "a".repeat(64);
type Client = ReturnType<typeof createDatabase>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type MemorySample = {
  elapsedMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBufferBytes: number;
  processHighWaterRssBytes: number;
};
type HeapSpaceSample = {
  space_name: string;
  space_used_size: number;
  physical_space_size: number;
};
type PairedMemorySnapshot = MemorySample & {
  v8TotalPhysicalBytes: number;
  v8MallocedBytes: number;
  heapSpaces: Record<
    "newSpace" | "oldSpace" | "newLargeObjectSpace" | "largeObjectSpace",
    { usedBytes: number | null; physicalBytes: number | null }
  >;
};
type MemorySpan = {
  start: PairedMemorySnapshot;
  end: PairedMemorySnapshot | null;
  pairedRssPeak: PairedMemorySnapshot;
  // These independent maxima may come from different observations.
  maximumSampledRssBytes: number;
  maximumSampledHeapUsedBytes: number;
  maximumSampledExternalBytes: number;
  maximumProcessHighWaterRssBytes: number;
  sampleCount: number;
  pagesObserved: number;
};
function pairMemorySnapshot(
  sample: MemorySample,
  heap: { total_physical_size: number; malloced_memory: number },
  spaces: readonly HeapSpaceSample[],
): PairedMemorySnapshot {
  const space = (name: string) => {
    const observed = spaces.find((entry) => entry.space_name === name);
    return {
      usedBytes: observed?.space_used_size ?? null,
      physicalBytes: observed?.physical_space_size ?? null,
    };
  };
  // Copy only numeric fields. Do not retain V8 objects or arbitrary space names.
  return {
    elapsedMs: sample.elapsedMs,
    rssBytes: sample.rssBytes,
    heapUsedBytes: sample.heapUsedBytes,
    heapTotalBytes: sample.heapTotalBytes,
    externalBytes: sample.externalBytes,
    arrayBufferBytes: sample.arrayBufferBytes,
    processHighWaterRssBytes: sample.processHighWaterRssBytes,
    v8TotalPhysicalBytes: heap.total_physical_size,
    v8MallocedBytes: heap.malloced_memory,
    heapSpaces: {
      newSpace: space("new_space"),
      oldSpace: space("old_space"),
      newLargeObjectSpace: space("new_large_object_space"),
      largeObjectSpace: space("large_object_space"),
    },
  };
}
function newMemorySpan(start: PairedMemorySnapshot): MemorySpan {
  return {
    start,
    end: null,
    pairedRssPeak: start,
    maximumSampledRssBytes: start.rssBytes,
    maximumSampledHeapUsedBytes: start.heapUsedBytes,
    maximumSampledExternalBytes: start.externalBytes,
    maximumProcessHighWaterRssBytes: start.processHighWaterRssBytes,
    sampleCount: 1,
    pagesObserved: 0,
  };
}
function replacePairedRssPeak(
  peak: PairedMemorySnapshot,
  sample: MemorySample,
  pair: (sample: MemorySample) => PairedMemorySnapshot,
) {
  return sample.rssBytes > peak.rssBytes ? pair(sample) : peak;
}
function recordMemorySample(
  span: MemorySpan,
  sample: MemorySample,
  pair: (sample: MemorySample) => PairedMemorySnapshot,
) {
  // Capture V8 details only at a new sampled RSS maximum, using that same
  // memoryUsage observation. Ties preserve the first peak; no history grows.
  span.pairedRssPeak = replacePairedRssPeak(span.pairedRssPeak, sample, pair);
  span.maximumSampledRssBytes = Math.max(span.maximumSampledRssBytes, sample.rssBytes);
  span.maximumSampledHeapUsedBytes = Math.max(
    span.maximumSampledHeapUsedBytes,
    sample.heapUsedBytes,
  );
  span.maximumSampledExternalBytes = Math.max(
    span.maximumSampledExternalBytes,
    sample.externalBytes,
  );
  span.maximumProcessHighWaterRssBytes = Math.max(
    span.maximumProcessHighWaterRssBytes,
    sample.processHighWaterRssBytes,
  );
  span.sampleCount += 1;
}

type PreparationResourceMetrics = Record<string, unknown> & {
  preparationMaxRssBytes: number;
  elapsedMs: number;
};

function finalizePreparationResourceMetrics(
  preparation: PreparationResourceMetrics,
  finalMemory: PairedMemorySnapshot,
) {
  return {
    ...preparation,
    measurementBoundary: "test-process-through-restore-and-owned-cleanup",
    preparationBeforeRestoreMaxRssBytes: preparation.preparationMaxRssBytes,
    preparationBeforeRestoreElapsedMs: preparation.elapsedMs,
    preparationMaxRssBytes: Math.max(
      preparation.preparationMaxRssBytes,
      finalMemory.processHighWaterRssBytes,
      finalMemory.rssBytes,
    ),
    elapsedMs: finalMemory.elapsedMs,
    finalMemory,
  };
}

describe("bounded paired memory telemetry", () => {
  const sample = (rssBytes: number, heapUsedBytes = 10, externalBytes = 20): MemorySample => ({
    elapsedMs: rssBytes,
    rssBytes,
    heapUsedBytes,
    heapTotalBytes: heapUsedBytes + 50,
    externalBytes,
    arrayBufferBytes: externalBytes - 1,
    processHighWaterRssBytes: rssBytes,
  });
  const pair = (value: MemorySample) =>
    pairMemorySnapshot(
      value,
      { total_physical_size: value.heapTotalBytes + 1, malloced_memory: value.externalBytes + 2 },
      [
        {
          space_name: "old_space",
          space_used_size: value.heapUsedBytes,
          physical_space_size: value.heapTotalBytes,
        },
      ],
    );
  it("keeps a late restore or cleanup peak in the launcher's existing resource field", () => {
    const preparation = { preparationMaxRssBytes: 200, elapsedMs: 10, recordCount: 12500 };
    const finalMemory = { ...pair(sample(180)), elapsedMs: 30, processHighWaterRssBytes: 300 };
    const result = finalizePreparationResourceMetrics(preparation, finalMemory);
    expect(result).toMatchObject({
      preparationMaxRssBytes: 300,
      preparationBeforeRestoreMaxRssBytes: 200,
      preparationBeforeRestoreElapsedMs: 10,
      elapsedMs: 30,
      recordCount: 12500,
      measurementBoundary: "test-process-through-restore-and-owned-cleanup",
    });
    expect(result.finalMemory).toBe(finalMemory);
    expect(preparation).toEqual({ preparationMaxRssBytes: 200, elapsedMs: 10, recordCount: 12500 });
  });
  it("never lowers an earlier peak when final current RSS and high-water are lower", () => {
    const result = finalizePreparationResourceMetrics(
      { preparationMaxRssBytes: 300, elapsedMs: 10 },
      pair(sample(200)),
    );
    expect(result.preparationMaxRssBytes).toBe(300);
    expect(result.preparationBeforeRestoreMaxRssBytes).toBe(300);
  });
  it("conservatively includes current RSS if it exceeds the sampled kernel high-water", () => {
    const result = finalizePreparationResourceMetrics(
      { preparationMaxRssBytes: 200, elapsedMs: 10 },
      { ...pair(sample(350)), processHighWaterRssBytes: 300 },
    );
    expect(result.preparationMaxRssBytes).toBe(350);
  });
  it("keeps an RSS peak contemporaneous when independent heap and external maxima differ", () => {
    const span = newMemorySpan(pair(sample(100)));
    let pairedReads = 0;
    const capture = (value: MemorySample) => {
      pairedReads += 1;
      return pair(value);
    };
    recordMemorySample(span, sample(90, 80, 75), capture);
    expect(pairedReads).toBe(0);
    const peak = sample(110, 15, 25);
    recordMemorySample(span, peak, capture);
    expect(pairedReads).toBe(1);
    expect(span.pairedRssPeak).toEqual(pair(peak));
    expect(span.pairedRssPeak.heapUsedBytes).toBe(15);
    expect(span.pairedRssPeak.externalBytes).toBe(25);
    expect(span.maximumSampledHeapUsedBytes).toBe(80);
    expect(span.maximumSampledExternalBytes).toBe(75);
  });
  it("replaces one fixed peak slot without retaining samples and preserves ties", () => {
    const initial = pair(sample(100));
    const span = newMemorySpan(initial);
    const fields = Object.keys(span);
    for (let index = 1; index <= 1000; index++) recordMemorySample(span, sample(100 + index), pair);
    const peak = span.pairedRssPeak;
    recordMemorySample(span, sample(1100, 2000), () => {
      throw new Error("Tied RSS must not collect another V8 snapshot");
    });
    expect(Object.keys(span)).toEqual(fields);
    expect(span.start).toBe(initial);
    expect(span.end).toBeNull();
    expect(span.pairedRssPeak).toBe(peak);
    expect(span.pairedRssPeak.rssBytes).toBe(1100);
    expect(span.pairedRssPeak.heapUsedBytes).toBe(10);
    expect(span.maximumSampledHeapUsedBytes).toBe(2000);
    expect(span.sampleCount).toBe(1002);
    expect(Object.values(span).some(Array.isArray)).toBe(false);
  });
  it("copies only fixed numeric fields and represents missing heap spaces as unknown", () => {
    const input = { ...sample(100), unexpected: "unretained-marker" };
    const heap = { total_physical_size: 70, malloced_memory: 4, unexpected: "unretained-marker" };
    const spaces = [
      { space_name: "old_space", space_used_size: 30, physical_space_size: 50 },
      { space_name: "unretained-marker", space_used_size: 999, physical_space_size: 999 },
    ];
    const paired = pairMemorySnapshot(input, heap, spaces);
    required(spaces[0]).space_used_size = 900;
    heap.total_physical_size = 800;
    expect(paired.heapSpaces).toEqual({
      newSpace: { usedBytes: null, physicalBytes: null },
      oldSpace: { usedBytes: 30, physicalBytes: 50 },
      newLargeObjectSpace: { usedBytes: null, physicalBytes: null },
      largeObjectSpace: { usedBytes: null, physicalBytes: null },
    });
    expect(paired.v8TotalPhysicalBytes).toBe(70);
    expect(JSON.stringify(paired)).not.toContain("unretained-marker");
  });
});

function pagedPreparationTestConfiguration(url: string, recordCount: string | undefined) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Paged preparation integration requires a valid authenticated loopback administrator URL",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !parsed.username ||
    !parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "Paged preparation integration requires an explicit authenticated loopback administrator URL",
    );
  if (recordCount !== "12500" && recordCount !== "25000")
    throw new Error("Select exactly the separately approved 12500 or 25000 synthetic workload");
  return { url: parsed, recordCount: Number(recordCount) };
}

function restoreInventoryDatabase(rowsForQuery: (query: CompiledQuery) => unknown[]) {
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          return { rows: rowsForQuery(query) as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("Unexpected restore inventory stream");
        },
      };
    }
  }
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

async function syntheticAdmissionCapacity(recordCount: number, admittedBytes?: number) {
  if (recordCount !== 12500 && recordCount !== 25000)
    throw new Error("Unsupported synthetic admission workload");
  // This fixture decision changes only the new immutable logical allowance.
  // It neither changes physical limits nor forecasts complete capacity.
  const maxIntermediateBytes = admittedBytes ?? (recordCount === 12500 ? 2 : 4) * 1024 ** 3;
  const token = "0".repeat(16);
  const releaseKey = `synthetic-paged-${token}`;
  const batchId = "12345678-1234-4234-8234-123456789abc";
  const principal = `paged_validate_${token}`;
  const records = Array.from({ length: 250 }, (_, sequence) =>
    syntheticRecord(releaseKey, sequence, 6144),
  );
  const stageDocument = encodeCataloguePreparationStagePageV2({
    batchId,
    admissionSha256: HASH,
    parserVersion: stageIdentity(releaseKey, HASH).parserVersion,
    pageNumber: 0,
    firstSequence: 0,
    previousReceiptSha256: null,
    records,
  });
  const entries = records.map((record) => ({
    sequenceNumber: String(record.sequenceNumber),
    sourceRecordKey: record.sourceRecordKey,
    sourceRecordType: record.sourceRecordType,
    sourcePayloadSha256: record.sourcePayloadSha256,
    canonicalPayloadSha256: required(record.canonicalPayloadSha256),
    canonicalPayloadDocument: canonicalJson(record.canonicalPayload),
  }));
  // For this printable-ASCII fixture, compact canonical payload text is no
  // larger than PostgreSQL jsonb text. All later numeric identities have at
  // least the first page's widths; hashes, UUIDs and fixture tokens stay fixed.
  const isLowerBoundFixtureValue = (value: JsonValue): boolean =>
    typeof value === "string"
      ? /^[\x20-\x7e]*$/u.test(value)
      : typeof value === "number"
        ? Number.isSafeInteger(value)
        : value === null || typeof value === "boolean"
          ? true
          : (Array.isArray(value) ? value : Object.values(value)).every(isLowerBoundFixtureValue);
  if (!records.every((record) => isLowerBoundFixtureValue(record.canonicalPayload)))
    throw new Error("Synthetic lower bound requires printable ASCII and integer fixture values");
  const stagePageLowerBytes =
    8192 +
    2 * Buffer.byteLength(stageDocument) +
    entries.reduce(
      (bytes, record) =>
        bytes +
        8192 +
        2 *
          (2 * Buffer.byteLength(record.canonicalPayloadDocument) +
            Buffer.byteLength(record.sourceRecordKey) +
            Buffer.byteLength(record.sourceRecordType ?? "")),
      0,
    );
  const observationDocument = canonicalJson({
    schemaVersion: 2,
    kind: "catalogue-validation-observation-v2",
    batchId,
    contextSha256: HASH,
    pageNumber: "0",
    startSequence: "0",
    endSequence: "64",
    maximumRecords: "64",
    previousReceiptSha256: HASH,
    sourceCode: "USDA_FDC",
    releaseKey,
    records: entries.slice(0, 64),
    nutrientMappings: [
      {
        canonicalUnit: MAPPING.canonicalNutrient.unit,
        conversionMultiplier: "1.000000000000",
        nutrientCode: MAPPING.canonicalNutrient.code,
        nutrientDimension: MAPPING.canonicalNutrient.dimension,
        nutrientId: "1",
        nutrientName: MAPPING.canonicalNutrient.name,
        mappingRevisionId: "22345678-1234-4234-8234-123456789abc",
        sourceNutrientId: MAPPING.sourceNutrientKey,
        sourceUnit: MAPPING.sourceUnit,
      },
    ],
    forbiddenGtins: [],
  });
  const responses: unknown[] = [
    {
      databasePrincipal: principal,
      effectivePrincipal: principal,
      canLogin: true,
      privileged: false,
      ownerMember: false,
      capabilities: ["nutrition_catalogue_validate"],
    },
    {
      schemaVersion: 2,
      observationDocument,
      observationSha256: catalogueFramedSha256V2("validation-observation", [observationDocument]),
    },
  ];
  const offline = restoreInventoryDatabase(() => {
    if (responses.length === 0) throw new Error("Unexpected synthetic preflight query");
    return [{ result: responses.shift() }];
  });
  let validationPageLowerBytes: number;
  try {
    const context: CatalogueValidationContextV2 = {
      schemaVersion: 2,
      kind: "catalogue-validation-context-v2",
      batchId,
      contextSha256: HASH,
      admissionSha256: HASH,
      maximumValidationEvidenceBytes: String(512 * 1024 ** 2),
      validatorDatabasePrincipal: principal,
      stagingSealSha256: HASH,
      generation: "1",
      baselineReleaseId: null,
      policyDocument: canonicalJson(POLICY),
      phase: "observing",
      nextSequence: "0",
      pageCount: "0",
      stagedCount: String(recordCount),
      lastPageReceiptSha256: HASH,
      validationCommitmentSha256: catalogueFramedSha256V2("validation-start", [batchId, HASH]),
      semanticCommitmentSha256: catalogueFramedSha256V2("semantic-start", [batchId, HASH]),
    };
    const request = await prepareCatalogueValidationPageV2(offline, context);
    if (responses.length !== 0 || request.endSequence !== "64")
      throw new Error("Synthetic validation preflight did not prepare its representative page");
    validationPageLowerBytes = 3 * request.requestByteSize + 8192 * 64 + 32768;
  } finally {
    await offline.destroy();
  }
  const stageLowerBytes = stagePageLowerBytes * (recordCount / 250);
  const validationLowerBytes = validationPageLowerBytes * Math.floor(recordCount / 64);
  // Deliberately omit the partial validation page and all admission, seal,
  // report, terminal and approval charges: this is a necessary LOWER bound.
  const minimumIntermediateBytes = stageLowerBytes + validationLowerBytes;
  if (maxIntermediateBytes < minimumIntermediateBytes)
    throw new Error(
      `Synthetic ${recordCount}-record admission ${maxIntermediateBytes} cannot cover ` +
        `its stage/validation lower bound ${minimumIntermediateBytes}`,
    );
  return { maxIntermediateBytes, stageLowerBytes, validationLowerBytes, minimumIntermediateBytes };
}

describe("synthetic paged admission capacity preflight", () => {
  it("rejects the original 25000-record allowance using real stage and validation serializers", async () => {
    await expect(syntheticAdmissionCapacity(25000, 2 * 1024 ** 3)).rejects.toThrow(
      "cannot cover its stage/validation lower bound",
    );
    const smaller = await syntheticAdmissionCapacity(12500);
    const larger = await syntheticAdmissionCapacity(25000);
    expect(larger.minimumIntermediateBytes).toBeGreaterThan(2 * 1024 ** 3);
    expect(smaller.minimumIntermediateBytes).toBeLessThan(smaller.maxIntermediateBytes);
    expect(larger.minimumIntermediateBytes).toBeLessThan(larger.maxIntermediateBytes);
    expect(larger.stageLowerBytes).toBe(2 * smaller.stageLowerBytes);
    expect(larger.maxIntermediateBytes).toBe(2 * smaller.maxIntermediateBytes);
    console.info(
      JSON.stringify({ kind: "synthetic-admission-necessary-lower-bound", smaller, larger }),
    );
  });
});

describe("paged restore primary-key inventory", () => {
  it.each([
    ["raw name-array string", "{id}"],
    ["missing array", undefined],
    ["null array", null],
    ["empty array", []],
    ["over-limit array", Array.from({ length: 17 }, (_, index) => `key_${index}`)],
    ["null column", [null]],
    ["non-string column", [42]],
    ["nested array", [["id"]]],
    ["duplicate column", ["id", "id"]],
    ["empty column", [""]],
    ["NUL column", ["id\0bad"]],
    ["overlong UTF-8 column", ["é".repeat(32)]],
  ] as const)("rejects malformed primary-key metadata: %s", async (_label, columns) => {
    const database = restoreInventoryDatabase(() =>
      Array.from({ length: 10 }, (_, index) => ({
        table_name: `fixture_${index}`,
        primary_columns: columns,
      })),
    );
    try {
      await expect(readPagedRestoreTableInventory(database)).rejects.toThrow(
        "bounded primary-key ordering",
      );
    } finally {
      await database.destroy();
    }
  });

  it.each(["", "table\0bad", "é".repeat(32)])(
    "rejects invalid table identifier %j",
    async (name) => {
      const database = restoreInventoryDatabase(() =>
        Array.from({ length: 10 }, () => ({
          table_name: name,
          primary_columns: ["id"],
        })),
      );
      try {
        await expect(readPagedRestoreTableInventory(database)).rejects.toThrow(
          "invalid identifier",
        );
      } finally {
        await database.destroy();
      }
    },
  );

  it.each([9, 251])("preserves the table inventory bound for %s rows", async (count) => {
    const database = restoreInventoryDatabase(() =>
      Array.from({ length: count }, (_, index) => ({
        table_name: `fixture_${index}`,
        primary_columns: ["id"],
      })),
    );
    try {
      await expect(readPagedRestoreTableInventory(database)).rejects.toThrow(
        "Unexpected restore table inventory",
      );
    } finally {
      await database.destroy();
    }
  });

  it("preserves legal quoted identifiers and the maximum primary-key width without sorting", async () => {
    const columns = [
      'quoted"column',
      ...Array.from({ length: 15 }, (_, index) => `key_${15 - index}`),
    ];
    const database = restoreInventoryDatabase(() =>
      Array.from({ length: 250 }, (_, index) => ({
        table_name: `quoted"table_${index}`,
        primary_columns: columns,
      })),
    );
    try {
      const tables = await readPagedRestoreTableInventory(database);
      expect(tables).toHaveLength(250);
      expect(tables[0]).toEqual({ table_name: 'quoted"table_0', primary_columns: columns });
    } finally {
      await database.destroy();
    }
  });

  it("reads a driver-decoded text array and preserves composite primary-key order", async () => {
    const encoded = "{z_second,a_first}";
    // The runtime deliberately supports unknown OIDs via its string fallback;
    // pg-types' enum declaration omits the unregistered name[] OID under test.
    const parserForOid = postgresTypes.getTypeParser as (
      oid: number,
      format: "text",
    ) => (value: string) => unknown;
    expect(parserForOid(1003, "text")(encoded)).toBe(encoded);
    let captured = "";
    const database = restoreInventoryDatabase((query) => {
      captured = query.sql;
      const oid = /array\(select a\.attname::text/u.test(query.sql) ? 1009 : 1003;
      return Array.from({ length: 10 }, (_, index) => ({
        table_name: `fixture_${index}`,
        primary_columns: parserForOid(oid, "text")(encoded),
      }));
    });
    try {
      const tables = await readPagedRestoreTableInventory(database);
      expect(tables).toHaveLength(10);
      expect(tables[0]?.primary_columns).toEqual(["z_second", "a_first"]);
      expect(captured).toContain("order by k.position");
    } finally {
      await database.destroy();
    }
  });
});

describe("paged preparation integration opt-in", () => {
  it.each(["rejected", "accepted", "unrelated-error"] as const)(
    "continues after expected client rejection and requires the independent server guard: %s",
    async (serverResult) => {
      const calls: string[] = [];
      const probe = expectIndependentValidationSemanticRejections(
        () => {
          calls.push("client-parser");
          throw new Error("V2 retained request differs from independent client semantics");
        },
        async () => {
          calls.push("restricted-server-submit");
          if (serverResult === "accepted") return {};
          throw Object.assign(
            new Error(
              serverResult === "rejected"
                ? "V2 SQL nutrition, source identity or barcode semantics disagree"
                : "unrelated SQL failure",
            ),
            { code: serverResult === "rejected" ? "55000" : "42501" },
          );
        },
      );
      if (serverResult === "rejected") await expect(probe).resolves.toBeUndefined();
      else await expect(probe).rejects.toThrow();
      expect(calls).toEqual(["client-parser", "restricted-server-submit"]);
    },
  );
  it.each(["baseline-fixture", "candidate-fixture"])(
    "binds the synthetic %s evidence URI to its digest without object storage I/O",
    (releaseKey) => {
      const stage = stageIdentity(releaseKey, HASH);
      const uri = new URL(stage.evidenceBundleUri);
      expect(stage.releaseClass).toBe("live-reviewed");
      expect(uri.protocol).toBe("s3:");
      expect(uri.hostname).toBe("nourishing-test-evidence");
      expect(uri.pathname).toBe(
        `/adr0104/sha256/${stage.evidenceBundleSha256}/${releaseKey}/bundle.json`,
      );
      expect(uri.search + uri.hash).toBe("");
      expect(Buffer.byteLength(stage.evidenceBundleUri)).toBeLessThanOrEqual(2048);
    },
  );
  it.each(["complete", "conservation", "metrics"] as const)(
    "checks the actual baseline fixture through production validation with %s inspection",
    async (inspectionCase) => {
      const fixture = baselineValidationObservation();
      const inspection = fixture.observation.parserReport.report.inspection as {
        [key: string]: JsonValue;
      };
      if (inspectionCase !== "complete") delete inspection[inspectionCase];
      fixture.observation.parserReport.reportSha256 = sha256CanonicalJson(
        fixture.observation.parserReport.report,
      );
      const responses: unknown[] = [
        {
          databasePrincipal: "validate_fixture",
          effectivePrincipal: "validate_fixture",
          canLogin: true,
          privileged: false,
          ownerMember: false,
          capabilities: ["nutrition_catalogue_validate"],
        },
        { schemaVersion: 1, observationSha256: HASH, observation: fixture.observation },
      ];
      class Driver extends DummyDriver {
        override async acquireConnection(): Promise<DatabaseConnection> {
          return {
            async executeQuery<R>(_query: CompiledQuery): Promise<QueryResult<R>> {
              if (!responses.length) throw new Error("Unexpected baseline fixture database call");
              return { rows: [{ result: responses.shift() }] as R[] };
            },
            streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
              throw new Error("Unexpected baseline fixture database stream");
            },
          };
        }
      }
      const database = new Kysely<Database>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new Driver(),
          createIntrospector: (db) => new PostgresIntrospector(db),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      });
      try {
        const prepared = prepareCatalogueValidation(database, fixture.input);
        if (inspectionCase !== "complete") {
          await expect(prepared).rejects.toThrow("Expected validation object");
        } else {
          const request = await prepared;
          const digest = JSON.parse(JSON.parse(request.validationDocument).digestDocument);
          expect(digest.records).toHaveLength(1);
          expect(digest.records[0]).toMatchObject({
            status: "valid",
            nutrientInputCount: 1,
            nutrientMaterializableCount: 1,
            portionInputCount: 0,
          });
          expect(digest.parserEvidence).toMatchObject({
            sourceRecordCount: 1,
            emittedRecordCount: 1,
            sourceNutrientCount: 1,
            emittedNutrientCount: 1,
            sourcePortionCount: 0,
          });
        }
        expect(responses).toHaveLength(0);
      } finally {
        await database.destroy();
      }
    },
  );
  it.each(["operation", "cleanup", "both"])(
    "does not publish restore success after %s failure",
    async (failure) => {
      const events: string[] = [];
      const operationError = new Error("synthetic restore failed"),
        cleanupError = new Error("synthetic drop failed");
      let caught: unknown;
      try {
        await runPagedRestoreProofAfterCleanup(
          async () => {
            events.push("restore");
            if (failure !== "cleanup") throw operationError;
            return { sourceAuthoritySha256: HASH, restoredAuthoritySha256: HASH };
          },
          async () => {
            events.push("cleanup");
            if (failure !== "operation") throw cleanupError;
          },
          async () => {
            events.push("publish-success");
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([
        ...(failure !== "cleanup" ? [operationError] : []),
        ...(failure !== "operation" ? [cleanupError] : []),
      ]);
      expect(events).toEqual(["restore", "cleanup"]);
    },
  );
  it("publishes restore proof only after successful owned cleanup", async () => {
    const events: string[] = [],
      proof = { sourceAuthoritySha256: HASH, restoredAuthoritySha256: HASH };
    expect(
      await runPagedRestoreProofAfterCleanup(
        async () => {
          events.push("restore");
          return proof;
        },
        async () => {
          events.push("cleanup");
        },
        async (completed) => {
          expect(completed).toBe(proof);
          events.push("publish-success");
        },
      ),
    ).toBe(proof);
    expect(events).toEqual(["restore", "cleanup", "publish-success"]);
  });
  it("sanitizes malformed sensitive URL errors before exposing diagnostics", async () => {
    const secret = "synthetic-do-not-log-password";
    const url = `postgresql://fixture:${secret}@[malformed/postgres`;
    const failures: unknown[] = [];
    try {
      pagedPreparationTestConfiguration(url, "12500");
    } catch (error) {
      failures.push(error);
    }
    try {
      await rehearsePagedCatalogueLogicalRestore({
        admin: {} as Client,
        source: {} as Client,
        sourceDatabaseUrl: url,
        container: "nourishing-adr0104-fixture",
        evidenceDirectory: "/unused",
      });
    } catch (error) {
      failures.push(error);
    }
    expect(failures).toHaveLength(2);
    for (const error of failures) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("input");
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
  it("accepts only the fixed verifier owner setting and adds noninteractive psql flags", () => {
    const command = [
      "exec",
      "nourishing-adr0104-fixture",
      "env",
      "PGOPTIONS=-c nutrition.expected_restore_owner=postgres",
      "psql",
      "--dbname",
      "paged_catalogue_0123456789abcdef",
    ];
    expect(
      validatePagedFingerprintCommand("docker", command, "nourishing-adr0104-fixture", "postgres"),
    ).toEqual([
      ...command.slice(0, 5),
      "-X",
      "--no-password",
      "--set",
      "ON_ERROR_STOP=1",
      ...command.slice(5),
    ]);
    expect(() =>
      validatePagedFingerprintCommand(
        "docker",
        [...command.slice(0, 3), "PGPASSWORD=secret", ...command.slice(4)],
        "nourishing-adr0104-fixture",
        "postgres",
      ),
    ).toThrow();
    expect(() =>
      validatePagedFingerprintCommand("docker", command, "nourishing-adr0104-other", "postgres"),
    ).toThrow();
    expect(() =>
      validatePagedFingerprintCommand("sh", command, "nourishing-adr0104-fixture", "postgres"),
    ).toThrow();
  });
  it.each([undefined, "postgres", "nourishing-adr0103-old", "nourishing-adr0104-bad;command"])(
    "rejects unapproved restore container %s",
    (container) => {
      expect(() =>
        validatePagedRestoreFixtureTarget(container, "paged_catalogue_0123456789abcdef"),
      ).toThrow();
    },
  );
  it("rejects non-fixture restore databases before subprocess use", () => {
    expect(() =>
      validatePagedRestoreFixtureTarget("nourishing-adr0104-fixture", "postgres"),
    ).toThrow();
    expect(
      validatePagedRestoreFixtureTarget(
        "nourishing-adr0104-fixture",
        "paged_catalogue_0123456789abcdef",
      ),
    ).toBe("nourishing-adr0104-fixture");
  });
  it.each([
    "https://127.0.0.1/x",
    "postgres://u:p@remote.invalid/postgres",
    "postgres://u@127.0.0.1/postgres",
    "postgres://u:p@127.0.0.1/postgres?options=unsafe",
  ])("rejects unsafe service target %s", (url) => {
    expect(() => pagedPreparationTestConfiguration(url, "12500")).toThrow();
  });
  it.each([undefined, "1", "10000", "25001"])("rejects unapproved workload %s", (count) => {
    expect(() =>
      pagedPreparationTestConfiguration("postgres://u:p@127.0.0.1/postgres", count),
    ).toThrow();
  });
  it("admits only explicit loopback and selected synthetic size", () => {
    expect(
      pagedPreparationTestConfiguration("postgres://u:p@127.0.0.1/postgres", "12500").recordCount,
    ).toBe(12500);
  });
});

databaseDescribe("paged catalogue preparation PostgreSQL integration", () => {
  it(
    "prepares one admitted large batch through independent validation and three reviewers without activation",
    async () => {
      if (!ADMIN) throw new Error("Dedicated administrator URL required");
      const configuration = pagedPreparationTestConfiguration(
        ADMIN,
        process.env.CATALOGUE_PAGED_TEST_RECORDS,
      );
      // Reject a known-impossible fixture allowance before creating any real
      // database client. Full service and physical-resource gates remain required.
      const fixtureCapacity = await syntheticAdmissionCapacity(configuration.recordCount);
      const token = randomBytes(8).toString("hex"),
        databaseName = `paged_catalogue_${token}`;
      const container = validatePagedRestoreFixtureTarget(
        process.env.CATALOGUE_PAGED_TEST_CONTAINER,
        databaseName,
      );
      const roleSpecs = [
        { key: "stage", capabilities: ["nutrition_catalogue_stage"] },
        { key: "validate", capabilities: ["nutrition_catalogue_validate"] },
        { key: "data", capabilities: ["nutrition_catalogue_approve_data"] },
        { key: "quality", capabilities: ["nutrition_catalogue_approve_quality"] },
        { key: "rights", capabilities: ["nutrition_catalogue_approve_rights"] },
        { key: "promote", capabilities: ["nutrition_catalogue_promote_activate"] },
        { key: "wrong", capabilities: [] },
        {
          key: "multi",
          capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_validate"],
        },
      ].map((role) => ({
        ...role,
        name: `paged_${role.key}_${token}`,
        password: randomBytes(24).toString("hex"),
      }));
      const admin = createDatabase({
        connectionString: configuration.url.toString(),
        maxConnections: 1,
        statementTimeoutMs: 30_000,
      });
      const clients = new Map<string, Client>();
      const createdRoles: string[] = [];
      let owner: Client | undefined;
      let createdDatabase = false;
      let scratch: string | undefined;
      let failure: unknown;
      let preparationMetrics: PreparationResourceMetrics | undefined;
      const cleanupErrors: unknown[] = [];
      const started = performance.now();
      const initialMemory = process.memoryUsage();
      const initialRss = initialMemory.rss;
      let maximumRss = initialRss;
      const memorySample = (memory = process.memoryUsage()): MemorySample => {
        return {
          elapsedMs: Math.ceil(performance.now() - started),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          arrayBufferBytes: memory.arrayBuffers,
          processHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
        };
      };
      const pairSample = (sample: MemorySample) =>
        pairMemorySnapshot(sample, getHeapStatistics(), getHeapSpaceStatistics());
      // This peak pairs observed RSS samples in the existing interval; it is not
      // the kernel lifetime maximum, which includes setup and between-sample peaks.
      let peakObservedRssSnapshot = pairSample(memorySample(initialMemory));
      const sample = () => {
        const observed = memorySample();
        peakObservedRssSnapshot = replacePairedRssPeak(
          peakObservedRssSnapshot,
          observed,
          pairSample,
        );
        maximumRss = Math.max(maximumRss, observed.rssBytes);
      };
      const phaseMemory: Array<PairedMemorySnapshot & { phase: string }> = [];
      const samplePhase = (phase: string) => {
        sample();
        phaseMemory.push({ phase, ...pairSample(memorySample()) });
      };
      type ReconciliationInvocation = "altered" | "interrupted" | "resumed";
      // Fixed six-span diagnostic surface. Samples replace numeric maxima;
      // no request, report page, or per-page history is retained here.
      const reconciliationMemory: Record<
        ReconciliationInvocation,
        { retainedJournal: MemorySpan | null; report: MemorySpan | null }
      > = {
        altered: { retainedJournal: null, report: null },
        interrupted: { retainedJournal: null, report: null },
        resumed: { retainedJournal: null, report: null },
      };
      let activeMemorySpan: MemorySpan | null = null;
      const sampleActiveMemory = () => {
        if (activeMemorySpan) recordMemorySample(activeMemorySpan, memorySample(), pairSample);
      };
      const beginMemorySpan = (
        invocation: ReconciliationInvocation,
        phase: "retainedJournal" | "report",
      ) => {
        const span = newMemorySpan(pairSample(memorySample()));
        reconciliationMemory[invocation][phase] = span;
        activeMemorySpan = span;
        return span;
      };
      const finishMemorySpan = (span: MemorySpan | null) => {
        if (!span || span.end) return;
        const end = pairSample(memorySample());
        recordMemorySample(span, end, () => end);
        span.end = end;
        if (activeMemorySpan === span) activeMemorySpan = null;
      };
      const observeReportPage = (invocation: ReconciliationInvocation) => {
        const span = reconciliationMemory[invocation].report;
        if (span) {
          span.pagesObserved += 1;
          recordMemorySample(span, memorySample(), pairSample);
        }
      };
      const sampler = setInterval(() => {
        sample();
        sampleActiveMemory();
      }, 100);
      const workloadRoot = process.env.CATALOGUE_PAGED_TEST_EVIDENCE_DIRECTORY;
      try {
        expect(
          (
            await sql<{
              exists: boolean;
            }>`select exists(select 1 from pg_catalog.pg_database where datname=${databaseName}) as exists`.execute(
              admin,
            )
          ).rows[0]?.exists,
        ).toBe(false);
        for (const role of roleSpecs)
          expect(
            (
              await sql<{
                exists: boolean;
              }>`select exists(select 1 from pg_catalog.pg_roles where rolname=${role.name}) as exists`.execute(
                admin,
              )
            ).rows[0]?.exists,
          ).toBe(false);
        await sql
          .raw(`create database ${identifier(databaseName)} template template0 encoding 'UTF8'`)
          .execute(admin);
        createdDatabase = true;
        const ownerUrl = new URL(configuration.url);
        ownerUrl.pathname = `/${databaseName}`;
        owner = createDatabase({
          connectionString: ownerUrl.toString(),
          maxConnections: 1,
          statementTimeoutMs: 30_000,
        });
        await runMigrations(owner);
        scratch = await mkdtemp(join(workloadRoot ?? tmpdir(), `paged-evidence-${token}-`));
        await mkdir(join(scratch, "report"), { mode: 0o700 });
        // Check fixed schema authority before creating fixture capability logins or
        // allocating the scale workload. The post-workload restore check remains.
        const preflight = await collectPagedCatalogueSourceAuthority({
          source: owner,
          sourceDatabaseUrl: ownerUrl.toString(),
          container,
          evidenceDirectory: scratch,
        });
        await durableJson(join(scratch, "source-authority-preflight.json"), {
          kind: "fixed-source-authority-before-synthetic-workload",
          sourceAuthoritySha256: preflight.sourceAuthority.sha256,
          workloadExecuted: false,
        });
        samplePhase("migrations-and-authority");
        const vectors = [
          {
            domain: "empty",
            fields: [],
            hash: "12dd818858742f5569d674d580a7c991593f486e9bec55b95b62c8e2b77beb6a",
          },
          {
            domain: "record",
            fields: ["0", "USDA_FDC:1", "a".repeat(64)],
            hash: "632e236a80f0b19343c1c7982925bb0a124b3700af7ac5654760310c3cdd0159",
          },
          {
            domain: "unicode",
            fields: ["é", "𐐀", "a:b", "line\nnext"],
            hash: "1d3589e459b2708f0e3692093a9fd7ef4266d1293b79c32fba6a2980cd8ed287",
          },
          {
            domain: "ambiguity",
            fields: ["ab", "c"],
            hash: "df3ab98a4040aef1b5e290692ce6d5434831d920e13eee3fc331a6c2869db7fb",
          },
          {
            domain: "ambiguity",
            fields: ["a", "bc"],
            hash: "b878cb1a7e391504d0a1aaceb148f77a5bbc4472b35c972a2a56534a3c210e57",
          },
        ];
        for (const vector of vectors) {
          expect(catalogueFramedSha256V2(vector.domain, vector.fields)).toBe(vector.hash);
          const actual = await sql<{
            hash: string;
          }>`select catalogue_frame_sha256_v2(${vector.domain}::text,${vector.fields}::text[]) as hash`.execute(
            owner,
          );
          expect(actual.rows[0]?.hash).toBe(vector.hash);
        }
        await sql
          .raw(`revoke connect on database ${identifier(databaseName)} from public`)
          .execute(admin);
        const expires = new Date(Date.now() + 30 * 60_000).toISOString();
        for (const role of roleSpecs) {
          await sql
            .raw(
              `create role ${identifier(role.name)} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 2 password '${role.password}' valid until '${expires}'`,
            )
            .execute(admin);
          createdRoles.push(role.name);
          await sql
            .raw(
              `grant connect on database ${identifier(databaseName)} to ${identifier(role.name)}`,
            )
            .execute(admin);
          for (const capability of role.capabilities)
            await sql
              .raw(
                `grant ${identifier(capability)} to ${identifier(role.name)} with admin false, inherit true, set false`,
              )
              .execute(admin);
          const url = new URL(ownerUrl);
          url.username = role.name;
          url.password = role.password;
          const client = createDatabase({
            connectionString: url.toString(),
            maxConnections: 1,
            statementTimeoutMs: 30_000,
          });
          // Register before the first await so connection/setup failures remain owned.
          clients.set(role.key, client);
          await sql`set lock_timeout='2s'`.execute(client);
        }
        await registerFoodSourceFromReviewedManifest(owner, {
          code: "USDA_FDC",
          displayName: "Synthetic paged PostgreSQL fixture",
          kind: "government",
          homepageUrl: "https://example.invalid/paged-catalogue",
          licenseExpression: "CC0-1.0",
          licenseUrl: "https://example.invalid/synthetic-rights",
          attributionRequired: true,
          attributionText: "Synthetic non-production rehearsal",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          rightsReviewStatus: "approved",
          rightsReviewedAt: new Date(),
          rightsReviewedBy: "fixture:paged:rights",
        });
        await registerSourceNutrientMappings(owner, {
          sourceCode: "USDA_FDC",
          reviewedAt: new Date(),
          reviewedBy: "fixture:paged:mapping",
          mappings: [MAPPING],
        });
        const mappingSha = await getSourceNutrientMappingDigest(owner, "USDA_FDC");
        const actor = (key: string) => required(roleSpecs.find((role) => role.key === key)).name;
        const client = (key: string) => required(clients.get(key));
        const baseline = await createBaseline({ owner, client, actor, mappingSha, token });
        samplePhase("baseline");
        const releaseKey = `synthetic-paged-${token}`;
        const stageInput = stageIdentity(releaseKey, mappingSha);
        const stageDocument = encodeCataloguePreparationStageIdentityV2(stageInput);
        const count = configuration.recordCount;
        const admissionDocument = encodeCataloguePreparationAdmissionV2({
          stageDocument,
          manifestSha256: HASH,
          exportSha256: HASH,
          exportBytes: count * 8192,
          stagePrincipal: actor("stage"),
          maxRecords: count,
          maxPayloadTextBytes: count * 16384,
          maxIntermediateBytes: fixtureCapacity.maxIntermediateBytes,
          maxValidationEvidenceBytes: 512 * 1024 ** 2,
          maxReconciliationEvidenceBytes: 512 * 1024 ** 2,
          maxBaselineRecords: 1,
          maxBaselinePayloadBytes: 1024 * 1024,
          reviewReference: `urn:test:paged:admission:${token}`,
        });
        for (const rejected of [owner, client("stage"), client("wrong"), client("multi")])
          await expect(admitCataloguePreparationV2(rejected, admissionDocument)).rejects.toThrow();
        const admission = await admitCataloguePreparationV2(client("quality"), admissionDocument);
        expect(await admitCataloguePreparationV2(client("quality"), admissionDocument)).toEqual(
          admission,
        );
        const batch = await beginCataloguePreparationV2(client("stage"), {
          admissionSha256: admission.admissionSha256,
          stageDocument,
        });
        const payloadHash = createHash("sha256");
        let previous: string | null = null;
        let pageCount = 0;
        let payloadBytes = "0";
        let recordCommitment = batch.recordCommitmentSha256;
        let lastStageDocument = "";
        let stageLockContention:
          | {
              sqlstate: "55P03";
              elapsedMs: number;
              configuredLockTimeout: string;
              configuredStatementTimeout: string;
              blockerStatementTimeout: string;
              blockerIdleTransactionTimeout: string;
              progressUnchanged: true;
              exactRetrySucceeded: boolean;
            }
          | undefined;
        const progressOwner = owner;
        const stageProgress = async () =>
          required(
            (
              await sql<{ snapshot: JsonObject }>`
          select pg_catalog.jsonb_build_object(
            'batchStagedCount', (select staged_count::text from food_import_batch where id=${batch.batchId}::uuid),
            'preparation', (select pg_catalog.to_jsonb(p) from catalogue_preparation_v2 p where batch_id=${batch.batchId}::uuid),
            'budget', (select pg_catalog.to_jsonb(u) from catalogue_preparation_budget_usage_v2 u where admission_sha256=${admission.admissionSha256}),
            'sourceRecordCount', (select count(*)::text from food_import_record where batch_id=${batch.batchId}::uuid),
            'payloadRecordCount', (select count(*)::text from catalogue_preparation_record_v2 where batch_id=${batch.batchId}::uuid),
            'pageReceiptCount', (select count(*)::text from catalogue_preparation_stage_page_v2 where batch_id=${batch.batchId}::uuid)
          ) as snapshot
        `.execute(progressOwner)
            ).rows[0],
          ).snapshot;
        for (let first = 0; first < count; first += 250) {
          const records: StagedCatalogueRecordInput[] = [];
          for (let sequence = first; sequence < Math.min(first + 250, count); sequence++) {
            const record = syntheticRecord(releaseKey, sequence, 6144);
            records.push(record);
            payloadHash.update(`${canonicalJson(record.canonicalPayload)}\n`);
          }
          const document = encodeCataloguePreparationStagePageV2({
            batchId: batch.batchId,
            admissionSha256: admission.admissionSha256,
            parserVersion: stageInput.parserVersion,
            pageNumber: pageCount,
            firstSequence: first,
            previousReceiptSha256: previous,
            records,
          });
          if (first === 0) {
            const beforeContention = await stageProgress();
            const timeouts = required(
              (
                await sql<{
                  lock_timeout: string;
                  statement_timeout: string;
                }>`select current_setting('lock_timeout') as lock_timeout,
              current_setting('statement_timeout') as statement_timeout`.execute(client("stage"))
              ).rows[0],
            );
            expect(timeouts).toEqual({ lock_timeout: "2s", statement_timeout: "30s" });
            const blocker = createDatabase({
              connectionString: ownerUrl.toString(),
              maxConnections: 1,
              statementTimeoutMs: 10_000,
            });
            // Track ownership before the first connection or transaction can fail.
            clients.set("stage-lock-blocker", blocker);
            try {
              stageLockContention = await blocker.transaction().execute(async (transaction) => {
                await sql`set local lock_timeout='2s'`.execute(transaction);
                await sql`set local idle_in_transaction_session_timeout='10s'`.execute(transaction);
                const blockerTimeouts = required(
                  (
                    await sql<{
                      statement_timeout: string;
                      idle_timeout: string;
                    }>`select current_setting('statement_timeout') as statement_timeout,
                  current_setting('idle_in_transaction_session_timeout') as idle_timeout`.execute(
                      transaction,
                    )
                  ).rows[0],
                );
                expect(blockerTimeouts).toEqual({ statement_timeout: "10s", idle_timeout: "10s" });
                // This is the first FOR UPDATE acquired by the actual V2 page function.
                const locked = await sql<{ id: string }>`select id::text from food_import_batch
                  where id=${batch.batchId}::uuid for update`.execute(transaction);
                expect(locked.rows).toEqual([{ id: batch.batchId }]);
                const contentionStarted = performance.now();
                let rejected: unknown;
                try {
                  await submitCataloguePreparationStagePageV2(client("stage"), {
                    batchId: batch.batchId,
                    document,
                  });
                } catch (error) {
                  rejected = error;
                }
                const elapsedMs = Math.ceil(performance.now() - contentionStarted);
                expect(rejected).toMatchObject({ code: "55P03" });
                expect(elapsedMs).toBeGreaterThanOrEqual(1000);
                expect(elapsedMs).toBeLessThanOrEqual(10000);
                // Normal reads on a third owned connection observe committed state
                // while the blocker still holds its transaction lock.
                expect(await stageProgress()).toEqual(beforeContention);
                return {
                  sqlstate: "55P03" as const,
                  elapsedMs,
                  configuredLockTimeout: timeouts.lock_timeout,
                  configuredStatementTimeout: timeouts.statement_timeout,
                  blockerStatementTimeout: blockerTimeouts.statement_timeout,
                  blockerIdleTransactionTimeout: blockerTimeouts.idle_timeout,
                  progressUnchanged: true as const,
                  exactRetrySucceeded: false,
                };
              });
            } finally {
              await blocker.destroy();
              clients.delete("stage-lock-blocker");
            }
          }
          const receipt = await submitCataloguePreparationStagePageV2(client("stage"), {
            batchId: batch.batchId,
            document,
          });
          if (first === 0) {
            expect(receipt.firstSequence).toBe("0");
            expect(receipt.nextSequence).toBe("250");
            expect(receipt.requestSha256).toBe(sha(document));
            required(stageLockContention).exactRetrySucceeded = true;
          }
          if (first === 0)
            expect(
              await submitCataloguePreparationStagePageV2(client("stage"), {
                batchId: batch.batchId,
                document,
              }),
            ).toEqual(receipt);
          previous = receipt.receiptSha256;
          payloadBytes = receipt.totalPayloadTextBytes;
          recordCommitment = receipt.recordCommitmentSha256;
          lastStageDocument = document;
          pageCount++;
          sample();
        }
        samplePhase("staging");
        const beforeBudget = await sql<{
          state: JsonObject;
        }>`select to_jsonb(u) as state from catalogue_preparation_budget_usage_v2 u where admission_sha256=${admission.admissionSha256}`.execute(
          owner,
        );
        const excessive = encodeCataloguePreparationStagePageV2({
          batchId: batch.batchId,
          admissionSha256: admission.admissionSha256,
          parserVersion: stageInput.parserVersion,
          pageNumber: pageCount,
          firstSequence: count,
          previousReceiptSha256: previous,
          records: [syntheticRecord(releaseKey, count, 6144)],
        });
        await expect(
          submitCataloguePreparationStagePageV2(client("stage"), {
            batchId: batch.batchId,
            document: excessive,
          }),
        ).rejects.toThrow();
        expect(
          (
            await sql<{
              state: JsonObject;
            }>`select to_jsonb(u) as state from catalogue_preparation_budget_usage_v2 u where admission_sha256=${admission.admissionSha256}`.execute(
              owner,
            )
          ).rows,
        ).toEqual(beforeBudget.rows);
        expect(
          (
            await submitCataloguePreparationStagePageV2(client("stage"), {
              batchId: batch.batchId,
              document: lastStageDocument,
            })
          ).receiptSha256,
        ).toBe(previous);
        expect(BigInt(payloadBytes)).toBeGreaterThan(64n * 1024n * 1024n);
        expect(count).toBeGreaterThan(10000);
        const actualBytes = await sql<{
          bytes: string;
          records: string;
        }>`select sum(octet_length(canonical_payload::text))::text as bytes,count(*)::text as records from food_import_record where batch_id=${batch.batchId}::uuid`.execute(
          owner,
        );
        expect(actualBytes.rows[0]).toEqual({ bytes: payloadBytes, records: String(count) });
        const parserInput = parserReport(
          batch.batchId,
          stageInput,
          count,
          payloadHash.digest("hex"),
          admission.admissionSha256,
        );
        const parserDocument = encodeCataloguePreparationParserReportV2(parserInput);
        const sealStart = await beginCataloguePreparationSealV2(client("stage"), {
          batchId: batch.batchId,
          document: parserDocument,
        });
        for (let pageNumber = 0; pageNumber < pageCount; pageNumber++) {
          const verified = await verifyCataloguePreparationSealPageV2(client("stage"), {
            batchId: batch.batchId,
            pageNumber,
          });
          if (pageNumber === pageCount - 1) {
            expect(verified.recordCommitmentSha256).toBe(recordCommitment);
            expect(verified.verifiedPayloadTextBytes).toBe(payloadBytes);
          }
        }
        const sealDocument = encodeCataloguePreparationSealTerminalV2({
          schemaVersion: 2,
          batchId: batch.batchId,
          admissionSha256: admission.admissionSha256,
          recordCount: String(count),
          payloadTextBytes: payloadBytes,
          recordCommitmentSha256: recordCommitment,
          stageReceiptSha256: previous,
          parserReportSha256: sealStart.parserReportSha256,
          sealRequestSha256: sealStart.sealRequestSha256,
        });
        const seal = await finishCataloguePreparationSealV2(client("stage"), {
          batchId: batch.batchId,
          document: sealDocument,
        });
        expect(
          await finishCataloguePreparationSealV2(client("stage"), {
            batchId: batch.batchId,
            document: sealDocument,
          }),
        ).toEqual(seal);
        for (const rejected of [owner, client("stage"), client("wrong"), client("multi")])
          await expect(
            beginCatalogueValidationV2(rejected, {
              batchId: batch.batchId,
              stagingSealSha256: seal.stagingSealSha256,
              policy: POLICY,
            }),
          ).rejects.toThrow();
        samplePhase("sealing");
        let context = await beginCatalogueValidationV2(client("validate"), {
          batchId: batch.batchId,
          stagingSealSha256: seal.stagingSealSha256,
          policy: POLICY,
        });
        const journalBinding = {
          batchId: context.batchId,
          validatorDatabasePrincipal: context.validatorDatabasePrincipal,
          stagingSealSha256: context.stagingSealSha256,
          contextSha256: context.contextSha256,
          admissionSha256: context.admissionSha256,
        };
        let journalHead = await createCatalogueValidationJournalV2(
          journalBinding,
          Number(context.maximumValidationEvidenceBytes),
          scratch,
        );
        while (context.nextSequence !== context.stagedCount) {
          const prepared = await prepareCatalogueValidationPageV2(client("validate"), context);
          if (context.pageCount === "0") {
            const wrong = JSON.parse(prepared.requestDocument) as {
              records: { validatedFoodDocument: string; validatedFoodSha256: string }[];
            };
            const first = required(wrong.records[0]);
            const food = JSON.parse(first.validatedFoodDocument) as {
              nutrients: { amount: string }[];
            };
            required(food.nutrients[0]).amount = "999";
            first.validatedFoodDocument = canonicalJson(food as unknown as JsonValue);
            first.validatedFoodSha256 = sha(first.validatedFoodDocument);
            const alteredDocument = canonicalJson(wrong as unknown as JsonValue);
            const validationProgress = async () =>
              required(
                (
                  await sql<{ snapshot: JsonObject }>`
              select pg_catalog.jsonb_build_object(
                'context', (select pg_catalog.to_jsonb(c) from catalogue_validation_context_v2 c where batch_id=${batch.batchId}::uuid),
                'recordCount', (select count(*)::text from catalogue_validation_record_v2 where batch_id=${batch.batchId}::uuid),
                'pageCount', (select count(*)::text from catalogue_validation_page_v2 where batch_id=${batch.batchId}::uuid)
              ) as snapshot
            `.execute(progressOwner)
                ).rows[0],
              ).snapshot;
            const beforeTampering = {
              preparation: await stageProgress(),
              validation: await validationProgress(),
            };
            expect(beforeTampering.validation).toMatchObject({ recordCount: "0", pageCount: "0" });
            // The strict client must reject the forged result before its submit API.
            // Exercise the independent SQL gate with the same raw bytes and actual
            // restricted validator login; never fabricate a Prepared request object.
            await expectIndependentValidationSemanticRejections(
              () => parsePreparedCatalogueValidationPageV2(alteredDocument),
              () =>
                sql`select public.catalogue_submit_validation_page_v2(
                ${batch.batchId}::uuid,${alteredDocument}::text) as result`.execute(
                  client("validate"),
                ),
            );
            expect({
              preparation: await stageProgress(),
              validation: await validationProgress(),
            }).toEqual(beforeTampering);
          }
          const pending = await retainCatalogueValidationRequestV2(
            journalHead,
            prepared.requestDocument,
            "page",
            scratch,
            canonicalJson(context as unknown as JsonValue),
          );
          const receipt = await submitCatalogueValidationPageV2(
            client("validate"),
            prepared,
            context,
          );
          if (context.pageCount === "0")
            expect(
              await submitCatalogueValidationPageV2(client("validate"), prepared, context),
            ).toEqual(receipt);
          journalHead = await acknowledgeCatalogueValidationPageV2(
            pending,
            receipt.receiptSha256,
            scratch,
            journalHead,
          );
          context = advanceCatalogueValidationContextV2(context, prepared, receipt);
          sample();
        }
        const terminalRequest = prepareCatalogueValidationTerminalV2(context);
        const pendingTerminal = await retainCatalogueValidationRequestV2(
          journalHead,
          terminalRequest.terminalDocument,
          "terminal",
          scratch,
          canonicalJson(context as unknown as JsonValue),
        );
        const validationTerminal = await submitCatalogueValidationTerminalV2(
          client("validate"),
          context,
          terminalRequest,
        );
        expect(
          await submitCatalogueValidationTerminalV2(client("validate"), context, terminalRequest),
        ).toEqual(validationTerminal);
        // Match the production cleanup boundary: publish completion only after
        // the submitting validator has closed. Failed cleanup leaves no terminal.
        await client("validate").destroy();
        clients.delete("validate");
        const journalTerminal = await finishCatalogueValidationJournalV2(
          pendingTerminal,
          validationTerminal.terminalSha256,
          canonicalJson(validationTerminal as unknown as JsonValue),
          scratch,
          journalHead,
        );
        expect(journalHead.nextPageNumber).toBe(Number(context.pageCount));
        const validationRole = required(roleSpecs.find((role) => role.key === "validate"));
        const validationUrl = new URL(ownerUrl);
        validationUrl.username = validationRole.name;
        validationUrl.password = validationRole.password;
        const reconciliationClient = createDatabase({
          connectionString: validationUrl.toString(),
          maxConnections: 1,
          statementTimeoutMs: 30_000,
        });
        // Own the replacement before connecting so failed setup remains in cleanup.
        clients.set("validate", reconciliationClient);
        await sql`set lock_timeout='2s'`.execute(reconciliationClient);
        const validatorIdentity = required(
          (
            await sql<{
              principal: string;
              statement_timeout: string;
              lock_timeout: string;
            }>`select session_user::text as principal,
            current_setting('statement_timeout') as statement_timeout,
            current_setting('lock_timeout') as lock_timeout`.execute(reconciliationClient)
          ).rows[0],
        );
        expect(validatorIdentity).toEqual({
          principal: actor("validate"),
          statement_timeout: "30s",
          lock_timeout: "2s",
        });
        samplePhase("validation");
        const retainedRoot = scratch;
        async function* pages(
          invocation: ReconciliationInvocation,
        ): AsyncIterable<RetainedCatalogueValidationPageV2> {
          const span = beginMemorySpan(invocation, "retainedJournal");
          let exhausted = false;
          try {
            for await (const page of readCatalogueValidationJournalV2(
              journalTerminal,
              {
                binding: journalBinding,
                validationTerminalSha256: validationTerminal.terminalSha256,
              },
              retainedRoot,
            )) {
              span.pagesObserved += 1;
              sampleActiveMemory();
              yield page;
              sampleActiveMemory();
            }
            exhausted = true;
          } finally {
            finishMemorySpan(span);
            // This starts before the report SQL call and its result parsing.
            // Early iterator closure after altered evidence starts no report span.
            if (exhausted) beginMemorySpan(invocation, "report");
          }
        }
        const reconciliationInput = {
          batchId: batch.batchId,
          validationTerminalSha256: validationTerminal.terminalSha256,
          expectedCurrentReleaseId: baseline.releaseId,
          principalId: actor("validate"),
        };
        async function* alteredPages(): AsyncIterable<RetainedCatalogueValidationPageV2> {
          for await (const page of pages("altered"))
            yield page.pageNumber === "0" ? { ...page, receiptSha256: "f".repeat(64) } : page;
        }
        await expect(
          reconcileCataloguePagedBatch(client("validate"), reconciliationInput, {
            validationPages: alteredPages(),
            consumePage: async () => {
              throw new Error("No report page expected for altered retention");
            },
          }).finally(() => finishMemorySpan(reconciliationMemory.altered.report)),
        ).rejects.toThrow();
        expect(
          (
            await sql<{
              count: string;
            }>`select count(*)::text as count from catalogue_reconciliation_v2 where batch_id=${batch.batchId}::uuid`.execute(
              owner,
            )
          ).rows[0]?.count,
        ).toBe("0");
        await expect(
          reconcileCataloguePagedBatch(client("validate"), reconciliationInput, {
            validationPages: pages("interrupted"),
            consumePage: async (page) => {
              observeReportPage("interrupted");
              await durableJson(join(retainedRoot, "report", `${page.pageNumber}.json`), page);
              throw new Error("Synthetic interruption after durable report page");
            },
          }).finally(() => finishMemorySpan(reconciliationMemory.interrupted.report)),
        ).rejects.toThrow("Synthetic interruption after durable report page");
        expect(
          (
            await sql<{
              page_count: string;
              terminal_sha256: string | null;
            }>`select page_count::text,terminal_sha256 from catalogue_reconciliation_v2 where batch_id=${batch.batchId}::uuid`.execute(
              owner,
            )
          ).rows[0],
        ).toEqual({ page_count: "1", terminal_sha256: null });
        let reportBytes = 0;
        let approvedBudget = 0;
        const report = await reconcileCataloguePagedBatch(
          client("validate"),
          {
            batchId: batch.batchId,
            validationTerminalSha256: validationTerminal.terminalSha256,
            expectedCurrentReleaseId: baseline.releaseId,
            principalId: actor("validate"),
          },
          {
            validationPages: pages("resumed"),
            admitEvidenceBudget: (bytes) => {
              approvedBudget = Number(bytes);
            },
            consumePage: async (page) => {
              observeReportPage("resumed");
              reportBytes += Buffer.byteLength(page.document);
              expect(reportBytes).toBeLessThanOrEqual(approvedBudget);
              const reportPath = join(retainedRoot, "report", `${page.pageNumber}.json`);
              if (page.pageNumber === "1") {
                expect(await readFile(reportPath, "utf8")).toBe(`${JSON.stringify(page)}\n`);
              } else await durableJson(reportPath, page);
              sample();
              sampleActiveMemory();
            },
          },
        ).finally(() => finishMemorySpan(reconciliationMemory.resumed.report));
        samplePhase("reconciliation");
        expect(report.promotionAvailable).toBe(false);
        expect(report.counts.candidateRecords).toBe(String(count));
        expect(report.counts.baselineRecords).toBe("1");
        expect(report.counts.unchanged).toBe("1");
        expect(report.counts.added).toBe(String(count - 1));
        expect(report.counts.changed).toBe("0");
        await durableJson(join(scratch, "report", "terminal.json"), report);
        // Owner runtime is not a substitute for authenticated preparation or review.
        await expect(
          sql`update catalogue_reconciliation_v2 set added_count=added_count+1 where batch_id=${batch.batchId}::uuid`.execute(
            owner,
          ),
        ).rejects.toThrow();
        await expect(
          sql`truncate catalogue_reconciliation_v2 cascade`.execute(owner),
        ).rejects.toThrow();
        await expect(
          sql`insert into catalogue_paged_approval_v2(batch_id,approval_role,database_principal,rights_manifest_sha256,
        validation_terminal_sha256,context_sha256,report_sha256,approval_reference) values(${batch.batchId}::uuid,'data','forged-owner',
        ${HASH},${validationTerminal.terminalSha256},${report.contextSha256},${report.reportSha256},'forged-owner')`.execute(
            owner,
          ),
        ).rejects.toThrow();
        for (const approvalRole of ["data", "quality", "rights"] as const) {
          const decision = {
            batchId: batch.batchId,
            approvalRole,
            principalId: actor(approvalRole),
            rightsManifestSha256: stageInput.rightsManifestSha256,
            validationTerminalSha256: validationTerminal.terminalSha256,
            reportSha256: report.reportSha256,
            contextSha256: report.contextSha256,
            approvalReference: `urn:test:paged:review:${token}:${approvalRole}`,
          };
          const page = await readCataloguePagedReconciliationPage(client(approvalRole), {
            batchId: batch.batchId,
            reportSha256: report.reportSha256,
            pageNumber: "1",
            approvalRole,
            principalId: actor(approvalRole),
          });
          expect(page.stream).toBe("metadata");
          for (const rejected of [owner, client("stage"), client("wrong"), client("multi")])
            await expect(submitCataloguePagedApproval(rejected, decision)).rejects.toThrow();
          expect(
            (await submitCataloguePagedApproval(client(approvalRole), decision)).wasAlreadyApproved,
          ).toBe(false);
          expect(
            (await submitCataloguePagedApproval(client(approvalRole), decision)).wasAlreadyApproved,
          ).toBe(true);
          await expect(
            submitCataloguePagedApproval(client(approvalRole), {
              ...decision,
              approvalReference: `${decision.approvalReference}:changed`,
            }),
          ).rejects.toThrow();
        }
        await expect(
          sql`select public.catalogue_promote_import_batch(${batch.batchId}::uuid,${actor("promote")}::text,'V2 must remain private')`.execute(
            client("promote"),
          ),
        ).rejects.toThrow();
        const state = await sql<{
          active_release_id: string;
          status: string;
          materialized_count: string;
        }>`select s.active_release_id::text,b.status,b.materialized_count::text
        from food_import_batch b join food_source s on s.id=b.food_source_id where b.id=${batch.batchId}::uuid`.execute(
          owner,
        );
        expect(state.rows[0]).toEqual({
          active_release_id: baseline.releaseId,
          status: "staging",
          materialized_count: "0",
        });
        // Normal reviewed mapping revisions move away and return to the same values.
        // The generation must still reject every old validation/report/reviewer use.
        const current = await sql<{
          id: string;
        }>`select current_revision_id::text as id from source_nutrient_map where source_nutrient_key='1003'`.execute(
          owner,
        );
        await supersedeSourceNutrientMapping(owner, {
          sourceCode: "USDA_FDC",
          expectedCurrentRevisionId: required(current.rows[0]).id,
          mapping: { ...MAPPING, conversionMultiplier: "2" },
          reviewedAt: new Date(),
          reviewedBy: "fixture:paged:mapping",
          changeReason: "Synthetic away transition",
        });
        const away = await sql<{
          id: string;
        }>`select current_revision_id::text as id from source_nutrient_map where source_nutrient_key='1003'`.execute(
          owner,
        );
        await supersedeSourceNutrientMapping(owner, {
          sourceCode: "USDA_FDC",
          expectedCurrentRevisionId: required(away.rows[0]).id,
          mapping: MAPPING,
          reviewedAt: new Date(),
          reviewedBy: "fixture:paged:mapping",
          changeReason: "Synthetic return transition",
        });
        await expect(
          readCataloguePagedReconciliationPage(client("data"), {
            batchId: batch.batchId,
            reportSha256: report.reportSha256,
            pageNumber: "1",
            approvalRole: "data",
            principalId: actor("data"),
          }),
        ).rejects.toThrow();
        sample();
        samplePhase("review-and-drift");
        const metrics = {
          kind: "synthetic-canonical-payload-postgres-resource-proof",
          recordCount: count,
          postgresPayloadTextBytes: payloadBytes,
          reportBytes,
          pageCount: report.pageCount,
          validationJournal: {
            header: journalHead.header,
            terminal: journalTerminal,
            pageCount: journalHead.nextPageNumber,
          },
          initialRssBytes: initialRss,
          peakObservedRssBytes: maximumRss,
          peakObservedRssSnapshot,
          // Linux maxRSS is KiB. This process high-water includes Vitest/setup;
          // the guarded launcher runs each selected workload in a fresh process.
          preparationMaxRssBytes: process.resourceUsage().maxRSS * 1024,
          preparationProcessId: process.pid,
          phaseMemory,
          reconciliationMemory,
          stageLockContention: required(stageLockContention),
          elapsedMs: Math.ceil(performance.now() - started),
          syntheticPaddingBytesPerRecord: 6144,
          liveCatalogueQualification: false,
        };
        // Preserve the preparation checkpoint even if restore later fails. The
        // launcher's resource-metrics.json is published after owned cleanup.
        preparationMetrics = metrics;
        await durableJson(join(scratch, "resource-preparation-memory.json"), metrics);
        // The fixed restore policy requires the closed capability-role surface.
        // Retain every principal in immutable rows, close only owned connections,
        // and revoke only this fixture's explicit memberships before fingerprinting.
        for (const runtime of clients.values()) await runtime.destroy();
        clients.clear();
        for (const role of roleSpecs)
          for (const capability of role.capabilities) {
            await sql
              .raw(`revoke ${identifier(capability)} from ${identifier(role.name)}`)
              .execute(admin);
          }
        const restore = await rehearsePagedCatalogueLogicalRestore({
          admin,
          source: owner,
          sourceDatabaseUrl: ownerUrl.toString(),
          container,
          evidenceDirectory: scratch,
        });
        expect(restore.sourceAuthoritySha256).toBe(restore.restoredAuthoritySha256);
        expect(
          restore.tables.some(
            (table) => table.table === "catalogue_paged_approval_v2" && table.count === "3",
          ),
        ).toBe(true);
        expect(
          restore.tables.some(
            (table) =>
              table.table === "catalogue_validation_record_v2" && table.count === String(count),
          ),
        ).toBe(true);
        samplePhase("restore");
      } catch (error) {
        failure = error;
      } finally {
        clearInterval(sampler);
        for (const client of clients.values())
          try {
            await client.destroy();
          } catch (error) {
            cleanupErrors.push(error);
          }
        if (owner)
          try {
            await owner.destroy();
          } catch (error) {
            cleanupErrors.push(error);
          }
        if (createdDatabase)
          try {
            await sql.raw(`drop database ${identifier(databaseName)}`).execute(admin);
          } catch (error) {
            cleanupErrors.push(error);
          }
        for (const role of createdRoles.reverse())
          try {
            await sql.raw(`drop role ${identifier(role)}`).execute(admin);
          } catch (error) {
            cleanupErrors.push(error);
          }
        try {
          await admin.destroy();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (preparationMetrics && scratch)
          try {
            samplePhase("owned-cleanup");
            const finalMetrics = finalizePreparationResourceMetrics(
              preparationMetrics,
              pairSample(memorySample()),
            );
            await durableJson(join(scratch, "resource-metrics.json"), finalMetrics);
            console.info(JSON.stringify(finalMetrics));
          } catch (error) {
            cleanupErrors.push(error);
          }
        // The guarded lifecycle may retain synthetic evidence under its owned proof
        // directory. Only this exact mkdtemp directory is removed for default runs.
        if (scratch && !workloadRoot)
          try {
            await rm(scratch, { recursive: true, force: false });
          } catch (error) {
            cleanupErrors.push(error);
          }
      }
      if (failure || cleanupErrors.length)
        throw new AggregateError(
          [...(failure ? [failure] : []), ...cleanupErrors],
          "Paged preparation rehearsal or owned cleanup failed",
        );
    },
    30 * 60_000,
  );
});

async function expectIndependentValidationSemanticRejections(
  parseAltered: () => unknown,
  submitAltered: () => Promise<unknown>,
) {
  expect(parseAltered).toThrow("V2 retained request differs from independent client semantics");
  await expect(submitAltered()).rejects.toMatchObject({
    code: "55000",
    message: "V2 SQL nutrition, source identity or barcode semantics disagree",
  });
}

function baselineValidationObservation() {
  const batchId = "12345678-1234-4234-8234-123456789abc";
  const mapping = {
    canonicalUnit: MAPPING.canonicalNutrient.unit,
    conversionMultiplier: "1.000000000000",
    nutrientCode: MAPPING.canonicalNutrient.code,
    nutrientDimension: MAPPING.canonicalNutrient.dimension,
    nutrientId: "1",
    nutrientName: MAPPING.canonicalNutrient.name,
    revisionId: "22345678-1234-4234-8234-123456789abc",
    sourceNutrientKey: MAPPING.sourceNutrientKey,
    sourceUnit: MAPPING.sourceUnit,
  };
  const mappingSha = nutrientMappingRevisionDigest([mapping]);
  const stage = stageIdentity("baseline-fixture", mappingSha);
  const record = syntheticRecord(stage.releaseKey, 0, 0);
  const { batchId: _batchId, ...report } = parserReport(
    batchId,
    stage,
    1,
    sha(`${canonicalJson(record.canonicalPayload)}\n`),
  );
  const { sourceCode, ...batch } = stage;
  return {
    input: {
      batchId,
      expectedStagingSealSha256: HASH,
      expectedNutrientMappingDigest: mappingSha,
      policy: POLICY,
    },
    observation: {
      schemaVersion: 1,
      sourceCode,
      batch: {
        ...batch,
        acquiredAt: new Date(stage.acquiredAt).toISOString(),
        evidenceValidUntil: new Date(stage.evidenceValidUntil).toISOString(),
        id: batchId,
        stagedCount: 1,
        stagedDatabasePrincipal: "stage_fixture",
        stagingSealSha256: HASH,
        stagingSealedAt: new Date().toISOString(),
        status: "staging",
      },
      forbiddenGtins: [],
      nutrientMappings: [mapping],
      parserReport: { ...report, reportSha256: sha256CanonicalJson(report.report) },
      records: [
        {
          ...record,
          validatedFoodContractVersion: null,
          validatedFoodDocument: null,
          validatedFoodSha256: null,
          validatedAt: null,
          validationIssues: [],
          validationStatus: "pending",
        },
      ],
      stageCheckpoint: { cursor: { nextOffset: 1 }, lastSequenceNumber: 0, processedCount: 1 },
    },
  };
}

async function durableJson(path: string, value: unknown) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error("Unsafe synthetic resource identifier");
  return `"${value}"`;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture value");
  return value;
}
