import {
  type CataloguePreparationPageReceiptV2,
  catalogueDocumentSha256V2,
  catalogueFramedSha256V2,
  encodeCataloguePreparationAdmissionV2,
  encodeCataloguePreparationStageIdentityV2,
  type StageBatchInput,
} from "@nutrition-tracker/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FdcCsvPagedStageInput,
  fdcPagedStageAdmissionLimits,
  stageVerifiedFdcCsvExportV2,
} from "../src/fdc-csv-paged-stage.js";
import type {
  FdcRecordExportHeader,
  VerifiedFdcRecordExportV2,
} from "../src/fdc-record-reader-v2.js";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  page: vi.fn(),
  sealStart: vi.fn(),
  verify: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("@nutrition-tracker/db", async (original) => ({
  ...(await original<typeof import("@nutrition-tracker/db")>()),
  beginCataloguePreparationV2: mocks.begin,
  submitCataloguePreparationStagePageV2: mocks.page,
  beginCataloguePreparationSealV2: mocks.sealStart,
  verifyCataloguePreparationSealPageV2: mocks.verify,
  finishCataloguePreparationSealV2: mocks.finish,
}));

const BATCH = "12345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const BUILD = "c".repeat(64);
const MAPPING = "d".repeat(64);
const EXPORT = "e".repeat(64);
const DATABASE = {} as Parameters<typeof stageVerifiedFdcCsvExportV2>[0];
const header: FdcRecordExportHeader = {
  recordType: "header",
  format: "usda-fdc-csv-normalized-record-export-v1",
  schemaVersion: 1,
  authority: {
    acquisition: false,
    review: false,
    staging: false,
    promotion: false,
    activation: false,
  },
  artifactByteSize: 1024,
  artifactSha256: HASH,
  manifestSha256: MANIFEST,
  parserBuildSha256: BUILD,
  parserPackage: "@nutrition-tracker/ingestion",
  parserVersion: "0.1.0",
  sourceCode: "USDA_FDC",
  releaseKey: "synthetic-release",
  ordering: "sha256-partition-then-fdc-id-v1",
};
const batch: StageBatchInput = {
  acquiredAt: "2026-09-21T00:00:00Z",
  artifactBytes: 1024,
  artifactSha256: HASH,
  artifactUri: "s3://fixture/artifact.zip",
  evidenceBundleSha256: HASH,
  evidenceBundleUri: "s3://fixture/evidence.json",
  evidenceDecisionSha256: HASH,
  evidenceObjectVersionId: "fixture-v1",
  evidenceValidUntil: "2026-09-21T12:00:00Z",
  mediaType: "application/zip",
  parserVersion: `0.1.0+build.${BUILD}+mapping.${MAPPING}`,
  releaseClass: "fixture-nonrelease",
  releaseKey: header.releaseKey,
  rightsManifestSha256: MANIFEST,
  rightsManifestUri: "s3://fixture/manifest.json",
  sourceCode: header.sourceCode,
};
let input: FdcCsvPagedStageInput;
let pages: { document: string; receipt: CataloguePreparationPageReceiptV2 }[];
let phase: "staging" | "sealing" | "sealed";
let parserDocument: string | undefined;
let terminalDocument: string | undefined;
function headerCommitment() {
  return catalogueFramedSha256V2("stage-header", [
    BATCH,
    input.admission.admissionSha256,
    MANIFEST,
    EXPORT,
    "12345",
    batch.parserVersion,
  ]);
}
beforeEach(() => {
  vi.resetAllMocks();
  input = makeInput(501);
  pages = [];
  phase = "staging";
  parserDocument = undefined;
  terminalDocument = undefined;
  mocks.begin.mockImplementation(async () => {
    const last = pages.at(-1)?.receipt;
    return {
      schemaVersion: 2,
      batchId: BATCH,
      admissionSha256: input.admission.admissionSha256,
      phase,
      nextSequence: last?.nextSequence ?? "0",
      payloadTextBytes: last?.totalPayloadTextBytes ?? "0",
      stagePageCount: String(pages.length),
      recordCommitmentSha256: last?.recordCommitmentSha256 ?? headerCommitment(),
      lastPageReceiptSha256: last?.receiptSha256 ?? null,
    };
  });
  mocks.page.mockImplementation(async (_db, request: { document: string }) => {
    const page = JSON.parse(request.document);
    const number = Number(page.pageNumber);
    const old = pages[number];
    if (old) {
      if (old.document !== request.document) throw new Error("Changed retained SQL page request");
      return old.receipt;
    }
    if (phase !== "staging" || number !== pages.length) throw new Error("Wrong phase or page");
    const requestSha256 = catalogueDocumentSha256V2(request.document, 16 * 1024 * 1024);
    const recordCommitmentSha256 = catalogueFramedSha256V2("fixture-records", [
      pages.at(-1)?.receipt.recordCommitmentSha256 ?? headerCommitment(),
      requestSha256,
    ]);
    const firstSequence = page.firstSequence;
    const nextSequence = String(BigInt(firstSequence) + BigInt(page.records.length));
    const payloadTextBytes = String(page.records.length * 100);
    const totalPayloadTextBytes = String(Number(nextSequence) * 100);
    const receipt: CataloguePreparationPageReceiptV2 = {
      schemaVersion: 2,
      batchId: BATCH,
      admissionSha256: input.admission.admissionSha256,
      pageNumber: String(number),
      firstSequence,
      nextSequence,
      recordCount: String(page.records.length),
      payloadTextBytes,
      totalPayloadTextBytes,
      recordCommitmentSha256,
      requestSha256,
      previousReceiptSha256: page.previousReceiptSha256,
      receiptSha256: catalogueFramedSha256V2("stage-page", [
        BATCH,
        input.admission.admissionSha256,
        batch.parserVersion,
        String(number),
        firstSequence,
        nextSequence,
        page.previousReceiptSha256 ?? "",
        requestSha256,
        recordCommitmentSha256,
        payloadTextBytes,
        totalPayloadTextBytes,
      ]),
    };
    pages.push({ document: request.document, receipt });
    return receipt;
  });
  mocks.sealStart.mockImplementation(async (_db, request: { document: string }) => {
    if (parserDocument !== undefined && parserDocument !== request.document)
      throw new Error("Changed parser request");
    parserDocument = request.document;
    if (phase === "staging") phase = "sealing";
    const parsed = JSON.parse(request.document);
    return {
      schemaVersion: 2,
      batchId: BATCH,
      sealRequestSha256: catalogueDocumentSha256V2(request.document, 16 * 1024 * 1024),
      parserReportSha256: parsed.reportSha256,
      recordCount: String(input.records.evidence.recordCount),
      payloadTextBytes: pages.at(-1)?.receipt.totalPayloadTextBytes ?? "0",
      stagePageCount: String(pages.length),
    };
  });
  mocks.verify.mockImplementation(async (_db, request: { pageNumber: bigint }) => {
    const receipt = pages[Number(request.pageNumber)]?.receipt;
    if (!receipt) throw new Error("Missing SQL receipt");
    return {
      schemaVersion: 2,
      batchId: BATCH,
      pageNumber: receipt.pageNumber,
      nextSequence: receipt.nextSequence,
      recordCommitmentSha256: receipt.recordCommitmentSha256,
      stageReceiptSha256: receipt.receiptSha256,
      verifiedPayloadTextBytes: receipt.totalPayloadTextBytes,
    };
  });
  mocks.finish.mockImplementation(async (_db, request: { document: string }) => {
    if (terminalDocument !== undefined && terminalDocument !== request.document)
      throw new Error("Changed terminal request");
    terminalDocument = request.document;
    phase = "sealed";
    return { ...JSON.parse(request.document), stagingSealSha256: HASH };
  });
});

describe("V2 verified FDC stage orchestration", () => {
  it("derives source allocation limits from the exact admitted request", () => {
    expect(fdcPagedStageAdmissionLimits(input.admission)).toEqual({
      maxRecords: 25000,
      maxPayloadTextBytes: 268435456,
      maxSnapshotBytes: 12345,
    });
    expect(() =>
      fdcPagedStageAdmissionLimits({
        ...input.admission,
        requestDocument: `${input.admission.requestDocument} `,
      }),
    ).toThrow("differs");
  });
  it("stages bounded source pages and independently verifies every page before its terminal", async () => {
    const result = await stageVerifiedFdcCsvExportV2(DATABASE, input);
    expect(result).toMatchObject({
      phase: "sealed",
      staged: "501",
      stagePages: "3",
      validationPending: true,
      activationAuthorized: false,
    });
    expect(
      mocks.page.mock.calls.map((call) => JSON.parse(call[1].document).records.length),
    ).toEqual([250, 250, 1]);
    expect(mocks.verify.mock.calls.map((call) => call[1].pageNumber)).toEqual([0n, 1n, 2n]);
    expect(mocks.finish.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.verify.mock.invocationCallOrder.at(-1) ?? 0,
    );
    const report = JSON.parse(JSON.parse(parserDocument ?? "").reportDocument);
    expect(report).toMatchObject({
      reportKind: "usda-fdc-full-csv-capability-stage-v2",
      schemaVersion: 2,
      preparationAdmissionSha256: input.admission.admissionSha256,
      nutrientMappingDigest: MAPPING,
      recordsExport: { sha256: EXPORT, byteSize: 12345, recordCount: 501 },
    });
  });
  it("replays a fully sealed source with byte-identical requests and the same terminal", async () => {
    await stageVerifiedFdcCsvExportV2(DATABASE, input);
    const retainedPages = pages.map((page) => page.document);
    const retainedTerminal = terminalDocument;
    await stageVerifiedFdcCsvExportV2(DATABASE, input);
    expect(pages.map((page) => page.document)).toEqual(retainedPages);
    expect(terminalDocument).toBe(retainedTerminal);
    expect(mocks.page).toHaveBeenCalledTimes(6);
    expect(mocks.verify).toHaveBeenCalledTimes(6);
  });
  it("stops on a lost post-commit acknowledgement and resumes only on a new invocation", async () => {
    const implementation = mocks.page.getMockImplementation();
    if (!implementation) throw new Error("Missing mock");
    mocks.page.mockImplementationOnce(async (...args) => {
      await implementation(...args);
      throw new Error("lost acknowledgement");
    });
    await expect(stageVerifiedFdcCsvExportV2(DATABASE, input)).rejects.toThrow(
      "lost acknowledgement",
    );
    expect(pages).toHaveLength(1);
    expect(mocks.page).toHaveBeenCalledOnce();
    expect(mocks.sealStart).not.toHaveBeenCalled();
    await expect(stageVerifiedFdcCsvExportV2(DATABASE, input)).resolves.toMatchObject({
      staged: "501",
    });
    expect(mocks.page.mock.calls[0]?.[1].document).toBe(mocks.page.mock.calls[1]?.[1].document);
  });
  it.each(["manifest", "export", "parser", "source", "protocol"])(
    "rejects changed %s before creating a batch",
    async (kind) => {
      let changed = input;
      if (kind === "manifest")
        changed = {
          ...input,
          records: { ...input.records, header: { ...header, manifestSha256: HASH } },
        };
      if (kind === "export")
        changed = {
          ...input,
          records: { ...input.records, evidence: { ...input.records.evidence, sha256: HASH } },
        };
      if (kind === "parser")
        changed = {
          ...input,
          batch: { ...batch, parserVersion: `0.1.0+build.${HASH}+mapping.${MAPPING}` },
        };
      if (kind === "source") changed = { ...input, batch: { ...batch, sourceCode: "OTHER" } };
      if (kind === "protocol")
        changed = {
          ...input,
          records: { ...input.records, protocolVersion: 1 } as unknown as VerifiedFdcRecordExportV2,
        };
      await expect(stageVerifiedFdcCsvExportV2(DATABASE, changed)).rejects.toThrow(
        "identity differs",
      );
      expect(mocks.begin).not.toHaveBeenCalled();
    },
  );
  it("rejects bad conservation before creating the attempt", async () => {
    const changed = {
      ...input,
      records: {
        ...input.records,
        inspection: {
          ...input.records.inspection,
          conservation: { foods: { acceptedCount: 501, quarantinedCount: 0, sourceCount: 500 } },
        },
      },
    };
    await expect(stageVerifiedFdcCsvExportV2(DATABASE, changed)).rejects.toThrow();
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it("rejects a resumed checkpoint inside a deterministic page before appending", async () => {
    mocks.begin.mockResolvedValueOnce({
      schemaVersion: 2,
      batchId: BATCH,
      admissionSha256: input.admission.admissionSha256,
      phase: "staging",
      nextSequence: "249",
      stagePageCount: "1",
      payloadTextBytes: "24900",
      recordCommitmentSha256: HASH,
      lastPageReceiptSha256: HASH,
    });
    await expect(stageVerifiedFdcCsvExportV2(DATABASE, input)).rejects.toThrow(
      "deterministic resumable boundary",
    );
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("rejects tampered durable prefix evidence before a new page", async () => {
    const implementation = mocks.page.getMockImplementation();
    if (!implementation) throw new Error("Missing mock");
    mocks.page.mockImplementationOnce(async (...args) => {
      await implementation(...args);
      throw new Error("pause");
    });
    await expect(stageVerifiedFdcCsvExportV2(DATABASE, input)).rejects.toThrow("pause");
    const begin = mocks.begin.getMockImplementation();
    if (!begin) throw new Error("Missing mock");
    mocks.begin.mockImplementationOnce(async (...args) => ({
      ...(await begin(...args)),
      recordCommitmentSha256: HASH,
    }));
    await expect(stageVerifiedFdcCsvExportV2(DATABASE, input)).rejects.toThrow(
      "resumed prefix differs",
    );
    expect(pages).toHaveLength(1);
  });
  it("withholds the terminal after independent verification disagreement", async () => {
    const implementation = mocks.verify.getMockImplementation();
    if (!implementation) throw new Error("Missing mock");
    mocks.verify.mockImplementation(async (...args) => ({
      ...(await implementation(...args)),
      verifiedPayloadTextBytes: "1",
    }));
    await expect(stageVerifiedFdcCsvExportV2(DATABASE, input)).rejects.toThrow(
      "verification differs",
    );
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it("cancels after an acknowledged page without advancing to sealing", async () => {
    const controller = new AbortController();
    const implementation = mocks.page.getMockImplementation();
    if (!implementation) throw new Error("Missing mock");
    mocks.page.mockImplementationOnce(async (...args) => {
      const receipt = await implementation(...args);
      controller.abort();
      return receipt;
    });
    await expect(
      stageVerifiedFdcCsvExportV2(DATABASE, { ...input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(pages).toHaveLength(1);
    expect(mocks.sealStart).not.toHaveBeenCalled();
  });
});

function makeInput(count: number): FdcCsvPagedStageInput {
  const requestDocument = encodeCataloguePreparationAdmissionV2({
    stageDocument: encodeCataloguePreparationStageIdentityV2(batch),
    manifestSha256: MANIFEST,
    exportSha256: EXPORT,
    exportBytes: "12345",
    stagePrincipal: "stage_fixture",
    maxRecords: "25000",
    maxPayloadTextBytes: "268435456",
    maxIntermediateBytes: "1073741824",
    maxValidationEvidenceBytes: "536870912",
    maxReconciliationEvidenceBytes: "1073741824",
    maxBaselineRecords: "25000",
    maxBaselinePayloadBytes: "268435456",
    reviewReference: "synthetic scope",
  });
  const requestSha256 = catalogueDocumentSha256V2(requestDocument, 131072);
  return {
    batch,
    admission: {
      schemaVersion: 2,
      requestDocument,
      requestSha256,
      admittedBy: "quality_fixture",
      admissionSha256: catalogueFramedSha256V2("admission", [requestSha256, "quality_fixture"]),
    },
    records: {
      protocolVersion: 2,
      header,
      evidence: {
        path: "/fixture/records.ndjson",
        byteSize: 12345,
        sha256: EXPORT,
        recordCount: count,
        recordsSha256: HASH,
        nutrientCount: 0,
        servingCount: 0,
        postgresPayloadByteUpperBound: count * 100,
      },
      inspection: {
        manifestSha256: MANIFEST,
        parserBuildSha256: BUILD,
        parserVersion: "0.1.0",
        parserPackage: header.parserPackage,
        releaseKey: header.releaseKey,
        metrics: {
          acceptedFoodCount: count,
          quarantinedFoodCount: 0,
          stagedNutrientCount: 0,
          stagedPortionCount: 0,
          excludedNutrientCount: 0,
          excludedPortionCount: 0,
          derivedLabelServingCount: 0,
        },
        conservation: {
          foods: { acceptedCount: count, quarantinedCount: 0, sourceCount: count },
          foodNutrients: {
            emittedCount: 0,
            excludedCount: 0,
            quarantinedParentCount: 0,
            sourceCount: 0,
          },
          foodPortions: {
            emittedCount: 0,
            excludedCount: 0,
            quarantinedParentCount: 0,
            sourceCount: 0,
          },
        },
      },
      async *pages({ nextOffset }) {
        if (nextOffset !== 0) throw new Error("Full pinned chain required");
        for (let start = 0; start < count; start += 250) {
          const length = Math.min(250, count - start);
          yield {
            expectedNextOffset: start,
            nextOffset: start + length,
            recordsDocumentBytes: length * 100,
            records: Array.from({ length }, (_, offset) => ({
              sequenceNumber: start + offset,
              sourceRecordKey: `source:${start + offset}`,
              sourceRecordType: "Foundation",
              sourcePayloadSha256: HASH,
              canonicalPayload: { record: start + offset },
            })),
          };
        }
      },
      close: async () => undefined,
    },
  };
}
