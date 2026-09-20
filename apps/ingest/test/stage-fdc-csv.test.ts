import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type JsonObject,
  type StagedCatalogueRecordInput,
  sha256CanonicalJson,
} from "@nutrition-tracker/db";
import { canonicalJson, type FoodSourceManifestV4 } from "@nutrition-tracker/ingestion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFdcCsvStageParserReport } from "../src/fdc-csv-stage.js";
import type { VerifiedFdcRecordExport } from "../src/fdc-record-reader.js";
import { runCommand } from "../src/run.js";
import {
  bindSyntheticReleaseEvidence,
  SYNTHETIC_EVIDENCE_EVALUATED_AT,
  writeCanonicalReleaseEvidence,
} from "./synthetic-release-evidence.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  create: vi.fn(),
  principal: vi.fn(),
  chunk: vi.fn(),
  seal: vi.fn(),
  database: { destroy: vi.fn() },
  openDatabase: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("Legacy owner/validation API must not run");
  }),
}));
vi.mock("../src/fdc-record-reader.js", () => ({ openVerifiedFdcRecordExport: mocks.open }));
vi.mock("@nutrition-tracker/db", async (original) => ({
  ...(await original<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: mocks.openDatabase,
  assertCatalogueStagePrincipal: mocks.principal,
  createOrResumeCatalogueStage: mocks.create,
  appendCatalogueStageChunk: mocks.chunk,
  sealCatalogueStageParserReport: mocks.seal,
  stageBatch: mocks.forbidden,
  stageBatchRecords: mocks.forbidden,
  saveBatchCheckpoint: mocks.forbidden,
  registerFoodSourceFromReviewedManifest: mocks.forbidden,
  getSourceNutrientMappingDigest: mocks.forbidden,
  recordBatchParserReportAndValidate: mocks.forbidden,
  validateBatch: mocks.forbidden,
  promoteBatch: mocks.forbidden,
}));

const ROOT = resolve(import.meta.dirname, "../../..");
const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const BUILD = "b".repeat(64);
const MAPPING = "d".repeat(64);
const EXPORT = "e".repeat(64);
const ARTIFACT = "a".repeat(64);
const RECORDS = ".local-data/evidence/fdc-csv-records/synthetic-stage-unit.ndjson";
const RUNNER = {
  authenticationMethod: "workload-identity" as const,
  principalId: "service:fdc-csv-stage-test",
  runId: "fdc-csv-stage-test",
  runReference: "urn:nutrition-tracker:test:fdc-csv-stage-test",
};
const cleanup: string[] = [];
let records: VerifiedFdcRecordExport;
let offset = 0;
let sealed = false;

beforeEach(() => {
  vi.resetAllMocks();
  offset = 0;
  sealed = false;
  records = verifiedRecords(251);
  mocks.open.mockImplementation(async () => records);
  mocks.openDatabase.mockReturnValue(mocks.database);
  mocks.database.destroy.mockResolvedValue(undefined);
  mocks.principal.mockResolvedValue({
    databasePrincipal: "synthetic_stage",
    capabilityRole: "nutrition_catalogue_stage",
  });
  mocks.create.mockImplementation(async () => ({
    batchId: BATCH_ID,
    nextOffset: offset,
    stagedCount: offset,
    status: "staging",
    resumed: offset > 0,
  }));
  mocks.chunk.mockImplementation(
    async (
      _database,
      input: { expectedNextOffset: number; records: readonly StagedCatalogueRecordInput[] },
    ) => {
      const end = input.expectedNextOffset + input.records.length;
      const replay = offset === end;
      if (!replay && offset !== input.expectedNextOffset) throw new Error("Wrong checkpoint");
      if (sealed) throw new Error("Already sealed");
      offset = end;
      return {
        nextOffset: end,
        stagedCount: end,
        inserted: replay ? 0 : input.records.length,
        replayed: replay ? input.records.length : 0,
        wasAlreadyStaged: replay,
      };
    },
  );
  mocks.seal.mockImplementation(async (_database, input: { report: JsonObject }) => {
    const wasAlreadySealed = sealed;
    sealed = true;
    return {
      parserReportSha256: sha256CanonicalJson(input.report),
      stagingSealSha256: "f".repeat(64),
      wasAlreadySealed,
    };
  });
});
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("catalogue stage-fdc-csv bounded orchestration", () => {
  it("runs the actual CLI through verified input, stage-only pages and a parser seal", async () => {
    const fixture = await commandFixture();
    const result = capture();
    expect(await runCommand(fixture.argv, result.io), result.errors.join("\n")).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mocks.open.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openDatabase.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.chunk.mock.calls.map((call) => call[1].records.length)).toEqual([250, 1]);
    expect(result.output[0]).toMatchObject({
      batchId: BATCH_ID,
      inserted: 251,
      replayed: 0,
      staged: 251,
      status: "staging",
      validationPending: true,
      wasAlreadySealed: false,
    });
    expect(result.output[0]).not.toHaveProperty("promotionEligible");
    expect(result.output[0]).not.toHaveProperty("validationDigest");
    expect(mocks.forbidden).not.toHaveBeenCalled();
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
    expect(records.close).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedExport: { sha256: EXPORT, byteSize: 12345 },
        expectedHeader: expect.objectContaining({
          manifestSha256: fixture.manifestSha,
          artifactSha256: ARTIFACT,
          parserBuildSha256: BUILD,
        }),
      }),
    );
    expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({
      releaseClass: "fixture-nonrelease",
      rightsManifestSha256: fixture.manifestSha,
      parserVersion: `0.1.0+build.${BUILD}+mapping.${MAPPING}`,
    });
    expect(mocks.seal.mock.calls[0]?.[1].report).toMatchObject({
      recordsExport: { sha256: EXPORT, byteSize: 12345, recordCount: 251 },
      reportKind: "usda-fdc-full-csv-capability-stage-v1",
      nutrientMappingDigest: MAPPING,
    });
    expect(mocks.seal.mock.calls[0]?.[1].report.recordsExport).not.toHaveProperty("path");
  });

  it("resumes after a committed page and replays only that page before completing", async () => {
    const fixture = await commandFixture();
    const implementation = mocks.chunk.getMockImplementation();
    if (!implementation) throw new Error("Fixture chunk implementation is missing");
    mocks.chunk
      .mockImplementationOnce(implementation)
      .mockRejectedValueOnce(new Error("synthetic second-page failure"));
    const failed = capture();
    expect(await runCommand(fixture.argv, failed.io)).toBe(1);
    expect(offset).toBe(250);
    expect(failed.output).toEqual([]);
    expect(mocks.seal).not.toHaveBeenCalled();
    const resumed = capture();
    expect(await runCommand(fixture.argv, resumed.io)).toBe(0);
    expect(resumed.output[0]).toMatchObject({
      inserted: 1,
      replayed: 250,
      resumed: true,
      staged: 251,
    });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.chunk.mock.calls.slice(2).map((call) => call[1].expectedNextOffset)).toEqual([
      0, 250,
    ]);
  });

  it("replays a complete sealed batch through the seal API without forbidden chunk writes", async () => {
    const fixture = await commandFixture();
    expect(await runCommand(fixture.argv, capture().io)).toBe(0);
    const chunks = mocks.chunk.mock.calls.length;
    const replay = capture();
    expect(await runCommand(fixture.argv, replay.io)).toBe(0);
    expect(mocks.chunk).toHaveBeenCalledTimes(chunks);
    expect(replay.output[0]).toMatchObject({
      inserted: 0,
      replayed: 0,
      wasAlreadySealed: true,
      validationPending: true,
    });
  });

  it.each([
    "late invalid footer",
    "wrong whole-file digest",
    "over-cap record set",
    "aborted verification",
  ])("does not open the database after %s", async (message) => {
    const fixture = await commandFixture();
    mocks.open.mockRejectedValueOnce(new Error(message));
    const result = capture();
    expect(await runCommand(fixture.argv, result.io)).toBe(1);
    expect(result.output).toEqual([]);
    expect(mocks.openDatabase).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not write under owner or wrong-capability credentials and closes both resources", async () => {
    const fixture = await commandFixture();
    mocks.principal.mockRejectedValueOnce(
      new Error("Stage principal must be a restricted stage-only login"),
    );
    expect(await runCommand(fixture.argv, capture().io)).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
    expect(records.close).toHaveBeenCalledOnce();
  });

  it.each([
    [-1, -1, "staging"],
    [252, 252, "staging"],
    [250, 249, "staging"],
    [0, 0, "ready"],
  ])("rejects malformed create receipt %s/%s/%s", async (nextOffset, stagedCount, status) => {
    const fixture = await commandFixture();
    mocks.create.mockResolvedValueOnce({
      batchId: BATCH_ID,
      nextOffset,
      stagedCount,
      status,
      resumed: true,
    });
    expect(await runCommand(fixture.argv, capture().io)).toBe(1);
    expect(mocks.chunk).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint inside a deterministic page", async () => {
    const fixture = await commandFixture();
    offset = 249;
    const result = capture();
    expect(await runCommand(fixture.argv, result.io)).toBe(1);
    expect(mocks.chunk).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it.each([
    { inserted: 249 },
    { stagedCount: 249 },
    { nextOffset: 249 },
    { wasAlreadyStaged: true },
    { replayed: 1 },
  ])("rejects malformed chunk receipt %j before sealing", async (change) => {
    const fixture = await commandFixture();
    mocks.chunk.mockResolvedValueOnce({
      nextOffset: 250,
      stagedCount: 250,
      inserted: 250,
      replayed: 0,
      wasAlreadyStaged: false,
      ...change,
    });
    expect(await runCommand(fixture.argv, capture().io)).toBe(1);
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("stops after post-commit cancellation without sealing or reporting completion", async () => {
    const fixture = await commandFixture();
    const controller = new AbortController();
    const implementation = mocks.chunk.getMockImplementation();
    if (!implementation) throw new Error("Fixture chunk implementation is missing");
    mocks.chunk.mockImplementationOnce(async (...args) => {
      const receipt = await implementation(...args);
      controller.abort();
      return receipt;
    });
    const result = capture();
    expect(await runCommand(fixture.argv, { ...result.io, signal: controller.signal })).toBe(1);
    expect(offset).toBe(250);
    expect(mocks.chunk).toHaveBeenCalledOnce();
    expect(mocks.seal).not.toHaveBeenCalled();
    expect(result.output).toEqual([]);
  });

  it("requires a matching parser-report seal receipt", async () => {
    const fixture = await commandFixture();
    mocks.seal.mockResolvedValueOnce({
      parserReportSha256: "0".repeat(64),
      stagingSealSha256: "f".repeat(64),
      wasAlreadySealed: false,
    });
    const result = capture();
    expect(await runCommand(fixture.argv, result.io)).toBe(1);
    expect(result.output).toEqual([]);
  });

  it.each(["database", "reader"])(
    "withholds successful completion when %s cleanup fails",
    async (resource) => {
      const fixture = await commandFixture();
      if (resource === "database")
        mocks.database.destroy.mockRejectedValueOnce(new Error("database cleanup failure"));
      else vi.mocked(records.close).mockRejectedValueOnce(new Error("reader cleanup failure"));
      const result = capture();
      expect(await runCommand(fixture.argv, result.io)).toBe(1);
      expect(result.output).toEqual([]);
      expect(records.close).toHaveBeenCalledOnce();
      expect(mocks.database.destroy).toHaveBeenCalledOnce();
    },
  );

  it("rejects an oversized escaped seal request before opening the database", async () => {
    const fixture = await commandFixture();
    const inspection = records.inspection as Record<string, unknown>;
    inspection.syntheticEscapedNotes = "\\".repeat(4_200_000);
    const result = capture();
    expect(await runCommand(fixture.argv, result.io)).toBe(1);
    expect(result.output).toEqual([]);
    expect(mocks.openDatabase).not.toHaveBeenCalled();
    expect(records.close).toHaveBeenCalledOnce();
  });

  it("rejects contradictory conserved counts before opening the database", async () => {
    const fixture = await commandFixture();
    const inspection = records.inspection as { conservation: { foods: { sourceCount: number } } };
    inspection.conservation.foods.sourceCount += 1;
    expect(await runCommand(fixture.argv, capture().io)).toBe(1);
    expect(mocks.openDatabase).not.toHaveBeenCalled();
    expect(records.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["--records", ".local-data/evidence/fdc-csv-records/nested/file.ndjson"],
    ["--records-sha256", "A".repeat(64)],
    ["--records-bytes", "001"],
    ["--nutrient-mapping-sha256", "bad"],
    ["--__proto__", "bad"],
  ])("rejects invalid %s before acquisition or database work", async (option, value) => {
    const fixture = await commandFixture();
    const argv = [...fixture.argv];
    const index = argv.indexOf(option);
    if (index === -1) argv.push(option, value);
    else argv[index + 1] = value;
    expect(await runCommand(argv, capture().io)).toBe(1);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openDatabase).not.toHaveBeenCalled();
  });

  it("enforces authenticated runner and reviewed parser-build pins independently of export", async () => {
    const fixture = await commandFixture();
    for (const environment of [
      { INGEST_PARSER_BUILD_SHA256: "0".repeat(64) },
      { INGEST_AUTHENTICATED_PRINCIPAL_ID: "service:another-runner" },
    ]) {
      const result = capture(environment);
      expect(await runCommand(fixture.argv, result.io)).toBe(1);
    }
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openDatabase).not.toHaveBeenCalled();
  });

  it("counts quarantined-parent children and derived servings without relabelling raw CSV rows", () => {
    const input = verifiedRecords(1);
    const inspection = input.inspection as {
      metrics: Record<string, number>;
      conservation: Record<string, Record<string, number>>;
    };
    inspection.metrics.derivedLabelServingCount = 1;
    inspection.metrics.quarantinedFoodCount = 1;
    inspection.metrics.excludedNutrientCount = 2;
    inspection.metrics.excludedPortionCount = 3;
    inspection.conservation.foods = { acceptedCount: 1, quarantinedCount: 1, sourceCount: 2 };
    inspection.conservation.foodNutrients = {
      emittedCount: 1,
      excludedCount: 2,
      quarantinedParentCount: 4,
      sourceCount: 7,
    };
    inspection.conservation.foodPortions = {
      emittedCount: 0,
      excludedCount: 3,
      quarantinedParentCount: 5,
      sourceCount: 8,
    };
    const withServing = { ...input, evidence: { ...input.evidence, servingCount: 1 } };
    const report = buildFdcCsvStageParserReport({
      records: withServing,
      artifactSha256: ARTIFACT,
      nutrientMappingDigest: MAPPING,
      parserBuildSha256: BUILD,
      parserPackage: "@nutrition-tracker/ingestion",
      parserVersion: "0.1.0",
      releaseKey: "synthetic-csv-stage-unit",
      sourceCode: "USDA_FDC",
    });
    expect(report).toMatchObject({
      emittedRecordCount: 1,
      excludedRecordCount: 1,
      sourceRecordCount: 2,
      emittedNutrientCount: 1,
      excludedNutrientCount: 6,
      sourceNutrientCount: 7,
      emittedPortionCount: 1,
      excludedPortionCount: 8,
      sourcePortionCount: 9,
    });
    expect(report.report.inspection).toBe(input.inspection);
    expect(report.report.portionCountBasis).toBe(
      "source-csv-portions-plus-emitted-derived-label-servings-v1",
    );
  });
});

function verifiedRecords(count: number): VerifiedFdcRecordExport {
  const inspection: JsonObject = {
    metrics: {
      acceptedFoodCount: count,
      quarantinedFoodCount: 0,
      stagedNutrientCount: count,
      stagedPortionCount: 0,
      derivedLabelServingCount: 0,
      excludedNutrientCount: 0,
      excludedPortionCount: 0,
    },
    conservation: {
      foods: { acceptedCount: count, quarantinedCount: 0, sourceCount: count },
      foodNutrients: {
        emittedCount: count,
        excludedCount: 0,
        quarantinedParentCount: 0,
        sourceCount: count,
      },
      foodPortions: {
        emittedCount: 0,
        excludedCount: 0,
        quarantinedParentCount: 0,
        sourceCount: 0,
      },
    },
  };
  return {
    evidence: {
      path: resolve(ROOT, RECORDS),
      byteSize: 12345,
      sha256: EXPORT,
      recordCount: count,
      recordsSha256: "c".repeat(64),
      nutrientCount: count,
      servingCount: 0,
      postgresPayloadByteUpperBound: 1000 * count,
    },
    inspection,
    async *pages({ nextOffset, replayPreviousPage = false }) {
      if (nextOffset !== count && nextOffset % 250 !== 0)
        throw new Error("Checkpoint is not a deterministic page boundary");
      const start = replayPreviousPage && nextOffset > 0 ? nextOffset - 250 : nextOffset;
      for (let pageOffset = start; pageOffset < count; pageOffset += 250) {
        const end = Math.min(count, pageOffset + 250);
        const page = Array.from(
          { length: end - pageOffset },
          (_, index): StagedCatalogueRecordInput => ({
            canonicalPayload: { index: pageOffset + index },
            sequenceNumber: pageOffset + index,
            sourcePayloadSha256: ARTIFACT,
            sourceRecordKey: `food:${pageOffset + index}`,
            sourceRecordType: "Foundation",
          }),
        );
        yield {
          expectedNextOffset: pageOffset,
          nextOffset: end,
          records: page,
          recordsDocumentBytes: page.length * 1000,
        };
      }
    },
    close: vi.fn(async () => undefined),
  };
}

async function commandFixture() {
  const root = await mkdtemp(join(tmpdir(), "fdc-csv-stage-unit-"));
  cleanup.push(root);
  const base = JSON.parse(
    await readFile(
      join(ROOT, "data/manifests/usda-fdc-full-csv-2026-04-30.candidate.json"),
      "utf8",
    ),
  ) as FoodSourceManifestV4;
  const roles = [
    "food",
    "branded-food",
    "food-nutrient",
    "nutrient",
    "food-nutrient-derivation",
    "food-portion",
    "measure-unit",
  ];
  const expectedFiles = [...roles.map((role) => `${role}.csv`), "guide.pdf"].sort();
  const expectations: Record<string, string | number> = {
    fdcCsvDefaultMarketCode: "US",
    "fdcCsvDataTypeMapping:foundation_food": "Foundation",
    "fdcCsvMarketMapping:United States": "US",
    "fdcCsvDisposition:guide.pdf": "guide:publisher-documentation-v1",
    parserBaselineCsvAcceptedFoodCount: 251,
    parserBaselineCsvCanonicalAcceptedRecordsDigest: "c".repeat(64),
  };
  for (const role of roles)
    expectations[`fdcCsvDisposition:${role}.csv`] = `adapter-input:${role}-v1`;
  const evidence = bindSyntheticReleaseEvidence(
    {
      ...base,
      artifact: {
        ...base.artifact,
        byteSize: 100,
        sha256: ARTIFACT,
        objectUri: `s3://synthetic-fdc-stage/sha256/${ARTIFACT}/full.zip`,
      },
      ingestion: { ...base.ingestion, parserVersion: "0.1.0", parserBuildSha256: BUILD },
      release: {
        ...base.release,
        releaseKey: "synthetic-csv-stage-unit",
        upstreamSchemaVersion: "synthetic-v1",
      },
      rights: {
        ...base.rights,
        review: {
          ...base.rights.review,
          status: "approved",
          reviewedAt: "2026-08-29T12:00:00Z",
          reviewedBy: RUNNER.principalId,
          notes: "Synthetic unit fixture; never release evidence.",
        },
      },
      templateOnly: false,
      releaseClass: "fixture-nonrelease",
      evidenceBundle: null,
      validation: { ...base.validation, expectedFiles, releaseSpecificExpectations: expectations },
    },
    RUNNER,
  );
  const bytes = `${canonicalJson(evidence.manifest)}\n`;
  const manifestSha = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = join(root, "manifest.json");
  const evidencePath = join(root, "evidence.json");
  await writeFile(manifestPath, bytes, { mode: 0o600 });
  await writeCanonicalReleaseEvidence(evidencePath, evidence.bundle);
  return {
    manifestSha,
    argv: [
      "catalogue",
      "stage-fdc-csv",
      manifestPath,
      "--records",
      RECORDS,
      "--records-sha256",
      EXPORT,
      "--records-bytes",
      "12345",
      "--nutrient-mapping-sha256",
      MAPPING,
      "--evidence-bundle",
      evidencePath,
      "--manifest-object-uri",
      `s3://synthetic-fdc-stage/sha256/${manifestSha}/manifest.json`,
    ],
  };
}

function capture(overrides: NodeJS.ProcessEnv = {}) {
  const output: unknown[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    io: {
      environment: {
        DATABASE_URL: "postgresql://never-opened@127.0.0.1:1/test",
        INGEST_AUTHENTICATION_METHOD: RUNNER.authenticationMethod,
        INGEST_AUTHENTICATED_PRINCIPAL_ID: RUNNER.principalId,
        INGEST_AUTHENTICATION_RUN_REFERENCE: RUNNER.runReference,
        INGEST_PARSER_BUILD_SHA256: BUILD,
        ...overrides,
      },
      now: () => new Date(SYNTHETIC_EVIDENCE_EVALUATED_AT),
      writeOutput: (value: string) => output.push(JSON.parse(value)),
      writeError: (value: string) => errors.push(value),
    },
  };
}
