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
  assertCatalogueValidatePrincipal,
  type PreparedCatalogueValidationRequest,
  parsePreparedCatalogueValidationRequest,
  prepareCatalogueValidation,
  submitCatalogueValidation,
  validateCatalogueValidationPolicy,
} from "../src/catalogue-capability-validation.js";
import {
  type BatchValidationPolicy,
  nutrientMappingRevisionDigest,
} from "../src/catalogue-ingestion.js";
import { canonicalJson, sha256CanonicalJson } from "../src/catalogue-validation.js";
import type { Database, JsonValue } from "../src/types.js";

const HASH = "a".repeat(64);
const TOKEN = "b".repeat(64);
const BATCH = "12345678-1234-4234-8234-123456789abc";
const REVISION = "22345678-1234-4234-8234-123456789abc";
const RECORD_KEY = "FDC:2026-04-30:Foundation:123";
const POLICY: BatchValidationPolicy = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0,
  maximumQuarantinedRecords: 0,
  requireAtLeastOneValidRecord: true,
  requireDistinctApprovalPrincipals: true,
  requireMaterializedNutrientPerValidRecord: true,
};
const PRINCIPAL = {
  databasePrincipal: "validate_fixture",
  effectivePrincipal: "validate_fixture",
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
  revisionId: REVISION,
  sourceNutrientKey: "1003",
  sourceUnit: "g",
};
const MAPPING_HASH = nutrientMappingRevisionDigest([MAPPING]);
const INPUT = {
  batchId: BATCH,
  expectedStagingSealSha256: HASH,
  expectedNutrientMappingDigest: MAPPING_HASH,
  policy: POLICY,
};
type Mutable = { [key: string]: JsonValue };
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}
function obj(value: JsonValue | undefined): Mutable {
  return value as Mutable;
}
function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function payload(): Mutable {
  return {
    basis: { amount: "100", unit: "g" },
    idempotencyKey: RECORD_KEY,
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
      releaseKey: "2026-04-30",
      sourceCode: "USDA_FDC",
      sourceDataType: "Foundation",
      sourceModifiedAt: "2026-04-30T00:00:00.000Z",
      sourceRecordId: "123",
    },
    sourcePayloadHash: HASH,
    unlistedNutrientPolicy: "unknown_not_reported",
  };
}
function observation(values = [payload()]) {
  const nutrientCount = values.reduce((n, value) => n + (value.nutrients as JsonValue[]).length, 0);
  const recordsSha256 = sha(values.map((value) => `${canonicalJson(value)}\n`).join(""));
  const counts = {
    emittedRecordCount: values.length,
    excludedRecordCount: 0,
    sourceRecordCount: values.length,
    emittedNutrientCount: nutrientCount,
    excludedNutrientCount: 0,
    sourceNutrientCount: nutrientCount,
    emittedPortionCount: 0,
    excludedPortionCount: 0,
    sourcePortionCount: 0,
  };
  const report = {
    artifactSha256: HASH,
    inspection: {
      semanticEvidence: {
        canonicalAcceptedRecords: { count: values.length, sha256: recordsSha256 },
      },
      conservation: {
        foods: { acceptedCount: values.length, quarantinedCount: 0, sourceCount: values.length },
        foodNutrients: {
          emittedCount: nutrientCount,
          excludedCount: 0,
          quarantinedParentCount: 0,
          sourceCount: nutrientCount,
        },
        foodPortions: {
          emittedCount: 0,
          excludedCount: 0,
          quarantinedParentCount: 0,
          sourceCount: 0,
        },
      },
      metrics: {
        acceptedFoodCount: values.length,
        quarantinedFoodCount: 0,
        stagedNutrientCount: nutrientCount,
        excludedNutrientCount: 0,
        stagedPortionCount: 0,
        excludedPortionCount: 0,
        derivedLabelServingCount: 0,
      },
    },
    nutrientMappingDigest: MAPPING_HASH,
    parserBuildSha256: HASH,
    parserPackage: "@nutrition-tracker/ingestion",
    parserVersion: "0.1.0",
    portionCountBasis: "source-csv-portions-plus-emitted-derived-label-servings-v1",
    recordsExport: { byteSize: 1234, sha256: HASH, recordCount: values.length, recordsSha256 },
    releaseKey: "2026-04-30",
    reportKind: "usda-fdc-full-csv-capability-stage-v1",
    schemaVersion: 1,
    sourceCode: "USDA_FDC",
  };
  return {
    schemaVersion: 1,
    observationSha256: TOKEN,
    observation: {
      schemaVersion: 1,
      sourceCode: "USDA_FDC",
      batch: {
        acquiredAt: "2026-09-20T00:00:00+00:00",
        artifactBytes: 1234,
        artifactSha256: HASH,
        artifactUri: "s3://fixture/source.zip",
        evidenceBundleSha256: HASH,
        evidenceBundleUri: "s3://fixture/evidence.json",
        evidenceDecisionSha256: HASH,
        evidenceObjectVersionId: "v1",
        evidenceValidUntil: "2026-09-20T12:00:00+00:00",
        id: BATCH,
        mediaType: "application/zip",
        parserVersion: `0.1.0+build.${HASH}+mapping.${MAPPING_HASH}`,
        publishedOn: "2026-04-30",
        releaseClass: "fixture-nonrelease",
        releaseKey: "2026-04-30",
        rightsManifestSha256: HASH,
        rightsManifestUri: "s3://fixture/manifest.json",
        stagedCount: values.length,
        stagedDatabasePrincipal: "stage_fixture",
        stagingSealSha256: HASH,
        stagingSealedAt: "2026-09-20T00:01:00+00:00",
        status: "staging",
        upstreamSchemaVersion: null,
      },
      forbiddenGtins: [] as string[],
      nutrientMappings: [MAPPING],
      parserReport: { ...counts, report, reportSha256: sha256CanonicalJson(report) },
      records: values.map((value, index) => ({
        canonicalPayload: value,
        canonicalPayloadSha256: sha256CanonicalJson(value),
        sequenceNumber: index,
        sourcePayloadSha256: HASH,
        sourceRecordKey: value.idempotencyKey as string,
        sourceRecordType: "Foundation",
        validatedFoodContractVersion: null,
        validatedFoodDocument: null,
        validatedFoodSha256: null,
        validatedAt: null,
        validationIssues: [],
        validationStatus: "pending",
      })),
      stageCheckpoint: {
        cursor: { nextOffset: values.length },
        lastSequenceNumber: values.length === 0 ? null : values.length - 1,
        processedCount: values.length,
      },
    },
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
          return { rows: (result === undefined ? [] : [{ result }]) as R[] };
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
async function prepared(data = observation(), policy = POLICY) {
  return prepareCatalogueValidation(fixture([PRINCIPAL, data]).database, { ...INPUT, policy });
}
function decode(request: PreparedCatalogueValidationRequest) {
  const outer = JSON.parse(request.validationDocument);
  return { outer, digest: JSON.parse(outer.digestDocument) };
}
function rewrite(
  request: PreparedCatalogueValidationRequest,
  edit: (outer: Mutable, digest: Mutable) => void,
) {
  const { outer, digest } = decode(request);
  edit(outer, digest);
  outer.digestDocument = canonicalJson(digest);
  const validationDocument = canonicalJson(outer);
  return {
    ...request,
    validationDocument,
    validationDocumentByteSize: Buffer.byteLength(validationDocument),
    validationDocumentSha256: sha(validationDocument),
    validationDigest: sha(outer.digestDocument),
  };
}
function receipt(request: PreparedCatalogueValidationRequest, replay = false) {
  return {
    excludedNutrientCount: 0,
    nutrientInputCount: 1,
    nutrientMaterializableCount: 1,
    nutrientMappingDigest: MAPPING_HASH,
    nutritionSemanticContractVersion: 1,
    nutritionSemanticSha256: HASH,
    promotionEligible: true,
    quarantinedCount: 0,
    stagedCount: 1,
    validCount: 1,
    validationDigest: request.validationDigest,
    warningCount: 0,
    wasAlreadyValidated: replay,
    ...(replay ? {} : { recordErrorCount: 0, unresolvedErrorCount: 0 }),
  };
}

describe("bounded validate-only catalogue consumer", () => {
  it("requires actual singleton validate authority and returns the database principal", async () => {
    const f = fixture([PRINCIPAL]);
    await expect(assertCatalogueValidatePrincipal(f.database)).resolves.toEqual({
      databasePrincipal: "validate_fixture",
      capabilityRole: "nutrition_catalogue_validate",
    });
    expect(f.queries[0]?.sql).toContain("pg_catalog.pg_roles");
    expect(f.queries[0]?.sql).toContain("session_user");
  });
  it.each([
    { privileged: true },
    { ownerMember: true },
    { canLogin: false },
    { effectivePrincipal: "assumed" },
    { capabilities: [] },
    { capabilities: ["nutrition_catalogue_stage"] },
    { capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_validate"] },
    { extra: true },
  ])("rejects authority before observation: %j", async (change) => {
    const f = fixture([{ ...PRINCIPAL, ...change }]);
    await expect(prepareCatalogueValidation(f.database, INPUT)).rejects.toThrow();
    expect(f.queries).toHaveLength(1);
  });
  it.each([
    { maximumExcludedNutrientFraction: undefined },
    { maximumExcludedNutrientFraction: -1 },
    { maximumExcludedNutrientFraction: Infinity },
    { maximumQuarantineFraction: 1.1 },
    { maximumQuarantinedRecords: 0.5 },
    { requireDistinctApprovalPrincipals: false },
    { requireAtLeastOneValidRecord: false },
    { requireMaterializedNutrientPerValidRecord: false },
    { extra: 1 },
  ])("requires all explicit policy fields before any connection query: %j", async (change) => {
    const f = fixture([]);
    await expect(
      prepareCatalogueValidation(f.database, {
        ...INPUT,
        policy: { ...POLICY, ...change } as BatchValidationPolicy,
      }),
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(0);
  });
  it("pins the PostgreSQL observation token without substituting a canonical JSON hash", async () => {
    const source = observation();
    const f = fixture([PRINCIPAL, source]);
    const request = await prepareCatalogueValidation(f.database, INPUT);
    const { outer, digest } = decode(request);
    expect(request.observationSha256).toBe(TOKEN);
    expect(request.observationSha256).not.toBe(sha256CanonicalJson(source.observation));
    expect(digest.observationSha256).toBe(TOKEN);
    expect(digest.nutrientMappingRevisionIds).toEqual([REVISION]);
    expect(digest.records[0]).toMatchObject({
      status: "valid",
      nutrientInputCount: 1,
      nutrientMaterializableCount: 1,
      excludedNutrientCount: 0,
    });
    expect(JSON.parse(outer.records[0].validatedFoodDocument).nutrients[0].amount).toBe("12.5");
    expect(
      parsePreparedCatalogueValidationRequest(
        JSON.parse(canonicalJson(request as unknown as JsonValue)),
      ),
    ).toEqual(request);
    expect(f.queries[1]?.sql).toContain("public.catalogue_observe_import_validation($1::uuid)");
    expect(f.queries).toHaveLength(2);
  });
  it.each([
    "source",
    "seal",
    "stager",
    "state",
    "checkpoint",
    "payload",
    "pending",
    "sequence",
    "mapping",
    "reportHash",
    "reportKind",
    "semantic",
    "conservation",
    "metrics",
    "unknownField",
  ])("rejects observed %s drift before preparing a request", async (variant) => {
    const response = observation();
    const o = response.observation;
    const parser = o.parserReport;
    if (variant === "source") o.sourceCode = "HEALTH_CANADA_CNF";
    if (variant === "seal") o.batch.stagingSealSha256 = TOKEN;
    if (variant === "stager") o.batch.stagedDatabasePrincipal = "validate_fixture";
    if (variant === "state") o.batch.status = "ready";
    if (variant === "checkpoint") o.stageCheckpoint.cursor.nextOffset = 0;
    if (variant === "payload") required(o.records[0]).canonicalPayloadSha256 = TOKEN;
    if (variant === "pending") required(o.records[0]).validationStatus = "valid";
    if (variant === "sequence") required(o.records[0]).sequenceNumber = 1;
    if (variant === "mapping") o.nutrientMappings = [{ ...MAPPING, nutrientName: "Changed" }];
    if (variant === "reportHash") parser.reportSha256 = TOKEN;
    if (variant === "reportKind") parser.report.reportKind = "foundation-json";
    if (variant === "semantic")
      parser.report.inspection.semanticEvidence.canonicalAcceptedRecords.sha256 = TOKEN;
    if (variant === "conservation") parser.sourceNutrientCount = 2;
    if (variant === "metrics") parser.report.inspection.metrics.stagedNutrientCount = 2;
    if (variant === "unknownField") Object.assign(o.batch, { extra: true });
    if (variant !== "reportHash") parser.reportSha256 = sha256CanonicalJson(parser.report);
    await expect(prepared(response)).rejects.toThrow();
  });
  it("rejects duplicate record identity and more than 10,000 staged records", async () => {
    await expect(prepared(observation([payload(), payload()]))).rejects.toThrow(
      "Duplicate source record",
    );
    const data = observation();
    data.observation.records = Array.from({ length: 10_001 }, () =>
      required(data.observation.records[0]),
    );
    data.observation.batch.stagedCount = 10_001;
    await expect(prepared(data)).rejects.toThrow("oversized validation array");
  });
  it("preserves measured zero, trace and unknown missingness under the existing validator", async () => {
    const value = payload();
    obj((value.nutrients as JsonValue[])[0]).value = {
      amount: "0",
      quality: "measured",
      state: "known",
    };
    let request = await prepared(observation([value]));
    expect(
      JSON.parse(decode(request).outer.records[0].validatedFoodDocument).nutrients[0].amount,
    ).toBe("0");
    obj((value.nutrients as JsonValue[])[0]).value = { detectionLimit: null, state: "trace" };
    request = await prepared(observation([value]));
    expect(
      JSON.parse(decode(request).outer.records[0].validatedFoodDocument).nutrients[0].valueStatus,
    ).toBe("trace");
    obj((value.nutrients as JsonValue[])[0]).value = { reason: "not_reported", state: "unknown" };
    request = await prepared(observation([value]));
    expect(decode(request).digest.records[0]).toMatchObject({
      nutrientMaterializableCount: 0,
      excludedNutrientCount: 0,
    });
  });
  it("excludes an unmapped nutrient and produces a policy-ineligible valid record", async () => {
    const value = payload();
    (value.nutrients as JsonValue[]).push({
      ...obj((value.nutrients as JsonValue[])[0]),
      sourceNutrientId: "9999",
    });
    const request = await prepared(observation([value]));
    const row = decode(request).digest.records[0];
    expect(row).toMatchObject({
      status: "valid",
      nutrientInputCount: 2,
      nutrientMaterializableCount: 1,
      excludedNutrientCount: 1,
    });
    const result = {
      ...receipt(request),
      nutrientInputCount: 2,
      excludedNutrientCount: 1,
      promotionEligible: false,
      warningCount: row.issues.length,
      unresolvedErrorCount: 1,
    };
    await expect(
      submitCatalogueValidation(fixture([PRINCIPAL, result]).database, request),
    ).resolves.toMatchObject({ promotionEligible: false, validCount: 1, quarantinedCount: 0 });
  });
  it.each([false, true])(
    "submits exact persisted bytes through public semantic wrapper, replay=%s",
    async (replay) => {
      const request = await prepared();
      const result = receipt(request, replay);
      const f = fixture([PRINCIPAL, result]);
      await expect(submitCatalogueValidation(f.database, request)).resolves.toEqual(result);
      expect(f.queries).toHaveLength(2);
      expect(f.queries[1]?.sql).toContain(
        "public.catalogue_validate_import_batch($1::uuid, $2::text, $3::text, $4::text)",
      );
      expect(f.queries[1]?.parameters).toEqual([BATCH, HASH, TOKEN, request.validationDocument]);
      expect(
        f.queries.every(
          (query) => !query.sql.includes("_v1") && !query.sql.includes("observe_import"),
        ),
      ).toBe(true);
    },
  );
  it("retries identical retained bytes after a lost acknowledgement without observing", async () => {
    const request = await prepared();
    const f = fixture([
      PRINCIPAL,
      new Error("lost acknowledgement"),
      PRINCIPAL,
      receipt(request, true),
    ]);
    await expect(submitCatalogueValidation(f.database, request)).rejects.toThrow(
      "lost acknowledgement",
    );
    await expect(submitCatalogueValidation(f.database, request)).resolves.toMatchObject({
      wasAlreadyValidated: true,
    });
    expect(f.queries[1]?.parameters).toEqual(f.queries[3]?.parameters);
  });
  it("rejects a different validate-only login before submission", async () => {
    const request = await prepared();
    const f = fixture([
      { ...PRINCIPAL, databasePrincipal: "another", effectivePrincipal: "another" },
    ]);
    await expect(submitCatalogueValidation(f.database, request)).rejects.toThrow(
      "another validator",
    );
    expect(f.queries).toHaveLength(1);
  });
  it.each(["sha", "bytes", "digest", "policy", "food", "issues", "counts", "unknown", "canonical"])(
    "rejects retained request %s tampering without a query",
    async (kind) => {
      let request = await prepared();
      if (kind === "sha") request = { ...request, validationDocumentSha256: TOKEN };
      if (kind === "bytes")
        request = {
          ...request,
          validationDocumentByteSize: request.validationDocumentByteSize + 1,
        };
      if (kind === "digest") request = { ...request, validationDigest: TOKEN };
      if (kind === "policy")
        request = { ...request, policy: { ...POLICY, maximumExcludedNutrientFraction: 1 } };
      if (kind === "canonical")
        request = { ...request, validationDocument: ` ${request.validationDocument}` };
      if (["food", "issues", "counts", "unknown"].includes(kind))
        request = rewrite(request, (outer, digest) => {
          const row = obj((digest.records as JsonValue[])[0]);
          if (kind === "food") row.validatedFoodSha256 = TOKEN;
          if (kind === "issues")
            obj((outer.records as JsonValue[])[0]).validationIssuesDocument = "[] ";
          if (kind === "counts") row.nutrientInputCount = 2;
          if (kind === "unknown") digest.extra = true;
        });
      const f = fixture([]);
      await expect(submitCatalogueValidation(f.database, request)).rejects.toThrow();
      expect(f.queries).toHaveLength(0);
    },
  );
  it("allows structurally consistent altered nutrition to reach the independent SQL semantic guard", async () => {
    const request = rewrite(await prepared(), (outer, digest) => {
      const result = obj((outer.records as JsonValue[])[0]);
      const food = JSON.parse(result.validatedFoodDocument as string);
      food.nutrients[0].amount = "999";
      result.validatedFoodDocument = canonicalJson(food);
      obj((digest.records as JsonValue[])[0]).validatedFoodSha256 = sha(
        result.validatedFoodDocument,
      );
    });
    expect(parsePreparedCatalogueValidationRequest(request)).toEqual(request);
    const f = fixture([PRINCIPAL, new Error("SQL semantic recheck rejected altered nutrition")]);
    await expect(submitCatalogueValidation(f.database, request)).rejects.toThrow(
      "semantic recheck",
    );
    expect(f.queries).toHaveLength(2);
  });
  it.each([
    { nutritionSemanticContractVersion: undefined },
    { nutritionSemanticSha256: "bad" },
    { validationDigest: TOKEN },
    { nutrientMappingDigest: TOKEN },
    { promotionEligible: false },
    { nutrientMaterializableCount: 0 },
    { wasAlreadyValidated: "true" },
    { extra: true },
  ])("rejects missing or inconsistent semantic receipt: %j", async (change) => {
    const request = await prepared();
    await expect(
      submitCatalogueValidation(
        fixture([PRINCIPAL, { ...receipt(request), ...change }]).database,
        request,
      ),
    ).rejects.toThrow();
  });
  it("rejects oversized or non-PostgreSQL canonical payloads", async () => {
    const value = payload();
    value.large = "x".repeat(1024 * 1024);
    await expect(prepared(observation([value]))).rejects.toThrow("byte limit");
    delete value.large;
    value.bad = "nul\u0000";
    await expect(prepared(observation([value]))).rejects.toThrow("JSON string");
  });
  it("quarantines duplicate food identity even with distinct record keys", async () => {
    const second = payload();
    second.idempotencyKey = `${RECORD_KEY}:duplicate`;
    const request = await prepared(observation([payload(), second]));
    const { digest, outer } = decode(request);
    expect(digest.records).toHaveLength(2);
    expect(
      digest.records.every(
        (row: { status: string; nutrientMaterializableCount: number }) =>
          row.status === "quarantined" && row.nutrientMaterializableCount === 0,
      ),
    ).toBe(true);
    expect(digest.records[0].issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DUPLICATE_SOURCE_FOOD_KEY" })]),
    );
    expect(
      outer.records.every(
        (row: { validatedFoodDocument: unknown }) => row.validatedFoodDocument === null,
      ),
    ).toBe(true);
  });
  it("uses observed forbidden GTINs without excluding the record or changing nutrient values", async () => {
    const value = payload();
    obj(value.identity).gtin = "00036000291452";
    const response = observation([value]);
    response.observation.forbiddenGtins = ["00036000291452:US"];
    const request = await prepared(response);
    const { digest, outer } = decode(request);
    expect(digest.records[0].status).toBe("valid");
    expect(digest.records[0].issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BARCODE_CROSS_SOURCE_CONFLICT" })]),
    );
    expect(JSON.parse(outer.records[0].validatedFoodDocument)).toMatchObject({
      gtin: null,
      nutrients: [expect.objectContaining({ amount: "12.5" })],
    });
  });
  it("represents an empty sealed batch and keeps the required valid-record policy ineligible", async () => {
    const request = await prepared(observation([]));
    expect(decode(request).digest.records).toEqual([]);
    const result = {
      ...receipt(request),
      stagedCount: 0,
      validCount: 0,
      nutrientInputCount: 0,
      nutrientMaterializableCount: 0,
      promotionEligible: false,
      unresolvedErrorCount: 3,
    };
    await expect(
      submitCatalogueValidation(fixture([PRINCIPAL, result]).database, request),
    ).resolves.toMatchObject({ promotionEligible: false });
  });
  it("preserves a pinned version-8 batch UUID through preparation and exact submission", async () => {
    const batchId = "12345678-1234-8234-8234-123456789abc";
    const response = observation();
    response.observation.batch.id = batchId;
    const request = await prepareCatalogueValidation(fixture([PRINCIPAL, response]).database, {
      ...INPUT,
      batchId,
    });
    expect(request.batchId).toBe(batchId);
    expect(decode(request).digest.batchId).toBe(batchId);
    expect(parsePreparedCatalogueValidationRequest(request).batchId).toBe(batchId);
    const f = fixture([PRINCIPAL, receipt(request)]);
    await expect(submitCatalogueValidation(f.database, request)).resolves.toMatchObject({
      validationDigest: request.validationDigest,
    });
    expect(f.queries[1]?.parameters[0]).toBe(batchId);
  });
  it("retains the SQL version-1–5 restriction for observed and retained mapping revisions", async () => {
    const revisionId = "22345678-1234-8234-8234-123456789abc";
    const response = observation();
    response.observation.nutrientMappings = [{ ...MAPPING, revisionId }];
    await expect(prepared(response)).rejects.toThrow("version 1–5 mapping revision UUID");
    const request = rewrite(await prepared(), (_outer, digest) => {
      digest.nutrientMappingRevisionIds = [revisionId];
    });
    expect(() => parsePreparedCatalogueValidationRequest(request)).toThrow(
      "version 1–5 mapping revision UUID",
    );
  });
  it("keeps the mapping helper and policy deterministic", () => {
    expect(nutrientMappingRevisionDigest([{ ...MAPPING, conversionMultiplier: "1" }])).toBe(
      MAPPING_HASH,
    );
    expect(validateCatalogueValidationPolicy(POLICY)).toEqual(POLICY);
  });
});
