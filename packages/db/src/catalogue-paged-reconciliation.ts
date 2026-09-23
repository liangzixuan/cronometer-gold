import { type Kysely, sql } from "kysely";
import type { CatalogueApprovalRole } from "./catalogue-capability-approval.js";
import { catalogueDocumentSha256V2, catalogueFramedSha256V2 } from "./catalogue-paged-protocol.js";
import {
  canonicalJson,
  type ReviewedCatalogueNutrientMapping,
  readCatalogueBarcodeEvidence,
  sha256CanonicalJson,
  validateCatalogueRecord,
} from "./catalogue-validation.js";
import type { Database, JsonObject, JsonValue } from "./types.js";

const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PRINCIPAL = /^[a-z][-a-z0-9._:@/]{2,62}$/u;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
export const CATALOGUE_PAGED_RECONCILIATION_REPORT_TYPE =
  "nutrition-tracker.catalogue-reconciliation" as const;

export interface RetainedCatalogueValidationPageV2 {
  readonly pageNumber: string;
  readonly requestDocument: string;
  readonly requestSha256: string;
  readonly receiptSha256: string;
}
export interface ReconcileCataloguePagedBatchInput {
  readonly batchId: string;
  readonly validationTerminalSha256: string;
  readonly expectedCurrentReleaseId: string | null;
  readonly principalId: string;
}
export interface CataloguePagedReconciliationPage {
  readonly batchId: string;
  readonly contextSha256: string;
  readonly pageNumber: string;
  readonly stream: "metadata" | "baseline" | "candidate" | "removed";
  readonly startSequence: string;
  readonly endSequence: string;
  readonly document: string;
  readonly documentSha256: string;
  readonly previousCommitmentSha256: string;
  readonly commitmentSha256: string;
  readonly complete: boolean;
}
export interface CataloguePagedReconciliationTerminal {
  readonly schemaVersion: 3;
  readonly reportType: typeof CATALOGUE_PAGED_RECONCILIATION_REPORT_TYPE;
  readonly batchId: string;
  readonly contextSha256: string;
  readonly validationTerminalSha256: string;
  readonly reportSha256: string;
  readonly pageCount: string;
  readonly pageCommitmentSha256: string;
  readonly counts: Readonly<Record<string, string>>;
  readonly promotionAvailable: false;
}
export interface SubmitCataloguePagedApprovalInput {
  readonly batchId: string;
  readonly approvalRole: CatalogueApprovalRole;
  readonly principalId: string;
  readonly rightsManifestSha256: string;
  readonly validationTerminalSha256: string;
  readonly reportSha256: string;
  readonly contextSha256: string;
  readonly approvalReference: string;
}
export interface CataloguePagedApprovalReceipt {
  readonly approvalRole: CatalogueApprovalRole;
  readonly databasePrincipal: string;
  readonly reportSha256: string;
  readonly wasAlreadyApproved: boolean;
  readonly promotionAvailable: false;
}
interface InputEvidence {
  readonly batchId: string;
  readonly databasePrincipal: string;
  readonly baselineReleaseId: string | null;
  readonly validationTerminalSha256: string;
  readonly validationPageCount: string;
  readonly validationContextSha256: string;
  readonly validationCommitmentSha256: string;
  readonly contextSha256: string;
  readonly baselineEvidence: JsonObject | null;
  readonly maximumReconciliationEvidenceBytes: string;
}

/**
 * Verify every retained validation request before creating reconciliation state.
 * SQL derives report bytes from frozen evidence. The sink is provisional until
 * the terminal returns; failure leaves resumable private preparation, never a release.
 */
export async function reconcileCataloguePagedBatch(
  database: Kysely<Database>,
  input: ReconcileCataloguePagedBatchInput,
  options: {
    readonly validationPages: AsyncIterable<RetainedCatalogueValidationPageV2>;
    readonly consumePage: (page: CataloguePagedReconciliationPage) => Promise<void>;
    readonly admitEvidenceBudget?: (maximumBytes: string) => void;
    readonly signal?: AbortSignal;
  },
): Promise<CataloguePagedReconciliationTerminal> {
  keys(input, ["batchId", "validationTerminalSha256", "expectedCurrentReleaseId", "principalId"]);
  uuid(input.batchId);
  sha(input.validationTerminalSha256);
  principal(input.principalId);
  if (input.expectedCurrentReleaseId !== null) uuid(input.expectedCurrentReleaseId);
  const request = { ...input };
  aborted(options.signal);
  const evidence = parseInputEvidence(
    await query(
      database,
      sql`
    select public.catalogue_reconciliation_input_v2(
      ${request.batchId}::uuid, ${request.validationTerminalSha256}::text
    ) as result
  `,
    ),
  );
  if (
    evidence.batchId !== request.batchId ||
    evidence.databasePrincipal !== request.principalId ||
    evidence.baselineReleaseId !== request.expectedCurrentReleaseId ||
    evidence.validationTerminalSha256 !== request.validationTerminalSha256
  )
    throw new Error("Reconciliation input identity differs from the explicit pins");
  options.admitEvidenceBudget?.(evidence.maximumReconciliationEvidenceBytes);
  const baseline = verifyCataloguePagedBaselineHeader(evidence.baselineEvidence);
  let pageNumber = 0;
  let validationCommitment = catalogueFramedSha256V2("validation-start", [
    request.batchId,
    evidence.validationContextSha256,
  ]);
  for await (const retained of options.validationPages) {
    aborted(options.signal);
    keys(retained, ["pageNumber", "requestDocument", "requestSha256", "receiptSha256"]);
    if (
      retained.pageNumber !== String(pageNumber) ||
      pageNumber >= Number(evidence.validationPageCount)
    )
      throw new Error(
        "Retained validation journal is reordered, duplicated or longer than SQL evidence",
      );
    exactDocument(retained.requestDocument, retained.requestSha256);
    sha(retained.receiptSha256);
    // Compare the exact retained bytes beside the immutable SQL evidence. Returning
    // that document again would allocate a second page plus its JSON wire encoding.
    const checked = await query(
      database,
      sql`
      with retained_page as materialized (
        select public.catalogue_reconciliation_validation_page_v2(
          ${request.batchId}::uuid, ${request.validationTerminalSha256}::text,
          ${pageNumber}::bigint
        ) as evidence
      )
      select pg_catalog.jsonb_build_object(
        'page', evidence - 'requestDocument',
        'requestDocumentMatches', coalesce(
          pg_catalog.jsonb_typeof(evidence->'requestDocument') = 'string'
          and pg_catalog.convert_to(evidence->>'requestDocument', 'UTF8')
            = pg_catalog.convert_to(${retained.requestDocument}::text, 'UTF8'),
          false
        )
      ) as result from retained_page
    `,
    );
    exactOwnKeys(checked, ["page", "requestDocumentMatches"]);
    const stored = checked.page;
    exactOwnKeys(stored, [
      "pageNumber",
      "requestSha256",
      "receiptSha256",
      "contextSha256",
      "startSequence",
      "endSequence",
      "observationSha256",
      "validationCommitmentSha256",
      "semanticCommitmentSha256",
    ]);
    if (
      checked.requestDocumentMatches !== true ||
      stored.pageNumber !== String(pageNumber) ||
      stored.requestSha256 !== retained.requestSha256 ||
      stored.receiptSha256 !== retained.receiptSha256 ||
      stored.contextSha256 !== evidence.validationContextSha256
    )
      throw new Error("Retained validation page differs from immutable SQL evidence");
    const start = unsigned(stored.startSequence);
    const end = unsigned(stored.endSequence);
    sha(stored.observationSha256);
    sha(stored.semanticCommitmentSha256);
    validationCommitment = catalogueFramedSha256V2("validation-page", [
      validationCommitment,
      evidence.validationContextSha256,
      String(pageNumber),
      start,
      end,
      stored.observationSha256,
      retained.requestSha256,
    ]);
    const receipt = catalogueFramedSha256V2("validation-page-receipt", [
      request.batchId,
      evidence.validationContextSha256,
      String(pageNumber),
      start,
      end,
      retained.requestSha256,
      validationCommitment,
      stored.semanticCommitmentSha256,
    ]);
    if (
      stored.validationCommitmentSha256 !== validationCommitment ||
      receipt !== retained.receiptSha256
    )
      throw new Error("Retained validation page commitment is inconsistent");
    pageNumber += 1;
  }
  if (
    String(pageNumber) !== evidence.validationPageCount ||
    validationCommitment !== evidence.validationCommitmentSha256
  )
    throw new Error(
      "Retained validation journal is incomplete or has a different terminal commitment",
    );
  aborted(options.signal);
  const begun = parseInputEvidence(
    await query(
      database,
      sql`
    select public.catalogue_begin_reconciliation_v2(
      ${request.batchId}::uuid, ${request.validationTerminalSha256}::text,
      ${request.expectedCurrentReleaseId}::uuid, ${evidence.contextSha256}::text
    ) as result
  `,
    ),
  );
  if (JSON.stringify(begun) !== JSON.stringify(evidence))
    throw new Error("Reconciliation context changed before preparation");
  let previous = catalogueFramedSha256V2("reconciliation-start", [
    request.batchId,
    evidence.contextSha256,
  ]);
  pageNumber = 0;
  while (true) {
    aborted(options.signal);
    pageNumber += 1;
    const page = parseCataloguePagedReconciliationPage(
      await query(
        database,
        sql`
      select public.catalogue_prepare_reconciliation_page_v2(
        ${request.batchId}::uuid, ${evidence.contextSha256}::text, ${pageNumber}::bigint
      ) as result
    `,
      ),
    );
    if (
      page.batchId !== request.batchId ||
      page.contextSha256 !== evidence.contextSha256 ||
      page.pageNumber !== String(pageNumber) ||
      page.previousCommitmentSha256 !== previous
    )
      throw new Error("Reconciliation page is outside the pinned ordered report");
    if (page.stream === "baseline") {
      const document = JSON.parse(page.document) as { records: JsonObject[] };
      for (const item of document.records) {
        if (!baseline) throw new Error("Report contains an unpinned baseline");
        verifyBaselineRecord(item.before, baseline);
      }
    }
    if (page.stream === "candidate" || page.complete) finishBaselineVerification(baseline);
    aborted(options.signal);
    await options.consumePage(page);
    previous = page.commitmentSha256;
    if (page.complete) break;
  }
  aborted(options.signal);
  const terminal = parseCataloguePagedReconciliationTerminal(
    await query(
      database,
      sql`
    select public.catalogue_finish_reconciliation_v2(
      ${request.batchId}::uuid, ${evidence.contextSha256}::text,
      ${pageNumber}::bigint, ${previous}::text
    ) as result
  `,
    ),
  );
  if (
    terminal.batchId !== request.batchId ||
    terminal.contextSha256 !== evidence.contextSha256 ||
    terminal.validationTerminalSha256 !== request.validationTerminalSha256 ||
    terminal.pageCount !== String(pageNumber) ||
    terminal.pageCommitmentSha256 !== previous
  )
    throw new Error("Reconciliation terminal differs from the consumed report");
  return terminal;
}

export async function submitCataloguePagedApproval(
  database: Kysely<Database>,
  input: SubmitCataloguePagedApprovalInput,
): Promise<CataloguePagedApprovalReceipt> {
  keys(input, [
    "batchId",
    "approvalRole",
    "principalId",
    "rightsManifestSha256",
    "validationTerminalSha256",
    "reportSha256",
    "contextSha256",
    "approvalReference",
  ]);
  uuid(input.batchId);
  principal(input.principalId);
  role(input.approvalRole);
  for (const digest of [
    input.rightsManifestSha256,
    input.validationTerminalSha256,
    input.reportSha256,
    input.contextSha256,
  ])
    sha(digest);
  reference(input.approvalReference);
  const request = { ...input };
  const result = await query(
    database,
    sql`
    select public.catalogue_record_paged_approval_v2(
      ${request.batchId}::uuid, ${request.approvalRole}::text, ${request.principalId}::text,
      ${request.rightsManifestSha256}::text, ${request.validationTerminalSha256}::text,
      ${request.reportSha256}::text, ${request.contextSha256}::text, ${request.approvalReference}::text
    ) as result
  `,
  );
  keys(result, [
    "approvalRole",
    "databasePrincipal",
    "reportSha256",
    "wasAlreadyApproved",
    "promotionAvailable",
  ]);
  if (
    result.approvalRole !== request.approvalRole ||
    result.databasePrincipal !== request.principalId ||
    result.reportSha256 !== request.reportSha256 ||
    typeof result.wasAlreadyApproved !== "boolean" ||
    result.promotionAvailable !== false
  )
    throw new Error("Unexpected paged approval receipt; retain exact request for retry");
  return result as unknown as CataloguePagedApprovalReceipt;
}

export async function readCataloguePagedReconciliationPage(
  database: Kysely<Database>,
  input: {
    readonly batchId: string;
    readonly reportSha256: string;
    readonly pageNumber: string;
    readonly approvalRole: CatalogueApprovalRole;
    readonly principalId: string;
  },
): Promise<CataloguePagedReconciliationPage> {
  keys(input, ["batchId", "reportSha256", "pageNumber", "approvalRole", "principalId"]);
  uuid(input.batchId);
  sha(input.reportSha256);
  principal(input.principalId);
  role(input.approvalRole);
  positive(input.pageNumber);
  const result = parseCataloguePagedReconciliationPage(
    await query(
      database,
      sql`
    select public.catalogue_read_reconciliation_page_v2(
      ${input.batchId}::uuid, ${input.reportSha256}::text, ${input.pageNumber}::bigint,
      ${input.approvalRole}::text, ${input.principalId}::text
    ) as result
  `,
    ),
  );
  if (result.batchId !== input.batchId || result.pageNumber !== input.pageNumber)
    throw new Error("Reviewer report page differs from the requested identity");
  return result;
}

export function parseCataloguePagedReconciliationPage(
  value: unknown,
): CataloguePagedReconciliationPage {
  keys(value, [
    "batchId",
    "contextSha256",
    "pageNumber",
    "stream",
    "startSequence",
    "endSequence",
    "document",
    "documentSha256",
    "previousCommitmentSha256",
    "commitmentSha256",
    "complete",
  ]);
  uuid(value.batchId);
  sha(value.contextSha256);
  positive(value.pageNumber);
  if (
    !["metadata", "baseline", "candidate", "removed"].includes(String(value.stream)) ||
    typeof value.complete !== "boolean"
  )
    throw new Error("Unsupported reconciliation page state");
  const start = unsigned(value.startSequence);
  const end = unsigned(value.endSequence);
  if (BigInt(end) < BigInt(start))
    throw new Error("Reconciliation page exceeds its record interval");
  exactDocument(value.document, value.documentSha256);
  sha(value.documentSha256);
  sha(value.previousCommitmentSha256);
  sha(value.commitmentSha256);
  const document: unknown = JSON.parse(value.document);
  keys(document, [
    "schemaVersion",
    "reportType",
    "batchId",
    "contextSha256",
    "pageNumber",
    "stream",
    "records",
  ]);
  if (
    document.schemaVersion !== 3 ||
    document.reportType !== CATALOGUE_PAGED_RECONCILIATION_REPORT_TYPE ||
    document.batchId !== value.batchId ||
    document.contextSha256 !== value.contextSha256 ||
    document.pageNumber !== value.pageNumber ||
    document.stream !== value.stream ||
    !Array.isArray(document.records) ||
    document.records.length > 250
  )
    throw new Error("Report document differs from its page identity or bounded schema");
  const expected = catalogueFramedSha256V2("reconciliation-page", [
    value.contextSha256,
    String(value.pageNumber),
    String(value.stream),
    start,
    end,
    value.documentSha256,
    value.previousCommitmentSha256,
    String(value.complete),
  ]);
  if (value.commitmentSha256 !== expected)
    throw new Error("Reconciliation page commitment mismatch");
  return value as unknown as CataloguePagedReconciliationPage;
}

export function parseCataloguePagedReconciliationTerminal(
  value: unknown,
): CataloguePagedReconciliationTerminal {
  keys(value, [
    "schemaVersion",
    "reportType",
    "batchId",
    "contextSha256",
    "validationTerminalSha256",
    "reportSha256",
    "pageCount",
    "pageCommitmentSha256",
    "counts",
    "promotionAvailable",
  ]);
  uuid(value.batchId);
  positive(value.pageCount);
  for (const digest of [
    value.contextSha256,
    value.validationTerminalSha256,
    value.reportSha256,
    value.pageCommitmentSha256,
  ])
    sha(digest);
  keys(value.counts, [
    "baselineRecords",
    "candidateRecords",
    "added",
    "changed",
    "unchanged",
    "removed",
    "quarantined",
  ]);
  const counts = value.counts;
  for (const count of Object.values(counts)) unsigned(count);
  if (
    value.schemaVersion !== 3 ||
    value.reportType !== CATALOGUE_PAGED_RECONCILIATION_REPORT_TYPE ||
    value.promotionAvailable !== false ||
    BigInt(unsigned(counts.candidateRecords)) !==
      BigInt(unsigned(counts.added)) +
        BigInt(unsigned(counts.changed)) +
        BigInt(unsigned(counts.unchanged)) +
        BigInt(unsigned(counts.quarantined))
  )
    throw new Error("Reconciliation terminal has unsupported state or inconsistent counts");
  const expected = catalogueFramedSha256V2("reconciliation-terminal", [
    value.batchId,
    value.contextSha256 as string,
    value.validationTerminalSha256 as string,
    String(value.pageCount),
    value.pageCommitmentSha256 as string,
    ...[
      "baselineRecords",
      "candidateRecords",
      "added",
      "changed",
      "unchanged",
      "removed",
      "quarantined",
    ].map((key) => unsigned(counts[key])),
  ]);
  if (value.reportSha256 !== expected)
    throw new Error("Reconciliation terminal commitment mismatch");
  return value as unknown as CataloguePagedReconciliationTerminal;
}

function parseInputEvidence(value: unknown): InputEvidence {
  keys(value, [
    "batchId",
    "databasePrincipal",
    "baselineReleaseId",
    "validationTerminalSha256",
    "validationPageCount",
    "validationContextSha256",
    "validationCommitmentSha256",
    "contextSha256",
    "baselineEvidence",
    "maximumReconciliationEvidenceBytes",
  ]);
  uuid(value.batchId);
  principal(value.databasePrincipal);
  if (value.baselineReleaseId !== null) uuid(value.baselineReleaseId);
  positive(value.validationPageCount);
  positive(value.maximumReconciliationEvidenceBytes);
  for (const digest of [
    value.validationTerminalSha256,
    value.validationContextSha256,
    value.validationCommitmentSha256,
    value.contextSha256,
  ])
    sha(digest);
  return value as unknown as InputEvidence;
}

interface BaselineVerification {
  readonly batch: Record<string, unknown>;
  readonly parser: Record<string, unknown>;
  readonly mappings: ReadonlyMap<string, ReviewedCatalogueNutrientMapping>;
  count: number;
  valid: number;
  quarantined: number;
  nutrients: number;
  portions: number;
  materializableNutrients: number;
  excludedNutrients: number;
  warnings: number;
  errors: number;
}

/** Bounded metadata checks run before any reconciliation state is created. */
export function verifyCataloguePagedBaselineHeader(value: unknown): BaselineVerification | null {
  if (value === null) return null;
  keys(value, ["batch", "release", "parser", "mappings", "approvals", "sourceCode"]);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PAGE_BYTES || value.sourceCode !== "USDA_FDC")
    throw new Error("Unsupported or oversized baseline header");
  const batch = object(value.batch);
  const release = object(value.release);
  const parser = object(value.parser);
  if (
    batch.validated_food_contract_version !== 1 ||
    batch.nutrition_semantic_contract_version !== 1 ||
    batch.status !== "completed" ||
    release.status !== "promoted" ||
    !release.promoted_at ||
    !batch.validated_at ||
    !batch.completed_at ||
    batch.release_id !== release.id ||
    count(batch.unresolved_error_count) !== 0 ||
    count(batch.materialized_count) !== count(batch.valid_count)
  )
    throw new Error("V2 requires an eligible completed V1 frozen-food baseline");
  for (const field of [
    "food_source_id",
    "release_key",
    "published_on",
    "acquired_at",
    "artifact_uri",
    "artifact_sha256",
    "artifact_bytes",
    "media_type",
    "upstream_schema_version",
    "parser_version",
    "rights_manifest_uri",
    "rights_manifest_sha256",
    "release_class",
    "evidence_bundle_sha256",
    "evidence_bundle_uri",
    "evidence_decision_sha256",
    "evidence_object_version_id",
    "evidence_valid_until",
  ])
    if (JSON.stringify(batch[field]) !== JSON.stringify(release[field]))
      throw new Error(`Baseline release provenance differs from its completed batch: ${field}`);
  sha(batch.validation_digest);
  sha(batch.nutrient_mapping_digest);
  const summary = object(release.validation_summary);
  if (
    summary.validationDigest !== batch.validation_digest ||
    summary.validatedFoodContractVersion !== 1
  )
    throw new Error("Baseline release validation digest differs from its completed batch");
  const report = object(parser.report);
  if (
    sha256CanonicalJson(report as JsonObject) !== parser.report_sha256 ||
    parser.batch_id !== batch.id
  )
    throw new Error("Baseline parser report digest or identity differs");
  const pinned = /^(.+)\+build\.([0-9a-f]{64})\+mapping\.([0-9a-f]{64})$/u.exec(
    String(batch.parser_version),
  );
  if (
    !pinned ||
    report.parserVersion !== pinned[1] ||
    report.parserBuildSha256 !== pinned[2] ||
    report.nutrientMappingDigest !== pinned[3] ||
    batch.nutrient_mapping_digest !== pinned[3] ||
    report.artifactSha256 !== batch.artifact_sha256 ||
    report.releaseKey !== batch.release_key ||
    report.sourceCode !== "USDA_FDC" ||
    report.schemaVersion !== 1
  )
    throw new Error("Baseline parser provenance differs from its immutable pins");
  for (const component of ["record", "nutrient", "portion"])
    if (
      count(parser[`source_${component}_count`]) !==
      count(parser[`emitted_${component}_count`]) + count(parser[`excluded_${component}_count`])
    )
      throw new Error("Baseline parser count conservation differs");
  if (
    !Array.isArray(value.mappings) ||
    value.mappings.length > 4096 ||
    !Array.isArray(batch.nutrient_mapping_revision_ids)
  )
    throw new Error("Baseline mapping registry is not bounded");
  const mappingRows = value.mappings
    .map((entry) => {
      const row = object(entry);
      keys(row, [
        "canonicalUnit",
        "conversionMultiplier",
        "nutrientCode",
        "nutrientDimension",
        "nutrientId",
        "nutrientName",
        "revisionId",
        "sourceNutrientKey",
        "sourceUnit",
      ]);
      return { ...row, conversionMultiplier: decimal(row.conversionMultiplier) } as JsonObject;
    })
    .sort((left, right) =>
      String(left.sourceNutrientKey) < String(right.sourceNutrientKey)
        ? -1
        : String(left.sourceNutrientKey) > String(right.sourceNutrientKey)
          ? 1
          : 0,
    );
  if (
    sha256CanonicalJson(mappingRows) !== batch.nutrient_mapping_digest ||
    canonicalJson([...mappingRows.map((row) => row.revisionId as string)].sort()) !==
      canonicalJson([...(batch.nutrient_mapping_revision_ids as string[])].sort()) ||
    canonicalJson(summary.nutrientMappingRevisionIds as JsonValue) !==
      canonicalJson(batch.nutrient_mapping_revision_ids as JsonValue)
  )
    throw new Error("Baseline historical mapping digest or revisions differ");
  const mappings = new Map<string, ReviewedCatalogueNutrientMapping>();
  for (const row of mappingRows) {
    const key = String(row.sourceNutrientKey);
    if (mappings.has(key)) throw new Error("Baseline historical mapping keys are duplicated");
    mappings.set(key, {
      canonicalUnit: String(row.canonicalUnit),
      conversionMultiplier: String(row.conversionMultiplier),
      mappingRevisionId: String(row.revisionId),
      nutrientCode: String(row.nutrientCode),
      nutrientId: String(row.nutrientId),
      sourceNutrientId: key,
      sourceUnit: String(row.sourceUnit),
    });
  }
  if (!Array.isArray(value.approvals) || value.approvals.length !== 3)
    throw new Error("Baseline requires all three immutable approvals");
  const roles = new Set<string>();
  const principals = new Set<string>();
  for (const entry of value.approvals) {
    const approval = object(entry);
    role(approval.approval_role);
    if (
      approval.batch_id !== batch.id ||
      approval.validation_digest !== batch.validation_digest ||
      approval.rights_manifest_sha256 !== batch.rights_manifest_sha256
    )
      throw new Error("Baseline approval differs from immutable evidence");
    roles.add(String(approval.approval_role));
    principals.add(String(approval.principal_id));
  }
  if (
    roles.size !== 3 ||
    (object(batch.validation_policy).requireDistinctApprovalPrincipals === true &&
      principals.size !== 3)
  )
    throw new Error("Baseline approval roles or principal separation differ");
  // Preserve the exact old release-summary shape; no unknown new evidence fields
  // can be silently accepted as the V1 materialization contract.
  const expectedSummary = {
    recordErrors: count(summary.recordErrors),
    excludedNutrientFraction:
      count(batch.nutrient_input_count) === 0
        ? 1
        : count(batch.nutrient_excluded_count) / count(batch.nutrient_input_count),
    nutrientMappingDigest: batch.nutrient_mapping_digest,
    nutrientMappingRevisionIds: batch.nutrient_mapping_revision_ids,
    parserExcludedNutrients: count(parser.excluded_nutrient_count),
    parserExcludedPortions: count(parser.excluded_portion_count),
    parserReportSha256: parser.report_sha256,
    unresolvedErrors: 0,
    validatedFoodContractVersion: 1,
    validationDigest: batch.validation_digest,
    warnings: count(batch.warning_count),
  };
  if (canonicalJson(summary as JsonObject) !== canonicalJson(expectedSummary as JsonObject))
    throw new Error("Baseline release validation evidence differs from its completed batch");
  const expectedCounts = {
    materializable: count(batch.valid_count),
    nutrientInput: count(batch.nutrient_input_count),
    nutrientMaterializable: count(batch.nutrient_materializable_count),
    nutrientExcluded: count(batch.nutrient_excluded_count),
    parserExcludedRecords: count(parser.excluded_record_count),
    quarantined: count(batch.quarantined_count),
    sourcePortions: count(parser.source_portion_count),
    sourceRecords: count(batch.staged_count) + count(parser.excluded_record_count),
    staged: count(batch.staged_count),
  };
  if (canonicalJson(release.record_counts as JsonValue) !== canonicalJson(expectedCounts))
    throw new Error("Baseline release record counts differ from its completed batch");
  return {
    batch: { ...batch, expectedRecordErrors: count(summary.recordErrors) },
    parser,
    mappings,
    count: 0,
    valid: 0,
    quarantined: 0,
    nutrients: 0,
    portions: 0,
    materializableNutrients: 0,
    excludedNutrients: 0,
    warnings: 0,
    errors: 0,
  };
}

function verifyBaselineRecord(value: unknown, state: BaselineVerification): void {
  keys(value, [
    "sequenceNumber",
    "sourceRecordKey",
    "sourceRecordType",
    "sourcePayloadSha256",
    "canonicalPayloadSha256",
    "canonicalPayload",
    "validationStatus",
    "validationIssues",
    "validatedFoodDocument",
    "validatedFoodSha256",
  ]);
  if (unsigned(value.sequenceNumber) !== String(state.count))
    throw new Error("Baseline record sequence is incomplete");
  sha(value.sourcePayloadSha256);
  sha(value.canonicalPayloadSha256);
  if (sha256CanonicalJson(value.canonicalPayload as JsonValue) !== value.canonicalPayloadSha256)
    throw new Error("Baseline canonical payload digest differs");
  if (!Array.isArray(value.validationIssues)) throw new Error("Baseline issues are malformed");
  const forbidden = new Set<string>();
  if (
    value.validationIssues.some(
      (issue) =>
        object(issue).code === "BARCODE_CROSS_SOURCE_CONFLICT" &&
        object(issue).disposition === "exclude_barcode",
    )
  ) {
    const barcode = readCatalogueBarcodeEvidence(value.canonicalPayload as JsonValue);
    if (!barcode?.normalizedGtin || !barcode.marketCode)
      throw new Error("Baseline frozen barcode exclusion is incomplete");
    forbidden.add(`${barcode.normalizedGtin}:${barcode.marketCode}`);
  }
  const result = validateCatalogueRecord(
    value.canonicalPayload as JsonValue,
    {
      canonicalPayloadSha256: value.canonicalPayloadSha256,
      sourcePayloadSha256: value.sourcePayloadSha256,
      expectedReleaseKey: String(state.batch.release_key),
      expectedSourceCode: "USDA_FDC",
      sourceRecordKey: String(value.sourceRecordKey),
      sourceRecordType: String(value.sourceRecordType),
    },
    state.mappings,
    forbidden,
  );
  if (
    canonicalJson(result.issues as JsonValue) !== canonicalJson(value.validationIssues as JsonValue)
  )
    throw new Error("Baseline frozen issues differ from staged meaning");
  const valid = value.validationStatus === "materialized";
  if (valid !== result.recordIsValid || (!valid && value.validationStatus !== "quarantined"))
    throw new Error("Baseline record disposition differs from staged meaning");
  if (valid) {
    exactDocument(value.validatedFoodDocument, value.validatedFoodSha256);
    if (canonicalJson(result.food as unknown as JsonValue) !== value.validatedFoodDocument)
      throw new Error("Baseline frozen food differs from staged meaning");
    state.valid += 1;
    state.materializableNutrients += result.nutrientMaterializableCount;
  } else {
    if (value.validatedFoodDocument !== null || value.validatedFoodSha256 !== null)
      throw new Error("Quarantined baseline contains a food document");
    state.quarantined += 1;
  }
  state.count += 1;
  state.nutrients += result.nutrientInputCount;
  state.portions += result.portionInputCount;
  state.excludedNutrients += result.excludedNutrientCount;
  for (const issue of result.issues) {
    if (issue.severity === "warning") state.warnings += 1;
    else state.errors += 1;
  }
}

function finishBaselineVerification(state: BaselineVerification | null): void {
  if (!state) return;
  const { batch, parser } = state;
  if (
    state.count !== count(batch.staged_count) ||
    state.count !== count(parser.emitted_record_count) ||
    state.valid !== count(batch.valid_count) ||
    state.quarantined + count(parser.excluded_record_count) !== count(batch.quarantined_count) ||
    state.nutrients !== count(parser.emitted_nutrient_count) ||
    state.portions !== count(parser.emitted_portion_count) ||
    state.materializableNutrients !== count(batch.nutrient_materializable_count) ||
    state.excludedNutrients + count(parser.excluded_nutrient_count) !==
      count(batch.nutrient_excluded_count) ||
    state.warnings !== count(batch.warning_count) ||
    state.errors !== count(batch.expectedRecordErrors)
  )
    throw new Error("Complete baseline records do not conserve frozen batch/parser evidence");
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected evidence object");
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(unsigned(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Expected safe evidence count");
  return parsed;
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/u.test(value))
    throw new Error("Invalid historical conversion multiplier");
  return value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;
}
async function query(
  database: Kysely<Database>,
  statement: ReturnType<typeof sql>,
): Promise<unknown> {
  const result = await statement.execute(database);
  if (result.rows.length !== 1) throw new Error("Unexpected paged catalogue SQL receipt count");
  const row = result.rows[0];
  keys(row, ["result"]);
  return row.result;
}
function keys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  )
    throw new Error("Paged catalogue evidence has missing or unexpected fields");
}
function exactOwnKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  keys(value, expected);
  if (Reflect.ownKeys(value).length !== expected.length)
    throw new Error("Paged catalogue evidence has missing or unexpected fields");
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Expected canonical UUID");
}
function sha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("Expected lowercase SHA-256");
}
function principal(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PRINCIPAL.test(value) || Buffer.byteLength(value) > 63)
    throw new Error("Expected explicit bounded database principal");
}
function positive(value: unknown): asserts value is string {
  if (BigInt(unsigned(value)) < 1n) throw new Error("Expected positive safe page number");
}
function unsigned(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(value) ||
    BigInt(value) > MAX_SAFE_COUNT
  )
    throw new Error("Expected bounded unsigned decimal count");
  return value;
}
function role(value: unknown): void {
  if (!["data", "quality", "rights"].includes(String(value)))
    throw new Error("Expected explicit reviewer role");
}
function reference(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 2048 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("Expected explicit bounded approval reference");
}
function exactDocument(document: unknown, digest: unknown): asserts document is string {
  sha(digest);
  if (
    typeof document !== "string" ||
    catalogueDocumentSha256V2(document, MAX_PAGE_BYTES) !== digest
  )
    throw new Error("Exact retained document exceeds its bound or digest differs");
}
function aborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
