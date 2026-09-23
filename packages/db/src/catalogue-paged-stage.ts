import { type Kysely, sql } from "kysely";
import { CATALOGUE_CAPABILITY_ROLES } from "./catalogue-authority-deployment.js";
import type {
  RecordBatchParserReportInput,
  StageBatchInput,
  StagedCatalogueRecordInput,
} from "./catalogue-ingestion.js";
import {
  assertCatalogueSha256V2,
  assertCatalogueTextV2,
  catalogueDocumentSha256V2,
  catalogueFramedSha256V2,
  catalogueUnsignedIntegerV2,
} from "./catalogue-paged-protocol.js";
import { canonicalJson } from "./catalogue-validation.js";
import type { Database, JsonObject, JsonValue } from "./types.js";

const PAGE_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type Count = string | number | bigint;

export interface CataloguePreparationAdmissionInputV2 {
  readonly stageDocument: string;
  readonly manifestSha256: string;
  readonly exportSha256: string;
  readonly exportBytes: Count;
  readonly stagePrincipal: string;
  readonly maxRecords: Count;
  readonly maxPayloadTextBytes: Count;
  readonly maxIntermediateBytes: Count;
  readonly maxValidationEvidenceBytes: Count;
  readonly maxReconciliationEvidenceBytes: Count;
  readonly maxBaselineRecords: Count;
  readonly maxBaselinePayloadBytes: Count;
  readonly reviewReference: string;
}
export interface CataloguePreparationAdmissionReceiptV2 {
  readonly schemaVersion: 2;
  readonly admissionSha256: string;
  readonly requestSha256: string;
  readonly admittedBy: string;
}
export interface CatalogueAcceptedPreparationAdmissionV2
  extends CataloguePreparationAdmissionReceiptV2 {
  readonly requestDocument: string;
}
export interface CataloguePreparationStageReceiptV2 {
  readonly schemaVersion: 2;
  readonly batchId: string;
  readonly admissionSha256: string;
  readonly phase: "staging" | "sealing" | "sealed";
  readonly nextSequence: string;
  readonly payloadTextBytes: string;
  readonly stagePageCount: string;
  readonly recordCommitmentSha256: string;
  readonly lastPageReceiptSha256: string | null;
}
export interface CataloguePreparationPageInputV2 {
  readonly batchId: string;
  readonly admissionSha256: string;
  readonly parserVersion: string;
  readonly pageNumber: Count;
  readonly firstSequence: Count;
  readonly previousReceiptSha256: string | null;
  readonly records: readonly StagedCatalogueRecordInput[];
}
export interface CataloguePreparationPageReceiptV2 {
  readonly schemaVersion: 2;
  readonly batchId: string;
  readonly admissionSha256: string;
  readonly pageNumber: string;
  readonly firstSequence: string;
  readonly nextSequence: string;
  readonly recordCount: string;
  readonly payloadTextBytes: string;
  readonly totalPayloadTextBytes: string;
  readonly recordCommitmentSha256: string;
  readonly requestSha256: string;
  readonly previousReceiptSha256: string | null;
  readonly receiptSha256: string;
}
export interface CataloguePreparationSealStartReceiptV2 {
  readonly schemaVersion: 2;
  readonly batchId: string;
  readonly sealRequestSha256: string;
  readonly parserReportSha256: string;
  readonly recordCount: string;
  readonly payloadTextBytes: string;
  readonly stagePageCount: string;
}
export interface CataloguePreparationSealPageReceiptV2 {
  readonly schemaVersion: 2;
  readonly batchId: string;
  readonly pageNumber: string;
  readonly nextSequence: string;
  readonly recordCommitmentSha256: string;
  readonly stageReceiptSha256: string;
  readonly verifiedPayloadTextBytes: string;
}
export interface CataloguePreparationSealTerminalV2 {
  readonly schemaVersion: 2;
  readonly batchId: string;
  readonly admissionSha256: string;
  readonly recordCount: string;
  readonly payloadTextBytes: string;
  readonly recordCommitmentSha256: string;
  readonly stageReceiptSha256: string | null;
  readonly parserReportSha256: string;
  readonly sealRequestSha256: string;
}
export interface CataloguePreparationSealReceiptV2 extends CataloguePreparationSealTerminalV2 {
  readonly stagingSealSha256: string;
}

/** Uses the unchanged V1 provenance constructor only; all record/seal work is V2. */
export function encodeCataloguePreparationStageIdentityV2(input: StageBatchInput): string {
  return bounded(
    {
      ...input,
      schemaVersion: 1,
      acquiredAt: timestamp(input.acquiredAt),
      evidenceValidUntil: timestamp(input.evidenceValidUntil),
      artifactBytes: positive(input.artifactBytes, "artifactBytes"),
      publishedOn: input.publishedOn ?? null,
      upstreamSchemaVersion: input.upstreamSchemaVersion ?? null,
    },
    65536,
  );
}

export function encodeCataloguePreparationAdmissionV2(
  input: CataloguePreparationAdmissionInputV2,
): string {
  const stage = parseDocument(input.stageDocument, 65536);
  if (stage.schemaVersion !== 1)
    throw new Error("Preparation admission needs exact stage provenance version 1");
  textField(input.stagePrincipal, "stagePrincipal", 63);
  textField(input.reviewReference, "reviewReference", 2048);
  assertCatalogueSha256V2(input.manifestSha256, "manifestSha256");
  assertCatalogueSha256V2(input.exportSha256, "exportSha256");
  return bounded(
    {
      schemaVersion: 2,
      stageDocument: input.stageDocument,
      manifestSha256: input.manifestSha256,
      exportSha256: input.exportSha256,
      exportBytes: positive(input.exportBytes, "exportBytes"),
      stagePrincipal: input.stagePrincipal,
      maxRecords: positive(input.maxRecords, "maxRecords"),
      maxPayloadTextBytes: positive(input.maxPayloadTextBytes, "maxPayloadTextBytes"),
      maxIntermediateBytes: positive(input.maxIntermediateBytes, "maxIntermediateBytes"),
      maxValidationEvidenceBytes: positive(
        input.maxValidationEvidenceBytes,
        "maxValidationEvidenceBytes",
      ),
      maxReconciliationEvidenceBytes: positive(
        input.maxReconciliationEvidenceBytes,
        "maxReconciliationEvidenceBytes",
      ),
      maxBaselineRecords: catalogueUnsignedIntegerV2(
        input.maxBaselineRecords,
        "maxBaselineRecords",
      ),
      maxBaselinePayloadBytes: catalogueUnsignedIntegerV2(
        input.maxBaselinePayloadBytes,
        "maxBaselinePayloadBytes",
      ),
      reviewReference: input.reviewReference,
    },
    131072,
  );
}

/** The caller retains this exact document before submission, including retries. */
export async function admitCataloguePreparationV2(
  database: Kysely<Database>,
  document: string,
): Promise<CataloguePreparationAdmissionReceiptV2> {
  const request = parseDocument(document, 131072);
  exactKeys(request, [
    "schemaVersion",
    "stageDocument",
    "manifestSha256",
    "exportSha256",
    "exportBytes",
    "stagePrincipal",
    "maxRecords",
    "maxPayloadTextBytes",
    "maxIntermediateBytes",
    "maxValidationEvidenceBytes",
    "maxReconciliationEvidenceBytes",
    "maxBaselineRecords",
    "maxBaselinePayloadBytes",
    "reviewReference",
  ]);
  if (request.schemaVersion !== 2) throw new Error("Invalid preparation admission version");
  const actor = await assertCataloguePreparationPrincipalV2(
    database,
    "nutrition_catalogue_approve_quality",
  );
  const row = result(
    (
      await sql<{
        result: unknown;
      }>`select public.catalogue_admit_preparation_v2(${document}::text) as result`.execute(
        database,
      )
    ).rows,
  );
  exactKeys(row, ["schemaVersion", "admissionSha256", "requestSha256", "admittedBy"]);
  const requestSha256 = catalogueDocumentSha256V2(document, 131072);
  if (
    row.schemaVersion !== 2 ||
    row.requestSha256 !== requestSha256 ||
    row.admittedBy !== actor ||
    row.admissionSha256 !== catalogueFramedSha256V2("admission", [requestSha256, actor])
  )
    throw new Error("Preparation admission receipt differs from exact request and reviewer");
  return row as unknown as CataloguePreparationAdmissionReceiptV2;
}

/** Read the accepted limits before allocating a source snapshot or retained pages. */
export async function readCataloguePreparationAdmissionV2(
  database: Kysely<Database>,
  admissionSha256: string,
): Promise<CatalogueAcceptedPreparationAdmissionV2> {
  assertCatalogueSha256V2(admissionSha256, "admissionSha256");
  await assertCataloguePreparationPrincipalV2(database, "nutrition_catalogue_stage");
  const row = result(
    (
      await sql<{
        result: unknown;
      }>`select public.catalogue_read_preparation_admission_v2(${admissionSha256}::text) as result`.execute(
        database,
      )
    ).rows,
  );
  exactKeys(row, [
    "schemaVersion",
    "admissionSha256",
    "requestSha256",
    "admittedBy",
    "requestDocument",
  ]);
  textField(row.admittedBy, "admittedBy", 63);
  assertCatalogueTextV2(row.requestDocument, "requestDocument");
  const document = parseDocument(row.requestDocument, 131072);
  if (document.schemaVersion !== 2)
    throw new Error("Invalid accepted preparation admission version");
  const { schemaVersion: _version, ...input } = document;
  encodeCataloguePreparationAdmissionV2(input as unknown as CataloguePreparationAdmissionInputV2);
  const requestSha256 = catalogueDocumentSha256V2(row.requestDocument, 131072);
  if (
    row.schemaVersion !== 2 ||
    row.admissionSha256 !== admissionSha256 ||
    row.requestSha256 !== requestSha256 ||
    admissionSha256 !== catalogueFramedSha256V2("admission", [requestSha256, row.admittedBy])
  )
    throw new Error("Accepted preparation admission differs from immutable reviewed request");
  return row as unknown as CatalogueAcceptedPreparationAdmissionV2;
}

export async function beginCataloguePreparationV2(
  database: Kysely<Database>,
  input: { readonly admissionSha256: string; readonly stageDocument: string },
): Promise<CataloguePreparationStageReceiptV2> {
  assertCatalogueSha256V2(input.admissionSha256, "admissionSha256");
  parseDocument(input.stageDocument, 65536);
  await assertCataloguePreparationPrincipalV2(database, "nutrition_catalogue_stage");
  const row = result(
    (
      await sql<{
        result: unknown;
      }>`select public.catalogue_begin_preparation_v2(${input.admissionSha256}::text, ${input.stageDocument}::text) as result`.execute(
        database,
      )
    ).rows,
  );
  exactKeys(row, [
    "schemaVersion",
    "batchId",
    "admissionSha256",
    "phase",
    "nextSequence",
    "payloadTextBytes",
    "stagePageCount",
    "recordCommitmentSha256",
    "lastPageReceiptSha256",
  ]);
  receiptBase(row);
  if (
    row.admissionSha256 !== input.admissionSha256 ||
    !["staging", "sealing", "sealed"].includes(String(row.phase))
  )
    throw new Error("Preparation batch receipt identity or phase differs");
  counts(row, ["nextSequence", "payloadTextBytes", "stagePageCount"]);
  assertCatalogueSha256V2(row.recordCommitmentSha256, "recordCommitmentSha256");
  nullableHash(row.lastPageReceiptSha256);
  if (
    (row.stagePageCount === "0") !== (row.lastPageReceiptSha256 === null) ||
    (row.nextSequence === "0") !== (row.stagePageCount === "0")
  )
    throw new Error("Incoherent preparation stage counters");
  return row as unknown as CataloguePreparationStageReceiptV2;
}

export function encodeCataloguePreparationStagePageV2(
  input: CataloguePreparationPageInputV2,
): string {
  batchId(input.batchId);
  assertCatalogueSha256V2(input.admissionSha256, "admissionSha256");
  textField(input.parserVersion, "parserVersion", 512);
  nullableHash(input.previousReceiptSha256);
  const pageNumber = catalogueUnsignedIntegerV2(input.pageNumber, "pageNumber");
  const firstSequence = catalogueUnsignedIntegerV2(input.firstSequence, "firstSequence");
  if (input.records.length < 1 || input.records.length > 250)
    throw new Error("Preparation page requires 1 to 250 records");
  catalogueUnsignedIntegerV2(BigInt(firstSequence) + BigInt(input.records.length), "nextSequence");
  const header = {
    schemaVersion: 2,
    batchId: input.batchId,
    admissionSha256: input.admissionSha256,
    parserVersion: input.parserVersion,
    pageNumber,
    firstSequence,
    previousReceiptSha256: input.previousReceiptSha256,
  };
  const records: JsonObject[] = [];
  let bytes = Buffer.byteLength(canonicalJson({ ...header, records: [] }));
  for (const [index, record] of input.records.entries()) {
    const sequenceNumber = catalogueUnsignedIntegerV2(record.sequenceNumber, "sequenceNumber");
    if (sequenceNumber !== String(BigInt(firstSequence) + BigInt(index)))
      throw new Error("Preparation record sequences must be contiguous");
    textField(record.sourceRecordKey, "sourceRecordKey", 1024);
    textField(record.sourceRecordType, "sourceRecordType", 256);
    assertCatalogueSha256V2(record.sourcePayloadSha256, "sourcePayloadSha256");
    const canonicalPayloadDocument = bounded(record.canonicalPayload, 1024 * 1024);
    const canonicalPayloadSha256 = catalogueDocumentSha256V2(canonicalPayloadDocument, 1024 * 1024);
    if (
      record.canonicalPayloadSha256 !== undefined &&
      record.canonicalPayloadSha256 !== canonicalPayloadSha256
    )
      throw new Error("Preparation payload digest differs");
    const entry = {
      sourceRecordKey: record.sourceRecordKey,
      sourceRecordType: record.sourceRecordType,
      sequenceNumber,
      sourcePayloadSha256: record.sourcePayloadSha256,
      canonicalPayloadSha256,
      canonicalPayloadDocument,
    };
    bytes += Buffer.byteLength(canonicalJson(entry)) + (index === 0 ? 0 : 1);
    if (bytes > PAGE_BYTES) throw new Error("Preparation page exceeds its byte bound");
    records.push(entry);
  }
  return bounded({ ...header, records }, PAGE_BYTES);
}

export async function submitCataloguePreparationStagePageV2(
  database: Kysely<Database>,
  input: { readonly batchId: string; readonly document: string },
): Promise<CataloguePreparationPageReceiptV2> {
  batchId(input.batchId);
  const request = parseDocument(input.document, PAGE_BYTES);
  exactKeys(request, [
    "schemaVersion",
    "batchId",
    "admissionSha256",
    "parserVersion",
    "pageNumber",
    "firstSequence",
    "previousReceiptSha256",
    "records",
  ]);
  if (
    request.schemaVersion !== 2 ||
    request.batchId !== input.batchId ||
    !Array.isArray(request.records) ||
    request.records.length < 1 ||
    request.records.length > 250
  )
    throw new Error("Invalid retained preparation page identity or count");
  counts(request, ["pageNumber", "firstSequence"]);
  assertCatalogueSha256V2(request.admissionSha256, "admissionSha256");
  textField(request.parserVersion, "parserVersion", 512);
  nullableHash(request.previousReceiptSha256);
  await assertCataloguePreparationPrincipalV2(database, "nutrition_catalogue_stage");
  const row = result(
    (
      await sql<{
        result: unknown;
      }>`select public.catalogue_stage_preparation_page_v2(${input.batchId}::uuid, ${input.document}::text) as result`.execute(
        database,
      )
    ).rows,
  );
  exactKeys(row, [
    "schemaVersion",
    "batchId",
    "admissionSha256",
    "pageNumber",
    "firstSequence",
    "nextSequence",
    "recordCount",
    "payloadTextBytes",
    "totalPayloadTextBytes",
    "recordCommitmentSha256",
    "requestSha256",
    "previousReceiptSha256",
    "receiptSha256",
  ]);
  receiptBase(row, input.batchId);
  counts(row, [
    "pageNumber",
    "firstSequence",
    "nextSequence",
    "recordCount",
    "payloadTextBytes",
    "totalPayloadTextBytes",
  ]);
  assertCatalogueSha256V2(row.recordCommitmentSha256, "recordCommitmentSha256");
  const expectedRequestSha = catalogueDocumentSha256V2(input.document, PAGE_BYTES);
  if (
    row.admissionSha256 !== request.admissionSha256 ||
    row.pageNumber !== request.pageNumber ||
    row.firstSequence !== request.firstSequence ||
    row.recordCount !== String(request.records.length) ||
    row.nextSequence !==
      String(BigInt(String(request.firstSequence)) + BigInt(request.records.length)) ||
    row.previousReceiptSha256 !== request.previousReceiptSha256 ||
    row.requestSha256 !== expectedRequestSha ||
    BigInt(String(row.payloadTextBytes)) < 1n ||
    BigInt(String(row.totalPayloadTextBytes)) < BigInt(String(row.payloadTextBytes)) ||
    row.receiptSha256 !==
      catalogueFramedSha256V2("stage-page", [
        input.batchId,
        request.admissionSha256,
        request.parserVersion,
        String(row.pageNumber),
        String(row.firstSequence),
        String(row.nextSequence),
        request.previousReceiptSha256 ?? "",
        expectedRequestSha,
        row.recordCommitmentSha256,
        String(row.payloadTextBytes),
        String(row.totalPayloadTextBytes),
      ])
  )
    throw new Error("Preparation page receipt differs from retained request");
  return row as unknown as CataloguePreparationPageReceiptV2;
}

export function encodeCataloguePreparationParserReportV2(
  input: RecordBatchParserReportInput,
): string {
  batchId(input.batchId);
  const reportDocument = bounded(input.report, 15 * 1024 * 1024);
  const reportSha256 = catalogueDocumentSha256V2(reportDocument, 15 * 1024 * 1024);
  if (input.reportSha256 !== undefined && input.reportSha256 !== reportSha256)
    throw new Error("Preparation parser report digest differs");
  const evidence: Record<string, string> = {};
  for (const kind of ["Record", "Nutrient", "Portion"] as const) {
    for (const prefix of ["source", "emitted", "excluded"] as const) {
      const key = `${prefix}${kind}Count` as const;
      evidence[key] = catalogueUnsignedIntegerV2(input[key], key);
    }
    if (
      BigInt(evidence[`source${kind}Count`] ?? "") !==
      BigInt(evidence[`emitted${kind}Count`] ?? "") + BigInt(evidence[`excluded${kind}Count`] ?? "")
    )
      throw new Error("Preparation parser count conservation differs");
  }
  return bounded({ schemaVersion: 2, reportDocument, reportSha256, ...evidence }, PAGE_BYTES);
}

export async function beginCataloguePreparationSealV2(
  database: Kysely<Database>,
  input: { readonly batchId: string; readonly document: string },
): Promise<CataloguePreparationSealStartReceiptV2> {
  batchId(input.batchId);
  const request = parseDocument(input.document, PAGE_BYTES);
  if (request.schemaVersion !== 2) throw new Error("Invalid preparation parser version");
  assertCatalogueSha256V2(request.reportSha256, "reportSha256");
  counts(request, ["emittedRecordCount"]);
  await assertCataloguePreparationPrincipalV2(database, "nutrition_catalogue_stage");
  const row = result(
    (
      await sql<{
        result: unknown;
      }>`select public.catalogue_begin_preparation_seal_v2(${input.batchId}::uuid, ${input.document}::text) as result`.execute(
        database,
      )
    ).rows,
  );
  exactKeys(row, [
    "schemaVersion",
    "batchId",
    "sealRequestSha256",
    "parserReportSha256",
    "recordCount",
    "payloadTextBytes",
    "stagePageCount",
  ]);
  receiptBase(row, input.batchId);
  counts(row, ["recordCount", "payloadTextBytes", "stagePageCount"]);
  if (
    row.sealRequestSha256 !== catalogueDocumentSha256V2(input.document, PAGE_BYTES) ||
    row.parserReportSha256 !== request.reportSha256 ||
    row.recordCount !== request.emittedRecordCount
  )
    throw new Error("Preparation seal start receipt differs from retained parser report");
  return row as unknown as CataloguePreparationSealStartReceiptV2;
}

export async function verifyCataloguePreparationSealPageV2(
  database: Kysely<Database>,
  input: { readonly batchId: string; readonly pageNumber: Count },
): Promise<CataloguePreparationSealPageReceiptV2> {
  batchId(input.batchId);
  const pageNumber = catalogueUnsignedIntegerV2(input.pageNumber, "pageNumber");
  await assertCataloguePreparationPrincipalV2(database, "nutrition_catalogue_stage");
  const row = result(
    (
      await sql<{
        result: unknown;
      }>`select public.catalogue_verify_preparation_seal_page_v2(${input.batchId}::uuid, ${pageNumber}::bigint) as result`.execute(
        database,
      )
    ).rows,
  );
  exactKeys(row, [
    "schemaVersion",
    "batchId",
    "pageNumber",
    "nextSequence",
    "recordCommitmentSha256",
    "stageReceiptSha256",
    "verifiedPayloadTextBytes",
  ]);
  receiptBase(row, input.batchId);
  counts(row, ["pageNumber", "nextSequence", "verifiedPayloadTextBytes"]);
  assertCatalogueSha256V2(row.recordCommitmentSha256, "recordCommitmentSha256");
  assertCatalogueSha256V2(row.stageReceiptSha256, "stageReceiptSha256");
  if (row.pageNumber !== pageNumber || row.nextSequence === "0")
    throw new Error("Preparation seal verification receipt cursor differs");
  return row as unknown as CataloguePreparationSealPageReceiptV2;
}

export function encodeCataloguePreparationSealTerminalV2(
  input: CataloguePreparationSealTerminalV2,
): string {
  const value = input as unknown as JsonObject;
  exactKeys(value, [
    "schemaVersion",
    "batchId",
    "admissionSha256",
    "recordCount",
    "payloadTextBytes",
    "recordCommitmentSha256",
    "stageReceiptSha256",
    "parserReportSha256",
    "sealRequestSha256",
  ]);
  receiptBase(value);
  counts(value, ["recordCount", "payloadTextBytes"]);
  for (const key of [
    "admissionSha256",
    "recordCommitmentSha256",
    "parserReportSha256",
    "sealRequestSha256",
  ])
    assertCatalogueSha256V2(value[key], key);
  nullableHash(value.stageReceiptSha256);
  if ((input.recordCount === "0") !== (input.stageReceiptSha256 === null))
    throw new Error("Preparation terminal receipt chain is incomplete");
  return bounded(value, 65536);
}

export async function finishCataloguePreparationSealV2(
  database: Kysely<Database>,
  input: { readonly batchId: string; readonly document: string },
): Promise<CataloguePreparationSealReceiptV2> {
  batchId(input.batchId);
  const request = parseDocument(input.document, 65536);
  encodeCataloguePreparationSealTerminalV2(
    request as unknown as CataloguePreparationSealTerminalV2,
  );
  if (request.batchId !== input.batchId)
    throw new Error("Preparation terminal batch identity differs");
  await assertCataloguePreparationPrincipalV2(database, "nutrition_catalogue_stage");
  const row = result(
    (
      await sql<{
        result: unknown;
      }>`select public.catalogue_finish_preparation_seal_v2(${input.batchId}::uuid, ${input.document}::text) as result`.execute(
        database,
      )
    ).rows,
  );
  exactKeys(row, [...Object.keys(request), "stagingSealSha256"]);
  assertCatalogueSha256V2(row.stagingSealSha256, "stagingSealSha256");
  for (const [key, value] of Object.entries(request))
    if (row[key] !== value)
      throw new Error("Preparation terminal receipt differs from retained request");
  return row as unknown as CataloguePreparationSealReceiptV2;
}

/** Separate client preflight; SQL repeats these checks on every mutation. */
export async function assertCataloguePreparationPrincipalV2(
  database: Kysely<Database>,
  capability: "nutrition_catalogue_stage" | "nutrition_catalogue_approve_quality",
): Promise<string> {
  const row = result(
    (
      await sql<{ result: unknown }>`
    select pg_catalog.jsonb_build_object('databasePrincipal',session_user::text,'effectivePrincipal',current_user::text,
      'canLogin',actor.rolcanlogin,'privileged',actor.rolsuper or actor.rolcreatedb or actor.rolcreaterole or actor.rolreplication or actor.rolbypassrls,
      'ownerMember',pg_catalog.pg_has_role(session_user,target.relowner,'member'),
      'capabilities',(select coalesce(pg_catalog.jsonb_agg(role_name order by role_name),'[]'::jsonb)
        from pg_catalog.unnest(${[...CATALOGUE_CAPABILITY_ROLES]}::text[]) names(role_name)
        where pg_catalog.pg_has_role(session_user,role_name,'member'))) as result
    from pg_catalog.pg_roles actor join pg_catalog.pg_class target on target.oid = 'public.food_import_batch'::pg_catalog.regclass
    where actor.rolname = session_user
  `.execute(database)
    ).rows,
  );
  exactKeys(row, [
    "databasePrincipal",
    "effectivePrincipal",
    "canLogin",
    "privileged",
    "ownerMember",
    "capabilities",
  ]);
  textField(row.databasePrincipal, "databasePrincipal", 63);
  if (
    row.effectivePrincipal !== row.databasePrincipal ||
    row.canLogin !== true ||
    row.privileged !== false ||
    row.ownerMember !== false ||
    !Array.isArray(row.capabilities) ||
    row.capabilities.length !== 1 ||
    row.capabilities[0] !== capability
  )
    throw new Error(
      "Preparation requires an actual restricted login with exactly the requested capability",
    );
  return row.databasePrincipal;
}

function result(rows: readonly { result: unknown }[]): JsonObject {
  if (
    rows.length !== 1 ||
    rows[0]?.result === null ||
    typeof rows[0]?.result !== "object" ||
    Array.isArray(rows[0]?.result)
  )
    throw new Error("Preparation capability returned no unique receipt");
  return rows[0].result as JsonObject;
}
function exactKeys(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new Error("Preparation document or receipt shape differs");
}
function batchId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("Invalid preparation batch ID");
}
function receiptBase(value: JsonObject, expectedBatchId?: string): void {
  batchId(value.batchId);
  if (
    value.schemaVersion !== 2 ||
    (expectedBatchId !== undefined && value.batchId !== expectedBatchId)
  )
    throw new Error("Preparation receipt identity differs");
}
function counts(value: JsonObject, keys: readonly string[]): void {
  for (const key of keys) {
    if (
      typeof value[key] !== "string" ||
      catalogueUnsignedIntegerV2(value[key], key) !== value[key]
    )
      throw new Error("Preparation count must remain exact decimal text");
  }
}
function positive(value: Count, name: string): string {
  const result = catalogueUnsignedIntegerV2(value, name);
  if (result === "0") throw new Error(`${name} must be positive`);
  return result;
}
function nullableHash(value: unknown): asserts value is string | null {
  if (value !== null) assertCatalogueSha256V2(value, "receipt digest");
}
function textField(value: unknown, name: string, maximum: number): asserts value is string {
  assertCatalogueTextV2(value, name);
  if (Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > maximum)
    throw new Error(`Invalid bounded ${name}`);
}
function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid preparation timestamp");
  return date.toISOString();
}
function jsonText(value: JsonValue): void {
  if (typeof value === "string") assertCatalogueTextV2(value, "JSON string");
  else if (Array.isArray(value)) for (const child of value) jsonText(child);
  else if (value !== null && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      assertCatalogueTextV2(key, "JSON key");
      jsonText(child);
    }
}
function bounded(value: JsonValue, maximum: number): string {
  jsonText(value);
  const document = canonicalJson(value);
  catalogueDocumentSha256V2(document, maximum);
  return document;
}
function parseDocument(document: string, maximum: number): JsonObject {
  catalogueDocumentSha256V2(document, maximum);
  const value: unknown = JSON.parse(document);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Preparation document must be an object");
  jsonText(value as JsonObject);
  return value as JsonObject;
}
