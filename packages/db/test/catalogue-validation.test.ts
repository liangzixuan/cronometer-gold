import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type BatchRecordValidation,
  type BatchValidationPolicy,
  canonicalJson,
  canonicalJsonChunks,
  evaluateBatchPolicy,
  type JsonObject,
  type JsonValue,
  type ReviewedCatalogueNutrientMapping,
  readCatalogueBarcodeEvidence,
  sha256CanonicalJson,
  validateCatalogueRecord,
  verifyCnfParserReport,
} from "../src/index.js";

type MutableJsonObject = { [key: string]: JsonValue };

const SOURCE_HASH = "a".repeat(64);
const RECORD_KEY = "FDC:2026-04-30:Foundation:123";
const POLICY: BatchValidationPolicy = {
  maximumExcludedNutrientFraction: 0,
  maximumQuarantineFraction: 0.1,
  maximumQuarantinedRecords: 100,
  requireAtLeastOneValidRecord: true,
  requireDistinctApprovalPrincipals: true,
  requireMaterializedNutrientPerValidRecord: true,
};

const PROTEIN_MAPPING: ReviewedCatalogueNutrientMapping = {
  canonicalUnit: "g",
  conversionMultiplier: "1.000000000000",
  mappingRevisionId: "revision:protein:1",
  nutrientCode: "protein",
  nutrientId: "1",
  sourceNutrientId: "1003",
  sourceUnit: "g",
};

const CNF_TABLE_CONTRACT = [
  ["Food_Name.csv", "adapter-input", null],
  ["Food_Source.csv", "reference-only", "food_source_reference_not_materialized_v1"],
  ["CNF_Food_Group.csv", "reference-only", "upstream_food_group_taxonomy_not_materialized_v1"],
  ["Nutrient_Amount.csv", "adapter-input", null],
  ["Nutrient_Name.csv", "adapter-input", null],
  ["Nutrient_Source.csv", "reference-only", "nutrient_source_lookup_not_materialized_v1"],
  ["Measure_Weight_Conversion.csv", "adapter-input", null],
  ["Measure_Type.csv", "reference-only", "measure_type_lookup_not_materialized_v1"],
  ["Measure_Name.csv", "adapter-input", null],
] as const;

function cnfParserEvidenceFixture(): {
  readonly counts: {
    readonly emittedNutrientCount: number;
    readonly emittedPortionCount: number;
    readonly emittedRecordCount: number;
    readonly excludedNutrientCount: number;
    readonly excludedPortionCount: number;
    readonly excludedRecordCount: number;
    readonly sourceNutrientCount: number;
    readonly sourcePortionCount: number;
    readonly sourceRecordCount: number;
  };
  readonly report: JsonObject;
} {
  const expectedFiles = CNF_TABLE_CONTRACT.map(([archivePath]) => archivePath).sort();
  const tables = CNF_TABLE_CONTRACT.map(([archivePath, disposition, referenceOnlyReason]) => ({
    archivePath,
    byteSize: 10,
    disposition,
    headerSha256: sha256CanonicalJson(["Code"]),
    headers: ["Code"],
    rawSha256: "2".repeat(64),
    referenceOnlyReason,
    rowCount: 1,
    rowsSha256: "3".repeat(64),
  }));
  const exclusions = {
    measures: [],
    nutrients: [],
    records: [],
    skippedMeasures: [],
  };
  const exclusionReasonCounts = {};
  const rowDispositions = {
    foodNames: [{ disposition: "emitted", sourceIndex: 0 }],
    measureWeightConversions: [{ disposition: "emitted", sourceIndex: 0 }],
    nutrientAmounts: [{ disposition: "emitted", sourceIndex: 0 }],
  };
  const counts = {
    emittedNutrientCount: 1,
    emittedPortionCount: 1,
    emittedRecordCount: 1,
    excludedNutrientCount: 0,
    excludedPortionCount: 0,
    excludedRecordCount: 0,
    sourceNutrientCount: 1,
    sourcePortionCount: 1,
    sourceRecordCount: 1,
  };
  return {
    counts,
    report: {
      actor: {
        authenticationMethod: "oidc",
        principalId: "service:cnf-release",
        runReference: "https://runner.example/runs/123",
      },
      archive: {
        expectedFiles,
        inventoryCount: expectedFiles.length,
        inventorySha256: sha256CanonicalJson(expectedFiles),
      },
      artifactSha256: "4".repeat(64),
      exclusionReasonCounts,
      exclusions,
      metrics: {
        acceptedSourcePayloadSha256: "5".repeat(64),
        bilingualDescriptionCount: 1,
        emittedNutrientCount: 1,
        emittedPortionCount: 1,
        emittedRecordCount: 1,
        englishOnlyDescriptionCount: 0,
        excludedMeasureCount: 0,
        excludedNutrientCount: 0,
        exclusionReasonCountsSha256: sha256CanonicalJson(exclusionReasonCounts),
        frenchOnlyDescriptionCount: 0,
        missingBothDescriptionCount: 0,
        quarantinedRecordCount: 0,
        rowDispositionsSha256: sha256CanonicalJson(rowDispositions),
        skippedMeasureCount: 0,
        sourceNutrientCount: 1,
        sourcePortionCount: 1,
        sourceRecordCount: 1,
        tableEvidenceSha256: sha256CanonicalJson(tables),
      },
      nutrientMappingDigest: "6".repeat(64),
      parserBuildSha256: "7".repeat(64),
      parserPackage: "@nutrition-tracker/ingestion",
      parserVersion: "0.1.0",
      releaseKey: "cnf-synthetic-2026",
      reportKind: "health-canada-cnf-stage-v1",
      rowDispositions,
      schemaVersion: 1,
      sourceCode: "HEALTH_CANADA_CNF",
      tables,
    },
  };
}

function addCnfExpectedFile(report: MutableJsonObject, archivePath: string): void {
  const archive = report.archive as MutableJsonObject;
  const expectedFiles = archive.expectedFiles as string[];
  expectedFiles.push(archivePath);
  expectedFiles.sort();
  archive.inventoryCount = expectedFiles.length;
  archive.inventorySha256 = sha256CanonicalJson(expectedFiles);
}

function foodPayload(overrides: Partial<JsonObject> = {}): JsonObject {
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
      sourceCode: "FDC",
      sourceDataType: "Foundation",
      sourceModifiedAt: "2026-04-30T00:00:00.000Z",
      sourceRecordId: "123",
    },
    sourcePayloadHash: SOURCE_HASH,
    unlistedNutrientPolicy: "unknown_not_reported",
    ...overrides,
  };
}

function validate(payload: JsonObject | null, mappings = [PROTEIN_MAPPING]) {
  return validateCatalogueRecord(
    payload,
    {
      canonicalPayloadSha256: sha256CanonicalJson(payload),
      expectedReleaseKey: "2026-04-30",
      expectedSourceCode: "FDC",
      sourcePayloadSha256: SOURCE_HASH,
      sourceRecordKey: RECORD_KEY,
      sourceRecordType: "Foundation",
    },
    new Map(mappings.map((mapping) => [mapping.sourceNutrientId, mapping])),
  );
}

describe("CNF immutable parser evidence", () => {
  it("accepts the exact nine-table schema with conserved typed counts", () => {
    const fixture = cnfParserEvidenceFixture();
    expect(() => verifyCnfParserReport(fixture.report, fixture.counts)).not.toThrow();
  });

  it.each([
    {
      name: "a missing table",
      mutate: (report: MutableJsonObject) => {
        (report.tables as MutableJsonObject[]).pop();
      },
    },
    {
      name: "an undeclared CSV",
      mutate: (report: MutableJsonObject) => {
        const archive = report.archive as MutableJsonObject;
        const expectedFiles = archive.expectedFiles as string[];
        expectedFiles.push("Unexpected.csv");
        expectedFiles.sort();
        archive.inventoryCount = expectedFiles.length;
        archive.inventorySha256 = sha256CanonicalJson(expectedFiles);
      },
    },
    {
      name: "a typed count mismatch",
      mutate: (report: MutableJsonObject) => {
        (report.metrics as MutableJsonObject).emittedNutrientCount = 0;
      },
    },
    {
      name: "a different parser package",
      mutate: (report: MutableJsonObject) => {
        report.parserPackage = "unreviewed-parser";
      },
    },
    {
      name: "a non-partitioning description count",
      mutate: (report: MutableJsonObject) => {
        (report.metrics as MutableJsonObject).bilingualDescriptionCount = 0;
      },
    },
    {
      name: "changed headers with a recomputed table digest but stale header digest",
      mutate: (report: MutableJsonObject) => {
        const tables = report.tables as MutableJsonObject[];
        const firstTable = tables[0];
        if (!firstTable) throw new Error("fixture is missing its first CNF table");
        firstTable.headers = ["Different_Code"];
        (report.metrics as MutableJsonObject).tableEvidenceSha256 = sha256CanonicalJson(tables);
      },
    },
    {
      name: "a changed exclusion array without its digest",
      mutate: (report: MutableJsonObject) => {
        const exclusions = report.exclusions as MutableJsonObject;
        exclusions.skippedMeasures = [
          {
            foodCode: "101",
            measureCode: "750",
            measureTypeCode: "3",
            reason: "non_user_facing_refuse",
            sourceIndex: 0,
            sourcePayloadHash: "8".repeat(64),
          },
        ];
        const metrics = report.metrics as MutableJsonObject;
        metrics.skippedMeasureCount = 1;
        metrics.sourcePortionCount = 2;
      },
    },
  ])("rejects $name", ({ mutate }) => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    mutate(report);
    expect(() => verifyCnfParserReport(report, fixture.counts)).toThrow();
  });

  it.each(["C:guide.txt", "z:guide.txt"])(
    "rejects drive-prefixed archive inventory path %s",
    (archivePath) => {
      const fixture = cnfParserEvidenceFixture();
      const report = structuredClone(fixture.report) as MutableJsonObject;
      addCnfExpectedFile(report, archivePath);

      expect(() => verifyCnfParserReport(report, fixture.counts)).toThrow("unsafe archive path");
    },
  );

  it.each([...Array.from({ length: 32 }, (_, codePoint) => codePoint), 0x7f])(
    "rejects archive inventory path containing control code point %i",
    (codePoint) => {
      const fixture = cnfParserEvidenceFixture();
      const report = structuredClone(fixture.report) as MutableJsonObject;
      addCnfExpectedFile(report, `guide-${String.fromCodePoint(codePoint)}.txt`);

      expect(() => verifyCnfParserReport(report, fixture.counts)).toThrow("unsafe archive path");
    },
  );

  it("rejects a misspelled child exclusion code even when counts and digests are consistent", () => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.nutrients = [
      {
        code: "INVALID_REOCRD",
        foodCode: "101",
        message: "synthetic exclusion",
        sourceIndex: 0,
        sourcePayloadHash: "8".repeat(64),
      },
    ];
    const reasonCounts = { "nutrient:INVALID_REOCRD": 1 };
    report.exclusionReasonCounts = reasonCounts;
    const rowDispositions = report.rowDispositions as MutableJsonObject;
    rowDispositions.nutrientAmounts = [{ disposition: "excluded", sourceIndex: 0 }];
    const metrics = report.metrics as MutableJsonObject;
    metrics.emittedNutrientCount = 0;
    metrics.excludedNutrientCount = 1;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    metrics.rowDispositionsSha256 = sha256CanonicalJson(rowDispositions);
    const counts = {
      ...fixture.counts,
      emittedNutrientCount: 0,
      excludedNutrientCount: 1,
    };

    expect(() => verifyCnfParserReport(report, counts)).toThrow(
      "outside the reviewed CNF parser v1 taxonomy",
    );
  });

  it("rejects a misspelled record exclusion code even when counts and digests are consistent", () => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.records = [
      {
        code: "DUPLCIATE_KEY",
        message: "synthetic quarantine",
        sourceIndex: 0,
        sourcePayloadHash: "8".repeat(64),
        sourceRecordId: "101",
      },
    ];
    const reasonCounts = { "record:DUPLCIATE_KEY": 1 };
    report.exclusionReasonCounts = reasonCounts;
    const rowDispositions = report.rowDispositions as MutableJsonObject;
    rowDispositions.foodNames = [{ disposition: "quarantined", sourceIndex: 0 }];
    const metrics = report.metrics as MutableJsonObject;
    metrics.emittedRecordCount = 0;
    metrics.quarantinedRecordCount = 1;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    metrics.rowDispositionsSha256 = sha256CanonicalJson(rowDispositions);
    const counts = {
      ...fixture.counts,
      emittedRecordCount: 0,
      excludedRecordCount: 1,
    };

    expect(() => verifyCnfParserReport(report, counts)).toThrow(
      "outside the reviewed CNF parser v1 taxonomy",
    );
  });

  it("rejects an out-of-range nutrient exclusion source index", () => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.nutrients = [
      {
        code: "INVALID_RECORD",
        foodCode: "101",
        message: "synthetic exclusion",
        sourceIndex: 1,
        sourcePayloadHash: "8".repeat(64),
      },
    ];
    const reasonCounts = { "nutrient:INVALID_RECORD": 1 };
    report.exclusionReasonCounts = reasonCounts;
    const metrics = report.metrics as MutableJsonObject;
    metrics.emittedNutrientCount = 0;
    metrics.excludedNutrientCount = 1;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    const counts = {
      ...fixture.counts,
      emittedNutrientCount: 0,
      excludedNutrientCount: 1,
    };

    expect(() => verifyCnfParserReport(report, counts)).toThrow("unique and in range");
  });

  it("rejects an out-of-range quarantined-record source index", () => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.records = [
      {
        code: "INVALID_RECORD",
        message: "synthetic quarantine",
        sourceIndex: 1,
        sourcePayloadHash: "8".repeat(64),
        sourceRecordId: "101",
      },
    ];
    const reasonCounts = { "record:INVALID_RECORD": 1 };
    report.exclusionReasonCounts = reasonCounts;
    const metrics = report.metrics as MutableJsonObject;
    metrics.emittedRecordCount = 0;
    metrics.quarantinedRecordCount = 1;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    const counts = {
      ...fixture.counts,
      emittedRecordCount: 0,
      excludedRecordCount: 1,
    };

    expect(() => verifyCnfParserReport(report, counts)).toThrow("unique and in range");
  });

  it("rejects a measure source index shared by exclusion and skip evidence", () => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.measures = [
      {
        code: "INVALID_RECORD",
        foodCode: "101",
        message: "synthetic exclusion",
        sourceIndex: 0,
        sourcePayloadHash: "8".repeat(64),
      },
    ];
    exclusions.skippedMeasures = [
      {
        foodCode: "101",
        measureCode: "750",
        measureTypeCode: "3",
        reason: "non_user_facing_refuse",
        sourceIndex: 0,
        sourcePayloadHash: "9".repeat(64),
      },
    ];
    const reasonCounts = {
      "measure:INVALID_RECORD": 1,
      "skipped-measure:non_user_facing_refuse": 1,
    };
    report.exclusionReasonCounts = reasonCounts;
    const metrics = report.metrics as MutableJsonObject;
    metrics.emittedPortionCount = 0;
    metrics.excludedMeasureCount = 1;
    metrics.skippedMeasureCount = 1;
    metrics.sourcePortionCount = 2;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    const tables = report.tables as MutableJsonObject[];
    const measureTable = tables.find(
      (table) => table.archivePath === "Measure_Weight_Conversion.csv",
    );
    if (!measureTable) throw new Error("fixture is missing its CNF measure table");
    measureTable.rowCount = 2;
    metrics.tableEvidenceSha256 = sha256CanonicalJson(tables);
    const counts = {
      ...fixture.counts,
      emittedPortionCount: 0,
      excludedPortionCount: 2,
      sourcePortionCount: 2,
    };

    expect(() => verifyCnfParserReport(report, counts)).toThrow("disjoint, unique, and in range");
  });

  it.each([
    ["3", "unsupported_measure_type"],
    ["9", "non_user_facing_refuse"],
    ["6", "unsupported_measure_type"],
    ["7", "non_user_facing_refuse"],
  ] as const)("rejects skipped measure type %s with reason %s", (measureTypeCode, reason) => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.skippedMeasures = [
      {
        foodCode: "101",
        measureCode: "750",
        measureTypeCode,
        reason,
        sourceIndex: 0,
        sourcePayloadHash: "8".repeat(64),
      },
    ];
    const reasonCounts = { [`skipped-measure:${reason}`]: 1 };
    report.exclusionReasonCounts = reasonCounts;
    const rowDispositions = report.rowDispositions as MutableJsonObject;
    rowDispositions.measureWeightConversions = [{ disposition: "skipped", sourceIndex: 0 }];
    const metrics = report.metrics as MutableJsonObject;
    metrics.emittedPortionCount = 0;
    metrics.skippedMeasureCount = 1;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    metrics.rowDispositionsSha256 = sha256CanonicalJson(rowDispositions);
    const counts = {
      ...fixture.counts,
      emittedPortionCount: 0,
      excludedPortionCount: 1,
    };

    expect(() => verifyCnfParserReport(report, counts)).toThrow("type/reason mapping");
  });

  it("accepts a non-serving measure type only with unsupported_measure_type", () => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.skippedMeasures = [
      {
        foodCode: "101",
        measureCode: "750",
        measureTypeCode: "7",
        reason: "unsupported_measure_type",
        sourceIndex: 0,
        sourcePayloadHash: "8".repeat(64),
      },
    ];
    const reasonCounts = { "skipped-measure:unsupported_measure_type": 1 };
    report.exclusionReasonCounts = reasonCounts;
    const rowDispositions = report.rowDispositions as MutableJsonObject;
    rowDispositions.measureWeightConversions = [{ disposition: "skipped", sourceIndex: 0 }];
    const metrics = report.metrics as MutableJsonObject;
    metrics.emittedPortionCount = 0;
    metrics.skippedMeasureCount = 1;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    metrics.rowDispositionsSha256 = sha256CanonicalJson(rowDispositions);
    const counts = {
      ...fixture.counts,
      emittedPortionCount: 0,
      excludedPortionCount: 1,
    };

    expect(() => verifyCnfParserReport(report, counts)).not.toThrow();
  });

  it("rejects a complete-looking partition whose excluded index disagrees with evidence", () => {
    const fixture = cnfParserEvidenceFixture();
    const report = structuredClone(fixture.report) as MutableJsonObject;
    const exclusions = report.exclusions as MutableJsonObject;
    exclusions.nutrients = [
      {
        code: "INVALID_RECORD",
        foodCode: "101",
        message: "synthetic exclusion",
        sourceIndex: 0,
        sourcePayloadHash: "8".repeat(64),
      },
    ];
    const reasonCounts = { "nutrient:INVALID_RECORD": 1 };
    report.exclusionReasonCounts = reasonCounts;
    const rowDispositions = report.rowDispositions as MutableJsonObject;
    rowDispositions.nutrientAmounts = [
      { disposition: "emitted", sourceIndex: 0 },
      { disposition: "excluded", sourceIndex: 1 },
    ];
    const metrics = report.metrics as MutableJsonObject;
    metrics.excludedNutrientCount = 1;
    metrics.sourceNutrientCount = 2;
    metrics.exclusionReasonCountsSha256 = sha256CanonicalJson(reasonCounts);
    metrics.rowDispositionsSha256 = sha256CanonicalJson(rowDispositions);
    const tables = report.tables as MutableJsonObject[];
    const nutrientTable = tables.find((table) => table.archivePath === "Nutrient_Amount.csv");
    if (!nutrientTable) throw new Error("fixture is missing its CNF nutrient table");
    nutrientTable.rowCount = 2;
    metrics.tableEvidenceSha256 = sha256CanonicalJson(tables);
    const counts = {
      ...fixture.counts,
      excludedNutrientCount: 1,
      sourceNutrientCount: 2,
    };

    expect(() => verifyCnfParserReport(report, counts)).toThrow(
      "excluded dispositions do not match exclusion evidence",
    );
  });
});

describe("catalogue record validation", () => {
  it("streams byte-identical canonical JSON and SHA-256 evidence", () => {
    const value: JsonObject = {
      astral: "food 🫐",
      control: 'line\nquote"',
      nested: { z: null, a: [true, -0, "é"] },
    };
    const chunks = [...canonicalJsonChunks(value)];
    const streamedHash = createHash("sha256");
    for (const chunk of chunks) streamedHash.update(chunk, "utf8");

    expect(chunks.join("")).toBe(canonicalJson(value));
    expect(streamedHash.digest("hex")).toBe(sha256CanonicalJson(value));
    expect(canonicalJson(value)).toBe(
      '{"astral":"food 🫐","control":"line\\nquote\\"","nested":{"a":[true,0,"é"],"z":null}}',
    );
  });

  it("streams large canonical documents without changing their bytes or digest", () => {
    const value: JsonObject = {
      rows: Array.from({ length: 10_000 }, (_, index) => ({ index, value: `row-${index}` })),
      scalar: "x".repeat(128 * 1_024 + 1),
    };
    const chunks = [...canonicalJsonChunks(value)];
    const streamedHash = createHash("sha256");
    for (const chunk of chunks) streamedHash.update(chunk, "utf8");

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join("")).toBe(canonicalJson(value));
    expect(streamedHash.digest("hex")).toBe(sha256CanonicalJson(value));
  });

  it("normalizes retained barcode evidence through the validation text path", () => {
    expect(
      readCatalogueBarcodeEvidence(
        foodPayload({
          identity: {
            brandOwner: null,
            description: "Oats",
            descriptionFr: null,
            gtin: "  00000000000017  ",
          },
          source: {
            ...(foodPayload().source as JsonObject),
            marketCode: "US",
            sourceRecordId: " 123 ",
          },
        }),
      ),
    ).toEqual({
      marketCode: "US",
      normalizedGtin: "00000000000017",
      rawValue: "00000000000017",
      sourceFoodKey: "123",
    });
    expect(
      readCatalogueBarcodeEvidence(
        foodPayload({
          identity: {
            brandOwner: null,
            description: "Oats",
            descriptionFr: null,
            gtin: "  ba\u0301d   value  ",
          },
        }),
      ),
    ).toMatchObject({ normalizedGtin: null, rawValue: "bád value" });
    expect(
      readCatalogueBarcodeEvidence(
        foodPayload({
          identity: {
            brandOwner: null,
            description: "Oats",
            descriptionFr: null,
            gtin: "00000000000017",
          },
          source: { ...(foodPayload().source as JsonObject), marketCode: "us" },
        }),
      ),
    ).toMatchObject({ marketCode: null, normalizedGtin: "00000000000017" });
  });

  it("accepts a nutrient-bearing food with no source portions", () => {
    const result = validate(foodPayload());

    expect(result.recordIsValid).toBe(true);
    expect(result.food?.servings).toEqual([]);
    expect(result.food?.nutrients).toHaveLength(1);
    expect(result.nutrientMaterializableCount).toBe(1);
  });

  it("quarantines a non-object top-level record without losing its checksum identity", () => {
    const result = validate(null);

    expect(result.recordIsValid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("RECORD_NOT_OBJECT");
  });

  it("excludes null and negative nutrient amounts granularly instead of rejecting the food", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: "protein",
          canonicalUnit: "g",
          originalUnit: "g",
          provenance: { dataPoints: null, derivationCode: null },
          sourceName: "Protein null",
          sourceNutrientId: "1003-null",
          value: { amount: null, quality: "measured", state: "known" },
        },
        {
          canonicalNutrientId: "carbohydrate",
          canonicalUnit: "g",
          originalUnit: "g",
          provenance: { dataPoints: null, derivationCode: null },
          sourceName: "Carbohydrate",
          sourceNutrientId: "1005",
          value: { amount: "-0.1", quality: "measured", state: "known" },
        },
        ...(foodPayload().nutrients as readonly JsonObject[]),
      ],
    });
    const nullMapping = { ...PROTEIN_MAPPING, sourceNutrientId: "1003-null" };
    const carbohydrateMapping = {
      ...PROTEIN_MAPPING,
      nutrientCode: "carbohydrate",
      nutrientId: "2",
      sourceNutrientId: "1005",
    };
    const result = validate(payload, [nullMapping, carbohydrateMapping, PROTEIN_MAPPING]);

    expect(result.recordIsValid).toBe(true);
    expect(result.food?.nutrients).toHaveLength(1);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NUTRIENT_NULL_AMOUNT", "NUTRIENT_NEGATIVE_AMOUNT"]),
    );
    expect(result.excludedNutrientCount).toBe(2);
  });

  it("ignores a staged mapping proposal and resolves solely through the reviewed registry", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: null,
          canonicalUnit: null,
          originalUnit: "g",
          provenance: { dataPoints: 1, derivationCode: null },
          sourceName: "Protein",
          sourceNutrientId: "1003",
          value: { amount: "12.5", quality: "measured", state: "known" },
        },
      ],
    });
    const result = validate(payload);

    expect(result.recordIsValid).toBe(true);
    expect(result.food?.nutrients[0]).toMatchObject({
      canonicalUnit: "g",
      nutrientCode: "protein",
    });
    expect(result.issues).toEqual([]);
  });

  it("rejects non-positive FDC IDs and duplicate canonical source-food identities", () => {
    const nonPositive = foodPayload({
      idempotencyKey: "FDC:2026-04-30:Foundation:0",
      source: {
        ...(foodPayload().source as JsonObject),
        sourceRecordId: "0",
      },
    });
    const nonPositiveResult = validateCatalogueRecord(
      nonPositive,
      {
        canonicalPayloadSha256: sha256CanonicalJson(nonPositive),
        expectedReleaseKey: "2026-04-30",
        expectedSourceCode: "FDC",
        sourcePayloadSha256: SOURCE_HASH,
        sourceRecordKey: "FDC:2026-04-30:Foundation:0",
        sourceRecordType: "Foundation",
      },
      new Map([[PROTEIN_MAPPING.sourceNutrientId, PROTEIN_MAPPING]]),
    );
    const duplicateResult = validateCatalogueRecord(
      foodPayload(),
      {
        canonicalPayloadSha256: sha256CanonicalJson(foodPayload()),
        expectedReleaseKey: "2026-04-30",
        expectedSourceCode: "FDC",
        sourcePayloadSha256: SOURCE_HASH,
        sourceRecordKey: RECORD_KEY,
        sourceRecordType: "Foundation",
      },
      new Map([[PROTEIN_MAPPING.sourceNutrientId, PROTEIN_MAPPING]]),
      new Set(),
      new Set(["123"]),
    );

    expect(nonPositiveResult.issues.map((issue) => issue.code)).toContain(
      "FDC_ID_NOT_POSITIVE_INTEGER",
    );
    expect(duplicateResult.issues.map((issue) => issue.code)).toContain(
      "DUPLICATE_SOURCE_FOOD_KEY",
    );
    expect(duplicateResult.recordIsValid).toBe(false);
  });

  it("excludes nutrients with malformed derivation provenance", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: null,
          canonicalUnit: null,
          originalUnit: "g",
          provenance: { dataPoints: -1, derivationCode: "analytical" },
          sourceName: "Protein",
          sourceNutrientId: "1003",
          value: { amount: "12.5", quality: "measured", state: "known" },
        },
      ],
    });

    const result = validate(payload);
    expect(result.recordIsValid).toBe(true);
    expect(result.food?.nutrients).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain("NUTRIENT_PROVENANCE_INVALID");
  });

  it("fails promotion policy when every nutrient is unmapped or excluded", () => {
    const result = validate(foodPayload(), []);
    const record: BatchRecordValidation = {
      canonicalPayloadSha256: "b".repeat(64),
      excludedNutrientCount: result.excludedNutrientCount,
      issues: result.issues,
      nutrientInputCount: result.nutrientInputCount,
      nutrientMaterializableCount: result.nutrientMaterializableCount,
      portionInputCount: result.portionInputCount,
      sourceRecordKey: RECORD_KEY,
      status: "valid",
    };

    expect(evaluateBatchPolicy([record], POLICY)).toMatchObject({
      nutrientMaterializableCount: 0,
      promotionEligible: false,
    });
  });

  it("preserves trace source name and unit in canonical metadata", () => {
    const payload = foodPayload({
      nutrients: [
        {
          canonicalNutrientId: "protein",
          canonicalUnit: "g",
          originalUnit: "g",
          provenance: { dataPoints: null, derivationCode: "analytical" },
          sourceName: "Protein, trace",
          sourceNutrientId: "1003",
          value: { detectionLimit: "0.01", state: "trace" },
        },
      ],
    });

    expect(validate(payload).food?.nutrients[0]).toMatchObject({
      metadata: { sourceName: "Protein, trace", sourceUnit: "g" },
      valueStatus: "trace",
    });
  });

  it("counts parser-rejected source records outside the staged-row denominator", () => {
    const result = validate(foodPayload());
    const emittedRecord: BatchRecordValidation = {
      canonicalPayloadSha256: "c".repeat(64),
      excludedNutrientCount: 0,
      issues: result.issues,
      nutrientInputCount: 1,
      nutrientMaterializableCount: 1,
      portionInputCount: 0,
      sourceRecordKey: RECORD_KEY,
      status: "valid",
    };
    const records = Array.from({ length: 363 }, (_, index) => ({
      ...emittedRecord,
      sourceRecordKey: `${RECORD_KEY}:${index}`,
    }));

    expect(
      evaluateBatchPolicy(records, POLICY, {
        emittedNutrientCount: 363,
        emittedPortionCount: 0,
        emittedRecordCount: 363,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 32,
        sourceNutrientCount: 363,
        sourcePortionCount: 0,
        sourceRecordCount: 395,
      }),
    ).toMatchObject({
      promotionEligible: true,
      quarantinedCount: 32,
      validCount: 363,
    });
  });
});
