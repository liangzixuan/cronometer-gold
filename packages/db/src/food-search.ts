import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";

import type { Database, PromotedFoodSearchCatalogueV1Table } from "./types.js";

const DEFAULT_PROJECTION_PAGE_SIZE = 250;
const MAX_PROJECTION_PAGE_SIZE = 500;
const DEFAULT_FALLBACK_RESULT_LIMIT = 20;
const MAX_FALLBACK_RESULT_LIMIT = 50;
const MAX_DOCUMENT_BARCODES = 32;
const MAX_DOCUMENT_SERVINGS = 64;
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const MAX_BIGINT_ID = 9_223_372_036_854_775_807n;

type CatalogueRow = Selectable<PromotedFoodSearchCatalogueV1Table>;
type SearchExecutor = Kysely<Database> | Transaction<Database>;

export interface FoodSearchBarcodeProjection {
  /** Canonical GTIN identity used for exact matching. */
  readonly gtin14: string;
  /** Valid source representation retained for display and provenance. */
  readonly sourceGtin: string;
  readonly marketCode: string;
}

export interface FoodSearchServingProjection {
  readonly id: string;
  readonly sourceServingKey: string | null;
  readonly label: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitKind: "count" | "mass" | "volume";
  readonly gramWeight: string | null;
  readonly milliliterVolume: string | null;
  readonly isDefault: boolean;
  readonly displayOrder: number;
}

/** Version-pinned public document suitable for a disposable external index. */
export interface FoodSearchProjectionDocument {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly versionNumber: number;
  readonly kind: "branded" | "generic";
  readonly sourceFoodKey: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly brandName: string | null;
  readonly description: string | null;
  readonly languageTag: string;
  readonly marketCode: string;
  readonly dataQuality: "curated" | "provisional" | "verified";
  readonly basisQuantity: string;
  readonly basisUnit: "g" | "ml" | "serving";
  readonly sourceModifiedAt: string | null;
  readonly foodSourceId: string;
  readonly sourceCode: string;
  readonly sourceDisplayName: string;
  readonly licenseExpression: string;
  readonly attributionRequired: boolean;
  readonly attributionText: string;
  readonly sourceReleaseId: string;
  readonly sourceReleaseKey: string;
  readonly sourceArtifactSha256: string;
  readonly barcodes: readonly FoodSearchBarcodeProjection[];
  readonly barcodesTruncated: boolean;
  readonly servings: readonly FoodSearchServingProjection[];
  readonly servingsTruncated: boolean;
}

export interface PageFoodSearchProjectionInput {
  /** Exclusive, decimal food ID returned by the previous page. */
  readonly afterFoodId?: string | null;
  readonly limit?: number;
}

export interface FoodSearchProjectionPage {
  readonly documents: readonly FoodSearchProjectionDocument[];
  readonly nextCursor: string | null;
}

export interface FoodSearchProjectionSnapshotInfo {
  /** Digest of the source/release set visible to this PostgreSQL snapshot. */
  readonly generation: string;
  readonly expectedDocumentCount: string;
  /** Monotonic eligibility/metadata revision visible to this snapshot. */
  readonly revision: string;
}

export class FoodSearchProjectionRevisionChangedError extends Error {
  constructor() {
    super("food-search projection changed while the index generation was being built");
    this.name = "FoodSearchProjectionRevisionChangedError";
  }
}

export interface ConsumeFoodSearchProjectionSnapshotOptions {
  readonly pageSize?: number;
  /** Runs after count verification but before the read-only transaction ends. */
  readonly finalize?: (result: FoodSearchProjectionSnapshotResult) => Promise<void>;
}

export interface FoodSearchProjectionSnapshotPage extends FoodSearchProjectionPage {
  readonly pageNumber: number;
  readonly snapshot: FoodSearchProjectionSnapshotInfo;
}

export interface FoodSearchProjectionSnapshotResult extends FoodSearchProjectionSnapshotInfo {
  readonly consumedDocumentCount: string;
  readonly pageCount: number;
}

export interface LookupPromotedFoodByBarcodeInput {
  readonly barcode: string;
  /** Requested market wins, then global `001`; omitted means global then lexical market. */
  readonly marketCode?: string | null;
}

export interface SearchPromotedFoodsPostgresInput {
  readonly query: string;
  readonly limit?: number;
  /** Restricts candidates to this market plus global `001`. */
  readonly marketCode?: string | null;
  readonly kind?: "branded" | "generic" | null;
  readonly languageTag?: string | null;
}

export interface FoodSearchFallbackResult {
  readonly document: FoodSearchProjectionDocument;
  readonly score: number;
}

/**
 * Validate a GTIN-8/12/13/14 check digit and return its zero-padded GTIN-14
 * identity. Formatting characters are intentionally rejected: this is an exact
 * barcode operation, not a fuzzy text parser. Surrounding whitespace is
 * ignored, while internal formatting characters are rejected.
 */
export function normalizeGtin14(value: string): string {
  const candidate = value.trim();
  if (!/^\d+$/.test(candidate) || !GTIN_LENGTHS.has(candidate.length)) {
    throw new Error("barcode must contain exactly 8, 12, 13, or 14 digits");
  }
  const data = candidate.slice(0, -1);
  let weightedSum = 0;
  for (let index = data.length - 1, position = 0; index >= 0; index -= 1, position += 1) {
    weightedSum += Number(data[index]) * (position % 2 === 0 ? 3 : 1);
  }
  const expectedCheckDigit = (10 - (weightedSum % 10)) % 10;
  if (Number(candidate.at(-1)) !== expectedCheckDigit) {
    throw new Error("barcode has an invalid GS1 check digit");
  }
  return candidate.padStart(14, "0");
}

export function isValidGtin(value: string): boolean {
  try {
    normalizeGtin14(value);
    return true;
  } catch {
    return false;
  }
}

/** Page the authoritative projection using a stable, exclusive food-ID cursor. */
export async function pageFoodSearchProjection(
  database: Kysely<Database>,
  input: PageFoodSearchProjectionInput = {},
): Promise<FoodSearchProjectionPage> {
  const limit = boundedInteger(
    input.limit,
    DEFAULT_PROJECTION_PAGE_SIZE,
    MAX_PROJECTION_PAGE_SIZE,
    "limit",
  );
  const afterFoodId = normalizeFoodIdCursor(input.afterFoodId);
  return readProjectionSnapshot(database, async (transaction) => {
    return pageProjectionWithinSnapshot(transaction, afterFoodId, limit);
  });
}

/**
 * Stream a complete rebuild from one MVCC snapshot. The callback must apply
 * backpressure (resolve only after persisting the page); throwing aborts the
 * rebuild and no later page is delivered.
 */
export async function consumeFoodSearchProjectionSnapshot(
  database: Kysely<Database>,
  options: ConsumeFoodSearchProjectionSnapshotOptions,
  consumePage: (page: FoodSearchProjectionSnapshotPage) => Promise<void>,
): Promise<FoodSearchProjectionSnapshotResult> {
  const pageSize = boundedInteger(
    options.pageSize,
    DEFAULT_PROJECTION_PAGE_SIZE,
    MAX_PROJECTION_PAGE_SIZE,
    "pageSize",
  );
  return readProjectionSnapshot(database, async (transaction) => {
    const snapshotResult = await sql<{
      document_count: string;
      generation: string;
      revision: string;
    }>`
      with releases as (
        select distinct food_source_id, source_release_id
        from promoted_food_search_catalogue_v1
      ), totals as (
        select count(*)::bigint as document_count
        from promoted_food_search_catalogue_v1
      )
      select
        totals.document_count,
        encode(
          digest(
            coalesce(
              string_agg(
                releases.food_source_id || ':' || releases.source_release_id,
                ',' order by releases.food_source_id
              ),
              ''
            ),
            'sha256'
          ),
          'hex'
        ) as generation
        , revision.current_revision as revision
      from totals
      left join releases on true
      cross join food_search_projection_revision as revision
      where revision.singleton
      group by totals.document_count, revision.current_revision
    `.execute(transaction);
    const snapshotRow = snapshotResult.rows[0];
    if (!snapshotRow) throw new Error("food-search snapshot metadata query returned no row");
    const snapshot: FoodSearchProjectionSnapshotInfo = {
      expectedDocumentCount: snapshotRow.document_count,
      generation: snapshotRow.generation,
      revision: snapshotRow.revision,
    };
    let cursor: string | null = null;
    let consumed = 0n;
    let pageCount = 0;
    do {
      const page = await pageProjectionWithinSnapshot(transaction, cursor, pageSize);
      if (page.documents.length === 0) break;
      pageCount += 1;
      consumed += BigInt(page.documents.length);
      await consumePage({ ...page, pageNumber: pageCount, snapshot });
      cursor = page.nextCursor;
    } while (cursor !== null);

    if (consumed.toString() !== snapshot.expectedDocumentCount) {
      throw new Error(
        `food-search snapshot count changed: expected ${snapshot.expectedDocumentCount}, consumed ${consumed}`,
      );
    }
    const result = {
      ...snapshot,
      consumedDocumentCount: consumed.toString(),
      pageCount,
    };
    await options.finalize?.(result);
    return result;
  });
}

/** Defense-in-depth freshness check immediately before an external index swap. */
export async function assertFoodSearchProjectionRevision(
  database: Kysely<Database>,
  expectedRevision: string,
): Promise<void> {
  if (!/^(?:0|[1-9]\d*)$/u.test(expectedRevision) || BigInt(expectedRevision) > MAX_BIGINT_ID) {
    throw new Error("expectedRevision must be a PostgreSQL bigint decimal string");
  }
  const current = await database
    .selectFrom("food_search_projection_revision")
    .select("current_revision")
    .where("singleton", "=", true)
    .executeTakeFirstOrThrow();
  if (current.current_revision !== expectedRevision) {
    throw new FoodSearchProjectionRevisionChangedError();
  }
}

export interface FoodSearchProjectionPublicationState {
  readonly currentRevision: string;
  readonly publishedRevision: string | null;
  readonly isCurrent: boolean;
}

export async function getFoodSearchProjectionPublicationState(
  database: Kysely<Database>,
): Promise<FoodSearchProjectionPublicationState> {
  const state = await database
    .selectFrom("food_search_projection_revision")
    .select(["current_revision", "published_revision"])
    .where("singleton", "=", true)
    .executeTakeFirstOrThrow();
  return {
    currentRevision: state.current_revision,
    publishedRevision: state.published_revision,
    isCurrent:
      state.published_revision !== null && state.current_revision === state.published_revision,
  };
}

/** Mark a verified manual rebuild current without acknowledging outbox events. */
export async function publishFoodSearchProjectionRevision(
  database: Kysely<Database>,
  input: { readonly expectedRevision: string },
): Promise<void> {
  validateProjectionRevision(input.expectedRevision);
  await database.transaction().execute(async (transaction) => {
    const state = await transaction
      .selectFrom("food_search_projection_revision")
      .select("current_revision")
      .where("singleton", "=", true)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (state.current_revision !== input.expectedRevision) {
      throw new FoodSearchProjectionRevisionChangedError();
    }
    await transaction
      .updateTable("food_search_projection_revision")
      .set({
        published_revision: input.expectedRevision,
        updated_at: sql`clock_timestamp()`,
      })
      .where("singleton", "=", true)
      .executeTakeFirstOrThrow();
  });
}

function validateProjectionRevision(value: string): void {
  if (!/^(?:0|[1-9]\d*)$/u.test(value) || BigInt(value) > MAX_BIGINT_ID) {
    throw new Error("expectedRevision must be a PostgreSQL bigint decimal string");
  }
}

/** Exact GTIN identity lookup with deterministic requested-market/global fallback. */
export async function lookupPromotedFoodByBarcode(
  database: Kysely<Database>,
  input: LookupPromotedFoodByBarcodeInput,
): Promise<FoodSearchProjectionDocument | null> {
  const gtin14 = normalizeGtin14(input.barcode);
  const marketCode = normalizeMarketCode(input.marketCode);
  return readProjectionSnapshot(database, async (transaction) => {
    let query = transaction
      .selectFrom("food_barcode as barcode")
      .innerJoin(
        "promoted_food_search_catalogue_v1 as catalogue",
        "catalogue.food_id",
        "barcode.food_id",
      )
      .selectAll("catalogue")
      .where("barcode.valid_to", "is", null)
      .whereRef("barcode.food_version_id", "=", "catalogue.food_version_id")
      .whereRef("barcode.source_release_id", "=", "catalogue.source_release_id")
      .where(sql<boolean>`lpad(barcode.gtin, 14, '0') = ${gtin14}`);

    if (marketCode === "001") {
      query = query.where("barcode.market_code", "=", "001");
    } else if (marketCode) {
      query = query.where("barcode.market_code", "in", [marketCode, "001"]);
    }

    const marketRank = marketCode
      ? sql<number>`case
          when barcode.market_code = ${marketCode} then 0
          when barcode.market_code = '001' then 1
          else 2
        end`
      : sql<number>`case when barcode.market_code = '001' then 0 else 1 end`;
    const row = await query
      .orderBy(marketRank, "asc")
      .orderBy("barcode.market_code", "asc")
      .orderBy("catalogue.food_id", "asc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    const document = (await loadProjectionDocuments(transaction, [row]))[0];
    return document?.foodVersionId === row.food_version_id ? document : null;
  });
}

/**
 * Bounded PostgreSQL trigram fallback for degraded search operation. This is
 * intentionally not the primary relevance engine and has no offset/unbounded API.
 */
export async function searchPromotedFoodsPostgres(
  database: Kysely<Database>,
  input: SearchPromotedFoodsPostgresInput,
): Promise<readonly FoodSearchFallbackResult[]> {
  const queryText = normalizeSearchQuery(input.query);
  const marketCode = normalizeMarketCode(input.marketCode);
  const kind = normalizeFoodKind(input.kind);
  const languageTag = normalizeInputLanguageTag(input.languageTag);
  const limit = boundedInteger(
    input.limit,
    DEFAULT_FALLBACK_RESULT_LIMIT,
    MAX_FALLBACK_RESULT_LIMIT,
    "limit",
  );

  return readProjectionSnapshot(database, async (transaction) => {
    await sql`set local statement_timeout = '2s'`.execute(transaction);
    await sql`set local pg_trgm.similarity_threshold = 0.20`.execute(transaction);
    const marketFilter = marketCode
      ? sql`and catalogue.market_code in (${marketCode}, '001')`
      : sql``;
    const kindFilter = kind ? sql`and catalogue.kind = ${kind}` : sql``;
    const languageFilter = languageTag ? sql`and catalogue.language_tag = ${languageTag}` : sql``;
    const marketRank = marketCode
      ? sql`case
          when catalogue.market_code = ${marketCode} then 0
          when catalogue.market_code = '001' then 1
          else 2
        end`
      : sql`case when catalogue.market_code = '001' then 0 else 1 end`;
    const result = await sql<CatalogueRow & { relevance: number }>`
      select
        catalogue.*,
        greatest(
          case when lower(catalogue.normalized_name) = ${queryText} then 1.0 else 0.0 end,
          case when starts_with(lower(catalogue.normalized_name), ${queryText})
            then 0.95 else 0.0 end,
          case when lower(coalesce(catalogue.brand_name, '')) = ${queryText}
            then 0.90 else 0.0 end,
          similarity(
            lower(catalogue.normalized_name || ' ' || coalesce(catalogue.brand_name, '')),
            ${queryText}
          )::double precision
        )::double precision as relevance
      from promoted_food_search_catalogue_v1 as catalogue
      where (
        lower(catalogue.normalized_name || ' ' || coalesce(catalogue.brand_name, '')) % ${queryText}
      )
      ${marketFilter}
      ${kindFilter}
      ${languageFilter}
      order by relevance desc, ${marketRank} asc, catalogue.food_id asc
      limit ${limit}
    `.execute(transaction);
    const documents = await loadProjectionDocuments(transaction, result.rows);
    const scoreByVersion = new Map(
      result.rows.map((row) => [row.food_version_id, normalizedScore(row.relevance)]),
    );
    return documents.flatMap((document) => {
      const score = scoreByVersion.get(document.foodVersionId);
      return score === undefined ? [] : [{ document, score }];
    });
  });
}

function normalizeFoodKind(
  value: SearchPromotedFoodsPostgresInput["kind"],
): "branded" | "generic" | null {
  if (value === undefined || value === null) return null;
  if (value !== "branded" && value !== "generic") {
    throw new Error("kind must be branded or generic");
  }
  return value;
}

function normalizeInputLanguageTag(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical || canonical !== value || canonical.length > 35) {
      throw new Error("languageTag must be a canonical BCP 47 language tag");
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("languageTag")) throw error;
    throw new Error("languageTag must be a canonical BCP 47 language tag", { cause: error });
  }
}

async function readProjectionSnapshot<Result>(
  database: Kysely<Database>,
  operation: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(operation);
}

async function pageProjectionWithinSnapshot(
  transaction: Transaction<Database>,
  afterFoodId: string | null,
  limit: number,
): Promise<FoodSearchProjectionPage> {
  let query = transaction
    .selectFrom("promoted_food_search_catalogue_v1")
    .selectAll()
    .orderBy("food_id", "asc")
    .limit(limit + 1);
  if (afterFoodId) query = query.where("food_id", ">", afterFoodId);
  const rows = await query.execute();
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const documents = await loadProjectionDocuments(transaction, pageRows);
  return {
    documents,
    nextCursor: hasNextPage ? (pageRows.at(-1)?.food_id ?? null) : null,
  };
}

interface BarcodeRow {
  readonly food_id: string;
  readonly gtin: string;
  readonly market_code: string;
  readonly ordinal: string;
}

interface ServingRow {
  readonly food_id: string;
  readonly id: string;
  readonly source_serving_key: string | null;
  readonly label: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unit_kind: "count" | "mass" | "volume";
  readonly gram_weight: string | null;
  readonly milliliter_volume: string | null;
  readonly is_default: boolean;
  readonly display_order: number;
  readonly ordinal: string;
}

async function loadProjectionDocuments(
  database: SearchExecutor,
  rows: readonly CatalogueRow[],
): Promise<readonly FoodSearchProjectionDocument[]> {
  if (rows.length === 0) return [];
  const foodIds = rows.map((row) => row.food_id);
  const barcodeResult = await sql<BarcodeRow>`
    select ranked.food_id, ranked.gtin, ranked.market_code, ranked.ordinal
    from (
      select
        catalogue.food_id,
        barcode.gtin,
        barcode.market_code,
        row_number() over (
          partition by catalogue.food_id
          order by barcode.market_code collate "C", lpad(barcode.gtin, 14, '0'), barcode.id
        ) as ordinal
      from promoted_food_search_catalogue_v1 as catalogue
      join food_barcode as barcode
        on barcode.food_id = catalogue.food_id
        and barcode.food_version_id = catalogue.food_version_id
        and barcode.source_release_id = catalogue.source_release_id
        and barcode.valid_to is null
      where catalogue.food_id in (${sql.join(foodIds)})
    ) as ranked
    where ranked.ordinal <= ${MAX_DOCUMENT_BARCODES + 1}
    order by ranked.food_id, ranked.ordinal
  `.execute(database);
  const servingResult = await sql<ServingRow>`
    select
      ranked.food_id,
      ranked.id,
      ranked.source_serving_key,
      ranked.label,
      ranked.quantity,
      ranked.unit,
      ranked.unit_kind,
      ranked.gram_weight,
      ranked.milliliter_volume,
      ranked.is_default,
      ranked.display_order,
      ranked.ordinal
    from (
      select
        catalogue.food_id,
        serving.id,
        serving.source_serving_key,
        serving.label,
        serving.quantity,
        serving.unit,
        serving.unit_kind,
        serving.gram_weight,
        serving.milliliter_volume,
        serving.is_default,
        serving.display_order,
        row_number() over (
          partition by catalogue.food_id
          order by
            serving.is_default desc,
            serving.display_order,
            lower(serving.label) collate "C",
            serving.id
        ) as ordinal
      from promoted_food_search_catalogue_v1 as catalogue
      join food_serving as serving on serving.food_version_id = catalogue.food_version_id
      where catalogue.food_id in (${sql.join(foodIds)})
        and octet_length(serving.label) <= 200
        and octet_length(serving.unit) <= 50
    ) as ranked
    where ranked.ordinal <= ${MAX_DOCUMENT_SERVINGS + 1}
    order by ranked.food_id, ranked.ordinal
  `.execute(database);

  const barcodesByFood = groupRows(barcodeResult.rows);
  const servingsByFood = groupRows(servingResult.rows);
  return rows.map((row) => {
    const barcodeRows = barcodesByFood.get(row.food_id) ?? [];
    const servingRows = servingsByFood.get(row.food_id) ?? [];
    const barcodes = barcodeRows
      .slice(0, MAX_DOCUMENT_BARCODES)
      .flatMap((barcode): FoodSearchBarcodeProjection[] => {
        try {
          return [
            {
              gtin14: normalizeGtin14(barcode.gtin),
              marketCode: barcode.market_code,
              sourceGtin: barcode.gtin,
            },
          ];
        } catch {
          // Invalid legacy values must never enter a new search index.
          return [];
        }
      });
    const servings = servingRows.slice(0, MAX_DOCUMENT_SERVINGS).map(
      (serving): FoodSearchServingProjection => ({
        displayOrder: serving.display_order,
        gramWeight: serving.gram_weight,
        id: serving.id,
        isDefault: serving.is_default,
        label: serving.label,
        milliliterVolume: serving.milliliter_volume,
        quantity: serving.quantity,
        sourceServingKey: serving.source_serving_key,
        unit: serving.unit,
        unitKind: serving.unit_kind,
      }),
    );
    return {
      attributionRequired: row.attribution_required,
      attributionText: row.attribution_text,
      barcodes,
      barcodesTruncated: barcodeRows.length > MAX_DOCUMENT_BARCODES,
      basisQuantity: row.basis_quantity,
      basisUnit: row.basis_unit,
      brandName: row.brand_name,
      dataQuality: row.data_quality,
      description: row.description,
      foodId: row.food_id,
      foodSourceId: row.food_source_id,
      foodVersionId: row.food_version_id,
      kind: row.kind,
      languageTag: canonicalProjectionLanguageTag(row.language_tag),
      licenseExpression: row.license_expression,
      marketCode: row.market_code,
      name: row.name,
      normalizedName: row.normalized_name,
      servings,
      servingsTruncated: servingRows.length > MAX_DOCUMENT_SERVINGS,
      sourceArtifactSha256: row.source_artifact_sha256,
      sourceCode: row.source_code,
      sourceDisplayName: row.source_display_name,
      sourceFoodKey: row.source_food_key,
      sourceModifiedAt: row.source_modified_at?.toISOString() ?? null,
      sourceReleaseId: row.source_release_id,
      sourceReleaseKey: row.source_release_key,
      versionNumber: row.version_number,
    };
  });
}

function groupRows<Row extends { readonly food_id: string }>(
  rows: readonly Row[],
): ReadonlyMap<string, readonly Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const group = grouped.get(row.food_id) ?? [];
    group.push(row);
    grouped.set(row.food_id, group);
  }
  return grouped;
}

function normalizeFoodIdCursor(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > MAX_BIGINT_ID) {
    throw new Error("afterFoodId must be a positive PostgreSQL bigint decimal string");
  }
  return value;
}

function normalizeMarketCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const canonical = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,3}$/.test(canonical)) {
    throw new Error("marketCode must contain 2 or 3 ASCII letters or digits");
  }
  return canonical;
}

function normalizeSearchQuery(value: string): string {
  if (containsControlCharacter(value)) {
    throw new Error("query must contain between 1 and 128 non-control characters");
  }
  const canonical = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const characterCount = [...canonical].length;
  if (characterCount < 1 || characterCount > 128) {
    throw new Error("query must contain between 1 and 128 non-control characters");
  }
  return canonical;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function canonicalProjectionLanguageTag(value: string): string {
  try {
    const canonical = Intl.getCanonicalLocales(value.trim())[0];
    return canonical && canonical.length <= 35 ? canonical : "und";
  } catch {
    return "und";
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return candidate;
}

function normalizedScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
