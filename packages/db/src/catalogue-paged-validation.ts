import { type Kysely, sql } from "kysely";
import {
  assertCatalogueValidatePrincipal,
  validateCatalogueValidationPolicy,
} from "./catalogue-capability-validation.js";
import type { BatchValidationPolicy } from "./catalogue-ingestion.js";
import {
  assertCatalogueSha256V2,
  assertCatalogueTextV2,
  catalogueDocumentSha256V2,
  catalogueFramedSha256V2,
  catalogueUnsignedIntegerV2,
} from "./catalogue-paged-protocol.js";
import {
  canonicalJson,
  type ReviewedCatalogueNutrientMapping,
  sha256CanonicalJson,
  validateCatalogueRecord,
} from "./catalogue-validation.js";
import type { Database, JsonValue } from "./types.js";

const PAGE_BYTES = 16 * 1024 * 1024;
const RECORD_BYTES = 1024 * 1024;
const SQL_SCOPE = "nutrition-basis-counts-source-identity-barcode-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type ObjectValue = Record<string, unknown>;

export interface CatalogueValidationContextV2 {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-context-v2";
  readonly batchId: string;
  readonly contextSha256: string;
  readonly admissionSha256: string;
  readonly maximumValidationEvidenceBytes: string;
  readonly validatorDatabasePrincipal: string;
  readonly stagingSealSha256: string;
  readonly generation: string;
  readonly baselineReleaseId: string | null;
  readonly policyDocument: string;
  readonly phase: "observing" | "validated" | "quarantined";
  readonly nextSequence: string;
  readonly pageCount: string;
  readonly stagedCount: string;
  readonly lastPageReceiptSha256: string;
  readonly validationCommitmentSha256: string;
  readonly semanticCommitmentSha256: string;
}
export interface PreparedCatalogueValidationPageV2 {
  readonly requestDocument: string;
  readonly requestSha256: string;
  readonly requestByteSize: number;
  readonly batchId: string;
  readonly contextSha256: string;
  readonly validatorDatabasePrincipal: string;
  readonly pageNumber: string;
  readonly startSequence: string;
  readonly endSequence: string;
  readonly observationSha256: string;
  readonly previousReceiptSha256: string;
}
export interface CatalogueValidationPageReceiptV2 {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-page-receipt-v2";
  readonly batchId: string;
  readonly contextSha256: string;
  readonly pageNumber: string;
  readonly startSequence: string;
  readonly endSequence: string;
  readonly requestSha256: string;
  readonly validationCommitmentSha256: string;
  readonly semanticCommitmentSha256: string;
  readonly receiptSha256: string;
}
export interface PreparedCatalogueValidationTerminalV2 {
  readonly terminalDocument: string;
  readonly terminalRequestSha256: string;
}
export interface CatalogueValidationTerminalReceiptV2 {
  readonly schemaVersion: 2;
  readonly kind: "catalogue-validation-terminal-receipt-v2";
  readonly batchId: string;
  readonly contextSha256: string;
  readonly terminalRequestSha256: string;
  readonly summaryDocument: string;
  readonly terminalSha256: string;
}

export async function beginCatalogueValidationV2(
  database: Kysely<Database>,
  input: {
    readonly batchId: string;
    readonly stagingSealSha256: string;
    readonly policy: BatchValidationPolicy;
  },
): Promise<CatalogueValidationContextV2> {
  uuid(input.batchId);
  hash(input.stagingSealSha256);
  const policy = validateCatalogueValidationPolicy(input.policy);
  const principal = await assertCatalogueValidatePrincipal(database);
  const policyDocument = canonicalJson(policy as unknown as JsonValue);
  const response = only(
    (
      await sql<{ result: unknown }>`
    select public.catalogue_begin_validation_v2(${input.batchId}::uuid,
      ${input.stagingSealSha256}::text,${policyDocument}::text) as result
  `.execute(database)
    ).rows,
  );
  const context = parseCatalogueValidationContextV2(response);
  if (
    context.batchId !== input.batchId ||
    context.stagingSealSha256 !== input.stagingSealSha256 ||
    context.policyDocument !== policyDocument ||
    context.validatorDatabasePrincipal !== principal.databasePrincipal
  )
    fail("V2 validation context differs from requested identity");
  return context;
}

export function parseCatalogueValidationContextV2(value: unknown): CatalogueValidationContextV2 {
  const row = object(value);
  keys(row, [
    "schemaVersion",
    "kind",
    "batchId",
    "contextSha256",
    "admissionSha256",
    "maximumValidationEvidenceBytes",
    "validatorDatabasePrincipal",
    "stagingSealSha256",
    "generation",
    "baselineReleaseId",
    "policyDocument",
    "phase",
    "nextSequence",
    "pageCount",
    "stagedCount",
    "lastPageReceiptSha256",
    "validationCommitmentSha256",
    "semanticCommitmentSha256",
  ]);
  if (
    row.schemaVersion !== 2 ||
    row.kind !== "catalogue-validation-context-v2" ||
    !["observing", "validated", "quarantined"].includes(String(row.phase))
  )
    fail("Unsupported V2 validation context");
  uuid(row.batchId);
  if (row.baselineReleaseId !== null) uuid(row.baselineReleaseId);
  for (const name of [
    "contextSha256",
    "admissionSha256",
    "stagingSealSha256",
    "lastPageReceiptSha256",
    "validationCommitmentSha256",
    "semanticCommitmentSha256",
  ])
    hash(row[name]);
  for (const name of ["generation", "nextSequence", "pageCount", "stagedCount"]) integer(row[name]);
  integer(row.maximumValidationEvidenceBytes);
  if (BigInt(row.maximumValidationEvidenceBytes as string) === 0n)
    fail("V2 validation evidence budget is absent");
  text(row.validatorDatabasePrincipal, 63);
  text(row.policyDocument, 4096);
  validateCatalogueValidationPolicy(JSON.parse(row.policyDocument as string));
  if (BigInt(row.nextSequence as string) > BigInt(row.stagedCount as string))
    fail("V2 validation context cursor exceeds sealed count");
  return row as unknown as CatalogueValidationContextV2;
}

export async function prepareCatalogueValidationPageV2(
  database: Kysely<Database>,
  value: CatalogueValidationContextV2,
  maximumRecords = 250,
): Promise<PreparedCatalogueValidationPageV2> {
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 250)
    fail("V2 observation record limit must be 1 through 250");
  const context = parseCatalogueValidationContextV2(value);
  if (context.phase !== "observing" || context.nextSequence === context.stagedCount)
    fail("V2 validation context has no next observation");
  const principal = await assertCatalogueValidatePrincipal(database);
  if (principal.databasePrincipal !== context.validatorDatabasePrincipal)
    fail("V2 validation context belongs to another principal");
  // Bound the working set of new observations; retained pages keep the SQL limit.
  let pageLimit = Math.min(maximumRecords, 64);
  for (;;) {
    const response = object(
      only(
        (
          await sql<{ result: unknown }>`
    select public.catalogue_observe_validation_page_v2(
      ${context.batchId}::uuid,${context.nextSequence}::bigint,${pageLimit}::integer) as result
  `.execute(database)
        ).rows,
      ),
    );
    keys(response, ["schemaVersion", "observationDocument", "observationSha256"]);
    if (response.schemaVersion !== 2) fail("Unsupported V2 observation");
    const observation = decodeObservation(response.observationDocument, response.observationSha256);
    if (
      observation.batchId !== context.batchId ||
      observation.contextSha256 !== context.contextSha256 ||
      observation.pageNumber !== context.pageCount ||
      observation.startSequence !== context.nextSequence ||
      observation.previousReceiptSha256 !== context.lastPageReceiptSha256 ||
      observation.maximumRecords !== String(pageLimit) ||
      BigInt(observation.endSequence as string) > BigInt(context.stagedCount)
    )
      fail("V2 observation cursor or context differs");
    const requestDocument = canonicalJson({
      schemaVersion: 2,
      kind: "catalogue-validation-request-page-v2",
      batchId: context.batchId,
      contextSha256: context.contextSha256,
      validatorDatabasePrincipal: context.validatorDatabasePrincipal,
      pageNumber: observation.pageNumber,
      startSequence: observation.startSequence,
      endSequence: observation.endSequence,
      previousReceiptSha256: context.lastPageReceiptSha256,
      observationDocument: response.observationDocument,
      observationSha256: response.observationSha256,
      records: validateObservationRecords(observation),
      sqlSemanticScope: SQL_SCOPE,
    } as JsonValue);
    if (Buffer.byteLength(requestDocument) > PAGE_BYTES && pageLimit > 1) {
      pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      continue;
    }
    return parsePreparedCatalogueValidationPageV2(requestDocument);
  }
}

/** Replays exactly retained bytes. It never obtains a fresh observation. */
export function parsePreparedCatalogueValidationPageV2(
  requestDocument: string,
): PreparedCatalogueValidationPageV2 {
  const requestSha256 = catalogueDocumentSha256V2(requestDocument, PAGE_BYTES);
  const request = object(JSON.parse(requestDocument));
  keys(request, [
    "schemaVersion",
    "kind",
    "batchId",
    "contextSha256",
    "validatorDatabasePrincipal",
    "pageNumber",
    "startSequence",
    "endSequence",
    "previousReceiptSha256",
    "observationDocument",
    "observationSha256",
    "records",
    "sqlSemanticScope",
  ]);
  if (
    request.schemaVersion !== 2 ||
    request.kind !== "catalogue-validation-request-page-v2" ||
    request.sqlSemanticScope !== SQL_SCOPE
  )
    fail("Unsupported V2 validation request");
  if (canonicalJson(request as JsonValue) !== requestDocument)
    fail("V2 retained request is not exact canonical JSON");
  uuid(request.batchId);
  hash(request.contextSha256);
  hash(request.previousReceiptSha256);
  text(request.validatorDatabasePrincipal, 63);
  integer(request.pageNumber);
  integer(request.startSequence);
  integer(request.endSequence);
  const observation = decodeObservation(request.observationDocument, request.observationSha256);
  for (const name of [
    "batchId",
    "contextSha256",
    "pageNumber",
    "startSequence",
    "endSequence",
    "previousReceiptSha256",
  ])
    if (observation[name] !== request[name])
      fail("V2 retained request observation identity differs");
  if (
    canonicalJson(validateObservationRecords(observation)) !==
    canonicalJson(request.records as JsonValue)
  )
    fail("V2 retained request differs from independent client semantics");
  return {
    requestDocument,
    requestSha256,
    requestByteSize: Buffer.byteLength(requestDocument),
    batchId: request.batchId as string,
    contextSha256: request.contextSha256 as string,
    validatorDatabasePrincipal: request.validatorDatabasePrincipal as string,
    pageNumber: request.pageNumber as string,
    startSequence: request.startSequence as string,
    endSequence: request.endSequence as string,
    observationSha256: request.observationSha256 as string,
    previousReceiptSha256: request.previousReceiptSha256 as string,
  };
}

export async function submitCatalogueValidationPageV2(
  database: Kysely<Database>,
  value: PreparedCatalogueValidationPageV2,
  expected: CatalogueValidationContextV2,
): Promise<CatalogueValidationPageReceiptV2> {
  const request = parsePreparedCatalogueValidationPageV2(value.requestDocument);
  // The parsed envelope contains only scalar fields. Compare them directly so
  // the retained page document is not copied into two more JSON serializations.
  const fields = Object.keys(request) as (keyof PreparedCatalogueValidationPageV2)[];
  if (
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field) || value[field] !== request[field])
  )
    fail("V2 retained request metadata differs from exact bytes");
  const context = parseCatalogueValidationContextV2(expected);
  assertRequestContext(request, context);
  const principal = await assertCatalogueValidatePrincipal(database);
  if (principal.databasePrincipal !== request.validatorDatabasePrincipal)
    fail("V2 retained request belongs to another principal");
  const response = only(
    (
      await sql<{ result: unknown }>`
    select public.catalogue_submit_validation_page_v2(
      ${request.batchId}::uuid,${request.requestDocument}::text) as result
  `.execute(database)
    ).rows,
  );
  return parseCatalogueValidationPageReceiptV2(response, request, context);
}

export function parseCatalogueValidationPageReceiptV2(
  value: unknown,
  request: PreparedCatalogueValidationPageV2,
  context: CatalogueValidationContextV2,
): CatalogueValidationPageReceiptV2 {
  const row = object(value);
  keys(row, [
    "schemaVersion",
    "kind",
    "batchId",
    "contextSha256",
    "pageNumber",
    "startSequence",
    "endSequence",
    "requestSha256",
    "validationCommitmentSha256",
    "semanticCommitmentSha256",
    "receiptSha256",
  ]);
  if (row.schemaVersion !== 2 || row.kind !== "catalogue-validation-page-receipt-v2")
    fail("Unsupported V2 validation receipt");
  for (const name of [
    "batchId",
    "contextSha256",
    "pageNumber",
    "startSequence",
    "endSequence",
    "requestSha256",
  ])
    if (row[name] !== request[name as keyof PreparedCatalogueValidationPageV2])
      fail("V2 receipt does not identify retained request");
  hash(row.semanticCommitmentSha256);
  const commitment = catalogueFramedSha256V2("validation-page", [
    context.validationCommitmentSha256,
    request.contextSha256,
    request.pageNumber,
    request.startSequence,
    request.endSequence,
    request.observationSha256,
    request.requestSha256,
  ]);
  if (
    row.validationCommitmentSha256 !== commitment ||
    row.receiptSha256 !==
      catalogueFramedSha256V2("validation-page-receipt", [
        request.batchId,
        request.contextSha256,
        request.pageNumber,
        request.startSequence,
        request.endSequence,
        request.requestSha256,
        commitment,
        row.semanticCommitmentSha256 as string,
      ])
  )
    fail("V2 validation receipt commitment differs");
  return row as unknown as CatalogueValidationPageReceiptV2;
}

export function advanceCatalogueValidationContextV2(
  context: CatalogueValidationContextV2,
  request: PreparedCatalogueValidationPageV2,
  receipt: CatalogueValidationPageReceiptV2,
): CatalogueValidationContextV2 {
  assertRequestContext(request, context);
  const checked = parseCatalogueValidationPageReceiptV2(receipt, request, context);
  return {
    ...context,
    nextSequence: checked.endSequence,
    pageCount: (BigInt(context.pageCount) + 1n).toString(),
    lastPageReceiptSha256: checked.receiptSha256,
    validationCommitmentSha256: checked.validationCommitmentSha256,
    semanticCommitmentSha256: checked.semanticCommitmentSha256,
  };
}

export function prepareCatalogueValidationTerminalV2(
  value: CatalogueValidationContextV2,
): PreparedCatalogueValidationTerminalV2 {
  const context = parseCatalogueValidationContextV2(value);
  if (context.nextSequence !== context.stagedCount)
    fail("V2 validation terminal requires complete record coverage");
  const terminalDocument = canonicalJson({
    schemaVersion: 2,
    kind: "catalogue-validation-terminal-request-v2",
    batchId: context.batchId,
    contextSha256: context.contextSha256,
    pageCount: context.pageCount,
    recordCount: context.nextSequence,
    lastPageReceiptSha256: context.lastPageReceiptSha256,
    validationCommitmentSha256: context.validationCommitmentSha256,
    semanticCommitmentSha256: context.semanticCommitmentSha256,
  });
  return {
    terminalDocument,
    terminalRequestSha256: catalogueDocumentSha256V2(terminalDocument, 8192),
  };
}

export async function submitCatalogueValidationTerminalV2(
  database: Kysely<Database>,
  context: CatalogueValidationContextV2,
  value: PreparedCatalogueValidationTerminalV2,
): Promise<CatalogueValidationTerminalReceiptV2> {
  const expected = prepareCatalogueValidationTerminalV2(context);
  if (
    value.terminalDocument !== expected.terminalDocument ||
    value.terminalRequestSha256 !== expected.terminalRequestSha256
  )
    fail("V2 retained terminal request differs");
  const principal = await assertCatalogueValidatePrincipal(database);
  if (principal.databasePrincipal !== context.validatorDatabasePrincipal)
    fail("V2 terminal belongs to another principal");
  const row = object(
    only(
      (
        await sql<{ result: unknown }>`
    select public.catalogue_finish_validation_v2(
      ${context.batchId}::uuid,${value.terminalDocument}::text) as result
  `.execute(database)
      ).rows,
    ),
  );
  keys(row, [
    "schemaVersion",
    "kind",
    "batchId",
    "contextSha256",
    "terminalRequestSha256",
    "summaryDocument",
    "terminalSha256",
  ]);
  text(row.summaryDocument, 8192);
  if (
    row.schemaVersion !== 2 ||
    row.kind !== "catalogue-validation-terminal-receipt-v2" ||
    row.batchId !== context.batchId ||
    row.contextSha256 !== context.contextSha256 ||
    row.terminalRequestSha256 !== expected.terminalRequestSha256 ||
    row.terminalSha256 !==
      catalogueFramedSha256V2("validation-terminal", [
        expected.terminalDocument,
        row.summaryDocument as string,
      ])
  )
    fail("V2 terminal receipt identity differs");
  const summary = object(JSON.parse(row.summaryDocument as string));
  keys(summary, [
    "schemaVersion",
    "kind",
    "batchId",
    "contextSha256",
    "sqlSemanticScope",
    "pageCount",
    "stagedCount",
    "validCount",
    "quarantinedCount",
    "warningCount",
    "recordErrorCount",
    "nutrientInputCount",
    "nutrientMaterializableCount",
    "excludedNutrientCount",
    "portionInputCount",
    "unresolvedErrorCount",
    "policyEligible",
    "promotionEligible",
    "validationCommitmentSha256",
    "semanticCommitmentSha256",
    "lastPageReceiptSha256",
    "terminalRequestSha256",
  ]);
  if (
    summary.schemaVersion !== 2 ||
    summary.kind !== "catalogue-validation-summary-v2" ||
    summary.batchId !== context.batchId ||
    summary.contextSha256 !== context.contextSha256 ||
    summary.sqlSemanticScope !== SQL_SCOPE ||
    summary.pageCount !== context.pageCount ||
    summary.stagedCount !== context.stagedCount ||
    summary.promotionEligible !== false ||
    summary.validationCommitmentSha256 !== context.validationCommitmentSha256 ||
    summary.semanticCommitmentSha256 !== context.semanticCommitmentSha256 ||
    summary.lastPageReceiptSha256 !== context.lastPageReceiptSha256 ||
    summary.terminalRequestSha256 !== expected.terminalRequestSha256
  )
    fail("V2 terminal summary differs from complete retained validation");
  for (const name of [
    "validCount",
    "quarantinedCount",
    "warningCount",
    "recordErrorCount",
    "nutrientInputCount",
    "nutrientMaterializableCount",
    "excludedNutrientCount",
    "portionInputCount",
    "unresolvedErrorCount",
  ])
    integer(summary[name]);
  if (summary.policyEligible !== (summary.unresolvedErrorCount === "0"))
    fail("V2 terminal policy outcome differs");
  return row as unknown as CatalogueValidationTerminalReceiptV2;
}

function decodeObservation(document: unknown, digest: unknown): ObjectValue {
  text(document, PAGE_BYTES);
  hash(digest);
  if (catalogueFramedSha256V2("validation-observation", [document as string]) !== digest)
    fail("V2 exact observation document checksum differs");
  const row = object(JSON.parse(document as string));
  keys(row, [
    "schemaVersion",
    "kind",
    "batchId",
    "contextSha256",
    "pageNumber",
    "startSequence",
    "endSequence",
    "maximumRecords",
    "previousReceiptSha256",
    "sourceCode",
    "releaseKey",
    "records",
    "nutrientMappings",
    "forbiddenGtins",
  ]);
  if (
    row.schemaVersion !== 2 ||
    row.kind !== "catalogue-validation-observation-v2" ||
    row.sourceCode !== "USDA_FDC"
  )
    fail("Unsupported V2 observation");
  uuid(row.batchId);
  hash(row.contextSha256);
  hash(row.previousReceiptSha256);
  for (const name of ["pageNumber", "startSequence", "endSequence"]) integer(row[name]);
  text(row.releaseKey, 1024);
  integer(row.maximumRecords);
  if (BigInt(row.maximumRecords as string) < 1n || BigInt(row.maximumRecords as string) > 250n)
    fail("V2 observation record limit differs");
  const rows = array(row.records, Number(row.maximumRecords));
  if (
    rows.length < 1 ||
    BigInt(row.endSequence as string) - BigInt(row.startSequence as string) !== BigInt(rows.length)
  )
    fail("V2 observation sequence coverage differs");
  return row;
}

function validateObservationRecords(observation: ObjectValue): JsonValue[] {
  const mappings = new Map<string, ReviewedCatalogueNutrientMapping>();
  const mappingRows = array(observation.nutrientMappings, 10000);
  if (Buffer.byteLength(canonicalJson(mappingRows as JsonValue)) > 4 * 1024 * 1024)
    fail("V2 mapping page exceeds byte bound");
  for (const value of mappingRows) {
    const row = object(value);
    keys(row, [
      "sourceNutrientId",
      "mappingRevisionId",
      "sourceUnit",
      "conversionMultiplier",
      "nutrientId",
      "nutrientCode",
      "canonicalUnit",
      "nutrientName",
      "nutrientDimension",
    ]);
    for (const name of Object.keys(row)) text(row[name], 2000);
    uuid(row.mappingRevisionId);
    if (
      !/^[1-9][0-9]*$/u.test(row.nutrientId as string) ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(row.conversionMultiplier as string) ||
      /^0(?:\.0+)?$/u.test(row.conversionMultiplier as string) ||
      mappings.has(row.sourceNutrientId as string)
    )
      fail("Invalid or duplicate V2 mapping evidence");
    mappings.set(
      row.sourceNutrientId as string,
      row as unknown as ReviewedCatalogueNutrientMapping,
    );
  }
  const forbidden = new Set<string>();
  for (const value of array(observation.forbiddenGtins, 250)) {
    text(value, 18);
    if (!/^[0-9]{14}:[A-Z0-9]{2,3}$/u.test(value as string) || forbidden.has(value as string))
      fail("Invalid or duplicate V2 forbidden barcode");
    forbidden.add(value as string);
  }
  const sourceKeys = new Set<string>();
  const foodKeys = new Set<string>();
  const barcodeKeys = new Set<string>();
  let totalPayload = 0;
  return array(observation.records, 250).map((value, index) => {
    const row = object(value);
    keys(row, [
      "sequenceNumber",
      "sourceRecordKey",
      "sourceRecordType",
      "sourcePayloadSha256",
      "canonicalPayloadSha256",
      "canonicalPayloadDocument",
    ]);
    if (
      row.sequenceNumber !==
      (BigInt(observation.startSequence as string) + BigInt(index)).toString()
    )
      fail("V2 observed records are not contiguous");
    text(row.sourceRecordKey, 4096);
    text(row.sourceRecordType, 1024);
    hash(row.sourcePayloadSha256);
    hash(row.canonicalPayloadSha256);
    text(row.canonicalPayloadDocument, RECORD_BYTES);
    totalPayload += Buffer.byteLength(row.canonicalPayloadDocument as string);
    if (totalPayload > 4 * 1024 * 1024) fail("V2 observation payload page exceeds bound");
    const payload = JSON.parse(row.canonicalPayloadDocument as string) as JsonValue;
    if (
      canonicalJson(payload) !== row.canonicalPayloadDocument ||
      catalogueDocumentSha256V2(row.canonicalPayloadDocument as string, RECORD_BYTES) !==
        row.canonicalPayloadSha256 ||
      sourceKeys.has(row.sourceRecordKey as string)
    )
      fail("V2 payload identity or canonical bytes differ");
    sourceKeys.add(row.sourceRecordKey as string);
    const result = validateCatalogueRecord(
      payload,
      {
        canonicalPayloadSha256: row.canonicalPayloadSha256 as string,
        expectedReleaseKey: observation.releaseKey as string,
        expectedSourceCode: "USDA_FDC",
        sourcePayloadSha256: row.sourcePayloadSha256 as string,
        sourceRecordKey: row.sourceRecordKey as string,
        sourceRecordType: row.sourceRecordType as string,
      },
      mappings,
      forbidden,
    );
    if (result.food) {
      if (foodKeys.has(result.food.sourceFoodKey))
        fail("V2 page contains duplicate source food identity");
      foodKeys.add(result.food.sourceFoodKey);
      if (result.food.gtin) {
        const barcode = `${result.food.gtin}:${result.food.marketCode}`;
        if (barcodeKeys.has(barcode)) fail("V2 page contains duplicate candidate barcode");
        barcodeKeys.add(barcode);
      }
    }
    const foodDocument = result.food ? canonicalJson(result.food as unknown as JsonValue) : null;
    if (foodDocument !== null) catalogueDocumentSha256V2(foodDocument, 2 * RECORD_BYTES);
    const issuesDocument = canonicalJson(result.issues as JsonValue);
    catalogueDocumentSha256V2(issuesDocument, RECORD_BYTES);
    return {
      sequenceNumber: row.sequenceNumber,
      sourceRecordKey: row.sourceRecordKey,
      canonicalPayloadSha256: row.canonicalPayloadSha256,
      status: result.recordIsValid ? "valid" : "quarantined",
      validatedFoodDocument: foodDocument,
      validatedFoodSha256: result.food
        ? sha256CanonicalJson(result.food as unknown as JsonValue)
        : null,
      validationIssuesDocument: issuesDocument,
      nutrientInputCount: String(result.nutrientInputCount),
      nutrientMaterializableCount: String(result.nutrientMaterializableCount),
      excludedNutrientCount: String(result.excludedNutrientCount),
      portionInputCount: String(result.portionInputCount),
    } as JsonValue;
  });
}
function assertRequestContext(
  request: PreparedCatalogueValidationPageV2,
  context: CatalogueValidationContextV2,
): void {
  if (
    request.batchId !== context.batchId ||
    request.contextSha256 !== context.contextSha256 ||
    request.validatorDatabasePrincipal !== context.validatorDatabasePrincipal ||
    request.pageNumber !== context.pageCount ||
    request.startSequence !== context.nextSequence ||
    request.previousReceiptSha256 !== context.lastPageReceiptSha256 ||
    BigInt(request.endSequence) > BigInt(context.stagedCount)
  )
    fail("V2 retained request does not continue pinned context");
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected V2 object");
  return value as ObjectValue;
}
function keys(value: ObjectValue, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== [...expected].sort()[index])
  )
    fail("V2 object fields differ");
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail("V2 array exceeds bound");
  return value;
}
function text(value: unknown, maximum: number): void {
  assertCatalogueTextV2(value, "V2 text");
  if (Buffer.byteLength(value) === 0 || Buffer.byteLength(value) > maximum)
    fail("V2 text exceeds bound");
}
function hash(value: unknown): void {
  assertCatalogueSha256V2(value, "V2 hash");
}
function integer(value: unknown): void {
  if (typeof value !== "string" || catalogueUnsignedIntegerV2(value, "V2 count") !== value)
    fail("V2 count requires canonical decimal text");
}
function uuid(value: unknown): void {
  if (typeof value !== "string" || !UUID.test(value)) fail("Invalid V2 UUID");
}
function only(rows: readonly { result: unknown }[]): unknown {
  if (rows.length !== 1 || !rows[0]) fail("Expected exactly one V2 database result");
  return rows[0].result;
}
function fail(message: string): never {
  throw new Error(message);
}
