import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import type {
  RecordBatchParserReportInput,
  StageBatchInput,
  StagedCatalogueRecordInput,
} from "../src/catalogue-ingestion.js";
import {
  appendCatalogueStageChunk,
  assertCatalogueStagePrincipal,
  createOrResumeCatalogueStage,
  encodeCatalogueStageParserReport,
  sealCatalogueStageParserReport,
} from "../src/catalogue-stage.js";
import { canonicalJson, sha256CanonicalJson } from "../src/catalogue-validation.js";
import type { Database } from "../src/types.js";

const BATCH = "12345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const principal = {
  databasePrincipal: "stage_fixture",
  effectivePrincipal: "stage_fixture",
  canLogin: true,
  privileged: false,
  ownerMember: false,
  capabilities: ["nutrition_catalogue_stage"],
};
const input: StageBatchInput = {
  acquiredAt: "2026-09-20T00:00:00Z",
  artifactBytes: 100n,
  artifactSha256: HASH,
  artifactUri: "s3://synthetic/source.zip",
  evidenceBundleSha256: HASH,
  evidenceBundleUri: "s3://synthetic/evidence.json",
  evidenceDecisionSha256: HASH,
  evidenceObjectVersionId: "fixture-v1",
  evidenceValidUntil: "2026-09-20T12:00:00Z",
  mediaType: "application/zip",
  parserVersion: `0.1.0+build.${HASH}+mapping.${HASH}`,
  releaseClass: "fixture-nonrelease",
  releaseKey: "fixture-v1",
  rightsManifestSha256: HASH,
  rightsManifestUri: "s3://synthetic/manifest.json",
  sourceCode: "USDA_FDC",
};
const record: StagedCatalogueRecordInput = {
  canonicalPayload: { z: "零", a: 1 },
  sourcePayloadSha256: HASH,
  sourceRecordKey: "42",
  sourceRecordType: "foundation_food",
  sequenceNumber: 0,
};
const report: RecordBatchParserReportInput = {
  batchId: BATCH,
  report: { kind: "synthetic", count: 1 },
  sourceRecordCount: 1,
  emittedRecordCount: 1,
  excludedRecordCount: 0,
  sourceNutrientCount: 2,
  emittedNutrientCount: 1,
  excludedNutrientCount: 1,
  sourcePortionCount: 0,
  emittedPortionCount: 0,
  excludedPortionCount: 0,
};

function fixture(responses: unknown[]) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (responses.length === 0) throw new Error("Unexpected database call");
          const result = responses.shift();
          if (result instanceof Error) throw result;
          return { rows: (result === undefined ? [] : [{ result }]) as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("Streaming not allowed for bounded receipts");
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
  return { database, queries };
}

describe("catalogue stage capability wrappers", () => {
  it("reads actual session authority through pg_catalog and permits only stage", async () => {
    const f = fixture([principal]);
    await expect(assertCatalogueStagePrincipal(f.database)).resolves.toEqual({
      databasePrincipal: "stage_fixture",
      capabilityRole: "nutrition_catalogue_stage",
    });
    expect(f.queries[0]?.sql).toContain("pg_catalog.pg_roles");
    expect(f.queries[0]?.sql).toContain("session_user");
    expect(f.queries[0]?.sql).toContain("public.food_import_batch");
  });

  it.each([
    { privileged: true },
    { ownerMember: true },
    { canLogin: false },
    { effectivePrincipal: "assumed_stage" },
    { capabilities: [] },
    { capabilities: ["nutrition_catalogue_validate"] },
    { capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_validate"] },
    { databasePrincipal: "" },
    { databasePrincipal: "x".repeat(64), effectivePrincipal: "x".repeat(64) },
  ])("rejects invalid principal without a mutating call: %j", async (change) => {
    const f = fixture([{ ...principal, ...change }]);
    await expect(createOrResumeCatalogueStage(f.database, input)).rejects.toThrow(
      "restricted login",
    );
    expect(f.queries).toHaveLength(1);
  });

  it("serializes exact stage provenance as one parameter, preserves absent nullable fields", async () => {
    const f = fixture([
      principal,
      { batchId: BATCH, nextOffset: 0, resumed: false, stagedCount: 0, status: "staging" },
    ]);
    await expect(createOrResumeCatalogueStage(f.database, input)).resolves.toMatchObject({
      batchId: BATCH,
      resumed: false,
    });
    const query = f.queries[1];
    expect(query?.sql).toContain("public.catalogue_stage_import_batch($1::text)");
    const document = JSON.parse(String(query?.parameters[0]));
    expect(document).toMatchObject({
      schemaVersion: 1,
      artifactBytes: "100",
      acquiredAt: "2026-09-20T00:00:00.000Z",
      publishedOn: null,
      upstreamSchemaVersion: null,
    });
    expect(Object.keys(document)).toHaveLength(19);
    expect(query?.parameters[0]).toBe(canonicalJson(document));
  });

  it.each([
    undefined,
    { batchId: BATCH, nextOffset: 251, resumed: true, stagedCount: 250, status: "staging" },
    { batchId: BATCH, nextOffset: "250", resumed: true, stagedCount: 250, status: "staging" },
    { batchId: BATCH, nextOffset: 0, resumed: false, stagedCount: 0, status: "unknown" },
    {
      batchId: BATCH,
      nextOffset: 0,
      resumed: false,
      stagedCount: 0,
      status: "staging",
      extra: true,
    },
  ])("rejects malformed batch receipts %j", async (response) => {
    const f = fixture([principal, response]);
    await expect(createOrResumeCatalogueStage(f.database, input)).rejects.toThrow();
  });

  it("preserves exact chunk bytes and reconciles all counts", async () => {
    const f = fixture([
      principal,
      { inserted: 1, nextOffset: 1, replayed: 0, stagedCount: 1, wasAlreadyStaged: false },
    ]);
    await expect(
      appendCatalogueStageChunk(f.database, {
        batchId: BATCH,
        expectedNextOffset: 0,
        records: [record],
      }),
    ).resolves.toMatchObject({ inserted: 1 });
    const q = f.queries[1];
    expect(q?.sql).toContain(
      "public.catalogue_stage_import_record_chunk($1::uuid, $2::bigint, $3::text)",
    );
    expect(q?.parameters.slice(0, 2)).toEqual([BATCH, 0]);
    const document = JSON.parse(String(q?.parameters[2]));
    expect(document.records[0]).toEqual({
      canonicalPayloadDocument: canonicalJson(record.canonicalPayload),
      canonicalPayloadSha256: sha256CanonicalJson(record.canonicalPayload),
      sequenceNumber: 0,
      sourcePayloadSha256: HASH,
      sourceRecordKey: "42",
      sourceRecordType: "foundation_food",
    });
  });

  it("accepts exact last-page replay receipts", async () => {
    const f = fixture([
      principal,
      { inserted: 0, nextOffset: 251, replayed: 1, stagedCount: 251, wasAlreadyStaged: true },
    ]);
    await expect(
      appendCatalogueStageChunk(f.database, {
        batchId: BATCH,
        expectedNextOffset: 250,
        records: [{ ...record, sequenceNumber: 250 }],
      }),
    ).resolves.toMatchObject({ replayed: 1, wasAlreadyStaged: true });
  });

  it.each([
    { inserted: 0, nextOffset: 1, replayed: 0, stagedCount: 1, wasAlreadyStaged: false },
    { inserted: 1, nextOffset: 1, replayed: 0, stagedCount: 1, wasAlreadyStaged: true },
    { inserted: 1, nextOffset: 2, replayed: 0, stagedCount: 2, wasAlreadyStaged: false },
  ])("rejects inconsistent chunk receipts %j", async (response) => {
    const f = fixture([principal, response]);
    await expect(
      appendCatalogueStageChunk(f.database, {
        batchId: BATCH,
        expectedNextOffset: 0,
        records: [record],
      }),
    ).rejects.toThrow("receipt");
  });

  it.each([
    { records: [] },
    {
      records: Array.from({ length: 251 }, (_, sequenceNumber) => ({ ...record, sequenceNumber })),
    },
    { records: [{ ...record, sequenceNumber: 1 }] },
    { records: [{ ...record, canonicalPayloadSha256: "b".repeat(64) }] },
    { records: [{ ...record, canonicalPayload: { value: "x".repeat(1024 * 1024) } }] },
    { records: [record], expectedNextOffset: 10000 },
  ])("rejects invalid chunk input before SQL %j", async (change) => {
    const f = fixture([]);
    await expect(
      appendCatalogueStageChunk(f.database, { batchId: BATCH, expectedNextOffset: 0, ...change }),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(0);
  });

  it.each(["\u0000", "\ud800", "\udfff"])(
    "rejects PostgreSQL-incompatible report text before SQL",
    async (text) => {
      const input = { ...report, report: { nested: [{ text }] } };
      expect(() => encodeCatalogueStageParserReport(input)).toThrow("PostgreSQL JSONB");
      const f = fixture([]);
      await expect(sealCatalogueStageParserReport(f.database, input)).rejects.toThrow(
        "PostgreSQL JSONB",
      );
      expect(f.queries).toHaveLength(0);
    },
  );

  it("preflights report escaping and byte caps without a database", () => {
    expect(JSON.parse(encodeCatalogueStageParserReport(report))).toMatchObject({
      reportDocument: canonicalJson(report.report),
      reportSha256: sha256CanonicalJson(report.report),
    });
    expect(() =>
      encodeCatalogueStageParserReport({
        ...report,
        report: { payload: '"'.repeat(5 * 1024 * 1024) },
      }),
    ).toThrow("byte limit");
    expect(() =>
      encodeCatalogueStageParserReport({
        ...report,
        report: { payload: "x".repeat(15 * 1024 * 1024) },
      }),
    ).toThrow("byte limit");
  });

  it("seals exact parser evidence without calling validation", async () => {
    const f = fixture([
      principal,
      {
        parserReportSha256: sha256CanonicalJson(report.report),
        stagingSealSha256: HASH,
        wasAlreadySealed: true,
      },
    ]);
    await expect(sealCatalogueStageParserReport(f.database, report)).resolves.toMatchObject({
      stagingSealSha256: HASH,
      wasAlreadySealed: true,
    });
    expect(f.queries[1]?.sql).toContain("public.catalogue_stage_import_parser_report");
    const document = JSON.parse(String(f.queries[1]?.parameters[1]));
    expect(Object.keys(document)).toHaveLength(12);
    expect(document).toMatchObject({
      reportDocument: canonicalJson(report.report),
      sourceNutrientCount: "2",
      emittedNutrientCount: "1",
      excludedNutrientCount: "1",
    });
    expect(f.queries.map((q) => q.sql).join("\n")).not.toMatch(
      /public\.catalogue_(validate|approve|promote|rollback)/u,
    );
  });

  it.each([
    { sourceRecordCount: 2 },
    { reportSha256: "b".repeat(64) },
    { emittedRecordCount: -1 },
    { sourceRecordCount: 10001, emittedRecordCount: 10001 },
  ])("rejects invalid report before SQL %j", async (change) => {
    const f = fixture([]);
    await expect(
      sealCatalogueStageParserReport(f.database, { ...report, ...change }),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(0);
  });

  it("rejects a mismatched seal receipt and propagates ambiguous SQL failures", async () => {
    const f = fixture([
      principal,
      { parserReportSha256: "b".repeat(64), stagingSealSha256: HASH, wasAlreadySealed: false },
    ]);
    await expect(sealCatalogueStageParserReport(f.database, report)).rejects.toThrow(
      "seal receipt",
    );
    const failed = fixture([principal, new Error("connection lost after possible commit")]);
    await expect(sealCatalogueStageParserReport(failed.database, report)).rejects.toThrow(
      "connection lost",
    );
    expect(failed.queries).toHaveLength(2);
  });
});
