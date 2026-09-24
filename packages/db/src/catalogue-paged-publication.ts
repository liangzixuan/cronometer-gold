import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { assertCataloguePreparationPrincipalV2 } from "./catalogue-paged-stage.js";
import { canonicalJson } from "./catalogue-validation.js";
import type { Database, JsonObject } from "./types.js";

export const CATALOGUE_PUBLICATION_OPERATIONS_V2 = [
  "admit",
  "begin",
  "materialize",
  "verify",
  "finish",
  "activate",
  "rollback",
] as const;
export type CataloguePublicationOperationV2 = (typeof CATALOGUE_PUBLICATION_OPERATIONS_V2)[number];
export const MAX_CATALOGUE_PUBLICATION_REQUEST_BYTES_V2 = 65_536;
export const CATALOGUE_PUBLICATION_LIMIT_KEYS_V2 = [
  "maxRecords",
  "maxMaterializationBytes",
  "maxIntermediateBytes",
  "maxEvidenceBytes",
  "maxCutoverFoodRows",
  "maxCutoverBarcodeRows",
  "maxCutoverBytes",
] as const;
const REQUEST_KEYS = {
  admit: [
    "batchId",
    "contextSha256",
    "validationTerminalSha256",
    "reportSha256",
    "publisherPrincipal",
    "limits",
  ],
  begin: ["batchId", "admissionSha256"],
  materialize: [
    "batchId",
    "publicationSha256",
    "pageNumber",
    "firstSequence",
    "previousReceiptSha256",
  ],
  verify: ["batchId", "publicationSha256", "pageNumber", "firstSequence", "previousReceiptSha256"],
  finish: ["batchId", "publicationSha256", "previousReceiptSha256"],
  activate: ["batchId", "publicationSha256", "sealSha256", "expectedCurrentReleaseId", "reason"],
  rollback: ["sourceCode", "targetReleaseId", "expectedCurrentReleaseId", "reason", "requestId"],
} as const;
const FUNCTIONS = {
  admit: "catalogue_admit_publication_v2",
  begin: "catalogue_begin_publication_v2",
  materialize: "catalogue_materialize_publication_page_v2",
  verify: "catalogue_verify_publication_page_v2",
  finish: "catalogue_finish_publication_v2",
  activate: "catalogue_activate_publication_v2",
  rollback: "catalogue_rollback_publication_v2",
} as const;
const COMMON_KEYS = ["schemaVersion", "operation", "batchId", "sourceCode", "requestSha256"];
const PROGRESS_KEYS = [
  "publicationSha256",
  "admissionSha256",
  "releaseId",
  "contextSha256",
  "validationTerminalSha256",
  "reportSha256",
  "baselineReleaseId",
  "phase",
  "nextSequence",
  "pageCount",
  "materializedCount",
  "verifiedSequence",
  "verifiedPageCount",
  "generation",
  "sealSha256",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const INTEGER = /^(?:0|[1-9][0-9]*)$/u;

export function cataloguePublicationOperationV2(value: unknown): CataloguePublicationOperationV2 {
  if (
    typeof value !== "string" ||
    !CATALOGUE_PUBLICATION_OPERATIONS_V2.some((item) => item === value)
  )
    throw new Error("Unknown catalogue publication operation");
  return value as CataloguePublicationOperationV2;
}

/** Canonical request bytes are retained before opening a database connection. */
export function encodeCataloguePublicationRequestV2(
  operation: CataloguePublicationOperationV2,
  input: unknown,
): string {
  validateRequest(operation, input);
  const document = canonicalJson(input as JsonObject);
  bounded(document, MAX_CATALOGUE_PUBLICATION_REQUEST_BYTES_V2);
  return document;
}

export function parseCataloguePublicationRequestV2(
  operation: CataloguePublicationOperationV2,
  document: string,
): JsonObject {
  bounded(document, MAX_CATALOGUE_PUBLICATION_REQUEST_BYTES_V2);
  const value: unknown = JSON.parse(document);
  validateRequest(operation, value);
  if (canonicalJson(value as JsonObject) !== document)
    throw new Error("Publication request must preserve its exact canonical document");
  return value as JsonObject;
}

/** SQL repeats authority checks inside the mutator; preflight cannot grant a role. */
export async function submitCataloguePublicationRequestV2(
  database: Kysely<Database>,
  operation: CataloguePublicationOperationV2,
  document: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  signal?.throwIfAborted();
  parseCataloguePublicationRequestV2(operation, document);
  return database.transaction().execute(async (transaction) => {
    // Restrict only this transaction and preserve any tighter caller limits.
    // Zero means unlimited in PostgreSQL; it receives the reviewed maximum.
    await sql`
      select pg_catalog.set_config('lock_timeout',
        least(2000, coalesce(nullif((select setting::bigint from pg_catalog.pg_settings where name='lock_timeout'), 0), 2000))::text, true),
        pg_catalog.set_config('statement_timeout',
        least(30000, coalesce(nullif((select setting::bigint from pg_catalog.pg_settings where name='statement_timeout'), 0), 30000))::text, true)
    `.execute(transaction);
    await assertCataloguePreparationPrincipalV2(
      transaction,
      operation === "admit"
        ? "nutrition_catalogue_approve_quality"
        : operation === "rollback"
          ? "nutrition_catalogue_rollback"
          : "nutrition_catalogue_promote_activate",
    );
    // Cancellation before mutation is definite; after dispatch, the retained request
    // remains the recovery authority for an uncertain database outcome.
    signal?.throwIfAborted();
    const rows = (
      await sql<{
        result: unknown;
      }>`select public.${sql.id(FUNCTIONS[operation])}(${document}::text) as result`.execute(
        transaction,
      )
    ).rows;
    if (rows.length !== 1) throw new Error("Publication returned no unique receipt");
    return verifyCataloguePublicationReceiptV2(operation, document, rows[0]?.result);
  });
}

export async function readCataloguePublicationV2(
  database: Kysely<Database>,
  batchId: string,
  authority: "publisher" | "rollback" = "publisher",
): Promise<JsonObject> {
  uuid(batchId);
  if (authority !== "publisher" && authority !== "rollback")
    throw new Error("Invalid publication read authority");
  await assertCataloguePreparationPrincipalV2(
    database,
    authority === "publisher"
      ? "nutrition_catalogue_promote_activate"
      : "nutrition_catalogue_rollback",
  );
  const rows = (
    await sql<{
      result: unknown;
    }>`select public.catalogue_read_publication_v2(${batchId}::uuid) as result`.execute(database)
  ).rows;
  if (rows.length !== 1) throw new Error("Publication returned no unique context");
  const row = object(rows[0]?.result);
  exactKeys(row, ["schemaVersion", "batchId", "sourceCode", "lastReceiptSha256", ...PROGRESS_KEYS]);
  if (row.schemaVersion !== 2 || row.batchId !== batchId)
    throw new Error("Publication context identity differs");
  text(row.sourceCode, 100);
  hash(row.lastReceiptSha256);
  progress(row);
  if (authority === "rollback" && row.phase !== "activated")
    throw new Error("Rollback cannot read unpublished context");
  return row;
}

export function verifyCataloguePublicationReceiptV2(
  operation: CataloguePublicationOperationV2,
  document: string,
  value: unknown,
): JsonObject {
  const request = parseCataloguePublicationRequestV2(operation, document);
  const row = object(value);
  bounded(canonicalJson(row), 131_072);
  const core = Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "receiptDocument" && key !== "receiptSha256"),
  ) as JsonObject;
  if (typeof row.receiptDocument !== "string")
    throw new Error("Publication receipt lacks exact document");
  bounded(row.receiptDocument, 65_536);
  hash(row.receiptSha256);
  if (
    sha256(row.receiptDocument) !== row.receiptSha256 ||
    canonicalJson(object(JSON.parse(row.receiptDocument))) !== canonicalJson(core)
  )
    throw new Error("Publication receipt document or digest differs");
  const extra =
    operation === "admit"
      ? ["admissionSha256", "publisherPrincipal", "limits"]
      : operation === "rollback"
        ? ["requestId", "activationId", "previousReleaseId", "activeReleaseId"]
        : [
            ...PROGRESS_KEYS,
            ...(operation === "activate"
              ? ["activationId", "previousReleaseId", "activeReleaseId"]
              : []),
          ];
  exactKeys(row, [...COMMON_KEYS, ...extra, "receiptDocument", "receiptSha256"]);
  if (
    row.schemaVersion !== 2 ||
    row.operation !== operation ||
    row.requestSha256 !== sha256(document) ||
    row.batchId !== (operation === "rollback" ? null : request.batchId)
  )
    throw new Error("Publication receipt request binding differs");
  text(row.sourceCode, 100);
  if (operation === "admit") {
    hash(row.admissionSha256);
    if (
      row.publisherPrincipal !== request.publisherPrincipal ||
      canonicalJson(row.limits ?? null) !== canonicalJson(request.limits ?? null)
    )
      throw new Error("Publication admission differs from retained request");
  } else if (operation === "rollback") {
    if (
      row.sourceCode !== request.sourceCode ||
      row.requestId !== request.requestId ||
      row.previousReleaseId !== request.expectedCurrentReleaseId ||
      row.activeReleaseId !== request.targetReleaseId
    )
      throw new Error("Publication rollback destination differs");
    positive(row.activationId);
    nullableUuid(row.previousReleaseId);
    nullableUuid(row.activeReleaseId);
  } else {
    progress(row);
    for (const key of ["admissionSha256", "publicationSha256", "sealSha256"])
      if (request[key] !== undefined && row[key] !== request[key])
        throw new Error("Publication receipt lineage differs");
    if (
      operation === "begin" &&
      (row.phase !== "materializing" ||
        row.nextSequence !== "0" ||
        row.pageCount !== "0" ||
        row.verifiedSequence !== "0" ||
        row.verifiedPageCount !== "0" ||
        row.materializedCount !== "0")
    )
      throw new Error("Publication begin cursor differs");
    if (operation === "materialize" || operation === "verify") {
      const cursor = count(row[operation === "materialize" ? "nextSequence" : "verifiedSequence"]);
      const first = count(request.firstSequence);
      if (
        cursor <= first ||
        cursor > first + 250n ||
        count(row[operation === "materialize" ? "pageCount" : "verifiedPageCount"]) !==
          count(request.pageNumber) + 1n
      )
        throw new Error("Publication page receipt cursor differs");
      if (operation === "materialize" && row.phase !== "materializing" && row.phase !== "verifying")
        throw new Error("Publication materialization phase differs");
      if (operation === "verify" && row.phase !== "verifying")
        throw new Error("Publication verification phase differs");
    }
    if (operation === "finish" && row.phase !== "sealed")
      throw new Error("Publication finish is not sealed");
    if (operation === "activate") {
      positive(row.activationId);
      nullableUuid(row.previousReleaseId);
      uuid(row.activeReleaseId);
      if (
        row.phase !== "activated" ||
        row.activeReleaseId !== row.releaseId ||
        row.previousReleaseId !== request.expectedCurrentReleaseId
      )
        throw new Error("Publication activation destination differs");
    }
  }
  return row;
}

function validateRequest(operation: CataloguePublicationOperationV2, input: unknown): void {
  cataloguePublicationOperationV2(operation);
  const row = object(input);
  exactKeys(row, ["schemaVersion", ...REQUEST_KEYS[operation]]);
  if (row.schemaVersion !== 2) throw new Error("Publication request version differs");
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("Sha256")) hash(value);
    if (key === "batchId" || key === "requestId") uuid(value);
  }
  if (operation === "admit") {
    if (
      typeof row.publisherPrincipal !== "string" ||
      !/^[a-z][-a-z0-9._:@/]{2,62}$/u.test(row.publisherPrincipal)
    )
      throw new Error("Invalid publication principal");
    const limits = object(row.limits);
    exactKeys(limits, CATALOGUE_PUBLICATION_LIMIT_KEYS_V2);
    for (const value of Object.values(limits)) positive(value);
  }
  if (operation === "materialize" || operation === "verify") {
    count(row.pageNumber);
    count(row.firstSequence);
  }
  if (operation === "activate" || operation === "rollback") {
    nullableUuid(row.expectedCurrentReleaseId);
    text(row.reason, 2048);
  }
  if (operation === "rollback") {
    nullableUuid(row.targetReleaseId);
    text(row.sourceCode, 100);
  }
}
function progress(row: JsonObject): void {
  for (const key of [
    "publicationSha256",
    "admissionSha256",
    "contextSha256",
    "validationTerminalSha256",
    "reportSha256",
  ])
    hash(row[key]);
  uuid(row.releaseId);
  nullableUuid(row.baselineReleaseId);
  if (row.sealSha256 !== null) hash(row.sealSha256);
  if (!["materializing", "verifying", "sealed", "activated"].includes(String(row.phase)))
    throw new Error("Invalid publication phase");
  for (const key of [
    "nextSequence",
    "pageCount",
    "materializedCount",
    "verifiedSequence",
    "verifiedPageCount",
    "generation",
  ])
    count(row[key]);
  if (
    count(row.materializedCount) > count(row.nextSequence) ||
    count(row.verifiedSequence) > count(row.nextSequence)
  )
    throw new Error("Invalid publication count conservation");
  const sealed = row.phase === "sealed" || row.phase === "activated";
  if (sealed !== (row.sealSha256 !== null) || (sealed && row.verifiedSequence !== row.nextSequence))
    throw new Error("Invalid publication seal coverage");
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Publication object required");
  return value as JsonObject;
}
function exactKeys(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new Error("Publication document or receipt shape differs");
}
function uuid(value: unknown): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid publication UUID");
}
function nullableUuid(value: unknown): void {
  if (value !== null) uuid(value);
}
function hash(value: unknown): void {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new Error("Invalid publication SHA-256");
}
function text(value: unknown, max: number): void {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value) > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid publication text");
}
function count(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !INTEGER.test(value) ||
    value.length > 19 ||
    BigInt(value) > 9_223_372_036_854_775_807n
  )
    throw new Error("Invalid publication decimal count");
  return BigInt(value);
}
function positive(value: unknown): void {
  if (count(value) === 0n) throw new Error("Publication limit or identifier must be positive");
}
function bounded(value: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximum)
    throw new Error("Publication document exceeds byte limit");
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
