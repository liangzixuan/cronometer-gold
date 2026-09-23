import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { catalogueFramedSha256V2 } from "../src/catalogue-paged-protocol.js";
import {
  advanceCatalogueValidationContextV2,
  beginCatalogueValidationV2,
  type CatalogueValidationContextV2,
  type CatalogueValidationPageReceiptV2,
  parseCatalogueValidationContextV2,
  parsePreparedCatalogueValidationPageV2,
  prepareCatalogueValidationPageV2,
  prepareCatalogueValidationTerminalV2,
  submitCatalogueValidationPageV2,
  submitCatalogueValidationTerminalV2,
} from "../src/catalogue-paged-validation.js";
import { canonicalJson, sha256CanonicalJson } from "../src/catalogue-validation.js";
import type { Database, JsonValue } from "../src/types.js";

const HASH = "a".repeat(64);
const SEMANTIC = "b".repeat(64);
const BATCH = "12345678-1234-4234-8234-123456789abc";
const REVISION = "22345678-1234-4234-8234-123456789abc";
const POLICY = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0,
  maximumQuarantinedRecords: 0,
  requireAtLeastOneValidRecord: true,
  requireDistinctApprovalPrincipals: true,
  requireMaterializedNutrientPerValidRecord: true,
};
const PRINCIPAL = {
  databasePrincipal: "validator_fixture",
  effectivePrincipal: "validator_fixture",
  canLogin: true,
  privileged: false,
  ownerMember: false,
  capabilities: ["nutrition_catalogue_validate"],
};
const MAPPING = {
  canonicalUnit: "g",
  conversionMultiplier: "1.000000000000",
  nutrientCode: "protein",
  nutrientDimension: "mass",
  nutrientId: "1",
  nutrientName: "Protein",
  mappingRevisionId: REVISION,
  sourceNutrientId: "1003",
  sourceUnit: "g",
};
function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function context(): CatalogueValidationContextV2 {
  return {
    schemaVersion: 2,
    kind: "catalogue-validation-context-v2",
    batchId: BATCH,
    contextSha256: HASH,
    admissionSha256: HASH,
    maximumValidationEvidenceBytes: "536870912",
    validatorDatabasePrincipal: "validator_fixture",
    stagingSealSha256: HASH,
    generation: "1",
    baselineReleaseId: null,
    policyDocument: canonicalJson(POLICY),
    phase: "observing",
    nextSequence: "0",
    pageCount: "0",
    stagedCount: "1",
    lastPageReceiptSha256: HASH,
    validationCommitmentSha256: catalogueFramedSha256V2("validation-start", [BATCH, HASH]),
    semanticCommitmentSha256: catalogueFramedSha256V2("semantic-start", [BATCH, HASH]),
  };
}
function payload(id = "123"): Record<string, JsonValue> {
  return {
    basis: { amount: "100", unit: "g" },
    idempotencyKey: "FDC:Foundation:" + id,
    identity: { brandOwner: null, description: "Oats", descriptionFr: null, gtin: null },
    nutrients: [
      {
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
      releaseKey: "2026-04-30",
      sourceCode: "USDA_FDC",
      sourceDataType: "Foundation",
      sourceModifiedAt: null,
      sourceRecordId: id,
    },
    sourcePayloadHash: HASH,
    unlistedNutrientPolicy: "unknown_not_reported",
  };
}
function observation(values = [payload()], changes: Record<string, unknown> = {}) {
  const objectValue = {
    schemaVersion: 2,
    kind: "catalogue-validation-observation-v2",
    batchId: BATCH,
    contextSha256: HASH,
    pageNumber: "0",
    startSequence: "0",
    endSequence: String(Number(changes.startSequence ?? 0) + values.length),
    maximumRecords: "64",
    previousReceiptSha256: HASH,
    sourceCode: "USDA_FDC",
    releaseKey: "2026-04-30",
    records: values.map((value, i) => ({
      sequenceNumber: String(Number(changes.startSequence ?? 0) + i),
      sourceRecordKey: value.idempotencyKey,
      sourceRecordType: "Foundation",
      sourcePayloadSha256: HASH,
      canonicalPayloadSha256: sha256CanonicalJson(value),
      canonicalPayloadDocument: canonicalJson(value),
    })),
    nutrientMappings: [MAPPING],
    forbiddenGtins: [],
    ...changes,
  };
  // Whitespace is intentional: retain the database's exact serialization.
  const observationDocument = JSON.stringify(objectValue, null, 1);
  return {
    schemaVersion: 2,
    observationDocument,
    observationSha256: catalogueFramedSha256V2("validation-observation", [observationDocument]),
  };
}
function fixture(responses: unknown[]) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (responses.length === 0) throw new Error("Unexpected database call");
          const result = responses.shift();
          if (result instanceof Error) throw result;
          return { rows: [{ result }] as R[] };
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
async function prepare(response = observation(), pinned = context()) {
  return prepareCatalogueValidationPageV2(fixture([PRINCIPAL, response]).database, pinned);
}
function receipt(
  request: Awaited<ReturnType<typeof prepare>>,
  pinned = context(),
): CatalogueValidationPageReceiptV2 {
  const commitment = catalogueFramedSha256V2("validation-page", [
    pinned.validationCommitmentSha256,
    request.contextSha256,
    request.pageNumber,
    request.startSequence,
    request.endSequence,
    request.observationSha256,
    request.requestSha256,
  ]);
  return {
    schemaVersion: 2,
    kind: "catalogue-validation-page-receipt-v2",
    batchId: BATCH,
    contextSha256: HASH,
    pageNumber: request.pageNumber,
    startSequence: request.startSequence,
    endSequence: request.endSequence,
    requestSha256: request.requestSha256,
    validationCommitmentSha256: commitment,
    semanticCommitmentSha256: SEMANTIC,
    receiptSha256: catalogueFramedSha256V2("validation-page-receipt", [
      BATCH,
      HASH,
      request.pageNumber,
      request.startSequence,
      request.endSequence,
      request.requestSha256,
      commitment,
      SEMANTIC,
    ]),
  };
}
describe("paged catalogue validation V2", () => {
  it("parenthesizes CASE inside the PL/pgSQL count IF condition", async () => {
    const migration = await readFile(
      new URL("../migrations/0028_catalogue_paged_validation.sql", import.meta.url),
      "utf8",
    );
    // A depth-zero CASE THEN prematurely terminates PL/pgSQL's IF expression.
    expect(migration).toMatch(
      /or \(item->>'portionInputCount'\)::bigint<>\(case\b[^;]+end\) then/u,
    );
  });
  it("begins only after asserting actual independent singleton validator authority", async () => {
    const f = fixture([PRINCIPAL, context()]);
    await expect(
      beginCatalogueValidationV2(f.database, {
        batchId: BATCH,
        stagingSealSha256: HASH,
        policy: POLICY,
      }),
    ).resolves.toEqual(context());
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1]?.sql).toContain("catalogue_begin_validation_v2");
  });
  it.each([
    { canLogin: false },
    { ownerMember: true },
    { privileged: true },
    { effectivePrincipal: "assumed" },
    { capabilities: ["nutrition_catalogue_stage"] },
    { capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_validate"] },
  ])("rejects invalid runtime identity before observing: %j", async (change) => {
    const f = fixture([{ ...PRINCIPAL, ...change }]);
    await expect(prepareCatalogueValidationPageV2(f.database, context())).rejects.toThrow();
    expect(f.queries).toHaveLength(1);
  });
  it("retains exact database observation bytes and independently computes nutrients", async () => {
    const o = observation();
    const request = await prepare(o);
    const row = JSON.parse(request.requestDocument);
    expect(row.observationDocument).toBe(o.observationDocument);
    expect(row.observationSha256).toBe(o.observationSha256);
    expect(JSON.parse(row.records[0].validatedFoodDocument).nutrients[0].amount).toBe("12.5");
    expect(row.records[0].nutrientInputCount).toBe("1");
    expect(parsePreparedCatalogueValidationPageV2(request.requestDocument)).toEqual(request);
  });
  it.each([
    [undefined, 64],
    [1, 1],
    [63, 63],
    [64, 64],
    [65, 64],
    [250, 64],
  ] as const)("bounds new observations for maximum %s to %s records", async (maximum, limit) => {
    const f = fixture([PRINCIPAL, observation([payload()], { maximumRecords: String(limit) })]);
    const request = await prepareCatalogueValidationPageV2(f.database, context(), maximum);
    expect(f.queries[1]?.parameters[2]).toBe(limit);
    expect(JSON.parse(JSON.parse(request.requestDocument).observationDocument).maximumRecords).toBe(
      String(limit),
    );
  });
  it.each([-1, 0, 251, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid public observation maximum %s before SQL",
    async (maximum) => {
      const f = fixture([]);
      await expect(
        prepareCatalogueValidationPageV2(f.database, context(), maximum),
      ).rejects.toThrow("1 through 250");
      expect(f.queries).toHaveLength(0);
    },
  );
  it("traverses every record with capped observations and replays an existing 250-record page", async () => {
    const values = Array.from({ length: 250 }, (_, index) => payload(String(index + 1)));
    const initial = { ...context(), stagedCount: "250" };
    let pinned = initial;
    let firstRequest: Record<string, JsonValue> | undefined;
    const retainedRecords: JsonValue[] = [];
    for (const start of [0, 64, 128, 192]) {
      const observed = observation(values.slice(start, start + 64), {
        pageNumber: pinned.pageCount,
        startSequence: pinned.nextSequence,
        previousReceiptSha256: pinned.lastPageReceiptSha256,
      });
      const f = fixture([PRINCIPAL, observed]);
      const request = await prepareCatalogueValidationPageV2(f.database, pinned);
      const document = JSON.parse(request.requestDocument);
      firstRequest ??= document;
      retainedRecords.push(...document.records);
      expect(f.queries[1]?.parameters).toEqual([BATCH, String(start), 64]);
      expect(request.startSequence).toBe(String(start));
      expect(request.endSequence).toBe(String(Math.min(start + 64, 250)));
      const submitted = fixture([PRINCIPAL, receipt(request, pinned)]);
      const checked = await submitCatalogueValidationPageV2(submitted.database, request, pinned);
      expect(submitted.queries[1]?.parameters[1]).toBe(request.requestDocument);
      pinned = advanceCatalogueValidationContextV2(pinned, request, checked);
    }
    expect(retainedRecords).toHaveLength(250);
    expect(
      retainedRecords.map((value) => (value as Record<string, JsonValue>).sequenceNumber),
    ).toEqual(Array.from({ length: 250 }, (_, index) => String(index)));
    expect(
      retainedRecords.every((value) => {
        const record = value as Record<string, JsonValue>;
        return (
          record.status === "valid" &&
          record.nutrientInputCount === "1" &&
          record.nutrientMaterializableCount === "1" &&
          record.excludedNutrientCount === "0"
        );
      }),
    ).toBe(true);
    expect(JSON.parse(prepareCatalogueValidationTerminalV2(pinned).terminalDocument)).toMatchObject(
      {
        recordCount: "250",
        pageCount: "4",
      },
    );
    const originalObservation = observation(values, { maximumRecords: "250" });
    const historicalDocument = canonicalJson({
      ...firstRequest,
      endSequence: "250",
      observationDocument: originalObservation.observationDocument,
      observationSha256: originalObservation.observationSha256,
      records: retainedRecords,
    });
    const historical = parsePreparedCatalogueValidationPageV2(historicalDocument);
    const lost = fixture([PRINCIPAL, new Error("lost acknowledgement")]);
    await expect(
      submitCatalogueValidationPageV2(lost.database, historical, initial),
    ).rejects.toThrow("lost acknowledgement");
    const retry = fixture([PRINCIPAL, receipt(historical, initial)]);
    await expect(
      submitCatalogueValidationPageV2(
        retry.database,
        parsePreparedCatalogueValidationPageV2(historicalDocument),
        initial,
      ),
    ).resolves.toEqual(receipt(historical, initial));
    expect(retry.queries).toHaveLength(2);
    expect(retry.queries[1]?.sql).toContain("catalogue_submit_validation_page_v2");
    expect(retry.queries[1]?.parameters[1]).toBe(historicalDocument);
  });
  it.each([
    { startSequence: "1" },
    { pageNumber: "1" },
    { contextSha256: SEMANTIC },
    { previousReceiptSha256: SEMANTIC },
    { endSequence: "2" },
    { sourceCode: "HEALTH_CANADA_CNF" },
    { extra: true },
    { pageNumber: 0 },
    { startSequence: "00" },
    { maximumRecords: "0" },
    { maximumRecords: "251" },
    { maximumRecords: 250 },
    { maximumRecords: "249" },
  ])("rejects changed context or malformed observation: %j", async (change) => {
    await expect(prepare(observation([payload()], change))).rejects.toThrow();
  });
  it("halves only a locally oversized request before retaining or submitting it", async () => {
    const values = Array.from({ length: 4 }, (_, index) => {
      const value = payload(String(index + 1));
      (value.identity as Record<string, JsonValue>).descriptionFr = '"'.repeat(1800);
      value.padding = "";
      const available = 1024 * 1024 - Buffer.byteLength(canonicalJson(value));
      value.padding = '"'.repeat(Math.floor(available / 2));
      expect(Buffer.byteLength(canonicalJson(value))).toBeLessThanOrEqual(1024 * 1024);
      return value;
    });
    const f = fixture([
      PRINCIPAL,
      observation(values, { maximumRecords: "4" }),
      observation(values.slice(0, 2), { maximumRecords: "2" }),
    ]);
    const request = await prepareCatalogueValidationPageV2(
      f.database,
      { ...context(), stagedCount: "4" },
      4,
    );
    expect(request.endSequence).toBe("2");
    expect(request.requestByteSize).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(f.queries).toHaveLength(3);
    expect(f.queries[1]?.parameters[2]).toBe(4);
    expect(f.queries[2]?.parameters[2]).toBe(2);
    expect(
      f.queries
        .slice(1)
        .every((query) => query.sql.includes("catalogue_observe_validation_page_v2")),
    ).toBe(true);
  });
  it("propagates observation failures without retrying unrelated SQL errors", async () => {
    const f = fixture([PRINCIPAL, new Error("dependency generation changed")]);
    await expect(prepareCatalogueValidationPageV2(f.database, context())).rejects.toThrow(
      "dependency generation changed",
    );
    expect(f.queries).toHaveLength(2);
  });
  it("rejects exact-byte observation hash mismatch before retaining a request", async () => {
    const o = observation();
    o.observationDocument += " ";
    await expect(prepare(o)).rejects.toThrow("checksum");
  });
  it("rejects noncanonical or changed payload text despite a valid outer observation hash", async () => {
    const o = observation();
    const value = JSON.parse(o.observationDocument);
    value.records[0].canonicalPayloadDocument += " ";
    const text = JSON.stringify(value);
    await expect(
      prepare({
        schemaVersion: 2,
        observationDocument: text,
        observationSha256: catalogueFramedSha256V2("validation-observation", [text]),
      }),
    ).rejects.toThrow("canonical bytes");
  });
  it("preserves known zero, trace, unreported and unmapped nutrient distinctions", async () => {
    const amount = payload();
    const nutrients = amount.nutrients as Record<string, JsonValue>[];
    const n = nutrients[0];
    if (!n) throw new Error("Missing fixture nutrient");
    n.value = { amount: "0", quality: "measured", state: "known" };
    let row = JSON.parse((await prepare(observation([amount]))).requestDocument).records[0];
    expect(JSON.parse(row.validatedFoodDocument).nutrients[0].amount).toBe("0");
    n.value = { detectionLimit: null, state: "trace" };
    row = JSON.parse((await prepare(observation([amount]))).requestDocument).records[0];
    expect(JSON.parse(row.validatedFoodDocument).nutrients[0].valueStatus).toBe("trace");
    n.value = { state: "unknown", reason: "not_reported" };
    row = JSON.parse((await prepare(observation([amount]))).requestDocument).records[0];
    expect(row.nutrientMaterializableCount).toBe("0");
    expect(row.excludedNutrientCount).toBe("0");
    n.sourceNutrientId = "unmapped";
    row = JSON.parse((await prepare(observation([amount]))).requestDocument).records[0];
    expect(row.excludedNutrientCount).toBe("1");
  });
  it("rejects duplicated mappings and page-global source identities", async () => {
    await expect(
      prepare(observation([payload()], { nutrientMappings: [MAPPING, MAPPING] })),
    ).rejects.toThrow("duplicate");
    const duplicate = payload();
    duplicate.idempotencyKey = "FDC:Foundation:duplicate";
    await expect(
      prepare(observation([payload(), duplicate]), { ...context(), stagedCount: "2" }),
    ).rejects.toThrow("duplicate source");
  });
  it("excludes a cross-source barcode while retaining the record", async () => {
    const value = payload();
    (value.identity as Record<string, JsonValue>).gtin = "036000291452";
    const request = await prepare(observation([value], { forbiddenGtins: ["00036000291452:US"] }));
    const row = JSON.parse(request.requestDocument).records[0];
    expect(row.status).toBe("valid");
    expect(JSON.parse(row.validatedFoodDocument).gtin).toBeNull();
    expect(row.validationIssuesDocument).toContain("BARCODE_CROSS_SOURCE_CONFLICT");
  });
  it("rejects retained semantic tampering even if all outer hashes are regenerated", async () => {
    const request = await prepare();
    const row = JSON.parse(request.requestDocument);
    const food = JSON.parse(row.records[0].validatedFoodDocument);
    food.nutrients[0].amount = "99";
    row.records[0].validatedFoodDocument = canonicalJson(food);
    row.records[0].validatedFoodSha256 = sha(row.records[0].validatedFoodDocument);
    expect(() => parsePreparedCatalogueValidationPageV2(canonicalJson(row))).toThrow(
      "independent client semantics",
    );
  });
  it("rejects unknown request fields, noncanonical count types and oversized retained requests", async () => {
    const request = await prepare();
    const row = JSON.parse(request.requestDocument);
    expect(() =>
      parsePreparedCatalogueValidationPageV2(canonicalJson({ ...row, extra: true })),
    ).toThrow("fields");
    expect(() =>
      parsePreparedCatalogueValidationPageV2(canonicalJson({ ...row, pageNumber: 0 })),
    ).toThrow("count");
    expect(() => parsePreparedCatalogueValidationPageV2(" ".repeat(16 * 1024 * 1024 + 1))).toThrow(
      "byte budget",
    );
  });
  it.each([
    "requestDocument",
    "requestSha256",
    "requestByteSize",
    "batchId",
    "contextSha256",
    "validatorDatabasePrincipal",
    "pageNumber",
    "startSequence",
    "endSequence",
    "observationSha256",
    "previousReceiptSha256",
  ] as const)("rejects missing or altered envelope field %s before SQL", async (field) => {
    const request = await prepare();
    const missing = { ...request };
    Reflect.deleteProperty(missing, field);
    const original = request[field];
    const altered = {
      ...request,
      [field]: typeof original === "number" ? original + 1 : `${original} `,
    };
    for (const value of [missing, altered]) {
      const f = fixture([]);
      await expect(submitCatalogueValidationPageV2(f.database, value, context())).rejects.toThrow();
      expect(f.queries).toHaveLength(0);
    }
  });
  it("rejects extra own envelope fields, including hidden and symbol fields, before SQL", async () => {
    const request = await prepare();
    const hidden = Object.defineProperty({ ...request }, "extra", { value: true });
    const symbol = { ...request, [Symbol("extra")]: true };
    for (const value of [{ ...request, extra: true }, hidden, symbol]) {
      const f = fixture([]);
      await expect(submitCatalogueValidationPageV2(f.database, value, context())).rejects.toThrow(
        "retained request metadata",
      );
      expect(f.queries).toHaveLength(0);
    }
  });
  it("requires own envelope fields while accepting a different property order", async () => {
    const request = await prepare();
    const inherited = Object.assign(
      Object.create({ requestSha256: request.requestSha256 }),
      request,
    );
    Reflect.deleteProperty(inherited, "requestSha256");
    const rejected = fixture([]);
    await expect(
      submitCatalogueValidationPageV2(rejected.database, inherited, context()),
    ).rejects.toThrow("retained request metadata");
    expect(rejected.queries).toHaveLength(0);
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as typeof request;
    const accepted = fixture([PRINCIPAL, receipt(request)]);
    await expect(
      submitCatalogueValidationPageV2(accepted.database, reordered, context()),
    ).resolves.toEqual(receipt(request));
    expect(accepted.queries[1]?.parameters[1]).toBe(request.requestDocument);
  });
  it("replays identical retained bytes after lost acknowledgement without observing", async () => {
    const request = await prepare();
    const f = fixture([PRINCIPAL, new Error("lost acknowledgement")]);
    await expect(submitCatalogueValidationPageV2(f.database, request, context())).rejects.toThrow(
      "lost acknowledgement",
    );
    const retry = fixture([PRINCIPAL, receipt(request)]);
    await expect(
      submitCatalogueValidationPageV2(
        retry.database,
        parsePreparedCatalogueValidationPageV2(request.requestDocument),
        context(),
      ),
    ).resolves.toEqual(receipt(request));
    expect(retry.queries).toHaveLength(2);
    expect(retry.queries[1]?.sql).toContain("catalogue_submit_validation_page_v2");
    expect(retry.queries[1]?.parameters[1]).toBe(request.requestDocument);
  });
  it("rejects a wrong-principal replay before submitting and receipt-chain tampering afterwards", async () => {
    const request = await prepare();
    const f = fixture([{ ...PRINCIPAL, databasePrincipal: "other", effectivePrincipal: "other" }]);
    await expect(submitCatalogueValidationPageV2(f.database, request, context())).rejects.toThrow(
      "another principal",
    );
    expect(f.queries).toHaveLength(1);
    const r = receipt(request);
    await expect(
      submitCatalogueValidationPageV2(
        fixture([PRINCIPAL, { ...r, receiptSha256: HASH }]).database,
        request,
        context(),
      ),
    ).rejects.toThrow("commitment");
  });
  it("requires complete coverage and derives the terminal from the entire page chain", async () => {
    expect(() => prepareCatalogueValidationTerminalV2(context())).toThrow(
      "complete record coverage",
    );
    const request = await prepare();
    const r = receipt(request);
    const completed = advanceCatalogueValidationContextV2(context(), request, r);
    expect(completed.pageCount).toBe("1");
    expect(completed.nextSequence).toBe("1");
    const terminal = prepareCatalogueValidationTerminalV2(completed);
    expect(JSON.parse(terminal.terminalDocument).validationCommitmentSha256).toBe(
      r.validationCommitmentSha256,
    );
    expect(terminal.terminalRequestSha256).toBe(sha(terminal.terminalDocument));
    const f = fixture([]);
    await expect(
      submitCatalogueValidationTerminalV2(f.database, completed, {
        ...terminal,
        terminalDocument: terminal.terminalDocument + " ",
      }),
    ).rejects.toThrow("retained terminal");
    expect(f.queries).toHaveLength(0);
  });
  it("rejects malformed contexts and policies without any database queries", () => {
    expect(() => parseCatalogueValidationContextV2({ ...context(), generation: "01" })).toThrow();
    expect(() =>
      parseCatalogueValidationContextV2({ ...context(), maximumValidationEvidenceBytes: "0" }),
    ).toThrow();
    expect(() =>
      parseCatalogueValidationContextV2({ ...context(), admissionSha256: "bad" }),
    ).toThrow();
    expect(() => parseCatalogueValidationContextV2({ ...context(), nextSequence: "2" })).toThrow();
    expect(() =>
      parseCatalogueValidationContextV2({
        ...context(),
        policyDocument: canonicalJson({ ...POLICY, requireAtLeastOneValidRecord: false }),
      }),
    ).toThrow();
  });
});
