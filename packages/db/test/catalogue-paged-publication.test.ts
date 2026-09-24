import { createHash } from "node:crypto";
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
import {
  CATALOGUE_PUBLICATION_LIMIT_KEYS_V2,
  CATALOGUE_PUBLICATION_OPERATIONS_V2,
  type CataloguePublicationOperationV2,
  encodeCataloguePublicationRequestV2,
  parseCataloguePublicationRequestV2,
  readCataloguePublicationV2,
  submitCataloguePublicationRequestV2,
  verifyCataloguePublicationReceiptV2,
} from "../src/catalogue-paged-publication.js";
import type { Database, JsonObject } from "../src/types.js";

const BATCH = "12345678-1234-4234-8234-123456789abc";
const RELEASE = "22345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const limits = Object.fromEntries(
  CATALOGUE_PUBLICATION_LIMIT_KEYS_V2.map((key) => [key, "1000000"]),
);
function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function request(op: CataloguePublicationOperationV2): JsonObject {
  const base = { schemaVersion: 2, batchId: BATCH };
  switch (op) {
    case "admit":
      return {
        ...base,
        contextSha256: HASH,
        validationTerminalSha256: HASH,
        reportSha256: HASH,
        publisherPrincipal: "publisher_fixture",
        limits,
      };
    case "begin":
      return { ...base, admissionSha256: HASH };
    case "materialize":
    case "verify":
      return {
        ...base,
        publicationSha256: HASH,
        pageNumber: "0",
        firstSequence: "0",
        previousReceiptSha256: OTHER,
      };
    case "finish":
      return { ...base, publicationSha256: HASH, previousReceiptSha256: OTHER };
    case "activate":
      return {
        ...base,
        publicationSha256: HASH,
        sealSha256: HASH,
        expectedCurrentReleaseId: null,
        reason: "Approved synthetic cutover",
      };
    case "rollback":
      return {
        schemaVersion: 2,
        sourceCode: "USDA_FDC",
        requestId: BATCH,
        targetReleaseId: null,
        expectedCurrentReleaseId: RELEASE,
        reason: "Synthetic deactivation",
      };
  }
}
function progress(op: CataloguePublicationOperationV2): JsonObject {
  return {
    publicationSha256: HASH,
    admissionSha256: HASH,
    releaseId: RELEASE,
    contextSha256: HASH,
    validationTerminalSha256: HASH,
    reportSha256: HASH,
    baselineReleaseId: null,
    phase:
      op === "begin"
        ? "materializing"
        : op === "finish"
          ? "sealed"
          : op === "activate"
            ? "activated"
            : "verifying",
    nextSequence: op === "begin" ? "0" : "250",
    pageCount: op === "begin" ? "0" : "1",
    materializedCount: op === "begin" ? "0" : "249",
    verifiedSequence: op === "begin" || op === "materialize" ? "0" : "250",
    verifiedPageCount: op === "begin" || op === "materialize" ? "0" : "1",
    generation: "4321",
    sealSha256: op === "finish" || op === "activate" ? HASH : null,
  };
}
function envelope(core: JsonObject) {
  const receiptDocument = JSON.stringify(core, null, 1);
  return { ...core, receiptDocument, receiptSha256: sha(receiptDocument) };
}
function receipt(op: CataloguePublicationOperationV2, document: string, delta: JsonObject = {}) {
  const core: JsonObject = {
    schemaVersion: 2,
    operation: op,
    batchId: op === "rollback" ? null : BATCH,
    sourceCode: "USDA_FDC",
    requestSha256: sha(document),
  };
  if (op === "admit")
    Object.assign(core, { admissionSha256: HASH, publisherPrincipal: "publisher_fixture", limits });
  else if (op === "rollback")
    Object.assign(core, {
      requestId: BATCH,
      activationId: "42",
      previousReleaseId: RELEASE,
      activeReleaseId: null,
    });
  else {
    Object.assign(core, progress(op));
    if (op === "activate")
      Object.assign(core, {
        activationId: "41",
        previousReleaseId: null,
        activeReleaseId: RELEASE,
      });
  }
  return envelope({ ...core, ...delta });
}
function principal(op: CataloguePublicationOperationV2) {
  return {
    databasePrincipal: "operator_fixture",
    effectivePrincipal: "operator_fixture",
    canLogin: true,
    privileged: false,
    ownerMember: false,
    capabilities: [
      op === "admit"
        ? "nutrition_catalogue_approve_quality"
        : op === "rollback"
          ? "nutrition_catalogue_rollback"
          : "nutrition_catalogue_promote_activate",
    ],
  };
}
function fixture(responses: unknown[]) {
  const queries: CompiledQuery[] = [];
  const settings: CompiledQuery[] = [];
  const transactions = { begins: 0, commits: 0, rollbacks: 0 };
  class Driver extends DummyDriver {
    override async beginTransaction(): Promise<void> {
      transactions.begins += 1;
    }
    override async commitTransaction(): Promise<void> {
      transactions.commits += 1;
    }
    override async rollbackTransaction(): Promise<void> {
      transactions.rollbacks += 1;
    }
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          if (query.sql.includes("pg_catalog.set_config")) {
            settings.push(query);
            return { rows: [] as R[] };
          }
          queries.push(query);
          if (!responses.length) throw new Error("Unexpected database call");
          const value = await responses.shift();
          if (value instanceof Error) throw value;
          return { rows: (value === undefined ? [] : [{ result: value }]) as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No stream expected");
        },
      };
    }
  }
  return {
    queries,
    settings,
    transactions,
    database: new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new Driver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    }),
  };
}

describe("publication exact requests and receipts", () => {
  it("commits only verified receipts within transaction-local tighter-or-equal timeouts", async () => {
    const document = encodeCataloguePublicationRequestV2("begin", request("begin"));
    const f = fixture([principal("begin"), receipt("begin", document)]);
    await submitCataloguePublicationRequestV2(f.database, "begin", document);
    expect(f.settings).toHaveLength(1);
    expect(f.settings[0]?.sql).toContain("least(2000, coalesce(nullif(");
    expect(f.settings[0]?.sql).toContain("least(30000, coalesce(nullif(");
    expect(f.transactions).toEqual({ begins: 1, commits: 1, rollbacks: 0 });
    const bad = fixture([principal("begin"), receipt("begin", document, { batchId: RELEASE })]);
    await expect(
      submitCataloguePublicationRequestV2(bad.database, "begin", document),
    ).rejects.toThrow("binding differs");
    expect(bad.transactions).toEqual({ begins: 1, commits: 0, rollbacks: 1 });
  });

  it("does not mutate after cancellation during the restricted-principal preflight", async () => {
    let release: (value: unknown) => void = () => {
      throw new Error("preflight not waiting");
    };
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const document = encodeCataloguePublicationRequestV2("activate", request("activate"));
    const f = fixture([pending, receipt("activate", document)]);
    const controller = new AbortController();
    const work = submitCataloguePublicationRequestV2(
      f.database,
      "activate",
      document,
      controller.signal,
    );
    controller.abort(new Error("cancelled during preflight"));
    release(principal("activate"));
    await expect(work).rejects.toThrow("cancelled during preflight");
    expect(f.queries).toHaveLength(1);
  });

  it.each(CATALOGUE_PUBLICATION_OPERATIONS_V2)(
    "submits %s through a fixed restricted function with exact bytes",
    async (op) => {
      const document = encodeCataloguePublicationRequestV2(op, request(op));
      const result = receipt(op, document);
      const f = fixture([principal(op), result]);
      await expect(submitCataloguePublicationRequestV2(f.database, op, document)).resolves.toEqual(
        result,
      );
      expect(f.queries[1]?.parameters).toEqual([document]);
      expect(f.queries[1]?.sql).toMatch(
        /^select public\."catalogue_[a-z_]+_v2"\(\$1::text\) as result$/u,
      );
    },
  );
  it.each(["0", "01", "-1", "1.0", "9223372036854775808", 1, null])(
    "rejects malformed resource admission %s",
    (value) => {
      expect(() =>
        encodeCataloguePublicationRequestV2("admit", {
          ...request("admit"),
          limits: { ...limits, maxRecords: value },
        }),
      ).toThrow();
    },
  );
  it("rejects unknown keys, duplicate JSON keys and caller generation before any query", async () => {
    const f = fixture([]);
    const valid = encodeCataloguePublicationRequestV2("begin", request("begin"));
    for (const document of [
      valid.replace("{", '{"schemaVersion":2,'),
      `${valid}\n`,
      JSON.stringify({ ...request("begin"), generation: "4321" }),
    ]) {
      await expect(
        submitCataloguePublicationRequestV2(f.database, "begin", document),
      ).rejects.toThrow();
    }
    expect(f.queries).toHaveLength(0);
  });
  it("rejects oversized documents and control characters before SQL", () => {
    expect(() => parseCataloguePublicationRequestV2("begin", " ".repeat(65537))).toThrow(
      "byte limit",
    );
    expect(() =>
      encodeCataloguePublicationRequestV2("activate", {
        ...request("activate"),
        reason: "a\u0000b",
      }),
    ).toThrow();
  });
  it.each([
    { privileged: true },
    { ownerMember: true },
    { canLogin: false },
    { effectivePrincipal: "changed_role" },
    { capabilities: ["nutrition_catalogue_promote_activate", "nutrition_catalogue_rollback"] },
    { capabilities: ["nutrition_catalogue_approve_quality"] },
  ])("rejects unauthorized or mixed-role login %j", async (delta) => {
    const f = fixture([{ ...principal("begin"), ...delta }]);
    await expect(
      submitCataloguePublicationRequestV2(
        f.database,
        "begin",
        encodeCataloguePublicationRequestV2("begin", request("begin")),
      ),
    ).rejects.toThrow("restricted login");
    expect(f.queries).toHaveLength(1);
  });
  it.each([
    { operation: "verify" },
    { batchId: RELEASE },
    { requestSha256: OTHER },
    { nextSequence: "251" },
    { nextSequence: "0", materializedCount: "0" },
    { pageCount: "2" },
    { publicationSha256: OTHER },
    { generation: 4321 },
    { extra: true },
    { phase: "activated", sealSha256: HASH },
  ])("rejects well-hashed materialization receipt with wrong binding %j", (delta) => {
    const document = encodeCataloguePublicationRequestV2("materialize", request("materialize"));
    expect(() =>
      verifyCataloguePublicationReceiptV2(
        "materialize",
        document,
        receipt("materialize", document, delta),
      ),
    ).toThrow();
  });
  it("rejects tampered receipt text, digest and core independently", () => {
    const document = encodeCataloguePublicationRequestV2("begin", request("begin"));
    const valid = receipt("begin", document);
    for (const delta of [
      { receiptSha256: OTHER },
      { receiptDocument: `${valid.receiptDocument} ` },
      { sourceCode: "ALTERED" },
    ])
      expect(() =>
        verifyCataloguePublicationReceiptV2("begin", document, { ...valid, ...delta }),
      ).toThrow("digest differs");
  });
  it("rejects changed rollback and activation destinations even with valid receipt hashes", () => {
    for (const op of ["rollback", "activate"] as const) {
      const document = encodeCataloguePublicationRequestV2(op, request(op));
      expect(() =>
        verifyCataloguePublicationReceiptV2(
          op,
          document,
          receipt(op, document, { activeReleaseId: BATCH }),
        ),
      ).toThrow("destination differs");
    }
  });
  it("replays the identical activation request after a lost response", async () => {
    const document = encodeCataloguePublicationRequestV2("activate", request("activate"));
    const result = receipt("activate", document);
    const f = fixture([
      principal("activate"),
      new Error("connection lost"),
      principal("activate"),
      result,
    ]);
    await expect(
      submitCataloguePublicationRequestV2(f.database, "activate", document),
    ).rejects.toThrow("connection lost");
    await expect(
      submitCataloguePublicationRequestV2(f.database, "activate", document),
    ).resolves.toEqual(result);
    expect(f.queries[1]?.parameters).toEqual(f.queries[3]?.parameters);
  });
  it("binds read context to the batch and restricts rollback to activated publications", async () => {
    const context = {
      schemaVersion: 2,
      batchId: BATCH,
      sourceCode: "USDA_FDC",
      lastReceiptSha256: HASH,
      ...progress("finish"),
    };
    const f = fixture([principal("begin"), context, principal("rollback"), context]);
    await expect(readCataloguePublicationV2(f.database, BATCH)).resolves.toEqual(context);
    await expect(readCataloguePublicationV2(f.database, BATCH, "rollback")).rejects.toThrow(
      "unpublished",
    );
  });
});
