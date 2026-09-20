import { type Kysely, sql } from "kysely";
import { CATALOGUE_CAPABILITY_ROLES } from "./catalogue-authority-deployment.js";
import type {
  RecordBatchParserReportInput,
  StageBatchInput,
  StagedCatalogueRecordInput,
} from "./catalogue-ingestion.js";
import { canonicalJson, sha256CanonicalJson } from "./catalogue-validation.js";
import type { Database, FoodImportBatchStatus, JsonObject, JsonValue } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RECORDS = 10_000;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export interface CatalogueStagePrincipal {
  readonly databasePrincipal: string;
  readonly capabilityRole: "nutrition_catalogue_stage";
}
export interface CatalogueStageBatchResult {
  readonly batchId: string;
  readonly nextOffset: number;
  readonly resumed: boolean;
  readonly stagedCount: number;
  readonly status: FoodImportBatchStatus;
}
export interface CatalogueStageChunkResult {
  readonly inserted: number;
  readonly nextOffset: number;
  readonly replayed: number;
  readonly stagedCount: number;
  readonly wasAlreadyStaged: boolean;
}
export interface CatalogueStageSealResult {
  readonly parserReportSha256: string;
  readonly stagingSealSha256: string;
  readonly wasAlreadySealed: boolean;
}

/** This client lane requires an actual restricted login, never the SQL owner compatibility path. */
export async function assertCatalogueStagePrincipal(
  database: Kysely<Database>,
): Promise<CatalogueStagePrincipal> {
  const result = await sql<{ result: unknown }>`
    select pg_catalog.jsonb_build_object(
      'databasePrincipal', session_user::text,
      'effectivePrincipal', current_user::text,
      'canLogin', actor.rolcanlogin,
      'privileged', actor.rolsuper or actor.rolcreatedb or actor.rolcreaterole
        or actor.rolreplication or actor.rolbypassrls,
      'ownerMember', pg_catalog.pg_has_role(session_user, target.relowner, 'member'),
      'capabilities', (
        select coalesce(pg_catalog.jsonb_agg(role_name order by role_name), '[]'::jsonb)
        from pg_catalog.unnest(${[...CATALOGUE_CAPABILITY_ROLES]}::text[]) as names(role_name)
        where pg_catalog.pg_has_role(session_user, role_name, 'member')
      )
    ) as result
    from pg_catalog.pg_roles as actor
    join pg_catalog.pg_class as target on target.oid = 'public.food_import_batch'::pg_catalog.regclass
    where actor.rolname = session_user
  `.execute(database);
  const row = onlyResult(result.rows);
  exactKeys(row, [
    "databasePrincipal",
    "effectivePrincipal",
    "canLogin",
    "privileged",
    "ownerMember",
    "capabilities",
  ]);
  if (
    typeof row.databasePrincipal !== "string" ||
    Buffer.byteLength(row.databasePrincipal) < 1 ||
    Buffer.byteLength(row.databasePrincipal) > 63 ||
    row.effectivePrincipal !== row.databasePrincipal ||
    row.canLogin !== true ||
    row.privileged !== false ||
    row.ownerMember !== false ||
    !Array.isArray(row.capabilities) ||
    row.capabilities.length !== 1 ||
    row.capabilities[0] !== "nutrition_catalogue_stage"
  ) {
    throw new Error(
      "Catalogue staging requires a non-owner restricted login with exactly the stage capability",
    );
  }
  return { databasePrincipal: row.databasePrincipal, capabilityRole: "nutrition_catalogue_stage" };
}

/** Exact existing migration-0020 protocol; no registration, mapping writes or owner DML. */
export async function createOrResumeCatalogueStage(
  database: Kysely<Database>,
  input: StageBatchInput,
): Promise<CatalogueStageBatchResult> {
  const document = boundedDocument(
    {
      ...input,
      schemaVersion: 1,
      acquiredAt: timestamp(input.acquiredAt),
      evidenceValidUntil: timestamp(input.evidenceValidUntil),
      artifactBytes: integerText(input.artifactBytes, "artifactBytes", true),
      publishedOn: input.publishedOn ?? null,
      upstreamSchemaVersion: input.upstreamSchemaVersion ?? null,
    },
    65_536,
  );
  await assertCatalogueStagePrincipal(database);
  const row = onlyResult(
    (
      await sql<{ result: unknown }>`
    select public.catalogue_stage_import_batch(${document}::text) as result
  `.execute(database)
    ).rows,
  );
  exactKeys(row, ["batchId", "nextOffset", "resumed", "stagedCount", "status"]);
  batchId(row.batchId);
  const nextOffset = receiptCount(row.nextOffset);
  const stagedCount = receiptCount(row.stagedCount);
  const statuses: readonly FoodImportBatchStatus[] = [
    "staging",
    "quarantined",
    "ready",
    "promoting",
    "completed",
    "failed",
  ];
  if (
    nextOffset !== stagedCount ||
    typeof row.resumed !== "boolean" ||
    (!row.resumed && (nextOffset !== 0 || row.status !== "staging")) ||
    !statuses.includes(row.status as FoodImportBatchStatus)
  )
    throw new Error("Invalid catalogue stage batch receipt");
  return {
    batchId: row.batchId as string,
    nextOffset,
    stagedCount,
    resumed: row.resumed,
    status: row.status as FoodImportBatchStatus,
  };
}

export async function appendCatalogueStageChunk(
  database: Kysely<Database>,
  input: {
    readonly batchId: string;
    readonly expectedNextOffset: number;
    readonly records: readonly StagedCatalogueRecordInput[];
  },
): Promise<CatalogueStageChunkResult> {
  batchId(input.batchId);
  const offset = receiptCount(input.expectedNextOffset);
  if (
    input.records.length < 1 ||
    input.records.length > 250 ||
    offset + input.records.length > MAX_RECORDS
  ) {
    throw new Error("Catalogue stage chunk exceeds the existing record limit");
  }
  const records = input.records.map((record, index) => {
    if (integerText(record.sequenceNumber, "sequenceNumber") !== String(offset + index))
      throw new Error("Catalogue stage sequences must be contiguous");
    if (
      !SHA256.test(record.sourcePayloadSha256) ||
      typeof record.sourceRecordKey !== "string" ||
      Buffer.byteLength(record.sourceRecordKey) < 1 ||
      Buffer.byteLength(record.sourceRecordKey) > 1024 ||
      typeof record.sourceRecordType !== "string" ||
      Buffer.byteLength(record.sourceRecordType) < 1 ||
      Buffer.byteLength(record.sourceRecordType) > 256
    ) {
      throw new Error("Invalid bounded catalogue staged record identity");
    }
    const canonicalPayloadDocument = boundedDocument(record.canonicalPayload, 1024 * 1024);
    const canonicalPayloadSha256 = sha256CanonicalJson(record.canonicalPayload);
    if (
      record.canonicalPayloadSha256 !== undefined &&
      record.canonicalPayloadSha256 !== canonicalPayloadSha256
    )
      throw new Error("Catalogue staged payload checksum mismatch");
    return {
      sourceRecordKey: record.sourceRecordKey,
      sourceRecordType: record.sourceRecordType,
      sequenceNumber: offset + index,
      sourcePayloadSha256: record.sourcePayloadSha256,
      canonicalPayloadSha256,
      canonicalPayloadDocument,
    };
  });
  const document = boundedDocument({ schemaVersion: 1, records }, MAX_CHUNK_BYTES);
  await assertCatalogueStagePrincipal(database);
  const row = onlyResult(
    (
      await sql<{ result: unknown }>`
    select public.catalogue_stage_import_record_chunk(${input.batchId}::uuid, ${offset}::bigint, ${document}::text) as result
  `.execute(database)
    ).rows,
  );
  exactKeys(row, ["inserted", "nextOffset", "replayed", "stagedCount", "wasAlreadyStaged"]);
  const inserted = receiptCount(row.inserted);
  const replayed = receiptCount(row.replayed);
  const nextOffset = receiptCount(row.nextOffset);
  const stagedCount = receiptCount(row.stagedCount);
  if (
    typeof row.wasAlreadyStaged !== "boolean" ||
    nextOffset !== offset + records.length ||
    stagedCount !== nextOffset ||
    inserted + replayed !== records.length ||
    (row.wasAlreadyStaged
      ? inserted !== 0 || replayed !== records.length
      : replayed !== 0 || inserted !== records.length)
  ) {
    throw new Error("Invalid catalogue stage chunk receipt");
  }
  return { inserted, replayed, nextOffset, stagedCount, wasAlreadyStaged: row.wasAlreadyStaged };
}

/** Pure preflight, shared by the CLI before any connection and the final seal write. */
export function encodeCatalogueStageParserReport(input: RecordBatchParserReportInput): string {
  batchId(input.batchId);
  const reportDocument = boundedDocument(input.report, 15 * 1024 * 1024);
  const reportSha256 = sha256CanonicalJson(input.report);
  if (input.reportSha256 !== undefined && input.reportSha256 !== reportSha256)
    throw new Error("Catalogue parser report checksum mismatch");
  const fields = [
    "sourceRecordCount",
    "emittedRecordCount",
    "excludedRecordCount",
    "sourceNutrientCount",
    "emittedNutrientCount",
    "excludedNutrientCount",
    "sourcePortionCount",
    "emittedPortionCount",
    "excludedPortionCount",
  ] as const;
  const counts = Object.fromEntries(
    fields.map((key) => [key, integerText(input[key], key)]),
  ) as Record<(typeof fields)[number], string>;
  for (const kind of ["Record", "Nutrient", "Portion"] as const) {
    if (
      BigInt(counts[`source${kind}Count`]) !==
      BigInt(counts[`emitted${kind}Count`]) + BigInt(counts[`excluded${kind}Count`])
    )
      throw new Error("Catalogue parser count conservation differs");
  }
  if (BigInt(counts.emittedRecordCount) > BigInt(MAX_RECORDS))
    throw new Error("Catalogue parser report exceeds stage record limit");
  return boundedDocument(
    { schemaVersion: 1, reportDocument, reportSha256, ...counts },
    MAX_CHUNK_BYTES,
  );
}

export async function sealCatalogueStageParserReport(
  database: Kysely<Database>,
  input: RecordBatchParserReportInput,
): Promise<CatalogueStageSealResult> {
  const document = encodeCatalogueStageParserReport(input);
  const reportSha256 = sha256CanonicalJson(input.report);
  await assertCatalogueStagePrincipal(database);
  const row = onlyResult(
    (
      await sql<{ result: unknown }>`
    select public.catalogue_stage_import_parser_report(${input.batchId}::uuid, ${document}::text) as result
  `.execute(database)
    ).rows,
  );
  exactKeys(row, ["parserReportSha256", "stagingSealSha256", "wasAlreadySealed"]);
  if (
    row.parserReportSha256 !== reportSha256 ||
    typeof row.stagingSealSha256 !== "string" ||
    !SHA256.test(row.stagingSealSha256) ||
    typeof row.wasAlreadySealed !== "boolean"
  )
    throw new Error("Invalid catalogue stage seal receipt");
  return {
    parserReportSha256: reportSha256,
    stagingSealSha256: row.stagingSealSha256,
    wasAlreadySealed: row.wasAlreadySealed,
  };
}

function onlyResult(rows: readonly { result: unknown }[]): JsonObject {
  if (
    rows.length !== 1 ||
    typeof rows[0]?.result !== "object" ||
    rows[0].result === null ||
    Array.isArray(rows[0].result)
  )
    throw new Error("Catalogue capability returned no unique object receipt");
  return rows[0].result as JsonObject;
}
function exactKeys(row: JsonObject, names: readonly string[]): void {
  if (Object.keys(row).sort().join("\0") !== [...names].sort().join("\0"))
    throw new Error("Catalogue capability receipt shape differs");
}
function batchId(value: unknown): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid catalogue batch ID");
}
function receiptCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_RECORDS)
    throw new Error("Invalid bounded catalogue receipt count");
  return value;
}
function integerText(value: unknown, field: string, positive = false): string {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string")
    throw new Error(`Invalid ${field}`);
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error(`Invalid ${field}`);
  const text = String(value);
  if (
    !/^(0|[1-9][0-9]{0,18})$/u.test(text) ||
    BigInt(text) > 9223372036854775807n ||
    (positive && text === "0")
  )
    throw new Error(`Invalid ${field}`);
  return text;
}
function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid catalogue timestamp");
  return date.toISOString();
}
function boundedDocument(value: JsonValue, limit: number): string {
  assertPostgresJsonStrings(value);
  const result = canonicalJson(value);
  if (Buffer.byteLength(result, "utf8") > limit)
    throw new Error("Catalogue capability document exceeds its existing byte limit");
  return result;
}

// PostgreSQL JSONB rejects NUL and lone surrogates even when JSON.parse accepts
// their escaped form. Reject before staging, including strings in the seal report.
function assertPostgresJsonStrings(value: JsonValue): void {
  if (typeof value === "string") {
    for (const character of value) {
      const point = character.codePointAt(0) ?? 0;
      if (point === 0 || (point >= 0xd800 && point <= 0xdfff))
        throw new Error("Catalogue document contains a string PostgreSQL JSONB cannot store");
    }
  } else if (Array.isArray(value)) {
    for (const child of value) assertPostgresJsonStrings(child);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertPostgresJsonStrings(key);
      assertPostgresJsonStrings(child);
    }
  }
}
