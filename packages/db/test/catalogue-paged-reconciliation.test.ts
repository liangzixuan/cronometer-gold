import { createHash } from "node:crypto";
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
import { catalogueFramedSha256V2 as frame } from "../src/catalogue-paged-protocol.js";
import {
  type CataloguePagedReconciliationPage,
  type CataloguePagedReconciliationTerminal,
  parseCataloguePagedReconciliationPage,
  parseCataloguePagedReconciliationTerminal,
  type RetainedCatalogueValidationPageV2,
  readCataloguePagedReconciliationPage,
  reconcileCataloguePagedBatch,
  submitCataloguePagedApproval,
  verifyCataloguePagedBaselineHeader,
} from "../src/catalogue-paged-reconciliation.js";
import {
  canonicalJson,
  sha256CanonicalJson,
  validateCatalogueRecord,
} from "../src/catalogue-validation.js";
import type { Database, JsonObject, JsonValue } from "../src/types.js";

const BATCH = "12345678-1234-8234-8234-123456789abc";
const BASELINE = "22345678-1234-4234-8234-123456789abc";
const RELEASE = "32345678-1234-4234-8234-123456789abc";
const REVISION = "42345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const CONTEXT = "b".repeat(64);
const TERMINAL = "c".repeat(64);
const PRINCIPAL = "paged_validator_fixture";
const INPUT = {
  batchId: BATCH,
  validationTerminalSha256: TERMINAL,
  expectedCurrentReleaseId: null,
  principalId: PRINCIPAL,
};
const REPORT = "nutrition-tracker.catalogue-reconciliation";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture(responses: unknown[]) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (!responses.length) throw new Error("Unexpected database call");
          let value = responses.shift();
          if (typeof value === "function") value = await value();
          if (value instanceof Error) throw value;
          return { rows: (value === undefined ? [] : [{ result: value }]) as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No stream");
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
function validation(requestDocument = '{"retained":"exact original request"}') {
  const requestSha256 = sha(requestDocument);
  const validationCommitmentSha256 = frame("validation-page", [
    frame("validation-start", [BATCH, HASH]),
    HASH,
    "0",
    "0",
    "1",
    HASH,
    requestSha256,
  ]);
  const receiptSha256 = frame("validation-page-receipt", [
    BATCH,
    HASH,
    "0",
    "0",
    "1",
    requestSha256,
    validationCommitmentSha256,
    HASH,
  ]);
  const page = { pageNumber: "0", requestDocument, requestSha256, receiptSha256 };
  const stored = {
    page: {
      pageNumber: page.pageNumber,
      requestSha256,
      receiptSha256,
      contextSha256: HASH,
      startSequence: "0",
      endSequence: "1",
      observationSha256: HASH,
      validationCommitmentSha256,
      semanticCommitmentSha256: HASH,
    },
    requestDocumentMatches: true,
  };
  const input = {
    batchId: BATCH,
    databasePrincipal: PRINCIPAL,
    baselineReleaseId: null,
    validationTerminalSha256: TERMINAL,
    validationPageCount: "1",
    validationContextSha256: HASH,
    validationCommitmentSha256,
    contextSha256: CONTEXT,
    baselineEvidence: null,
    maximumReconciliationEvidenceBytes: "1073741824",
  };
  return { page, stored, input };
}
function reportPage(
  pageNumber: string,
  stream: CataloguePagedReconciliationPage["stream"],
  previous: string,
  records: JsonObject[] = [],
  complete = false,
): CataloguePagedReconciliationPage {
  const document = JSON.stringify({
    schemaVersion: 3,
    reportType: REPORT,
    batchId: BATCH,
    contextSha256: CONTEXT,
    pageNumber,
    stream,
    records,
  });
  const documentSha256 = sha(document);
  const startSequence = "0",
    endSequence = String(records.length);
  return {
    batchId: BATCH,
    contextSha256: CONTEXT,
    pageNumber,
    stream,
    startSequence,
    endSequence,
    document,
    documentSha256,
    previousCommitmentSha256: previous,
    commitmentSha256: frame("reconciliation-page", [
      CONTEXT,
      pageNumber,
      stream,
      startSequence,
      endSequence,
      documentSha256,
      previous,
      String(complete),
    ]),
    complete,
  };
}
function terminal(
  pages: CataloguePagedReconciliationPage[],
  counts = {
    baselineRecords: "0",
    candidateRecords: "1",
    added: "1",
    changed: "0",
    unchanged: "0",
    removed: "0",
    quarantined: "0",
  },
): CataloguePagedReconciliationTerminal {
  const pageCount = String(pages.length),
    last = pages.at(-1);
  if (!last) throw new Error("Missing fixture page");
  return {
    schemaVersion: 3,
    reportType: REPORT,
    batchId: BATCH,
    contextSha256: CONTEXT,
    validationTerminalSha256: TERMINAL,
    pageCount,
    pageCommitmentSha256: last.commitmentSha256,
    counts,
    promotionAvailable: false,
    reportSha256: frame("reconciliation-terminal", [
      BATCH,
      CONTEXT,
      TERMINAL,
      pageCount,
      last.commitmentSha256,
      ...Object.values(counts),
    ]),
  };
}
function setup(requestDocument?: string) {
  const v = validation(requestDocument);
  const first = reportPage("1", "metadata", frame("reconciliation-start", [BATCH, CONTEXT]));
  const second = reportPage("2", "candidate", first.commitmentSha256, [
    { change: "added", before: null, after: { sourceFoodKey: "1" } },
  ]);
  const third = reportPage("3", "removed", second.commitmentSha256, [], true);
  const pages = [first, second, third];
  const end = terminal(pages);
  return { ...v, pages, end, responses: [v.input, v.stored, v.input, ...pages, end] };
}
async function* retained(pages: RetainedCatalogueValidationPageV2[]) {
  yield* pages;
}

describe("paged reconciliation migration syntax", () => {
  it("keeps the barcode CASE inside the PL/pgSQL IF expression", () => {
    const migration = readFileSync(
      new URL("../migrations/0029_catalogue_paged_reconciliation.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "if barcode_count <> (case when food_document->>'gtin' is null then 0 else 1 end)",
    );
    expect(migration).not.toMatch(/\bif\s+barcode_count\s*<>\s*case\b/iu);
  });
});

describe("paged reconciliation consumer", () => {
  it("compares bound UTF-8 bytes once in SQL without returning the retained payload", async () => {
    const document = '{"retained":"é é 𐐀"}';
    const data = setup(document),
      f = fixture(data.responses);
    await reconcileCataloguePagedBatch(f.database, INPUT, {
      validationPages: retained([data.page]),
      consumePage: async () => {},
    });
    const statement = f.queries[1];
    expect(statement?.parameters).toEqual([BATCH, TERMINAL, 0, document]);
    expect(statement?.sql.match(/catalogue_reconciliation_validation_page_v2/gu)).toHaveLength(1);
    expect(statement?.sql.replace(/\s+/gu, " ").trim()).toBe(
      "with retained_page as materialized ( select public.catalogue_reconciliation_validation_page_v2( $1::uuid, $2::text, $3::bigint ) as evidence ) select pg_catalog.jsonb_build_object( 'page', evidence - 'requestDocument', 'requestDocumentMatches', coalesce( pg_catalog.jsonb_typeof(evidence->'requestDocument') = 'string' and pg_catalog.convert_to(evidence->>'requestDocument', 'UTF8') = pg_catalog.convert_to($4::text, 'UTF8'), false ) ) as result from retained_page",
    );
    expect(statement?.sql).not.toMatch(/collate|normalize|sha256|digest/iu);
    expect(data.stored.page).not.toHaveProperty("requestDocument");
  });
  it.each([false, null, undefined, 0, 1, "true", {}, []])(
    "requires an actual true exact-byte result before creation: %j",
    async (requestDocumentMatches) => {
      const data = setup();
      const f = fixture([data.input, { ...data.stored, requestDocumentMatches }]);
      await expect(
        reconcileCataloguePagedBatch(f.database, INPUT, {
          validationPages: retained([data.page]),
          consumePage: async () => {},
        }),
      ).rejects.toThrow("differs from immutable SQL evidence");
      expect(f.queries).toHaveLength(2);
      expect(f.queries.some((query) => query.sql.includes("catalogue_begin_reconciliation"))).toBe(
        false,
      );
    },
  );
  it.each([
    "outer-extra",
    "outer-missing",
    "inner-extra",
    "inner-collision",
    "inner-document",
    "outer-hidden",
    "inner-hidden",
    "outer-symbol",
    "inner-symbol",
  ])("rejects unexpected projection fields without hiding original evidence: %s", async (kind) => {
    const data = setup();
    const projected = { ...data.stored, page: { ...data.stored.page } };
    if (kind === "outer-extra") Object.assign(projected, { extra: true });
    if (kind === "outer-missing") Reflect.deleteProperty(projected, "requestDocumentMatches");
    if (kind === "inner-extra") Object.assign(projected.page, { extra: true });
    if (kind === "inner-collision") Object.assign(projected.page, { requestDocumentMatches: true });
    if (kind === "inner-document")
      Object.assign(projected.page, { requestDocument: data.page.requestDocument });
    if (kind === "outer-hidden") Object.defineProperty(projected, "extra", { value: true });
    if (kind === "inner-hidden") Object.defineProperty(projected.page, "extra", { value: true });
    if (kind === "outer-symbol") Object.assign(projected, { [Symbol("extra")]: true });
    if (kind === "inner-symbol") Object.assign(projected.page, { [Symbol("extra")]: true });
    const f = fixture([data.input, projected]);
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        validationPages: retained([data.page]),
        consumePage: async () => {},
      }),
    ).rejects.toThrow("missing or unexpected fields");
    expect(f.queries).toHaveLength(2);
  });
  it.each([
    ["pageNumber", 0],
    ["requestSha256", null],
    ["receiptSha256", 123],
    ["contextSha256", {}],
    ["startSequence", 0],
    ["endSequence", null],
    ["observationSha256", []],
    ["validationCommitmentSha256", null],
    ["semanticCommitmentSha256", 1],
  ])("preserves original metadata type checks for %s", async (field, value) => {
    const data = setup(),
      f = fixture([
        data.input,
        {
          ...data.stored,
          page: { ...data.stored.page, [String(field)]: value },
        },
      ]);
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        validationPages: retained([data.page]),
        consumePage: async () => {},
      }),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(2);
  });
  it("supplies the actual SQL admission budget before any journal or mutation work", async () => {
    const data = setup(),
      f = fixture(data.responses);
    const seen: string[] = [];
    await reconcileCataloguePagedBatch(f.database, INPUT, {
      validationPages: retained([data.page]),
      consumePage: async () => {},
      admitEvidenceBudget: (bytes) => {
        seen.push(bytes);
        expect(f.queries).toHaveLength(1);
      },
    });
    expect(seen).toEqual(["1073741824"]);
  });
  it("stops before writes when the actual approved evidence budget cannot be admitted", async () => {
    const data = setup(),
      f = fixture(data.responses);
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        validationPages: retained([data.page]),
        consumePage: async () => {},
        admitEvidenceBudget: () => {
          throw new Error("disk budget unavailable");
        },
      }),
    ).rejects.toThrow("disk budget unavailable");
    expect(f.queries).toHaveLength(1);
  });
  it("verifies the complete exact retained journal before the first mutation and streams every report page", async () => {
    const data = setup(),
      f = fixture(data.responses),
      seen: string[] = [];
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        validationPages: retained([data.page]),
        consumePage: async (page) => {
          seen.push(page.pageNumber);
        },
      }),
    ).resolves.toEqual(data.end);
    expect(seen).toEqual(["1", "2", "3"]);
    expect(f.queries[0]?.sql).toContain("catalogue_reconciliation_input_v2");
    expect(f.queries[1]?.sql).toContain("catalogue_reconciliation_validation_page_v2");
    expect(f.queries[2]?.sql).toContain("catalogue_begin_reconciliation_v2");
    expect(f.queries.at(-1)?.sql).toContain("catalogue_finish_reconciliation_v2");
    expect(f.queries.map((q) => q.sql).join("\n")).not.toMatch(
      /from food_import|set role|catalogue_attest|catalogue_promote/iu,
    );
  });
  it("rejects a journal exhaustion failure after every retained page matched without starting mutation", async () => {
    const data = setup(),
      f = fixture(data.responses),
      seen: string[] = [];
    const failure = new Error("Terminal journal prefix byte accounting differs");
    let exhausted = false;
    async function* lateFailure() {
      yield data.page;
      // The final reader check runs only when the consumer asks for exhaustion.
      expect(f.queries).toHaveLength(2);
      expect(f.queries[1]?.sql).toContain("catalogue_reconciliation_validation_page_v2");
      exhausted = true;
      throw failure;
    }
    try {
      await expect(
        reconcileCataloguePagedBatch(f.database, INPUT, {
          validationPages: lateFailure(),
          consumePage: async (page) => {
            seen.push(page.pageNumber);
          },
        }),
      ).rejects.toBe(failure);
      expect(exhausted).toBe(true);
      expect(seen).toEqual([]);
      expect(f.queries).toHaveLength(2);
      expect(f.queries.map((query) => query.sql).join("\n")).not.toMatch(
        /catalogue_(?:begin|finish)_reconciliation|catalogue_reconciliation_page_v2/iu,
      );
    } finally {
      await f.database.destroy();
    }
  });
  it.each(["missing", "duplicate", "reordered", "changed-request", "changed-receipt"])(
    "rejects %s retained evidence before writes",
    async (kind) => {
      const data = setup();
      let pages = [data.page];
      if (kind === "missing") pages = [];
      if (kind === "duplicate") pages = [data.page, data.page];
      if (kind === "reordered") pages = [{ ...data.page, pageNumber: "1" }];
      if (kind === "changed-request")
        pages = [{ ...data.page, requestDocument: "{}", requestSha256: sha("{}") }];
      if (kind === "changed-receipt") pages = [{ ...data.page, receiptSha256: HASH }];
      const f = fixture([data.input, data.stored]);
      await expect(
        reconcileCataloguePagedBatch(f.database, INPUT, {
          validationPages: retained(pages),
          consumePage: async () => {
            throw new Error("must not consume");
          },
        }),
      ).rejects.toThrow();
      expect(f.queries.every((q) => !q.sql.includes("catalogue_begin_reconciliation"))).toBe(true);
    },
  );
  it("rejects stale context between complete journal verification and begin", async () => {
    const data = setup(),
      f = fixture([data.input, data.stored, { ...data.input, contextSha256: HASH }]);
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        validationPages: retained([data.page]),
        consumePage: async () => {},
      }),
    ).rejects.toThrow("context changed");
    expect(f.queries).toHaveLength(3);
  });
  it("awaits sink backpressure before requesting another SQL page", async () => {
    const data = setup(),
      f = fixture(data.responses);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = reconcileCataloguePagedBatch(f.database, INPUT, {
      validationPages: retained([data.page]),
      consumePage: async (page) => {
        if (page.pageNumber === "1") {
          started();
          await hold;
        }
      },
    });
    await began;
    expect(f.queries).toHaveLength(4);
    release();
    await run;
  });
  it("propagates sink failure and never finalizes private partial report state", async () => {
    const data = setup(),
      f = fixture(data.responses);
    const failure = new Error("private output full");
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        validationPages: retained([data.page]),
        consumePage: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(f.queries).toHaveLength(4);
  });
  it("honors abort after an awaited sink and does not request the next page", async () => {
    const data = setup(),
      f = fixture(data.responses),
      controller = new AbortController();
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        validationPages: retained([data.page]),
        signal: controller.signal,
        consumePage: async () => {
          controller.abort(new Error("stopped"));
        },
      }),
    ).rejects.toThrow("stopped");
    expect(f.queries).toHaveLength(4);
  });
  it("replays all retained report pages and returns the same immutable terminal after lost acknowledgement", async () => {
    const data = setup(),
      f = fixture([
        ...data.responses.slice(0, -1),
        new Error("lost terminal response"),
        ...data.responses,
      ]);
    const options = { validationPages: retained([data.page]), consumePage: async () => {} };
    await expect(reconcileCataloguePagedBatch(f.database, INPUT, options)).rejects.toThrow(
      "lost terminal response",
    );
    await expect(
      reconcileCataloguePagedBatch(f.database, INPUT, {
        ...options,
        validationPages: retained([data.page]),
      }),
    ).resolves.toEqual(data.end);
  });
  it.each([
    { principalId: "other_validator" },
    { expectedCurrentReleaseId: RELEASE },
    { validationTerminalSha256: HASH },
  ])("rejects unexpected SQL identity pins %o", async (patch) => {
    const data = setup(),
      f = fixture([data.input]);
    await expect(
      reconcileCataloguePagedBatch(
        f.database,
        { ...INPUT, ...patch },
        { validationPages: retained([data.page]), consumePage: async () => {} },
      ),
    ).rejects.toThrow("identity");
    expect(f.queries).toHaveLength(1);
  });
});

describe("strict paged report evidence", () => {
  it("accepts version3 and keeps exact PG text hashing distinct from canonical serialization", () => {
    const data = setup();
    expect(parseCataloguePagedReconciliationPage(data.pages[0])).toEqual(data.pages[0]);
    expect(parseCataloguePagedReconciliationTerminal(data.end)).toEqual(data.end);
  });
  it.each([
    { document: "{}" },
    { documentSha256: HASH },
    { commitmentSha256: HASH },
    { pageNumber: "0" },
    { stream: "unknown" },
    { complete: "true" },
    { unexpected: true },
    { startSequence: "-1" },
    { pageNumber: 1 },
  ])("rejects malformed page %o", (patch) => {
    expect(() =>
      parseCataloguePagedReconciliationPage({ ...setup().pages[0], ...patch }),
    ).toThrow();
  });
  it("rejects oversized retained documents before parsing", () => {
    const document = " ".repeat(16 * 1024 * 1024 + 1);
    expect(() =>
      parseCataloguePagedReconciliationPage({
        ...setup().pages[0],
        document,
        documentSha256: sha(document),
      }),
    ).toThrow();
  });
  it.each([
    { schemaVersion: 2 },
    { reportSha256: HASH },
    { promotionAvailable: true },
    { pageCount: "0" },
    {
      counts: {
        baselineRecords: "0",
        candidateRecords: "2",
        added: "1",
        changed: "0",
        unchanged: "0",
        removed: "0",
        quarantined: "0",
      },
    },
  ])("rejects malformed terminal %o", (patch) => {
    expect(() => parseCataloguePagedReconciliationTerminal({ ...setup().end, ...patch })).toThrow();
  });
});

const APPROVAL = {
  batchId: BATCH,
  approvalRole: "data" as const,
  principalId: "paged_data_reviewer",
  rightsManifestSha256: HASH,
  validationTerminalSha256: TERMINAL,
  reportSha256: HASH,
  contextSha256: CONTEXT,
  approvalReference: "urn:test:review:paged",
};
describe("restricted paged reviewer consumers", () => {
  it.each([false, true])(
    "keeps exact SQL approval replay %s separate from new decisions",
    async (wasAlreadyApproved) => {
      const result = {
        approvalRole: "data",
        databasePrincipal: APPROVAL.principalId,
        reportSha256: HASH,
        wasAlreadyApproved,
        promotionAvailable: false,
      };
      const f = fixture([result]);
      await expect(submitCataloguePagedApproval(f.database, APPROVAL)).resolves.toEqual(result);
      expect(f.queries[0]?.sql).toContain("catalogue_record_paged_approval_v2");
      expect(f.queries[0]?.parameters).toEqual([
        BATCH,
        "data",
        APPROVAL.principalId,
        HASH,
        TERMINAL,
        HASH,
        CONTEXT,
        APPROVAL.approvalReference,
      ]);
    },
  );
  it("exposes only the requested bounded SQL-authenticated report page", async () => {
    const data = setup(),
      f = fixture([data.pages[0]]);
    await expect(
      readCataloguePagedReconciliationPage(f.database, {
        batchId: BATCH,
        reportSha256: HASH,
        pageNumber: "1",
        approvalRole: "data",
        principalId: APPROVAL.principalId,
      }),
    ).resolves.toEqual(data.pages[0]);
    expect(f.queries[0]?.sql).toContain("catalogue_read_reconciliation_page_v2");
  });
  it.each([
    { approvalRole: "owner" },
    { principalId: "Owner" },
    { rightsManifestSha256: "bad" },
    { approvalReference: "line\nbreak" },
    { approvalReference: " " },
    { contextSha256: "A".repeat(64) },
    { unexpected: true },
  ])("rejects malformed approval before SQL %o", async (patch) => {
    const f = fixture([]);
    await expect(
      submitCataloguePagedApproval(f.database, { ...APPROVAL, ...patch } as typeof APPROVAL),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(0);
  });
  it("propagates actual SQL wrong-role rejection without fallback", async () => {
    const f = fixture([new Error("singleton reviewer capability required")]);
    await expect(submitCataloguePagedApproval(f.database, APPROVAL)).rejects.toThrow(
      "singleton reviewer",
    );
    expect(f.queries).toHaveLength(1);
  });
  it("rejects a receipt that reports activation availability", async () => {
    const f = fixture([
      {
        approvalRole: "data",
        databasePrincipal: APPROVAL.principalId,
        reportSha256: HASH,
        wasAlreadyApproved: false,
        promotionAvailable: true,
      },
    ]);
    await expect(submitCataloguePagedApproval(f.database, APPROVAL)).rejects.toThrow("receipt");
  });
});

function baselineHeader(mappingCount = 1): JsonObject {
  const mapping = {
    canonicalUnit: "g",
    conversionMultiplier: "1",
    nutrientCode: "protein",
    nutrientDimension: "mass",
    nutrientId: "1",
    nutrientName: "Protein",
    revisionId: REVISION,
    sourceNutrientKey: "1003",
    sourceUnit: "g",
  };
  const mappings = Array.from({ length: mappingCount }, (_, index) =>
    index === 0
      ? mapping
      : {
          ...mapping,
          sourceNutrientKey: String(1003 + index),
          revisionId: `${String(index).padStart(8, "0")}-1234-4234-8234-123456789abc`,
        },
  );
  const mappingDigest = sha256CanonicalJson(
    [...mappings].sort((left, right) =>
      left.sourceNutrientKey < right.sourceNutrientKey
        ? -1
        : left.sourceNutrientKey > right.sourceNutrientKey
          ? 1
          : 0,
    ),
  );
  const report = {
    schemaVersion: 1,
    sourceCode: "USDA_FDC",
    releaseKey: "test",
    artifactSha256: HASH,
    nutrientMappingDigest: mappingDigest,
    parserBuildSha256: HASH,
    parserVersion: "0.1.0",
  };
  const parser = {
    batch_id: BASELINE,
    report,
    report_sha256: sha256CanonicalJson(report),
    source_record_count: 1,
    emitted_record_count: 1,
    excluded_record_count: 0,
    source_nutrient_count: 1,
    emitted_nutrient_count: 1,
    excluded_nutrient_count: 0,
    source_portion_count: 0,
    emitted_portion_count: 0,
    excluded_portion_count: 0,
  };
  const batch = {
    id: BASELINE,
    release_id: RELEASE,
    validated_food_contract_version: 1,
    nutrition_semantic_contract_version: 1,
    status: "completed",
    validated_at: "2026-09-21T00:00:00Z",
    completed_at: "2026-09-21T00:00:00Z",
    unresolved_error_count: 0,
    materialized_count: 1,
    valid_count: 1,
    staged_count: 1,
    quarantined_count: 0,
    nutrient_input_count: 1,
    nutrient_materializable_count: 1,
    nutrient_excluded_count: 0,
    warning_count: 0,
    validation_digest: HASH,
    nutrient_mapping_digest: mappingDigest,
    nutrient_mapping_revision_ids: mappings.map((row) => row.revisionId).sort(),
    food_source_id: 1,
    release_key: "test",
    artifact_sha256: HASH,
    parser_version: `0.1.0+build.${HASH}+mapping.${mappingDigest}`,
    rights_manifest_sha256: HASH,
    validation_policy: { requireDistinctApprovalPrincipals: true },
  };
  const release = {
    ...batch,
    id: RELEASE,
    status: "promoted",
    promoted_at: "2026-09-21T00:00:00Z",
    validation_summary: {
      recordErrors: 0,
      excludedNutrientFraction: 0,
      nutrientMappingDigest: mappingDigest,
      nutrientMappingRevisionIds: mappings.map((row) => row.revisionId).sort(),
      parserExcludedNutrients: 0,
      parserExcludedPortions: 0,
      parserReportSha256: parser.report_sha256,
      unresolvedErrors: 0,
      validatedFoodContractVersion: 1,
      validationDigest: HASH,
      warnings: 0,
    },
    record_counts: {
      materializable: 1,
      nutrientInput: 1,
      nutrientMaterializable: 1,
      nutrientExcluded: 0,
      parserExcludedRecords: 0,
      quarantined: 0,
      sourcePortions: 0,
      sourceRecords: 1,
      staged: 1,
    },
  };
  return {
    sourceCode: "USDA_FDC",
    batch,
    release,
    parser,
    mappings,
    approvals: ["data", "quality", "rights"].map((approval_role) => ({
      approval_role,
      batch_id: BASELINE,
      validation_digest: HASH,
      rights_manifest_sha256: HASH,
      principal_id: `baseline_${approval_role}`,
    })),
  };
}
describe("bounded legacy baseline eligibility", () => {
  it("accepts a complete matching V1 contract1 provenance/header", () => {
    expect(verifyCataloguePagedBaselineHeader(baselineHeader())).toMatchObject({
      count: 0,
      valid: 0,
    });
  });
  it("accepts no baseline", () => {
    expect(verifyCataloguePagedBaselineHeader(null)).toBeNull();
  });
  it.each([
    "precontract",
    "release-digest",
    "mapping-digest",
    "parser-digest",
    "approval",
    "counts",
  ])("rejects %s before preparation", async (kind) => {
    const header = baselineHeader();
    const batch = header.batch as JsonObject,
      release = header.release as JsonObject;
    if (kind === "precontract")
      (batch as Record<string, JsonValue>).validated_food_contract_version = null;
    if (kind === "release-digest")
      (release.validation_summary as JsonObject as Record<string, JsonValue>).validationDigest =
        CONTEXT;
    if (kind === "mapping-digest")
      (batch as Record<string, JsonValue>).nutrient_mapping_digest = CONTEXT;
    if (kind === "parser-digest")
      (header.parser as JsonObject as Record<string, JsonValue>).report_sha256 = CONTEXT;
    if (kind === "approval") (header as Record<string, JsonValue>).approvals = [];
    if (kind === "counts")
      (release.record_counts as JsonObject as Record<string, JsonValue>).staged = 2;
    expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow();
    const data = setup(),
      f = fixture([{ ...data.input, baselineReleaseId: RELEASE, baselineEvidence: header }]);
    await expect(
      reconcileCataloguePagedBatch(
        f.database,
        { ...INPUT, expectedCurrentReleaseId: RELEASE },
        { validationPages: retained([data.page]), consumePage: async () => {} },
      ),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(1);
  });
  it.each(["valid", "payload", "issues", "food", "missing-record"])(
    "streams and independently rechecks legacy baseline %s",
    async (kind) => {
      const header = baselineHeader();
      const key = "FDC:test:Foundation:123";
      const payload: JsonObject = {
        basis: { amount: "100", unit: "g" },
        idempotencyKey: key,
        identity: { brandOwner: null, description: "Oats", descriptionFr: null, gtin: null },
        nutrients: [
          {
            canonicalNutrientId: "protein",
            canonicalUnit: "g",
            originalUnit: "g",
            provenance: { dataPoints: 12, derivationCode: null },
            sourceName: "Protein",
            sourceNutrientId: "1003",
            value: { amount: "12.5", quality: "measured", state: "known" },
          },
        ],
        schemaVersion: 1,
        servings: [],
        source: {
          languageTag: "en",
          marketCode: "US",
          releaseKey: "test",
          sourceCode: "USDA_FDC",
          sourceDataType: "Foundation",
          sourceModifiedAt: null,
          sourceRecordId: "123",
        },
        sourcePayloadHash: HASH,
        unlistedNutrientPolicy: "unknown_not_reported",
      };
      const canonicalPayloadSha256 = sha256CanonicalJson(payload);
      const result = validateCatalogueRecord(
        payload,
        {
          canonicalPayloadSha256,
          expectedReleaseKey: "test",
          expectedSourceCode: "USDA_FDC",
          sourcePayloadSha256: HASH,
          sourceRecordKey: key,
          sourceRecordType: "Foundation",
        },
        new Map([
          [
            "1003",
            {
              canonicalUnit: "g",
              conversionMultiplier: "1",
              mappingRevisionId: REVISION,
              nutrientCode: "protein",
              nutrientId: "1",
              sourceNutrientId: "1003",
              sourceUnit: "g",
            },
          ],
        ]),
      );
      expect(result.recordIsValid).toBe(true);
      expect(result.issues).toEqual([]);
      const foodDocument = canonicalJson(result.food as unknown as JsonValue);
      const envelope: Record<string, JsonValue> = {
        sequenceNumber: "0",
        sourceRecordKey: key,
        sourceRecordType: "Foundation",
        sourcePayloadSha256: HASH,
        canonicalPayloadSha256,
        canonicalPayload: payload,
        validationStatus: "materialized",
        validationIssues: [],
        validatedFoodDocument: foodDocument,
        validatedFoodSha256: sha(foodDocument),
      };
      if (kind === "payload") envelope.canonicalPayloadSha256 = CONTEXT;
      if (kind === "issues") envelope.validationIssues = [{ code: "forged" }];
      if (kind === "food") {
        envelope.validatedFoodDocument = foodDocument.replace("Oats", "Forged");
        envelope.validatedFoodSha256 = sha(String(envelope.validatedFoodDocument));
      }
      const data = validation();
      const input = { ...data.input, baselineReleaseId: RELEASE, baselineEvidence: header };
      const first = reportPage("1", "metadata", frame("reconciliation-start", [BATCH, CONTEXT]));
      const baseline = reportPage(
        "2",
        "baseline",
        first.commitmentSha256,
        kind === "missing-record" ? [] : [{ before: envelope, after: null, change: "baseline" }],
      );
      const candidate = reportPage("3", "candidate", baseline.commitmentSha256, [
        { before: null, after: {}, change: "added" },
      ]);
      const removed = reportPage("4", "removed", candidate.commitmentSha256, [], true);
      const end = terminal([first, baseline, candidate, removed], {
        baselineRecords: "1",
        candidateRecords: "1",
        added: "1",
        changed: "0",
        unchanged: "0",
        removed: "0",
        quarantined: "0",
      });
      const f = fixture([input, data.stored, input, first, baseline, candidate, removed, end]);
      const run = reconcileCataloguePagedBatch(
        f.database,
        { ...INPUT, expectedCurrentReleaseId: RELEASE },
        { validationPages: retained([data.page]), consumePage: async () => {} },
      );
      if (kind === "valid") await expect(run).resolves.toEqual(end);
      else {
        await expect(run).rejects.toThrow();
        expect(f.queries.some((q) => q.sql.includes("catalogue_finish_reconciliation"))).toBe(
          false,
        );
      }
    },
  );
});

function publishedBaselineRecord(sequence: number, quarantined = false) {
  const key = `FDC:test:Foundation:${123 + sequence}`;
  const payload: JsonObject = {
    basis: { amount: "100", unit: "g" },
    idempotencyKey: key,
    identity: {
      brandOwner: null,
      description: quarantined ? "" : "Oats",
      descriptionFr: null,
      gtin: null,
    },
    nutrients: [
      {
        canonicalNutrientId: "protein",
        canonicalUnit: "g",
        originalUnit: "g",
        provenance: { dataPoints: 12, derivationCode: null },
        sourceName: "Protein",
        sourceNutrientId: "1003",
        value: { amount: "12.5", quality: "measured", state: "known" },
      },
    ],
    schemaVersion: 1,
    servings: [],
    source: {
      languageTag: "en",
      marketCode: "US",
      releaseKey: "test",
      sourceCode: "USDA_FDC",
      sourceDataType: "Foundation",
      sourceModifiedAt: null,
      sourceRecordId: String(123 + sequence),
    },
    sourcePayloadHash: HASH,
    unlistedNutrientPolicy: "unknown_not_reported",
  };
  const canonicalPayloadSha256 = sha256CanonicalJson(payload);
  const result = validateCatalogueRecord(
    payload,
    {
      canonicalPayloadSha256,
      expectedReleaseKey: "test",
      expectedSourceCode: "USDA_FDC",
      sourcePayloadSha256: HASH,
      sourceRecordKey: key,
      sourceRecordType: "Foundation",
    },
    new Map([
      [
        "1003",
        {
          canonicalUnit: "g",
          conversionMultiplier: "1",
          mappingRevisionId: REVISION,
          nutrientCode: "protein",
          nutrientId: "1",
          sourceNutrientId: "1003",
          sourceUnit: "g",
        },
      ],
    ]),
  );
  expect(result.recordIsValid).toBe(!quarantined);
  const foodDocument = result.food ? canonicalJson(result.food as unknown as JsonValue) : null;
  const envelope: Record<string, JsonValue> = {
    sequenceNumber: String(sequence),
    sourceRecordKey: key,
    sourceRecordType: "Foundation",
    sourcePayloadSha256: HASH,
    canonicalPayloadSha256,
    canonicalPayload: payload,
    validationStatus: quarantined ? "quarantined" : "valid",
    validationIssues: result.issues as unknown as JsonValue,
    validatedFoodDocument: foodDocument,
    validatedFoodSha256: foodDocument === null ? null : sha(foodDocument),
  };
  return { envelope, result };
}

function publishedBaselineHeader(mappingCount = 1) {
  const records = [publishedBaselineRecord(0), publishedBaselineRecord(1, true)];
  const header = baselineHeader(mappingCount) as Record<string, JsonValue>;
  const batch = header.batch as Record<string, JsonValue>;
  const parser = header.parser as Record<string, JsonValue>;
  const release = header.release as Record<string, JsonValue>;
  for (const field of [
    "release_id",
    "validated_at",
    "completed_at",
    "validation_digest",
    "validated_food_contract_version",
    "nutrition_semantic_contract_version",
    "nutrition_semantic_sha256",
    "nutrient_mapping_digest",
    "nutrient_mapping_revision_ids",
    "validated_database_principal",
    "validated_database_capability_role",
    "staging_seal_sha256",
    "staging_sealed_at",
  ])
    batch[field] = null;
  for (const field of [
    "valid_count",
    "quarantined_count",
    "unresolved_error_count",
    "warning_count",
    "nutrient_input_count",
    "nutrient_materializable_count",
    "nutrient_excluded_count",
    "materialized_count",
  ])
    batch[field] = 0;
  for (const [field, value] of Object.entries({
    published_on: "2026-09-21",
    acquired_at: "2026-09-21T00:00:00Z",
    artifact_uri: "urn:test:artifact",
    artifact_bytes: 100,
    media_type: "application/json",
    upstream_schema_version: null,
    rights_manifest_uri: "urn:test:rights",
    release_class: "live-reviewed",
    evidence_bundle_sha256: null,
    evidence_bundle_uri: null,
    evidence_decision_sha256: null,
    evidence_object_version_id: null,
    evidence_valid_until: null,
  })) {
    batch[field] = value;
    release[field] = value;
  }
  batch.status = "staging";
  batch.staged_count = 2;
  batch.staged_database_principal = "baseline_stager";
  batch.validation_policy = {};
  Object.assign(parser, {
    source_record_count: 4,
    emitted_record_count: 2,
    excluded_record_count: 2,
    source_nutrient_count: 5,
    emitted_nutrient_count: 2,
    excluded_nutrient_count: 3,
    source_portion_count: 1,
    emitted_portion_count: 0,
    excluded_portion_count: 1,
  });
  const preparation = {
    batch_id: BASELINE,
    protocol_version: 2,
    phase: "sealed",
    staged_count: 2,
    stage_page_count: 1,
    seal_verified_page_count: 1,
    seal_verified_record_count: 2,
    staging_seal_sha256: HASH,
    admission_sha256: HASH,
    sealed_at: "2026-09-21T00:00:00Z",
  };
  Object.assign(parser.report as Record<string, JsonValue>, {
    schemaVersion: 2,
    reportKind: "usda-fdc-full-csv-capability-stage-v2",
    preparationAdmissionSha256: preparation.admission_sha256,
  });
  parser.report_sha256 = sha256CanonicalJson(parser.report as JsonObject);
  const policyDocument = "{}";
  const contextSha256 = frame("validation-context", [
    BASELINE,
    HASH,
    HASH,
    "7",
    "",
    "baseline_validator",
    policyDocument,
    String((parser.report as JsonObject).nutrientMappingDigest),
  ]);
  const context: Record<string, JsonValue> = {
    batch_id: BASELINE,
    phase: "validated",
    validator_principal: "baseline_validator",
    staging_seal_sha256: HASH,
    context_sha256: contextSha256,
    generation: 7,
    baseline_release_id: null,
    policy_document: policyDocument,
    policy: {},
    next_sequence: 2,
    page_count: 1,
    last_page_receipt_sha256: HASH,
    validation_commitment_sha256: HASH,
    semantic_commitment_sha256: HASH,
    valid_count: 1,
    quarantined_count: 1,
    warning_count: records.reduce(
      (n, r) => n + r.result.issues.filter((i) => i.severity === "warning").length,
      0,
    ),
    record_error_count: records.reduce(
      (n, r) => n + r.result.issues.filter((i) => i.severity === "error").length,
      0,
    ),
    nutrient_input_count: 2,
    nutrient_materializable_count: 1,
    excluded_nutrient_count: 0,
    portion_input_count: 0,
    valid_without_nutrients_count: 0,
  };
  const terminalDocument = canonicalJson({
    schemaVersion: 2,
    kind: "catalogue-validation-terminal-request-v2",
    batchId: BASELINE,
    contextSha256,
    pageCount: "1",
    recordCount: "2",
    lastPageReceiptSha256: HASH,
    validationCommitmentSha256: HASH,
    semanticCommitmentSha256: HASH,
  });
  const terminalRequestSha256 = sha(terminalDocument);
  const summaryDocument = JSON.stringify({
    schemaVersion: 2,
    kind: "catalogue-validation-summary-v2",
    batchId: BASELINE,
    contextSha256,
    sqlSemanticScope: "nutrition-basis-counts-source-identity-barcode-v2",
    pageCount: "1",
    stagedCount: "2",
    validCount: "1",
    quarantinedCount: "3",
    warningCount: String(context.warning_count),
    recordErrorCount: String(context.record_error_count),
    nutrientInputCount: "5",
    nutrientMaterializableCount: "1",
    excludedNutrientCount: "3",
    portionInputCount: "1",
    unresolvedErrorCount: "0",
    policyEligible: true,
    promotionEligible: false,
    validationCommitmentSha256: HASH,
    semanticCommitmentSha256: HASH,
    lastPageReceiptSha256: HASH,
    terminalRequestSha256,
  });
  const terminalSha256 = frame("validation-terminal", [terminalDocument, summaryDocument]);
  context.terminal_document = terminalDocument;
  context.terminal_sha256 = terminalSha256;
  context.terminal_receipt = {
    schemaVersion: 2,
    kind: "catalogue-validation-terminal-receipt-v2",
    batchId: BASELINE,
    contextSha256,
    terminalRequestSha256,
    summaryDocument,
    terminalSha256,
  };
  const publicationSha256 = frame("publication-context", [
    BASELINE,
    HASH,
    CONTEXT,
    terminalSha256,
    HASH,
    "baseline_publisher",
    "",
    "7",
    String((parser.report as JsonObject).nutrientMappingDigest),
  ]);
  const sealSha256 = frame("publication-seal", [
    publicationSha256,
    HASH,
    "2",
    "1",
    "256",
    "1",
    "1",
  ]);
  const publication: Record<string, JsonValue> = {
    batch_id: BASELINE,
    release_id: RELEASE,
    publisher_principal: "baseline_publisher",
    publication_sha256: publicationSha256,
    admission_sha256: HASH,
    context_sha256: CONTEXT,
    validation_terminal_sha256: terminalSha256,
    report_sha256: HASH,
    baseline_release_id: null,
    mapping_document: header.mappings as JsonValue,
    mapping_sha256: (parser.report as JsonObject).nutrientMappingDigest as string,
    initial_generation: 7,
    last_generation: 12,
    phase: "activated",
    next_sequence: 2,
    page_count: 1,
    materialized_count: 1,
    verified_sequence: 2,
    verified_page_count: 1,
    verified_materialized_count: 1,
    record_commitment_sha256: HASH,
    verification_commitment_sha256: HASH,
    materialization_bytes: 256,
    seal_sha256: sealSha256,
    activated_at: "2026-09-21T00:00:00Z",
  };
  publication.finish_request_document = JSON.stringify({
    schemaVersion: 2,
    batchId: BASELINE,
    publicationSha256,
    previousReceiptSha256: HASH,
  });
  publication.activation_request_document = JSON.stringify({
    schemaVersion: 2,
    batchId: BASELINE,
    publicationSha256,
    sealSha256,
    expectedCurrentReleaseId: null,
    reason: "Publish reviewed baseline",
  });
  const receiptCore = {
    schemaVersion: 2,
    batchId: BASELINE,
    sourceCode: "USDA_FDC",
    publicationSha256,
    admissionSha256: HASH,
    releaseId: RELEASE,
    contextSha256: CONTEXT,
    validationTerminalSha256: terminalSha256,
    reportSha256: HASH,
    baselineReleaseId: null,
    nextSequence: "2",
    pageCount: "1",
    materializedCount: "1",
    verifiedSequence: "2",
    verifiedPageCount: "1",
    sealSha256,
  };
  function receipt(core: JsonObject) {
    const receiptDocument = JSON.stringify(core, null, 1);
    return { ...core, receiptDocument, receiptSha256: sha(receiptDocument) };
  }
  publication.finish_receipt = receipt({
    ...receiptCore,
    operation: "finish",
    phase: "sealed",
    generation: "10",
    requestSha256: sha(String(publication.finish_request_document)),
  });
  publication.activation_receipt = receipt({
    ...receiptCore,
    operation: "activate",
    phase: "activated",
    generation: "12",
    requestSha256: sha(String(publication.activation_request_document)),
    activationId: "1",
    previousReleaseId: null,
    activeReleaseId: RELEASE,
  });
  publication.last_receipt_sha256 = (publication.activation_receipt as JsonObject)
    .receiptSha256 as string;
  release.validation_summary = {
    publicationProtocolVersion: 2,
    batchId: BASELINE,
    publicationSha256,
    contextSha256: CONTEXT,
    validationTerminalSha256: terminalSha256,
    reportSha256: HASH,
    nutrientMappingDigest: publication.mapping_sha256 as string,
    nutrientMappingRevisionIds: (header.mappings as JsonObject[])
      .map((row) => String(row.revisionId))
      .sort(),
    parserReportSha256: parser.report_sha256 as string,
    validatedFoodContractVersion: 1,
  };
  release.record_counts = {
    staged: "2",
    materializable: "1",
    quarantined: "1",
    nutrientInput: "2",
    nutrientMaterializable: "1",
    nutrientExcluded: "0",
    sourceRecords: "4",
    sourcePortions: "1",
    parserExcludedRecords: "2",
  };
  header.schemaVersion = 2;
  header.preparation = preparation;
  header.validation = context;
  header.publication = publication;
  header.approvals = ["data", "quality", "rights"].map((approval_role) => ({
    approval_role,
    batch_id: BASELINE,
    database_principal: `baseline_${approval_role}`,
    rights_manifest_sha256: HASH,
    validation_terminal_sha256: terminalSha256,
    context_sha256: CONTEXT,
    report_sha256: HASH,
    approval_reference: `urn:test:baseline:${approval_role}`,
  }));
  return { header, records: records.map((entry) => entry.envelope) };
}

function publishedBaselineResponses(header: JsonObject, records: JsonObject[]) {
  const data = validation();
  const input = { ...data.input, baselineReleaseId: RELEASE, baselineEvidence: header };
  const first = reportPage("1", "metadata", frame("reconciliation-start", [BATCH, CONTEXT]));
  const baseline = reportPage(
    "2",
    "baseline",
    first.commitmentSha256,
    records.map((before) => ({ before, after: null, change: "baseline" })),
  );
  const candidate = reportPage("3", "candidate", baseline.commitmentSha256, [
    { before: null, after: {}, change: "added" },
  ]);
  const removed = reportPage("4", "removed", candidate.commitmentSha256, [], true);
  const end = terminal([first, baseline, candidate, removed], {
    baselineRecords: "2",
    candidateRecords: "1",
    added: "1",
    changed: "0",
    unchanged: "0",
    removed: "0",
    quarantined: "0",
  });
  return {
    data,
    end,
    responses: [input, data.stored, input, first, baseline, candidate, removed, end],
  };
}

describe("published V2 successor baseline eligibility", () => {
  it.each([
    ["publisher_principal", "another_independent_publisher"],
    ["initial_generation", 6],
  ])("rejects coherently shaped but unbound publication %s", (field, value) => {
    const { header } = publishedBaselineHeader();
    (header.publication as Record<string, JsonValue>)[String(field)] = value as JsonValue;
    expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow("publication context");
  });
  it.each([
    ["schemaVersion", 1],
    ["reportKind", "usda-fdc-full-csv-capability-stage-v1"],
    ["preparationAdmissionSha256", CONTEXT],
  ])(
    "rejects V1 or altered V2 parser %s despite a matching parser digest",
    (field, replacement) => {
      const { header } = publishedBaselineHeader();
      const parser = header.parser as Record<string, JsonValue>;
      (parser.report as Record<string, JsonValue>)[String(field)] = replacement as JsonValue;
      parser.report_sha256 = sha256CanonicalJson(parser.report as JsonObject);
      expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow("parser provenance");
    },
  );

  it("accepts 4097 frozen mappings while retaining V1's 4096 limit", () => {
    const { header } = publishedBaselineHeader(4097);
    expect(verifyCataloguePagedBaselineHeader(header)?.mappings.size).toBe(4097);
    expect(() => verifyCataloguePagedBaselineHeader(baselineHeader(4097))).toThrow("bounded");
  });
  it("rejects an oversized V2 mapping registry", () => {
    const { header } = publishedBaselineHeader(10001);
    expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow("bound");
  });
  it("rejects a fixture release or invented legacy policy in a V2 header", () => {
    const { header } = publishedBaselineHeader();
    (header.batch as Record<string, JsonValue>).release_class = "fixture-nonrelease";
    (header.release as Record<string, JsonValue>).release_class = "fixture-nonrelease";
    expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow();
    const other = publishedBaselineHeader().header;
    (other.batch as Record<string, JsonValue>).validation_policy = { forged: true };
    expect(() => verifyCataloguePagedBaselineHeader(other)).toThrow();
  });
  it.each(["validator_principal", "publisher_principal", "staged_database_principal"])(
    "rejects approval by %s",
    (field) => {
      const { header } = publishedBaselineHeader();
      const owner =
        field === "validator_principal"
          ? header.validation
          : field === "publisher_principal"
            ? header.publication
            : header.batch;
      (
        (header.approvals as Record<string, JsonValue>[])[0] as Record<string, JsonValue>
      ).database_principal = (owner as JsonObject)[field] as JsonValue;
      expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow();
    },
  );

  it("keeps the original staging row and emitted counts separate from parser exclusions", () => {
    const { header } = publishedBaselineHeader();
    const original = structuredClone(header.batch);
    const state = verifyCataloguePagedBaselineHeader(header);
    expect(state).toMatchObject({
      protocolVersion: 2,
      expectedCounts: {
        count: 2,
        valid: 1,
        quarantined: 1,
        nutrients: 2,
        portions: 0,
        materializableNutrients: 1,
        excludedNutrients: 0,
      },
    });
    expect(state?.batch).toEqual(original);
    expect(header.batch).toEqual(original);
    expect(state?.batch.validation_digest).toBeNull();
    expect(state?.batch.materialized_count).toBe(0);
  });
  it.each([undefined, 1, 3, "2"])(
    "rejects unversioned or unsupported publication header %s",
    (schemaVersion) => {
      const { header } = publishedBaselineHeader();
      if (schemaVersion === undefined) delete header.schemaVersion;
      else header.schemaVersion = schemaVersion;
      expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow();
    },
  );
  it("keeps the V1 envelope unversioned and rejects new evidence disguised as V1", () => {
    expect(verifyCataloguePagedBaselineHeader(baselineHeader())?.protocolVersion).toBe(1);
    expect(() =>
      verifyCataloguePagedBaselineHeader({ ...baselineHeader(), schemaVersion: 1 }),
    ).toThrow();
    expect(() =>
      verifyCataloguePagedBaselineHeader({ ...baselineHeader(), publication: {} }),
    ).toThrow();
  });
  it.each([
    ["publication", "phase", "sealed"],
    ["publication", "activated_at", null],
    ["publication", "verified_sequence", 1],
    ["publication", "materialized_count", 2],
    ["publication", "verified_materialized_count", 0],
    ["publication", "mapping_sha256", CONTEXT],
    ["publication", "materialization_bytes", 257],
    ["publication", "verification_commitment_sha256", CONTEXT],
    ["publication", "seal_sha256", CONTEXT],
    ["publication", "validation_terminal_sha256", CONTEXT],
    ["publication", "finish_receipt", null],
    ["publication", "activation_receipt", null],
    ["publication", "last_receipt_sha256", HASH],
    ["publication", "release_id", BATCH],
    ["validation", "phase", "quarantined"],
    ["validation", "terminal_sha256", CONTEXT],
    ["validation", "policy_document", "{ }"],
    ["validation", "next_sequence", 1],
    ["validation", "valid_without_nutrients_count", 1],
    ["validation", "staging_seal_sha256", CONTEXT],
    ["preparation", "phase", "sealing"],
    ["preparation", "seal_verified_record_count", 1],
    ["batch", "status", "completed"],
    ["batch", "validation_digest", HASH],
    ["batch", "materialized_count", 1],
    ["batch", "release_id", RELEASE],
    ["release", "artifact_sha256", CONTEXT],
    ["parser", "report_sha256", CONTEXT],
  ])("rejects inconsistent %s.%s before preparation", async (part, field, replacement) => {
    const { header } = publishedBaselineHeader();
    (header[String(part)] as Record<string, JsonValue>)[String(field)] = replacement as JsonValue;
    expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow();
    const data = validation();
    const f = fixture([{ ...data.input, baselineReleaseId: RELEASE, baselineEvidence: header }]);
    await expect(
      reconcileCataloguePagedBatch(
        f.database,
        { ...INPUT, expectedCurrentReleaseId: RELEASE },
        {
          validationPages: retained([data.page]),
          consumePage: async () => {},
        },
      ),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(1);
    await f.database.destroy();
  });
  it.each([
    "receipt-envelope",
    "receipt-bytes",
    "receipt-request",
    "summary",
    "legacy-counts",
    "parser-exclusions",
    "approvals",
    "mapping",
  ])("rejects changed %s evidence", (kind) => {
    const { header } = publishedBaselineHeader();
    const publication = header.publication as Record<string, JsonValue>;
    const receipt = publication.activation_receipt as Record<string, JsonValue>;
    if (kind === "receipt-envelope") receipt.activeReleaseId = BATCH;
    if (kind === "receipt-bytes") receipt.receiptDocument = `${String(receipt.receiptDocument)} `;
    if (kind === "receipt-request") publication.activation_request_document = "{}";
    if (kind === "summary")
      (header.release as Record<string, JsonValue>).validation_summary = { validationDigest: HASH };
    if (kind === "legacy-counts")
      ((header.release as JsonObject).record_counts as Record<string, JsonValue>).staged = 2;
    if (kind === "parser-exclusions")
      ((header.release as JsonObject).record_counts as Record<string, JsonValue>).quarantined = "3";
    if (kind === "approvals") {
      const approvals = header.approvals as Record<string, JsonValue>[];
      (approvals[1] as Record<string, JsonValue>).database_principal = (approvals[0] as JsonObject)
        .database_principal as string;
    }
    if (kind === "mapping")
      (
        (header.mappings as Record<string, JsonValue>[])[0] as Record<string, JsonValue>
      ).nutrientName = "Tampered";
    expect(() => verifyCataloguePagedBaselineHeader(header)).toThrow();
  });
  it.each([
    "valid",
    "missing-record",
    "duplicate",
    "payload",
    "issues",
    "food",
    "legacy-status",
    "quarantine-food",
    "counters",
  ])("revalidates complete published V2 records: %s", async (kind) => {
    const { header, records } = publishedBaselineHeader();
    const first = records[0] as Record<string, JsonValue>;
    if (kind === "missing-record") records.pop();
    if (kind === "duplicate") records[1] = { ...first };
    if (kind === "payload") first.canonicalPayloadSha256 = CONTEXT;
    if (kind === "issues") first.validationIssues = [];
    if (kind === "issues") (records[1] as Record<string, JsonValue>).validationIssues = [];
    if (kind === "food") {
      first.validatedFoodDocument = String(first.validatedFoodDocument).replace("Oats", "Forged");
      first.validatedFoodSha256 = sha(String(first.validatedFoodDocument));
    }
    if (kind === "legacy-status") first.validationStatus = "materialized";
    if (kind === "quarantine-food") {
      (records[1] as Record<string, JsonValue>).validatedFoodDocument =
        first.validatedFoodDocument as string;
      (records[1] as Record<string, JsonValue>).validatedFoodSha256 =
        first.validatedFoodSha256 as string;
    }
    if (kind === "counters") records[1] = publishedBaselineRecord(1).envelope;
    const data = publishedBaselineResponses(header, records);
    const f = fixture(data.responses);
    const run = reconcileCataloguePagedBatch(
      f.database,
      { ...INPUT, expectedCurrentReleaseId: RELEASE },
      {
        validationPages: retained([data.data.page]),
        consumePage: async () => {},
      },
    );
    if (kind === "valid") await expect(run).resolves.toEqual(data.end);
    else {
      await expect(run).rejects.toThrow();
      expect(f.queries.some((query) => query.sql.includes("catalogue_finish_reconciliation"))).toBe(
        false,
      );
    }
    await f.database.destroy();
  });
});
