import {
  assertCatalogueSha256V2,
  beginCataloguePreparationSealV2,
  beginCataloguePreparationV2,
  type CatalogueAcceptedPreparationAdmissionV2,
  type CataloguePreparationAdmissionInputV2,
  type CataloguePreparationPageReceiptV2,
  catalogueDocumentSha256V2,
  catalogueFramedSha256V2,
  encodeCataloguePreparationAdmissionV2,
  encodeCataloguePreparationParserReportV2,
  encodeCataloguePreparationSealTerminalV2,
  encodeCataloguePreparationStageIdentityV2,
  encodeCataloguePreparationStagePageV2,
  finishCataloguePreparationSealV2,
  type StageBatchInput,
  submitCataloguePreparationStagePageV2,
  verifyCataloguePreparationSealPageV2,
} from "@nutrition-tracker/db";
import {
  type AuthenticatedReleaseEvidenceBundleV1,
  assertAuthenticatedReleaseEvidenceBundle,
  assertImportReadyManifest,
  assertManifestParserIdentity,
  authenticatedReleaseEvidenceBundleSha256,
  canonicalJson,
  type FoodSourceManifestV4,
} from "@nutrition-tracker/ingestion";
import { buildFdcCsvStageParserReport } from "./fdc-csv-stage.js";
import type { FdcRecordExportHeader, VerifiedFdcRecordExportV2 } from "./fdc-record-reader-v2.js";

/** Caller supplies manifest bytes/URI and build pins verified by the existing CLI boundary. */
export function prepareFdcCsvPagedStageIdentity(input: {
  readonly manifest: FoodSourceManifestV4;
  readonly manifestSha256: string;
  readonly manifestObjectUri: string;
  readonly parserBuildSha256: string;
  readonly nutrientMappingDigest: string;
  readonly evaluatedAt: string;
  readonly releaseEvidence: {
    readonly bundle: AuthenticatedReleaseEvidenceBundleV1;
    readonly bundleSha256: string;
    readonly decisionSha256: string;
  };
}) {
  const { manifest, releaseEvidence } = input;
  assertImportReadyManifest(manifest);
  assertManifestParserIdentity(manifest);
  assertAuthenticatedReleaseEvidenceBundle(manifest, releaseEvidence.bundle, input.evaluatedAt);
  for (const [name, value] of Object.entries({
    manifestSha256: input.manifestSha256,
    parserBuildSha256: input.parserBuildSha256,
    nutrientMappingDigest: input.nutrientMappingDigest,
  }))
    assertCatalogueSha256V2(value, name);
  if (
    manifest.source.code !== "USDA_FDC" ||
    releaseEvidence.bundleSha256 !==
      authenticatedReleaseEvidenceBundleSha256(releaseEvidence.bundle) ||
    releaseEvidence.decisionSha256 !==
      catalogueDocumentSha256V2(
        canonicalJson(releaseEvidence.bundle.authorityDecision),
        16 * 1024 * 1024,
      )
  )
    throw new Error("V2 FDC stage identity differs from its verified release evidence");
  const parserVersion = requiredText(manifest.ingestion.parserVersion, "parserVersion");
  const artifactSha256 = requiredText(manifest.artifact.sha256, "artifactSha256");
  assertCatalogueSha256V2(artifactSha256, "artifactSha256");
  const artifactByteSize = safeCount(
    requiredTextOrNumber(manifest.artifact.byteSize, "artifactByteSize"),
    "artifactByteSize",
  );
  const batch: StageBatchInput = {
    acquiredAt: requiredText(manifest.release.acquiredAt, "acquiredAt"),
    artifactBytes: artifactByteSize,
    artifactSha256,
    artifactUri: requiredText(manifest.artifact.objectUri, "artifactObjectUri"),
    evidenceBundleSha256: releaseEvidence.bundleSha256,
    evidenceBundleUri: requiredText(manifest.evidenceBundle.objectUri, "evidenceBundleUri"),
    evidenceDecisionSha256: releaseEvidence.decisionSha256,
    evidenceObjectVersionId: releaseEvidence.bundle.candidate.artifact.objectVersionId,
    evidenceValidUntil: releaseEvidence.bundle.currentRetention.validUntil,
    mediaType: manifest.artifact.mediaType,
    parserVersion: `${parserVersion}+build.${input.parserBuildSha256}+mapping.${input.nutrientMappingDigest}`,
    publishedOn: manifest.release.publishedOn,
    releaseKey: manifest.release.releaseKey,
    releaseClass: manifest.releaseClass,
    rightsManifestSha256: input.manifestSha256,
    rightsManifestUri: requiredText(input.manifestObjectUri, "manifestObjectUri"),
    sourceCode: manifest.source.code,
    upstreamSchemaVersion: manifest.release.upstreamSchemaVersion,
  };
  const expectedHeader: FdcRecordExportHeader = {
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
    artifactByteSize,
    artifactSha256,
    manifestSha256: input.manifestSha256,
    parserBuildSha256: input.parserBuildSha256,
    parserPackage: manifest.ingestion.parserPackage,
    parserVersion,
    releaseKey: manifest.release.releaseKey,
    sourceCode: manifest.source.code,
    ordering: "sha256-partition-then-fdc-id-v1",
  };
  const expectedBaseline: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(manifest.validation.releaseSpecificExpectations)) {
    if (!key.startsWith("parserBaselineCsv")) continue;
    if (typeof value !== "number" && typeof value !== "string")
      throw new Error("V2 FDC reviewed parser baseline value is invalid");
    expectedBaseline[key] = value;
  }
  return {
    batch,
    stageDocument: encodeCataloguePreparationStageIdentityV2(batch),
    expectedHeader,
    expectedBaseline,
  };
}

export interface FdcCsvPagedStageInput {
  readonly admission: CatalogueAcceptedPreparationAdmissionV2;
  readonly batch: StageBatchInput;
  readonly records: VerifiedFdcRecordExportV2;
  readonly signal?: AbortSignal;
}

/** Read this from the restricted SQL admission getter before opening the export. */
export function fdcPagedStageAdmissionLimits(admission: CatalogueAcceptedPreparationAdmissionV2) {
  const accepted = acceptedDocument(admission);
  return {
    maxRecords: safeCount(accepted.maxRecords, "maxRecords"),
    maxPayloadTextBytes: safeCount(accepted.maxPayloadTextBytes, "maxPayloadTextBytes"),
    maxSnapshotBytes: safeCount(accepted.exportBytes, "exportBytes"),
  };
}

/**
 * One bounded scan replays the immutable source/receipt chain from zero. SQL
 * retains every exact page request and rejects different bytes. A lost reply
 * stops this invocation; a later explicit invocation verifies the export again.
 * The caller owns closing the verified reader and database, including failures.
 */
export async function stageVerifiedFdcCsvExportV2(
  database: Parameters<typeof beginCataloguePreparationV2>[0],
  input: FdcCsvPagedStageInput,
) {
  input.signal?.throwIfAborted();
  const accepted = acceptedDocument(input.admission);
  const { header, evidence, inspection } = input.records;
  const stageDocument = encodeCataloguePreparationStageIdentityV2(input.batch);
  const mappingDigest = /\+mapping\.([0-9a-f]{64})$/u.exec(input.batch.parserVersion)?.[1];
  if (
    input.records.protocolVersion !== 2 ||
    !mappingDigest ||
    accepted.stageDocument !== stageDocument ||
    accepted.manifestSha256 !== header.manifestSha256 ||
    accepted.exportSha256 !== evidence.sha256 ||
    String(accepted.exportBytes) !== String(evidence.byteSize) ||
    header.artifactSha256 !== input.batch.artifactSha256 ||
    String(header.artifactByteSize) !== String(input.batch.artifactBytes) ||
    header.sourceCode !== input.batch.sourceCode ||
    header.releaseKey !== input.batch.releaseKey ||
    input.batch.rightsManifestSha256 !== header.manifestSha256 ||
    input.batch.parserVersion !==
      `${header.parserVersion}+build.${header.parserBuildSha256}+mapping.${mappingDigest}` ||
    inspection.manifestSha256 !== header.manifestSha256 ||
    inspection.parserBuildSha256 !== header.parserBuildSha256 ||
    inspection.parserVersion !== header.parserVersion ||
    inspection.parserPackage !== header.parserPackage ||
    inspection.releaseKey !== header.releaseKey ||
    BigInt(evidence.recordCount) > BigInt(accepted.maxRecords) ||
    BigInt(evidence.postgresPayloadByteUpperBound) > BigInt(accepted.maxPayloadTextBytes)
  )
    throw new Error(
      "V2 FDC export, parser, source or resource identity differs from accepted admission",
    );
  const originalReport = buildFdcCsvStageParserReport({
    records: input.records,
    artifactSha256: input.batch.artifactSha256,
    nutrientMappingDigest: mappingDigest,
    parserBuildSha256: header.parserBuildSha256,
    parserPackage: header.parserPackage,
    parserVersion: header.parserVersion,
    releaseKey: header.releaseKey,
    sourceCode: header.sourceCode,
  });
  const report = {
    ...originalReport,
    report: {
      ...originalReport.report,
      reportKind: "usda-fdc-full-csv-capability-stage-v2",
      schemaVersion: 2,
      preparationAdmissionSha256: input.admission.admissionSha256,
    },
  };
  // UUID width is fixed and this identifier is not included in the parser wire document.
  encodeCataloguePreparationParserReportV2({
    ...report,
    batchId: "00000000-0000-4000-8000-000000000000",
  });
  const staged = await beginCataloguePreparationV2(database, {
    admissionSha256: input.admission.admissionSha256,
    stageDocument,
  });
  const parserDocument = encodeCataloguePreparationParserReportV2({
    ...report,
    batchId: staged.batchId,
  });
  const initialCount = BigInt(staged.nextSequence);
  const total = BigInt(evidence.recordCount);
  if (initialCount > total || (staged.phase !== "staging" && initialCount !== total))
    throw new Error("V2 FDC preparation receipt exceeds or truncates the verified source");
  let nextSequence = 0n;
  let pageNumber = 0n;
  let totalPayloadTextBytes = "0";
  let lastReceipt: CataloguePreparationPageReceiptV2 | undefined;
  let recordCommitmentSha256 = catalogueFramedSha256V2("stage-header", [
    staged.batchId,
    input.admission.admissionSha256,
    accepted.manifestSha256,
    accepted.exportSha256,
    String(accepted.exportBytes),
    input.batch.parserVersion,
  ]);

  function checkResumeBoundary(): void {
    if (nextSequence !== initialCount) return;
    if (
      staged.stagePageCount !== String(pageNumber) ||
      staged.payloadTextBytes !== totalPayloadTextBytes ||
      staged.recordCommitmentSha256 !== recordCommitmentSha256 ||
      staged.lastPageReceiptSha256 !== (lastReceipt?.receiptSha256 ?? null)
    )
      throw new Error("V2 FDC resumed prefix differs from the exact retained receipt chain");
  }
  checkResumeBoundary();
  for await (const page of input.records.pages({ nextOffset: 0 })) {
    input.signal?.throwIfAborted();
    if (
      BigInt(page.expectedNextOffset) !== nextSequence ||
      page.records.length < 1 ||
      page.records.length > 250 ||
      page.nextOffset !== page.expectedNextOffset + page.records.length ||
      BigInt(page.nextOffset) > total ||
      (nextSequence < initialCount && BigInt(page.nextOffset) > initialCount)
    )
      throw new Error("V2 FDC source page differs from its deterministic resumable boundary");
    const document = encodeCataloguePreparationStagePageV2({
      batchId: staged.batchId,
      admissionSha256: input.admission.admissionSha256,
      parserVersion: input.batch.parserVersion,
      pageNumber,
      firstSequence: nextSequence,
      previousReceiptSha256: lastReceipt?.receiptSha256 ?? null,
      records: page.records,
    });
    const receipt = await submitCataloguePreparationStagePageV2(database, {
      batchId: staged.batchId,
      document,
    });
    if (
      receipt.nextSequence !== String(page.nextOffset) ||
      receipt.pageNumber !== String(pageNumber) ||
      receipt.firstSequence !== String(nextSequence) ||
      receipt.recordCount !== String(page.records.length) ||
      receipt.previousReceiptSha256 !== (lastReceipt?.receiptSha256 ?? null) ||
      BigInt(receipt.totalPayloadTextBytes) !==
        BigInt(totalPayloadTextBytes) + BigInt(receipt.payloadTextBytes)
    )
      throw new Error("V2 FDC stage receipt does not continue its exact source page");
    lastReceipt = receipt;
    nextSequence = BigInt(page.nextOffset);
    pageNumber += 1n;
    totalPayloadTextBytes = receipt.totalPayloadTextBytes;
    recordCommitmentSha256 = receipt.recordCommitmentSha256;
    checkResumeBoundary();
    input.signal?.throwIfAborted();
  }
  if (nextSequence !== total)
    throw new Error("V2 FDC staging ended before its complete verified export");
  const sealStart = await beginCataloguePreparationSealV2(database, {
    batchId: staged.batchId,
    document: parserDocument,
  });
  if (
    sealStart.recordCount !== String(total) ||
    sealStart.payloadTextBytes !== totalPayloadTextBytes ||
    sealStart.stagePageCount !== String(pageNumber)
  )
    throw new Error("V2 FDC seal start differs from complete stage accounting");
  for (let cursor = 0n; cursor < pageNumber; cursor += 1n) {
    input.signal?.throwIfAborted();
    const verified = await verifyCataloguePreparationSealPageV2(database, {
      batchId: staged.batchId,
      pageNumber: cursor,
    });
    if (
      verified.pageNumber !== String(cursor) ||
      BigInt(verified.nextSequence) > total ||
      (cursor + 1n === pageNumber &&
        (verified.nextSequence !== String(total) ||
          verified.recordCommitmentSha256 !== recordCommitmentSha256 ||
          verified.stageReceiptSha256 !== lastReceipt?.receiptSha256 ||
          verified.verifiedPayloadTextBytes !== totalPayloadTextBytes))
    )
      throw new Error("V2 FDC independent SQL seal verification differs from stage receipts");
    input.signal?.throwIfAborted();
  }
  input.signal?.throwIfAborted();
  const terminalDocument = encodeCataloguePreparationSealTerminalV2({
    schemaVersion: 2,
    batchId: staged.batchId,
    admissionSha256: input.admission.admissionSha256,
    recordCount: String(total),
    payloadTextBytes: totalPayloadTextBytes,
    recordCommitmentSha256,
    stageReceiptSha256: lastReceipt?.receiptSha256 ?? null,
    parserReportSha256: sealStart.parserReportSha256,
    sealRequestSha256: sealStart.sealRequestSha256,
  });
  const sealed = await finishCataloguePreparationSealV2(database, {
    batchId: staged.batchId,
    document: terminalDocument,
  });
  input.signal?.throwIfAborted();
  return {
    schemaVersion: 2 as const,
    batchId: staged.batchId,
    phase: "sealed" as const,
    staged: String(total),
    stagePages: String(pageNumber),
    payloadTextBytes: totalPayloadTextBytes,
    stagingSealSha256: sealed.stagingSealSha256,
    validationPending: true as const,
    activationAuthorized: false as const,
  };
}

function acceptedDocument(
  admission: CatalogueAcceptedPreparationAdmissionV2,
): CataloguePreparationAdmissionInputV2 {
  const requestSha256 = catalogueDocumentSha256V2(admission.requestDocument, 131072);
  if (
    admission.schemaVersion !== 2 ||
    requestSha256 !== admission.requestSha256 ||
    catalogueFramedSha256V2("admission", [requestSha256, admission.admittedBy]) !==
      admission.admissionSha256
  )
    throw new Error("V2 FDC admission receipt differs from retained request");
  const document: Record<string, unknown> = JSON.parse(admission.requestDocument);
  const { schemaVersion, ...fields } = document;
  if (schemaVersion !== 2) throw new Error("V2 FDC admission version differs");
  const accepted = fields as unknown as CataloguePreparationAdmissionInputV2;
  // Validate all budget/identity fields without replacing the retained bytes.
  encodeCataloguePreparationAdmissionV2(accepted);
  return accepted;
}
function safeCount(value: string | number | bigint, name: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || String(count) !== String(value))
    throw new Error(`V2 FDC ${name} cannot be represented as a safe file-reader limit`);
  return count;
}
function requiredText(value: string | null | undefined, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`V2 FDC ${name} is absent`);
  return value;
}
function requiredTextOrNumber(value: number | null | undefined, name: string): number {
  if (typeof value !== "number") throw new Error(`V2 FDC ${name} is absent`);
  return value;
}
