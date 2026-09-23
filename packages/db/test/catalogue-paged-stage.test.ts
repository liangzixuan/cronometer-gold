import { readFileSync } from "node:fs";
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
  catalogueDocumentSha256V2,
  catalogueFramedSha256V2,
} from "../src/catalogue-paged-protocol.js";
import {
  admitCataloguePreparationV2,
  assertCataloguePreparationPrincipalV2,
  beginCataloguePreparationSealV2,
  beginCataloguePreparationV2,
  type CataloguePreparationAdmissionInputV2,
  type CataloguePreparationSealTerminalV2,
  encodeCataloguePreparationAdmissionV2,
  encodeCataloguePreparationParserReportV2,
  encodeCataloguePreparationSealTerminalV2,
  encodeCataloguePreparationStageIdentityV2,
  encodeCataloguePreparationStagePageV2,
  finishCataloguePreparationSealV2,
  readCataloguePreparationAdmissionV2,
  submitCataloguePreparationStagePageV2,
  verifyCataloguePreparationSealPageV2,
} from "../src/catalogue-paged-stage.js";
import type { Database } from "../src/types.js";

const BATCH = "12345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const identity: StageBatchInput = {
  acquiredAt: "2026-09-21T00:00:00Z",
  artifactBytes: 100n,
  artifactSha256: HASH,
  artifactUri: "s3://synthetic/source.zip",
  evidenceBundleSha256: HASH,
  evidenceBundleUri: "s3://synthetic/evidence.json",
  evidenceDecisionSha256: HASH,
  evidenceObjectVersionId: "synthetic-v1",
  evidenceValidUntil: "2026-09-21T12:00:00Z",
  mediaType: "application/zip",
  parserVersion: `0.1.0+build.${HASH}+mapping.${HASH}`,
  releaseClass: "fixture-nonrelease",
  releaseKey: "synthetic-v1",
  rightsManifestSha256: HASH,
  rightsManifestUri: "s3://synthetic/manifest.json",
  sourceCode: "USDA_FDC",
};
const stageDocument = encodeCataloguePreparationStageIdentityV2(identity);
const admission: CataloguePreparationAdmissionInputV2 = {
  stageDocument,
  manifestSha256: HASH,
  exportSha256: OTHER,
  exportBytes: 100000000n,
  stagePrincipal: "stage_fixture",
  maxRecords: 25000n,
  maxPayloadTextBytes: 268435456n,
  maxIntermediateBytes: 1073741824n,
  maxValidationEvidenceBytes: 536870912n,
  maxReconciliationEvidenceBytes: 1073741824n,
  maxBaselineRecords: 50000n,
  maxBaselinePayloadBytes: 536870912n,
  reviewReference: "synthetic-only scoped review",
};
const principal = {
  databasePrincipal: "stage_fixture",
  effectivePrincipal: "stage_fixture",
  canLogin: true,
  privileged: false,
  ownerMember: false,
  capabilities: ["nutrition_catalogue_stage"],
};
const record: StagedCatalogueRecordInput = {
  canonicalPayload: { identity: { name: "Food 零 🍓" } },
  sourcePayloadSha256: HASH,
  sourceRecordKey: "42",
  sourceRecordType: "foundation_food",
  sequenceNumber: 12500,
};
function pageDocument() {
  return encodeCataloguePreparationStagePageV2({
    batchId: BATCH,
    admissionSha256: HASH,
    parserVersion: identity.parserVersion,
    pageNumber: 50n,
    firstSequence: 12500n,
    previousReceiptSha256: OTHER,
    records: [record],
  });
}
function pageReceipt(document: string) {
  const requestSha256 = catalogueDocumentSha256V2(document, 16 * 1024 * 1024);
  return {
    schemaVersion: 2,
    batchId: BATCH,
    admissionSha256: HASH,
    pageNumber: "50",
    firstSequence: "12500",
    nextSequence: "12501",
    recordCount: "1",
    payloadTextBytes: "42",
    totalPayloadTextBytes: "123456789",
    recordCommitmentSha256: HASH,
    requestSha256,
    previousReceiptSha256: OTHER,
    receiptSha256: catalogueFramedSha256V2("stage-page", [
      BATCH,
      HASH,
      identity.parserVersion,
      "50",
      "12500",
      "12501",
      OTHER,
      requestSha256,
      HASH,
      "42",
      "123456789",
    ]),
  };
}
const report: RecordBatchParserReportInput = {
  batchId: BATCH,
  report: { kind: "synthetic", emitted: 25000 },
  sourceRecordCount: 25001,
  emittedRecordCount: 25000,
  excludedRecordCount: 1,
  sourceNutrientCount: 50000,
  emittedNutrientCount: 49999,
  excludedNutrientCount: 1,
  sourcePortionCount: 0,
  emittedPortionCount: 0,
  excludedPortionCount: 0,
};
const terminal: CataloguePreparationSealTerminalV2 = {
  schemaVersion: 2,
  batchId: BATCH,
  admissionSha256: HASH,
  recordCount: "25000",
  payloadTextBytes: "100000000",
  recordCommitmentSha256: HASH,
  stageReceiptSha256: OTHER,
  parserReportSha256: HASH,
  sealRequestSha256: OTHER,
};

function fixture(responses: unknown[]) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (responses.length === 0) throw new Error("Unexpected database call");
          const value = responses.shift();
          if (value instanceof Error) throw value;
          return { rows: (value === undefined ? [] : [{ result: value }]) as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No whole-batch stream in receipt calls");
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

describe("V2 preparation admission and authority", () => {
  it("reads exact accepted budgets through the restricted admission interface", async () => {
    const requestDocument = encodeCataloguePreparationAdmissionV2(admission);
    const requestSha256 = catalogueDocumentSha256V2(requestDocument, 131072);
    const admittedBy = "quality_fixture";
    const admissionSha256 = catalogueFramedSha256V2("admission", [requestSha256, admittedBy]);
    const receipt = {
      schemaVersion: 2,
      requestDocument,
      requestSha256,
      admissionSha256,
      admittedBy,
    };
    const f = fixture([principal, receipt]);
    await expect(readCataloguePreparationAdmissionV2(f.database, admissionSha256)).resolves.toEqual(
      receipt,
    );
    expect(f.queries[1]?.sql).toContain("public.catalogue_read_preparation_admission_v2");
    expect(f.queries[1]?.parameters).toEqual([admissionSha256]);
  });
  it("rejects changed admission bytes before exposing allocation limits", async () => {
    const requestDocument = encodeCataloguePreparationAdmissionV2(admission);
    const requestSha256 = catalogueDocumentSha256V2(requestDocument, 131072);
    const admittedBy = "quality_fixture";
    const admissionSha256 = catalogueFramedSha256V2("admission", [requestSha256, admittedBy]);
    const f = fixture([
      principal,
      {
        schemaVersion: 2,
        requestDocument: `${requestDocument} `,
        requestSha256,
        admissionSha256,
        admittedBy,
      },
    ]);
    await expect(readCataloguePreparationAdmissionV2(f.database, admissionSha256)).rejects.toThrow(
      "differs",
    );
  });
  it("retains explicit accepted candidate and baseline budgets as decimal text", () => {
    const value = JSON.parse(encodeCataloguePreparationAdmissionV2(admission));
    expect(value).toMatchObject({
      schemaVersion: 2,
      maxRecords: "25000",
      maxPayloadTextBytes: "268435456",
      maxBaselineRecords: "50000",
      maxBaselinePayloadBytes: "536870912",
      stageDocument,
    });
    expect(JSON.parse(stageDocument)).toMatchObject({
      schemaVersion: 1,
      artifactBytes: "100",
      publishedOn: null,
      upstreamSchemaVersion: null,
    });
    expect(Object.keys(JSON.parse(stageDocument))).toHaveLength(19);
  });
  it.each([
    "exportBytes",
    "maxRecords",
    "maxPayloadTextBytes",
    "maxIntermediateBytes",
    "maxValidationEvidenceBytes",
    "maxReconciliationEvidenceBytes",
  ] as const)("has no zero/default allowance for %s", (key) => {
    expect(() => encodeCataloguePreparationAdmissionV2({ ...admission, [key]: 0 })).toThrow(
      "positive",
    );
    expect(() =>
      encodeCataloguePreparationAdmissionV2({
        ...admission,
        [key]: undefined,
      } as unknown as CataloguePreparationAdmissionInputV2),
    ).toThrow();
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "01", "9223372036854775808"])(
    "rejects inexact or overflowing admission count %s",
    (maxRecords) => {
      expect(() => encodeCataloguePreparationAdmissionV2({ ...admission, maxRecords })).toThrow();
    },
  );
  it("accepts exact bigint counts without a V1-sized cap or number conversion", () => {
    expect(
      JSON.parse(
        encodeCataloguePreparationAdmissionV2({ ...admission, maxRecords: "9007199254740992" }),
      ).maxRecords,
    ).toBe("9007199254740992");
  });
  it.each([
    { privileged: true },
    { ownerMember: true },
    { canLogin: false },
    { effectivePrincipal: "assumed" },
    { capabilities: [] },
    { capabilities: ["nutrition_catalogue_validate"] },
    { capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_approve_quality"] },
  ])("rejects invalid session before mutation %j", async (change) => {
    const f = fixture([{ ...principal, ...change }]);
    await expect(
      beginCataloguePreparationV2(f.database, { admissionSha256: HASH, stageDocument }),
    ).rejects.toThrow("restricted login");
    expect(f.queries).toHaveLength(1);
  });
  it("binds an accepted admission to the actual distinct reviewer and exact bytes", async () => {
    const document = encodeCataloguePreparationAdmissionV2(admission);
    const requestSha256 = catalogueDocumentSha256V2(document, 131072);
    const reviewer = "quality_fixture";
    const receipt = {
      schemaVersion: 2,
      requestSha256,
      admissionSha256: catalogueFramedSha256V2("admission", [requestSha256, reviewer]),
      admittedBy: reviewer,
    };
    const f = fixture([
      {
        ...principal,
        databasePrincipal: reviewer,
        effectivePrincipal: reviewer,
        capabilities: ["nutrition_catalogue_approve_quality"],
      },
      receipt,
    ]);
    await expect(admitCataloguePreparationV2(f.database, document)).resolves.toEqual(receipt);
    expect(f.queries[1]?.parameters).toEqual([document]);
  });
  it("refuses a spoofed admission reviewer receipt", async () => {
    const document = encodeCataloguePreparationAdmissionV2(admission);
    const f = fixture([
      { ...principal, capabilities: ["nutrition_catalogue_approve_quality"] },
      { schemaVersion: 2, requestSha256: HASH, admissionSha256: HASH, admittedBy: "spoofed" },
    ]);
    await expect(admitCataloguePreparationV2(f.database, document)).rejects.toThrow(
      "receipt differs",
    );
  });
  it("reads actual principals without raw user table privileges", async () => {
    const f = fixture([principal]);
    await expect(
      assertCataloguePreparationPrincipalV2(f.database, "nutrition_catalogue_stage"),
    ).resolves.toBe("stage_fixture");
    expect(f.queries[0]?.sql).toContain("session_user");
    expect(f.queries[0]?.sql).toContain("pg_catalog.pg_roles");
  });
});

describe("V2 staged pages and retained acknowledgements", () => {
  it("encodes contiguous source identities beyond the old limit and hashes exact Unicode payload bytes", () => {
    const value = JSON.parse(pageDocument());
    expect(value.firstSequence).toBe("12500");
    expect(value.records[0].sequenceNumber).toBe("12500");
    expect(value.records[0].canonicalPayloadSha256).toBe(
      catalogueDocumentSha256V2(value.records[0].canonicalPayloadDocument, 1048576),
    );
    expect(JSON.parse(value.records[0].canonicalPayloadDocument)).toEqual(record.canonicalPayload);
  });
  it.each([
    { records: [] },
    {
      records: Array.from({ length: 251 }, (_, index) => ({
        ...record,
        sequenceNumber: 12500 + index,
      })),
    },
  ])("rejects empty/oversized page record sets", ({ records }) => {
    expect(() =>
      encodeCataloguePreparationStagePageV2({
        batchId: BATCH,
        admissionSha256: HASH,
        parserVersion: identity.parserVersion,
        pageNumber: 50,
        firstSequence: 12500,
        previousReceiptSha256: OTHER,
        records,
      }),
    ).toThrow("1 to 250");
  });
  it.each([
    { sequenceNumber: 12501 },
    { canonicalPayloadSha256: OTHER },
    { sourcePayloadSha256: "A".repeat(64) },
    { canonicalPayload: { invalid: "\u0000" } },
    { canonicalPayload: { invalid: "\ud800" } },
    { canonicalPayload: { huge: "x".repeat(1048576) } },
  ])("rejects malformed or changed source record %j", (change) => {
    expect(() =>
      encodeCataloguePreparationStagePageV2({
        batchId: BATCH,
        admissionSha256: HASH,
        parserVersion: identity.parserVersion,
        pageNumber: 50,
        firstSequence: 12500,
        previousReceiptSha256: OTHER,
        records: [{ ...record, ...change }],
      }),
    ).toThrow();
  });
  it("stops accumulating a page at its byte budget", () => {
    const records = Array.from({ length: 30 }, (_, index) => ({
      ...record,
      sequenceNumber: 12500 + index,
      canonicalPayload: { data: "x".repeat(600000) },
    }));
    expect(() =>
      encodeCataloguePreparationStagePageV2({
        batchId: BATCH,
        admissionSha256: HASH,
        parserVersion: identity.parserVersion,
        pageNumber: 50,
        firstSequence: 12500,
        previousReceiptSha256: OTHER,
        records,
      }),
    ).toThrow("byte bound");
  });
  it("submits retained bytes unchanged and accepts the same durable receipt on replay", async () => {
    const document = ` ${pageDocument()}\n`;
    const receipt = pageReceipt(document);
    const f = fixture([principal, receipt, principal, receipt]);
    await expect(
      submitCataloguePreparationStagePageV2(f.database, { batchId: BATCH, document }),
    ).resolves.toEqual(receipt);
    await expect(
      submitCataloguePreparationStagePageV2(f.database, { batchId: BATCH, document }),
    ).resolves.toEqual(receipt);
    expect(f.queries[1]?.parameters).toEqual([BATCH, document]);
    expect(f.queries[3]?.parameters).toEqual([BATCH, document]);
  });
  it.each([
    { requestSha256: OTHER },
    { pageNumber: "51" },
    { firstSequence: "12501" },
    { nextSequence: "12502" },
    { previousReceiptSha256: HASH },
    { admissionSha256: OTHER },
    { recordCount: 1 },
    { payloadTextBytes: "0" },
    { totalPayloadTextBytes: "1" },
    { receiptSha256: OTHER },
    { unexpected: true },
  ])("rejects a mismatched receipt %j", async (change) => {
    const document = pageDocument();
    const f = fixture([principal, { ...pageReceipt(document), ...change }]);
    await expect(
      submitCataloguePreparationStagePageV2(f.database, { batchId: BATCH, document }),
    ).rejects.toThrow();
  });
  it("does not regenerate or retry a page after a lost acknowledgement", async () => {
    const f = fixture([principal, new Error("lost acknowledgement")]);
    await expect(
      submitCataloguePreparationStagePageV2(f.database, {
        batchId: BATCH,
        document: pageDocument(),
      }),
    ).rejects.toThrow("lost acknowledgement");
    expect(f.queries).toHaveLength(2);
  });
});

describe("V2 independently paged seal client", () => {
  it("retains parser count conservation at 25,000 records", () => {
    const value = JSON.parse(encodeCataloguePreparationParserReportV2(report));
    expect(value).toMatchObject({
      schemaVersion: 2,
      emittedRecordCount: "25000",
      sourceRecordCount: "25001",
    });
    expect(() =>
      encodeCataloguePreparationParserReportV2({ ...report, excludedRecordCount: 2 }),
    ).toThrow("conservation");
  });
  it("binds seal start to the exact retained parser request", async () => {
    const document = encodeCataloguePreparationParserReportV2(report);
    const receipt = {
      schemaVersion: 2,
      batchId: BATCH,
      sealRequestSha256: catalogueDocumentSha256V2(document, 16 * 1024 * 1024),
      parserReportSha256: JSON.parse(document).reportSha256,
      recordCount: "25000",
      payloadTextBytes: "100000000",
      stagePageCount: "100",
    };
    const f = fixture([principal, receipt]);
    await expect(
      beginCataloguePreparationSealV2(f.database, { batchId: BATCH, document }),
    ).resolves.toEqual(receipt);
    expect(f.queries[1]?.parameters).toEqual([BATCH, document]);
  });
  it("uses a bounded server cursor and rejects a wrong verification receipt", async () => {
    const f = fixture([
      principal,
      {
        schemaVersion: 2,
        batchId: BATCH,
        pageNumber: "8",
        nextSequence: "2000",
        recordCommitmentSha256: HASH,
        stageReceiptSha256: OTHER,
        verifiedPayloadTextBytes: "10000000",
      },
    ]);
    await expect(
      verifyCataloguePreparationSealPageV2(f.database, { batchId: BATCH, pageNumber: 7 }),
    ).rejects.toThrow("cursor differs");
    expect(f.queries[1]?.parameters).toEqual([BATCH, "7"]);
  });
  it("retains and verifies the exact small terminal document", async () => {
    const document = encodeCataloguePreparationSealTerminalV2(terminal);
    const receipt = { ...terminal, stagingSealSha256: HASH };
    const f = fixture([principal, receipt]);
    await expect(
      finishCataloguePreparationSealV2(f.database, { batchId: BATCH, document }),
    ).resolves.toEqual(receipt);
    expect(f.queries[1]?.parameters).toEqual([BATCH, document]);
  });
  it("rejects a terminal that drops the final page chain", () => {
    expect(() =>
      encodeCataloguePreparationSealTerminalV2({ ...terminal, stageReceiptSha256: null }),
    ).toThrow("incomplete");
  });
  it("rejects receipt success for a different source count", async () => {
    const document = encodeCataloguePreparationSealTerminalV2(terminal);
    const f = fixture([principal, { ...terminal, recordCount: "24999", stagingSealSha256: HASH }]);
    await expect(
      finishCataloguePreparationSealV2(f.database, { batchId: BATCH, document }),
    ).rejects.toThrow("differs");
  });
});

it("keeps the stage evidence phase CASE parenthesized inside its PL/pgSQL IF", () => {
  const migration = readFileSync(
    new URL("../migrations/0027_catalogue_paged_staging.sql", import.meta.url),
    "utf8",
  );
  const body =
    /create function catalogue_guard_preparation_evidence_insert_v2\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/u.exec(
      migration,
    )?.[1];
  expect(body).toBeDefined();
  // PL/pgSQL otherwise treats the CASE's first THEN as the IF terminator.
  expect(body).toMatch(
    /preparation\.phase is distinct from\s+\(case when tg_table_name = 'catalogue_preparation_seal_page_v2' then 'sealing' else 'staging' end\) then/u,
  );
  expect(body).not.toMatch(/is distinct from\s+case\b/u);
});
