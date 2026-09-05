import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adaptFdcJsonRelease,
  canonicalJson,
  type ExtractedZipFile,
  type FoodSourceManifestV4,
  sha256CanonicalJson,
} from "@nutrition-tracker/ingestion";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type CommandIo, readExactFdcJsonMember, runCommand } from "../src/run.js";
import {
  bindSyntheticReleaseEvidence,
  SYNTHETIC_EVIDENCE_EVALUATED_AT,
  SYNTHETIC_EVIDENCE_EXPIRED_AT,
  type SyntheticEvidenceRunner,
  type SyntheticReleaseEvidenceFixture,
  writeCanonicalReleaseEvidence,
} from "./synthetic-release-evidence.js";

const databaseOpenAttempt = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("DATABASE_OPEN_CALLED");
  }),
);
vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: databaseOpenAttempt,
}));

beforeEach(() => {
  databaseOpenAttempt.mockClear();
});

const FOUNDATION_MANIFEST_PATH = join(
  import.meta.dirname,
  "../../../data/manifests/usda-fdc-foundation-json-2026-04-30.candidate.json",
);
const FDC_MEMBER = "synthetic-foundation.json";
const FDC_RELEASE_KEY = "fdc-inspect-synthetic";
const PARSER_BUILD_SHA256 = "b".repeat(64);
const FDC_EVIDENCE_RUNNER: SyntheticEvidenceRunner = Object.freeze({
  authenticationMethod: "oidc",
  principalId: "service:fdc-release",
  runId: "fdc-cli-evidence-test",
  runReference: "urn:nutrition-tracker:test:fdc-cli-evidence-test",
});
const FDC_JSON_DOCUMENT = Object.freeze({
  FoundationFoods: [
    Object.freeze({
      dataType: "Foundation",
      description: "Synthetic apple",
      fdcId: 123,
      foodNutrients: [
        Object.freeze({
          amount: 0,
          dataPoints: 1,
          foodNutrientDerivation: Object.freeze({ code: "A" }),
          nutrient: Object.freeze({ id: 1003, name: "Protein", unitName: "G" }),
        }),
      ],
      foodPortions: [
        Object.freeze({
          amount: 1,
          gramWeight: 100,
          id: 9,
          measureUnit: Object.freeze({ name: "serving" }),
          modifier: "",
        }),
      ],
      publicationDate: "4/1/2019",
    }),
  ],
});
const FDC_JSON_BYTES = Buffer.from(`${JSON.stringify(FDC_JSON_DOCUMENT)}\n`);
const FDC_PARSED = adaptFdcJsonRelease(FDC_JSON_DOCUMENT, { releaseKey: FDC_RELEASE_KEY });
const FDC_METRICS = Object.freeze({
  excludedAttributes: FDC_PARSED.excludedAttributes.length,
  excludedNutrients: FDC_PARSED.excludedNutrients.length,
  excludedPortions: FDC_PARSED.excludedPortions.length,
  quarantined: FDC_PARSED.quarantined.length,
  records: FDC_PARSED.records.length,
  sourcePayloadDigest: hashRecordDigests(
    FDC_PARSED.records.map((record) => record.sourcePayloadHash),
  ),
  stagedNutrients: FDC_PARSED.records.reduce((count, record) => count + record.nutrients.length, 0),
  stagedPortions: FDC_PARSED.records.reduce((count, record) => count + record.servings.length, 0),
});
const FDC_SEMANTIC_CORE = Object.freeze({
  canonicalAcceptedRecords: evidenceDigest(FDC_PARSED.records),
  orderedDispositions: Object.freeze({
    excludedAttributes: evidenceDigest(FDC_PARSED.excludedAttributes),
    excludedNutrients: evidenceDigest(FDC_PARSED.excludedNutrients),
    excludedPortions: evidenceDigest(FDC_PARSED.excludedPortions),
    quarantined: evidenceDigest(FDC_PARSED.quarantined),
  }),
  schemaVersion: 1,
});
const FDC_SEMANTIC = Object.freeze({
  ...FDC_SEMANTIC_CORE,
  sha256: sha256CanonicalJson(FDC_SEMANTIC_CORE),
});
const FDC_BASELINE = Object.freeze({
  parserBaselineAcceptedFoodCount: FDC_METRICS.records,
  parserBaselineCanonicalAcceptedRecordsDigest: FDC_SEMANTIC.canonicalAcceptedRecords.sha256,
  parserBaselineQuarantinedFoodCount: FDC_METRICS.quarantined,
  parserBaselineStagedNutrientCount: FDC_METRICS.stagedNutrients,
  parserBaselineExcludedNutrientCount: FDC_METRICS.excludedNutrients,
  parserBaselineStagedPortionCount: FDC_METRICS.stagedPortions,
  parserBaselineExcludedPortionCount: FDC_METRICS.excludedPortions,
  parserBaselineExcludedAttributeCount: FDC_METRICS.excludedAttributes,
  parserBaselineAcceptedPayloadDigest: FDC_METRICS.sourcePayloadDigest,
  parserBaselineOrderedQuarantinedDispositionsDigest:
    FDC_SEMANTIC.orderedDispositions.quarantined.sha256,
  parserBaselineOrderedExcludedNutrientDispositionsDigest:
    FDC_SEMANTIC.orderedDispositions.excludedNutrients.sha256,
  parserBaselineOrderedExcludedPortionDispositionsDigest:
    FDC_SEMANTIC.orderedDispositions.excludedPortions.sha256,
  parserBaselineOrderedExcludedAttributeDispositionsDigest:
    FDC_SEMANTIC.orderedDispositions.excludedAttributes.sha256,
  parserBaselineSemanticEvidenceDigest: FDC_SEMANTIC.sha256,
});

interface FdcInspectionFixture {
  readonly artifactByteSize: number;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly manifest: FoodSourceManifestV4;
  readonly manifestPath: string;
  readonly root: string;
}

describe("FDC evidence-only inspection boundary", () => {
  it("rejects non-exact arguments and caller-authored authority before manifest access", async () => {
    const exact = inspectArguments(
      FOUNDATION_MANIFEST_PATH,
      "/artifact-must-not-be-read.zip",
      "/cache-must-not-be-created",
      "/extract-must-not-be-created",
    );
    const withoutArtifact = exact.filter((_value, index) => index !== 3 && index !== 4);
    const blankCacheDirectory = exact.filter((_value, index) => index !== 6);
    blankCacheDirectory[5] = "--cache-dir=";
    const cases = [
      {
        args: [...exact, "--actor", "caller-authored"],
        expected: "Unknown fdc inspect option: --actor",
      },
      {
        args: [...exact, "--__proto__=caller-authored"],
        expected: "Unknown fdc inspect option: --__proto__",
      },
      {
        args: [...exact, "extra-position"],
        expected: "fdc inspect requires exactly one manifest path",
      },
      {
        args: withoutArtifact,
        expected: "--artifact requires a non-blank value",
      },
      {
        args: [...exact, "--artifact", "/second-artifact.zip"],
        expected: "Invalid or repeated option",
      },
      {
        args: blankCacheDirectory,
        expected: "Option --cache-dir requires a value",
      },
    ];

    for (const testCase of cases) {
      const result = commandIo();
      expect(await runCommand(testCase.args, result.io)).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain(testCase.expected);
      expect(result.errors.join("\n")).not.toContain("ENOENT");
    }
  });

  it("rejects a template whose artifact identity is not pinned", async () => {
    const fixture = await createFixture();
    try {
      const manifestPath = await writeManifest(fixture.root, "unpinned.json", {
        ...fixture.manifest,
        artifact: {
          ...fixture.manifest.artifact,
          byteSize: null,
          sha256: null,
        },
      });
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      expect(
        await runCommand(
          inspectArguments(
            manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-unpinned"),
            join(fixture.root, "extract-unpinned"),
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain("Manifest artifact.sha256 is not pinned");

      const missingByteSizePath = await writeManifest(fixture.root, "missing-byte-size.json", {
        ...fixture.manifest,
        artifact: {
          ...fixture.manifest.artifact,
          byteSize: null,
        },
      });
      const missingByteSize = commandIo({
        INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256,
      });
      expect(
        await runCommand(
          inspectArguments(
            missingByteSizePath,
            fixture.artifactPath,
            join(fixture.root, "cache-missing-byte-size"),
            join(fixture.root, "extract-missing-byte-size"),
          ),
          missingByteSize.io,
        ),
      ).toBe(1);
      expect(missingByteSize.output).toEqual([]);
      expect(missingByteSize.errors.join("\n")).toContain(
        "Manifest artifact.byteSize must be a pinned positive safe integer",
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a stale manifest parser version before reading the artifact", async () => {
    const fixture = await createFixture();
    try {
      const manifestPath = await writeManifest(fixture.root, "stale-parser.json", {
        ...fixture.manifest,
        ingestion: {
          ...fixture.manifest.ingestion,
          parserVersion: "0.0.0-stale",
        },
      });
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      expect(
        await runCommand(
          inspectArguments(
            manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-stale-parser"),
            join(fixture.root, "extract-stale-parser"),
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        "Manifest parser identity does not match the executing ingestion package",
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a runtime parser build that differs from the manifest pin", async () => {
    const fixture = await createFixture();
    try {
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: "c".repeat(64) });

      expect(
        await runCommand(
          inspectArguments(
            fixture.manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-parser-build"),
            join(fixture.root, "extract-parser-build"),
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        "Executing parser build digest does not match the reviewed manifest",
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("requires a present canonical runtime parser-build digest", async () => {
    const fixture = await createFixture();
    try {
      const cases: readonly {
        readonly environment: NodeJS.ProcessEnv;
        readonly expected: string;
      }[] = [
        {
          environment: {},
          expected:
            "INGEST_PARSER_BUILD_SHA256 must be non-blank text without surrounding whitespace",
        },
        {
          environment: { INGEST_PARSER_BUILD_SHA256: "A".repeat(64) },
          expected: "INGEST_PARSER_BUILD_SHA256 must be a lowercase SHA-256 digest",
        },
      ];

      for (const testCase of cases) {
        const result = commandIo(testCase.environment);
        expect(
          await runCommand(
            inspectArguments(
              fixture.manifestPath,
              fixture.artifactPath,
              join(fixture.root, "cache-invalid-parser-build"),
              join(fixture.root, "extract-invalid-parser-build"),
            ),
            result.io,
          ),
        ).toBe(1);
        expect(result.output).toEqual([]);
        expect(result.errors.join("\n")).toContain(testCase.expected);
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an artifact whose SHA-256 differs from the manifest pin", async () => {
    const fixture = await createFixture();
    try {
      const mismatchedSha256 =
        fixture.artifactSha256 === "a".repeat(64) ? "c".repeat(64) : "a".repeat(64);
      const manifestPath = await writeManifest(fixture.root, "wrong-sha256.json", {
        ...fixture.manifest,
        artifact: { ...fixture.manifest.artifact, sha256: mismatchedSha256 },
      });
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      expect(
        await runCommand(
          inspectArguments(
            manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-wrong-sha256"),
            join(fixture.root, "extract-wrong-sha256"),
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain("Artifact does not match its pinned expectation");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an artifact whose byte size differs from the manifest pin", async () => {
    const fixture = await createFixture();
    try {
      const manifestPath = await writeManifest(fixture.root, "wrong-byte-size.json", {
        ...fixture.manifest,
        artifact: {
          ...fixture.manifest.artifact,
          byteSize: fixture.artifactByteSize + 1,
        },
      });
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      expect(
        await runCommand(
          inspectArguments(
            manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-wrong-byte-size"),
            join(fixture.root, "extract-wrong-byte-size"),
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain("Artifact does not match its pinned expectation");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an archive with an unmanifested regular file", async () => {
    const fixture = await createFixture([
      { data: FDC_JSON_BYTES, name: FDC_MEMBER },
      { data: Buffer.from("unexpected\n"), name: "unexpected.txt" },
    ]);
    try {
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      expect(
        await runCommand(
          inspectArguments(
            fixture.manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-unexpected-member"),
            join(fixture.root, "extract-unexpected-member"),
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        "ZIP file set must exactly match the expected members",
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an archive that omits the exact manifested JSON member", async () => {
    const fixture = await createFixture([
      { data: FDC_JSON_BYTES, name: "different-foundation.json" },
    ]);
    try {
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      expect(
        await runCommand(
          inspectArguments(
            fixture.manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-missing-member"),
            join(fixture.root, "extract-missing-member"),
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain("Archive is missing an expected file");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails closed on missing or drifted semantic baselines and retains private evidence", async () => {
    const fixture = await createFixture();
    try {
      const missingExpectations = { ...fixture.manifest.validation.releaseSpecificExpectations };
      delete missingExpectations.parserBaselineSemanticEvidenceDigest;
      const missingPath = await writeManifest(fixture.root, "missing-semantic-baseline.json", {
        ...fixture.manifest,
        validation: {
          ...fixture.manifest.validation,
          releaseSpecificExpectations: missingExpectations,
        },
      });
      const missingExtract = join(fixture.root, "extract-missing-semantic-baseline");
      const missing = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      expect(
        await runCommand(
          inspectArguments(
            missingPath,
            fixture.artifactPath,
            join(fixture.root, "cache-missing-semantic-baseline"),
            missingExtract,
          ),
          missing.io,
        ),
      ).toBe(1);
      expect(missing.output).toHaveLength(1);
      expect(missing.errors.join("\n")).toContain("parserBaselineSemanticEvidenceDigest");
      expect(JSON.parse(missing.output[0] ?? "null")).toMatchObject({
        baseline: FDC_BASELINE,
        baselineReview: {
          kind: "non-qualifying-local-baseline-comparison-v1",
          manifestExpectationsMatched: false,
          mismatches: [
            {
              actual: FDC_BASELINE.parserBaselineSemanticEvidenceDigest,
              expected: null,
              issue: "missing",
              key: "parserBaselineSemanticEvidenceDigest",
            },
          ],
          qualifiesAsAcquisitionOrApprovalEvidence: false,
          status: "review-required",
        },
      });
      const retainedDirectory = await lstat(missingExtract);
      const retainedMember = await lstat(join(missingExtract, FDC_MEMBER));
      expect(retainedDirectory.mode & 0o777).toBe(0o700);
      expect(retainedMember.mode & 0o777).toBe(0o600);
      expect(retainedMember.nlink).toBe(1);
      if (typeof process.getuid === "function") {
        expect(retainedDirectory.uid).toBe(process.getuid());
        expect(retainedMember.uid).toBe(process.getuid());
      }

      const driftedPath = await writeManifest(fixture.root, "drifted-semantic-baseline.json", {
        ...fixture.manifest,
        validation: {
          ...fixture.manifest.validation,
          releaseSpecificExpectations: {
            ...fixture.manifest.validation.releaseSpecificExpectations,
            parserBaselineCanonicalAcceptedRecordsDigest: "f".repeat(64),
          },
        },
      });
      const drifted = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });
      expect(
        await runCommand(
          inspectArguments(
            driftedPath,
            fixture.artifactPath,
            join(fixture.root, "cache-drifted-semantic-baseline"),
            join(fixture.root, "extract-drifted-semantic-baseline"),
          ),
          drifted.io,
        ),
      ).toBe(1);
      expect(drifted.output).toHaveLength(1);
      expect(drifted.errors.join("\n")).toContain("parserBaselineCanonicalAcceptedRecordsDigest");
      expect(JSON.parse(drifted.output[0] ?? "null")).toMatchObject({
        baseline: FDC_BASELINE,
        baselineReview: {
          manifestExpectationsMatched: false,
          mismatches: [
            {
              actual: FDC_BASELINE.parserBaselineCanonicalAcceptedRecordsDigest,
              expected: "f".repeat(64),
              issue: "mismatch",
              key: "parserBaselineCanonicalAcceptedRecordsDigest",
            },
          ],
          status: "review-required",
        },
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("requires the exact FDC Foundation manifest dimensions", async () => {
    const fixture = await createFixture();
    try {
      const cases: readonly {
        readonly expected: string;
        readonly manifest: FoodSourceManifestV4;
        readonly name: string;
      }[] = [
        {
          expected: "USDA FDC single-member JSON manifest",
          manifest: {
            ...fixture.manifest,
            artifact: { ...fixture.manifest.artifact, mediaType: "application/json" },
          },
          name: "media-type",
        },
        {
          expected: "FDC data types must exactly match the reviewed contract",
          manifest: {
            ...fixture.manifest,
            ingestion: { ...fixture.manifest.ingestion, dataTypes: ["Branded"] },
          },
          name: "subtype",
        },
        {
          expected: "FDC languages must exactly match the reviewed contract",
          manifest: {
            ...fixture.manifest,
            ingestion: { ...fixture.manifest.ingestion, languages: ["fr"] },
          },
          name: "language",
        },
        {
          expected: "FDC markets must exactly match the reviewed contract",
          manifest: {
            ...fixture.manifest,
            ingestion: { ...fixture.manifest.ingestion, markets: ["CA"] },
          },
          name: "market",
        },
        {
          expected: "FDC source identity fields must exactly match the reviewed contract",
          manifest: {
            ...fixture.manifest,
            ingestion: {
              ...fixture.manifest.ingestion,
              sourceIdentityFields: ["dataType", "fdcId"],
            },
          },
          name: "source-identity",
        },
      ];

      for (const testCase of cases) {
        const manifestPath = await writeManifest(
          fixture.root,
          `wrong-${testCase.name}.json`,
          testCase.manifest,
        );
        const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });
        expect(
          await runCommand(
            inspectArguments(
              manifestPath,
              fixture.artifactPath,
              join(fixture.root, `cache-wrong-${testCase.name}`),
              join(fixture.root, `extract-wrong-${testCase.name}`),
            ),
            result.io,
          ),
        ).toBe(1);
        expect(result.output).toEqual([]);
        expect(result.errors.join("\n")).toContain(testCase.expected);
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("retains only private captured evidence after JSON parsing fails", async () => {
    const invalidJson = Buffer.from("{not-json\n");
    const fixture = await createFixture([{ data: invalidJson, name: FDC_MEMBER }]);
    const extractDirectory = join(fixture.root, "extract-parse-failure-🍎");
    try {
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });
      expect(
        await runCommand(
          inspectArguments(
            fixture.manifestPath,
            fixture.artifactPath,
            join(fixture.root, "cache-parse-failure-🍎"),
            extractDirectory,
          ),
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      const retainedDirectory = await lstat(extractDirectory);
      const retainedPath = join(extractDirectory, FDC_MEMBER);
      const retainedMember = await lstat(retainedPath);
      expect(retainedDirectory.mode & 0o777).toBe(0o700);
      expect(retainedMember.mode & 0o777).toBe(0o600);
      expect(retainedMember.nlink).toBe(1);
      if (typeof process.getuid === "function") {
        expect(retainedDirectory.uid).toBe(process.getuid());
        expect(retainedMember.uid).toBe(process.getuid());
      }
      expect(await readFile(retainedPath)).toEqual(invalidJson);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("binds parsed bytes to the captured extractor identity and digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "nutrition-fdc-exact-read-"));
    const memberPath = join(root, FDC_MEMBER);
    const displacedPath = join(root, "displaced.json");
    try {
      await writeFile(memberPath, FDC_JSON_BYTES, { flag: "wx", mode: 0o600 });
      const captured = await capturedExtractedFile(memberPath);
      await expect(
        readExactFdcJsonMember({
          ...captured,
          identity: { ...captured.identity, sha256: "0".repeat(64) },
        }),
      ).rejects.toThrow("Parsed FDC member content differs from extractor evidence");

      await rename(memberPath, displacedPath);
      await writeFile(memberPath, FDC_JSON_BYTES, { flag: "wx", mode: 0o600 });
      await expect(readExactFdcJsonMember(captured)).rejects.toThrow(
        "Extracted FDC member changed before parsing",
      );
      expect(await readFile(memberPath)).toEqual(FDC_JSON_BYTES);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("emits deterministic inventory and parser evidence without database authority", async () => {
    const fixture = await createFixture();
    try {
      const result = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });

      const exitCode = await runCommand(
        inspectArguments(
          fixture.manifestPath,
          fixture.artifactPath,
          join(fixture.root, "cache-success-🍎"),
          join(fixture.root, "extract-success-🍎"),
        ),
        result.io,
      );

      expect(result.errors).toEqual([]);
      expect(exitCode).toBe(0);
      const inspection = singleOutput(result);
      const manifestSha256 = sha256Bytes(await readFile(fixture.manifestPath));
      const members = [
        {
          archivePath: FDC_MEMBER,
          byteSize: FDC_JSON_BYTES.byteLength,
          sha256: sha256Bytes(FDC_JSON_BYTES),
        },
      ];
      expect(inspection).toMatchObject({
        archive: {
          expectedFiles: [FDC_MEMBER],
          inventoryCount: 1,
          inventorySha256: sha256CanonicalJson([FDC_MEMBER]),
          memberEvidenceSha256: sha256CanonicalJson(members),
          members,
        },
        baseline: FDC_BASELINE,
        baselineReview: {
          kind: "non-qualifying-local-baseline-comparison-v1",
          manifestExpectationsMatched: true,
          mismatches: [],
          qualifiesAsAcquisitionOrApprovalEvidence: false,
          status: "matched-manifest-expectations",
        },
        localVerification: {
          artifactByteSize: fixture.artifactByteSize,
          artifactSha256: fixture.artifactSha256,
          kind: "non-qualifying-local-artifact-verification-v1",
          qualifiesAsAcquisitionObservation: false,
          status: "verified-against-manifest-pins",
        },
        manifestSha256,
        metrics: FDC_METRICS,
        parserBuildSha256: PARSER_BUILD_SHA256,
        parserPackage: "@nutrition-tracker/ingestion",
        parserVersion: "0.1.0",
        releaseKey: FDC_RELEASE_KEY,
        semanticEvidence: FDC_SEMANTIC,
      });
      const serialized = JSON.stringify(inspection);
      for (const acquisitionField of [
        "acquisitionId",
        "operatorPrincipalId",
        "observedAt",
        "freshDownload",
        "downloadUrl",
        "resolvedUrl",
      ]) {
        expect(serialized).not.toContain(acquisitionField);
      }
      expect(inspection).not.toHaveProperty("actor");
      expect(inspection).not.toHaveProperty("artifact");
      expect(inspection).not.toHaveProperty("approved");
      expect(inspection).not.toHaveProperty("promotionEligible");
      expect(fixture.manifest.templateOnly).toBe(true);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("reads the supplied artifact even when its pinned digest is already cached", async () => {
    const fixture = await createFixture();
    try {
      const cacheDirectory = join(fixture.root, "cache-source-read");
      const parserEnvironment = { INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 };
      const seeded = commandIo(parserEnvironment);
      expect(
        await runCommand(
          inspectArguments(
            fixture.manifestPath,
            fixture.artifactPath,
            cacheDirectory,
            join(fixture.root, "extract-source-read-seed"),
          ),
          seeded.io,
        ),
      ).toBe(0);

      const missing = commandIo(parserEnvironment);
      expect(
        await runCommand(
          inspectArguments(
            fixture.manifestPath,
            join(fixture.root, "missing-foundation.zip"),
            cacheDirectory,
            join(fixture.root, "extract-source-read-missing"),
          ),
          missing.io,
        ),
      ).toBe(1);
      expect(missing.output).toEqual([]);
      expect(missing.errors.join("\n")).toContain("ENOENT");
      expect(databaseOpenAttempt).not.toHaveBeenCalled();

      const wrongArtifactPath = join(fixture.root, "wrong-foundation.zip");
      await writeFile(wrongArtifactPath, Buffer.alloc(fixture.artifactByteSize, 0x78), {
        flag: "wx",
        mode: 0o600,
      });
      const ready = importReadyFdcManifest(fixture.manifest);
      const readyPath = await writeManifest(fixture.root, "source-read-ready.json", ready.manifest);
      const evidencePath = join(fixture.root, "source-read-evidence.json");
      await writeCanonicalReleaseEvidence(evidencePath, ready.bundle);
      const staged = commandIo({
        ...parserEnvironment,
        INGEST_AUTHENTICATED_PRINCIPAL_ID: FDC_EVIDENCE_RUNNER.principalId,
        INGEST_AUTHENTICATION_METHOD: FDC_EVIDENCE_RUNNER.authenticationMethod,
        INGEST_AUTHENTICATION_RUN_REFERENCE: FDC_EVIDENCE_RUNNER.runReference,
      });
      expect(
        await runCommand(
          stageArguments(
            readyPath,
            wrongArtifactPath,
            cacheDirectory,
            join(fixture.root, "extract-source-read-wrong"),
            sha256Bytes(await readFile(readyPath)),
            evidencePath,
          ),
          staged.io,
        ),
      ).toBe(1);
      expect(staged.output).toEqual([]);
      expect(staged.errors.join("\n")).toContain("Artifact does not match its pinned expectation");
      expect(staged.errors.join("\n")).not.toContain("DATABASE_OPEN_CALLED");
      expect(databaseOpenAttempt).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects authority-shaped and unknown stage options before manifest or database access", async () => {
    const exact = [
      "catalogue",
      "stage-fdc",
      "/manifest-must-not-be-read.json",
      "--artifact",
      "/artifact-must-not-be-read.zip",
      "--cache-dir",
      "/cache-must-not-be-created",
      "--extract-dir",
      "/extract-must-not-be-created",
      "--evidence-bundle",
      "/evidence-must-not-be-read.json",
      "--manifest-object-uri",
      "s3://locked-evidence/sha256/placeholder/manifest.json",
    ];
    for (const testCase of [
      { args: [...exact, "--actor", "caller-authored"], option: "--actor" },
      { args: [...exact, "--__proto__=caller-authored"], option: "--__proto__" },
    ]) {
      const result = commandIo();
      expect(await runCommand(testCase.args, result.io)).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        `Unknown catalogue stage-fdc option: ${testCase.option}`,
      );
      expect(result.errors.join("\n")).not.toContain("ENOENT");
      expect(databaseOpenAttempt).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      "an uppercase bucket",
      (digest: string) => `s3://Release-Evidence/sha256/${digest}/bundle.json`,
    ],
    [
      "an invalid bucket",
      (digest: string) => `s3://release..evidence/sha256/${digest}/bundle.json`,
    ],
    [
      "a noncanonical path",
      (digest: string) => `s3://release-evidence/sha256/${digest}/nested/../bundle.json`,
    ],
  ])(
    "rejects %s during manifest validate --import-ready before reading evidence",
    async (_name, objectUriForDigest) => {
      const fixture = await createFixture();
      try {
        const ready = importReadyFdcManifest(fixture.manifest);
        if (ready.manifest.evidenceBundle === null) {
          throw new Error("Synthetic import-ready fixture did not bind release evidence");
        }
        const objectUri = objectUriForDigest(ready.manifest.evidenceBundle.sha256);
        const manifestPath = await writeManifest(fixture.root, "invalid-evidence-uri.json", {
          ...ready.manifest,
          evidenceBundle: { ...ready.manifest.evidenceBundle, objectUri },
        });
        const result = commandIo();

        expect(
          await runCommand(
            [
              "manifest",
              "validate",
              manifestPath,
              "--import-ready",
              "--evidence-bundle",
              join(fixture.root, "evidence-must-not-be-read.json"),
            ],
            result.io,
          ),
        ).toBe(1);
        expect(result.output).toEqual([]);
        expect(result.errors.join("\n")).toContain(
          "Evidence bundle objectUri must be a credential-free content-addressed S3 URI",
        );
        expect(result.errors.join("\n")).not.toContain("ENOENT");
        expect(databaseOpenAttempt).not.toHaveBeenCalled();
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it("rejects absent, tampered, noncanonical, and expired release evidence before artifact or database I/O", async () => {
    const fixture = await createFixture();
    try {
      const ready = importReadyFdcManifest(fixture.manifest);
      const readyPath = await writeManifest(
        fixture.root,
        "evidence-gate-ready.json",
        ready.manifest,
      );
      const manifestSha256 = sha256Bytes(await readFile(readyPath));
      const trustedEnvironment = {
        INGEST_AUTHENTICATED_PRINCIPAL_ID: FDC_EVIDENCE_RUNNER.principalId,
        INGEST_AUTHENTICATION_METHOD: FDC_EVIDENCE_RUNNER.authenticationMethod,
        INGEST_AUTHENTICATION_RUN_REFERENCE: FDC_EVIDENCE_RUNNER.runReference,
        INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256,
      };
      const argumentsFor = (evidencePath: string): string[] =>
        stageArguments(
          readyPath,
          join(fixture.root, "artifact-must-not-be-read.zip"),
          join(fixture.root, "cache-must-not-be-created"),
          join(fixture.root, "extract-must-not-be-created"),
          manifestSha256,
          evidencePath,
        );
      const assertPreIoFailure = async (
        arguments_: readonly string[],
        expected: string,
        evaluatedAt = SYNTHETIC_EVIDENCE_EVALUATED_AT,
      ): Promise<void> => {
        const result = commandIo(trustedEnvironment, evaluatedAt);
        expect(await runCommand(arguments_, result.io)).toBe(1);
        expect(result.output).toEqual([]);
        expect(result.errors.join("\n")).toContain(expected);
        expect(result.errors.join("\n")).not.toContain("Artifact does not match");
        expect(result.errors.join("\n")).not.toContain("artifact-must-not-be-read");
        expect(databaseOpenAttempt).not.toHaveBeenCalled();
      };

      const absentArguments = argumentsFor(join(fixture.root, "unused-evidence.json"));
      const evidenceOptionIndex = absentArguments.indexOf("--evidence-bundle");
      absentArguments.splice(evidenceOptionIndex, 2);
      await assertPreIoFailure(absentArguments, "--evidence-bundle requires a non-blank value");

      await assertPreIoFailure(argumentsFor(join(fixture.root, "missing-evidence.json")), "ENOENT");

      const tampered = structuredClone(ready.bundle) as unknown as {
        authorityDecision: { scope: { releaseKey: string } };
      };
      tampered.authorityDecision.scope.releaseKey = "tampered-release";
      const tamperedPath = join(fixture.root, "tampered-evidence.json");
      await writeFile(tamperedPath, `${canonicalJson(tampered)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await assertPreIoFailure(
        argumentsFor(tamperedPath),
        "Manifest evidence-bundle digest does not match",
      );

      const noncanonicalPath = join(fixture.root, "noncanonical-evidence.json");
      await writeFile(noncanonicalPath, `${JSON.stringify(ready.bundle, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await assertPreIoFailure(
        argumentsFor(noncanonicalPath),
        "exact canonical UTF-8 JSON serialization",
      );

      const malformedPath = join(fixture.root, "malformed-utf8-evidence.json");
      await writeFile(malformedPath, Buffer.from([0x7b, 0xff, 0x7d]), {
        flag: "wx",
        mode: 0o600,
      });
      await assertPreIoFailure(
        argumentsFor(malformedPath),
        "Release evidence bundle must be valid UTF-8",
      );

      const publicModePath = join(fixture.root, "public-mode-evidence.json");
      await writeCanonicalReleaseEvidence(publicModePath, ready.bundle);
      await chmod(publicModePath, 0o644);
      await assertPreIoFailure(
        argumentsFor(publicModePath),
        "Release evidence bundle must be an owner-only, single-link regular file",
      );

      const symlinkTargetPath = join(fixture.root, "symlink-target-evidence.json");
      const symlinkPath = join(fixture.root, "symlink-evidence.json");
      await writeCanonicalReleaseEvidence(symlinkTargetPath, ready.bundle);
      await symlink(symlinkTargetPath, symlinkPath);
      await assertPreIoFailure(argumentsFor(symlinkPath), "ELOOP");

      const hardlinkTargetPath = join(fixture.root, "hardlink-target-evidence.json");
      const hardlinkPath = join(fixture.root, "hardlink-evidence.json");
      await writeCanonicalReleaseEvidence(hardlinkTargetPath, ready.bundle);
      await link(hardlinkTargetPath, hardlinkPath);
      await assertPreIoFailure(
        argumentsFor(hardlinkPath),
        "Release evidence bundle must be an owner-only, single-link regular file",
      );

      const canonicalPath = join(fixture.root, "canonical-evidence.json");
      await writeCanonicalReleaseEvidence(canonicalPath, ready.bundle);
      const boundary = commandIo(trustedEnvironment, ready.bundle.currentRetention.validUntil);
      expect(await runCommand(argumentsFor(canonicalPath), boundary.io)).toBe(1);
      expect(boundary.output).toEqual([]);
      expect(boundary.errors.join("\n")).toContain("Authority evidence is not current");
      expect(boundary.errors.join("\n")).not.toContain("ENOENT");
      expect(databaseOpenAttempt).not.toHaveBeenCalled();

      await assertPreIoFailure(
        argumentsFor(canonicalPath),
        "Authority evidence is not current",
        SYNTHETIC_EVIDENCE_EXPIRED_AT,
      );

      for (const runnerMismatch of [
        {
          environment: {
            ...trustedEnvironment,
            INGEST_AUTHENTICATED_PRINCIPAL_ID: "service:fdc-release-other",
          },
          name: "reviewer principal",
        },
        {
          environment: {
            ...trustedEnvironment,
            INGEST_AUTHENTICATION_METHOD: "workload-identity",
          },
          name: "authentication method",
        },
        {
          environment: {
            ...trustedEnvironment,
            INGEST_AUTHENTICATION_RUN_REFERENCE:
              "urn:nutrition-tracker:test:fdc-cli-evidence-other",
          },
          name: "run reference",
        },
      ] as const) {
        const result = commandIo(runnerMismatch.environment);
        expect(await runCommand(argumentsFor(canonicalPath), result.io), runnerMismatch.name).toBe(
          1,
        );
        expect(result.output, runnerMismatch.name).toEqual([]);
        expect(result.errors.join("\n"), runnerMismatch.name).toContain(
          "Authority decision reviewer identity must match the authenticated staging runner",
        );
        expect(result.errors.join("\n"), runnerMismatch.name).not.toContain(
          "artifact-must-not-be-read",
        );
        expect(databaseOpenAttempt, runnerMismatch.name).not.toHaveBeenCalled();
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("finishes exact FDC preflight before opening a database and blocks drift without an open", async () => {
    const fixture = await createFixture();
    try {
      const ready = importReadyFdcManifest(fixture.manifest);
      const readyPath = await writeManifest(fixture.root, "import-ready.json", ready.manifest);
      const evidencePath = join(fixture.root, "import-ready-evidence.json");
      await writeCanonicalReleaseEvidence(evidencePath, ready.bundle);
      const trustedEnvironment = {
        INGEST_AUTHENTICATED_PRINCIPAL_ID: FDC_EVIDENCE_RUNNER.principalId,
        INGEST_AUTHENTICATION_METHOD: FDC_EVIDENCE_RUNNER.authenticationMethod,
        INGEST_AUTHENTICATION_RUN_REFERENCE: FDC_EVIDENCE_RUNNER.runReference,
        INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256,
      };
      const valid = commandIo(trustedEnvironment);
      expect(
        await runCommand(
          stageArguments(
            readyPath,
            fixture.artifactPath,
            join(fixture.root, "cache-stage-valid"),
            join(fixture.root, "extract-stage-valid"),
            sha256Bytes(await readFile(readyPath)),
            evidencePath,
          ),
          valid.io,
        ),
      ).toBe(1);
      expect(valid.output).toEqual([]);
      expect(valid.errors.join("\n")).toContain("DATABASE_OPEN_CALLED");
      expect(databaseOpenAttempt).toHaveBeenCalledTimes(1);

      databaseOpenAttempt.mockClear();
      const drifted = bindSyntheticReleaseEvidence(
        {
          ...ready.manifest,
          evidenceBundle: null,
          validation: {
            ...ready.manifest.validation,
            releaseSpecificExpectations: {
              ...ready.manifest.validation.releaseSpecificExpectations,
              parserBaselineSemanticEvidenceDigest: "f".repeat(64),
            },
          },
        },
        FDC_EVIDENCE_RUNNER,
      );
      const driftedPath = await writeManifest(
        fixture.root,
        "import-ready-drifted.json",
        drifted.manifest,
      );
      const driftedEvidencePath = join(fixture.root, "import-ready-drifted-evidence.json");
      await writeCanonicalReleaseEvidence(driftedEvidencePath, drifted.bundle);
      const driftedResult = commandIo(trustedEnvironment);
      expect(
        await runCommand(
          stageArguments(
            driftedPath,
            fixture.artifactPath,
            join(fixture.root, "cache-stage-drifted"),
            join(fixture.root, "extract-stage-drifted"),
            sha256Bytes(await readFile(driftedPath)),
            driftedEvidencePath,
          ),
          driftedResult.io,
        ),
      ).toBe(1);
      expect(driftedResult.output).toEqual([]);
      expect(driftedResult.errors.join("\n")).toContain("parserBaselineSemanticEvidenceDigest");
      expect(driftedResult.errors.join("\n")).not.toContain("DATABASE_OPEN_CALLED");
      expect(databaseOpenAttempt).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps the database staging authority boundary unchanged for templates", async () => {
    const fixture = await createFixture();
    try {
      const result = commandIo({
        INGEST_AUTHENTICATED_PRINCIPAL_ID: FDC_EVIDENCE_RUNNER.principalId,
        INGEST_AUTHENTICATION_METHOD: FDC_EVIDENCE_RUNNER.authenticationMethod,
        INGEST_AUTHENTICATION_RUN_REFERENCE: FDC_EVIDENCE_RUNNER.runReference,
        INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256,
      });
      expect(
        await runCommand(
          [
            "catalogue",
            "stage-fdc",
            fixture.manifestPath,
            "--artifact",
            fixture.artifactPath,
            "--cache-dir",
            join(fixture.root, "cache-stage-regression"),
            "--extract-dir",
            join(fixture.root, "extract-stage-regression"),
            "--evidence-bundle",
            join(fixture.root, "evidence-must-not-be-read.json"),
            "--manifest-object-uri",
            `s3://locked-evidence/sha256/${sha256Bytes(await readFile(fixture.manifestPath))}/manifest.json`,
          ],
          result.io,
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("\n")).toContain("Template manifest cannot be imported");
      expect(result.errors.join("\n")).not.toContain("DATABASE_URL");
      expect(databaseOpenAttempt).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

async function createFixture(
  files: readonly { readonly data: Buffer; readonly name: string }[] = [
    { data: FDC_JSON_BYTES, name: FDC_MEMBER },
  ],
): Promise<FdcInspectionFixture> {
  const root = await mkdtemp(join(tmpdir(), "nutrition-fdc-inspect-"));
  const artifactPath = join(root, "foundation.zip");
  const archiveBytes = makeStoredZip(files);
  await writeFile(artifactPath, archiveBytes, { flag: "wx", mode: 0o600 });
  const artifactSha256 = sha256Bytes(archiveBytes);
  const foundation = JSON.parse(
    await readFile(FOUNDATION_MANIFEST_PATH, "utf8"),
  ) as FoodSourceManifestV4;
  const manifest: FoodSourceManifestV4 = {
    ...foundation,
    artifact: {
      ...foundation.artifact,
      byteSize: archiveBytes.byteLength,
      sha256: artifactSha256,
    },
    ingestion: {
      ...foundation.ingestion,
      parserBuildSha256: PARSER_BUILD_SHA256,
      parserPackage: "@nutrition-tracker/ingestion",
      parserVersion: "0.1.0",
    },
    release: { ...foundation.release, releaseKey: FDC_RELEASE_KEY },
    templateOnly: true,
    validation: {
      ...foundation.validation,
      expectedFiles: [FDC_MEMBER],
      releaseSpecificExpectations: {
        ...foundation.validation.releaseSpecificExpectations,
        ...FDC_BASELINE,
      },
    },
  };
  const manifestPath = await writeManifest(root, "pinned-template.json", manifest);
  return {
    artifactByteSize: archiveBytes.byteLength,
    artifactPath,
    artifactSha256,
    manifest,
    manifestPath,
    root,
  };
}

function importReadyFdcManifest(template: FoodSourceManifestV4): SyntheticReleaseEvidenceFixture {
  const sha256 = template.artifact.sha256;
  const byteSize = template.artifact.byteSize;
  const downloadUrl = template.artifact.downloadUrl;
  const resolvedUrl = template.artifact.permittedResolvedUrls[0];
  if (!sha256 || !byteSize || !downloadUrl || !resolvedUrl) {
    throw new Error("Pinned FDC test fixture is incomplete");
  }
  return bindSyntheticReleaseEvidence(
    {
      ...template,
      artifact: {
        ...template.artifact,
        objectUri: `s3://synthetic-fdc-artifacts/sha256/${sha256}/foundation.zip`,
      },
      evidenceBundle: null,
      release: {
        ...template.release,
        upstreamSchemaVersion: "fdc-cli-preflight-v1",
      },
      releaseClass: "fixture-nonrelease",
      rights: {
        ...template.rights,
        review: {
          ...template.rights.review,
          notes: "Synthetic test fixture only; not release evidence.",
          reviewedAt: "2026-08-29T12:00:00Z",
          reviewedBy: "principal:fdc-rights-reviewer",
          status: "approved",
        },
      },
      templateOnly: false,
    },
    FDC_EVIDENCE_RUNNER,
  );
}

async function writeManifest(
  root: string,
  name: string,
  manifest: FoodSourceManifestV4,
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

function inspectArguments(
  manifestPath: string,
  artifactPath: string,
  cacheDirectory: string,
  extractDirectory: string,
): string[] {
  return [
    "fdc",
    "inspect",
    manifestPath,
    "--artifact",
    artifactPath,
    "--cache-dir",
    cacheDirectory,
    "--extract-dir",
    extractDirectory,
  ];
}

function stageArguments(
  manifestPath: string,
  artifactPath: string,
  cacheDirectory: string,
  extractDirectory: string,
  manifestSha256: string,
  evidenceBundlePath: string,
): string[] {
  return [
    "catalogue",
    "stage-fdc",
    manifestPath,
    "--artifact",
    artifactPath,
    "--cache-dir",
    cacheDirectory,
    "--extract-dir",
    extractDirectory,
    "--evidence-bundle",
    evidenceBundlePath,
    "--manifest-object-uri",
    `s3://locked-evidence/sha256/${manifestSha256}/manifest.json`,
  ];
}

function commandIo(
  environment: NodeJS.ProcessEnv = {},
  evaluatedAt = SYNTHETIC_EVIDENCE_EVALUATED_AT,
): {
  readonly errors: string[];
  readonly io: CommandIo;
  readonly output: string[];
} {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    errors,
    io: {
      environment,
      now: () => new Date(evaluatedAt),
      writeError: (value) => errors.push(value),
      writeOutput: (value) => output.push(value),
    },
    output,
  };
}

function singleOutput(result: {
  readonly errors: readonly string[];
  readonly output: readonly string[];
}): Record<string, unknown> {
  expect(result.errors).toEqual([]);
  expect(result.output).toHaveLength(1);
  return JSON.parse(result.output[0] ?? "null") as Record<string, unknown>;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashRecordDigests(digests: readonly string[]): string {
  return createHash("sha256")
    .update([...digests].sort().join("\n"))
    .digest("hex");
}

function evidenceDigest(values: readonly unknown[]): {
  readonly count: number;
  readonly sha256: string;
} {
  return Object.freeze({
    count: values.length,
    sha256: sha256CanonicalJson(values),
  });
}

async function capturedExtractedFile(path: string): Promise<ExtractedZipFile> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("FDC exact-read fixture must be a regular file");
  }
  return Object.freeze({
    archivePath: FDC_MEMBER,
    byteSize: metadata.size,
    identity: Object.freeze({
      birthtimeMs: metadata.birthtimeMs,
      ctimeMs: metadata.ctimeMs,
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode & 0o777,
      mtimeMs: metadata.mtimeMs,
      nlink: metadata.nlink,
      sha256: sha256Bytes(await readFile(path)),
      size: metadata.size,
      uid: metadata.uid,
    }),
    path,
  });
}

function makeStoredZip(files: readonly { readonly data: Buffer; readonly name: string }[]): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localEntries.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralEntries.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, centralDirectory, end]);
}

function crc32(bytes: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
