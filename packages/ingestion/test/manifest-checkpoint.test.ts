import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertImportReadyManifest,
  assertManifestParserIdentity,
  type BatchCheckpoint,
  type BatchCheckpointStore,
  type BatchIdentity,
  canonicalJson,
  INGESTION_PARSER_PACKAGE,
  INGESTION_PARSER_VERSION,
  importReadyManifest,
  manifestAuthoritySubjectSha256,
  parseFoodSourceManifest,
  runResumableBatch,
} from "../src/index.js";

describe("food source manifest v4 contract", () => {
  it("keeps the exported parser identity aligned with package metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { readonly name: string; readonly version: string };
    expect(packageJson).toMatchObject({
      name: INGESTION_PARSER_PACKAGE,
      version: INGESTION_PARSER_VERSION,
    });
  });

  it("validates every checked-in manifest and keeps candidates non-import-ready", async () => {
    const directory = fileURLToPath(new URL("../../../data/manifests/", import.meta.url));
    const names = (await readdir(directory)).filter(
      (name) => name.endsWith(".json") && name !== "food-source-manifest.schema.json",
    );
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) {
      const input: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      const manifest = parseFoodSourceManifest(input);
      expect(manifest.manifestVersion).toBe(4);
      expect(manifest.templateOnly).toBe(true);
      expect(manifest.releaseClass).toBe("live-reviewed");
      expect(manifest.evidenceBundle).toBeNull();
      expect(manifest.artifact).not.toHaveProperty("acquisitionObservations");
      expect(() => assertImportReadyManifest(manifest)).toThrowError(
        expect.objectContaining({ code: "INVALID_MANIFEST" }),
      );
    }
  });

  it("accepts a non-template manifest only with an immutable authority-bundle reference", () => {
    const ready = readyManifest();
    const parsed = importReadyManifest(ready);
    expect(parsed.artifact.sha256).toBe("a".repeat(64));
    expect(INGESTION_PARSER_PACKAGE).toBe("@nutrition-tracker/ingestion");
    expect(INGESTION_PARSER_VERSION).toBe("0.1.0");
    expect(() => assertManifestParserIdentity(parsed)).not.toThrow();
    expect(Object.isFrozen(parsed.evidenceBundle)).toBe(true);
  });

  it("rejects v3 and the removed caller-authored acquisition-observation field", () => {
    const v3 = readyManifest();
    v3.manifestVersion = 3;
    expect(() => parseFoodSourceManifest(v3)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );

    const legacy = readyManifest();
    artifact(legacy).acquisitionObservations = [];
    expect(() => parseFoodSourceManifest(legacy)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );
  });

  it("enforces the template/bundle invariant and exact release classification", () => {
    const missing = readyManifest();
    missing.evidenceBundle = null;
    expect(() => importReadyManifest(missing)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );

    const template = readyManifest();
    template.templateOnly = true;
    expect(() => parseFoodSourceManifest(template)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );

    const wrongUri = readyManifest();
    evidenceBundle(wrongUri).objectUri = "s3://release-evidence/sha256/wrong/bundle.json";
    expect(() => importReadyManifest(wrongUri)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );

    const unknownClass = readyManifest();
    unknownClass.releaseClass = "caller-authored";
    expect(() => parseFoodSourceManifest(unknownClass)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );
  });

  it.each([
    ["an uppercase bucket", `s3://Release-Evidence/sha256/${"c".repeat(64)}/bundle.json`],
    [
      "a bucket with consecutive dots",
      `s3://release..evidence/sha256/${"c".repeat(64)}/bundle.json`,
    ],
    ["an IPv4-shaped bucket", `s3://192.168.0.1/sha256/${"c".repeat(64)}/bundle.json`],
    ["a bucket shorter than three characters", `s3://ab/sha256/${"c".repeat(64)}/bundle.json`],
    ["a bucket with a port", `s3://release-evidence:443/sha256/${"c".repeat(64)}/bundle.json`],
    [
      "a path that URL parsing would normalize",
      `s3://release-evidence/sha256/${"c".repeat(64)}/nested/../bundle.json`,
    ],
    [
      "an empty path segment before the digest",
      `s3://release-evidence//sha256/${"c".repeat(64)}/bundle.json`,
    ],
    [
      "an empty path segment after the digest",
      `s3://release-evidence/sha256/${"c".repeat(64)}//bundle.json`,
    ],
    [
      "a malformed percent escape",
      `s3://release-evidence/%zz/sha256/${"c".repeat(64)}/bundle.json`,
    ],
  ])("rejects an evidence-bundle URI with %s", (_name, objectUri) => {
    const input = readyManifest();
    evidenceBundle(input).objectUri = objectUri;
    expect(() => importReadyManifest(input)).toThrowError(
      expect.objectContaining({
        code: "INVALID_MANIFEST",
        message: "Evidence bundle objectUri must be a credential-free content-addressed S3 URI",
      }),
    );
  });

  it("hashes the complete manifest authority subject without the bundle reference", () => {
    const first = importReadyManifest(readyManifest());
    const secondInput = readyManifest();
    secondInput.evidenceBundle = {
      contractVersion: 1,
      sha256: "d".repeat(64),
      objectUri: `s3://release-evidence/sha256/${"d".repeat(64)}/bundle.json`,
    };
    const second = importReadyManifest(secondInput);
    expect(manifestAuthoritySubjectSha256(first)).toBe(manifestAuthoritySubjectSha256(second));
  });

  it("rejects whitespace identities, incomplete rights review, bad dates, and weak expectations", () => {
    const cases = [
      (value: Record<string, unknown>) => {
        ingestion(value).parserVersion = " 0.1.0";
      },
      (value: Record<string, unknown>) => {
        ingestion(value).parserVersion = "0.2.0";
      },
      (value: Record<string, unknown>) => {
        ingestion(value).parserPackage = "@nutrition-tracker/other";
      },
      (value: Record<string, unknown>) => {
        ingestion(value).parserBuildSha256 = null;
      },
      (value: Record<string, unknown>) => {
        artifact(value).objectUri = "s3://food-source-artifacts/fdc/latest.zip";
      },
      (value: Record<string, unknown>) => {
        artifact(value).objectUri =
          `s3://food-source-artifacts/fdc/sha256/${"a".repeat(64)}suffix/release.zip`;
      },
      (value: Record<string, unknown>) => {
        artifact(value).objectUri =
          `s3://food-source-artifacts/fdc/junk/../sha256/${"a".repeat(64)}/release.zip`;
      },
      (value: Record<string, unknown>) => {
        artifact(value).objectUri =
          `s3://food-source-artifacts/fdc//sha256/${"a".repeat(64)}/release.zip`;
      },
      (value: Record<string, unknown>) => {
        rightsReview(value).reviewedBy = "reviewer.one ";
      },
      (value: Record<string, unknown>) => {
        rightsReview(value).reviewedAt = null;
      },
      (value: Record<string, unknown>) => {
        validation(value).expectedFiles = [];
      },
      (value: Record<string, unknown>) => {
        validation(value).expectedFiles = ["release.json", "release.json"];
      },
      (value: Record<string, unknown>) => {
        validation(value).releaseSpecificExpectations = {};
      },
    ];
    for (const mutate of cases) {
      const input = readyManifest();
      mutate(input);
      expect(() => importReadyManifest(input)).toThrowError(
        expect.objectContaining({ code: "INVALID_MANIFEST" }),
      );
    }
  });
});

describe("resumable idempotent batch coordination", () => {
  const identity: BatchIdentity = {
    sourceCode: "USDA_FDC",
    releaseKey: "r1",
    artifactSha256: "a".repeat(64),
    parserVersion: "0.1.0",
  };

  it("replays an applied page safely after a checkpoint interruption", async () => {
    let checkpoint: BatchCheckpoint | null = null;
    let failFirstSave = true;
    const store: BatchCheckpointStore = {
      load: async () => checkpoint,
      save: async (next, expectedRevision) => {
        if (failFirstSave) {
          failFirstSave = false;
          throw new Error("simulated checkpoint outage");
        }
        expect(expectedRevision).toBeNull();
        checkpoint = next;
        return next;
      },
    };
    const applied = new Set<string>();
    const sink = {
      apply: async ({ idempotencyKey }: { readonly idempotencyKey: string }) => {
        if (applied.has(idempotencyKey)) {
          return "already-applied" as const;
        }
        applied.add(idempotencyKey);
        return "applied" as const;
      },
    };
    const pagesAfter = async function* () {
      yield {
        cursor: "page-1",
        records: [{ id: "food-1" }],
        acceptedRecords: 1,
        quarantinedRecords: 0,
      };
    };
    await expect(
      runResumableBatch({ identity, checkpoints: store, sink, pagesAfter }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT" });
    const resumed = await runResumableBatch({ identity, checkpoints: store, sink, pagesAfter });
    expect(resumed).toMatchObject({ appliedPages: 0, replayedPages: 1 });
    expect(resumed.checkpoint).toMatchObject({
      revision: 1,
      lastCursor: "page-1",
      processedRecords: 1,
    });
    expect(applied).toHaveLength(1);
  });

  it("rejects non-advancing cursors and inconsistent counters", async () => {
    const store: BatchCheckpointStore = {
      load: async () => null,
      save: async (next) => next,
    };
    const sink = { apply: async () => "applied" as const };
    const pagesAfter = async function* () {
      yield { cursor: "same", records: [{ id: 1 }], acceptedRecords: 1, quarantinedRecords: 0 };
      yield { cursor: "same", records: [{ id: 2 }], acceptedRecords: 1, quarantinedRecords: 0 };
    };
    await expect(
      runResumableBatch({ identity, checkpoints: store, sink, pagesAfter }),
    ).rejects.toMatchObject({ code: "DUPLICATE_KEY" });

    const badPages = async function* () {
      yield { cursor: "bad", records: [{ id: 1 }], acceptedRecords: 0, quarantinedRecords: 0 };
    };
    await expect(
      runResumableBatch({ identity, checkpoints: store, sink, pagesAfter: badPages }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });

  it("canonicalizes object keys deterministically", () => {
    expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
    expect(canonicalJson({ a: [true, null], z: 1 })).toBe('{"a":[true,null],"z":1}');
  });
});

function readyManifest(): Record<string, unknown> {
  const downloadUrl = "https://fdc.nal.usda.gov/fdc-datasets/release.zip";
  const sha256 = "a".repeat(64);
  return {
    manifestVersion: 4,
    templateOnly: false,
    releaseClass: "fixture-nonrelease",
    evidenceBundle: {
      contractVersion: 1,
      sha256: "c".repeat(64),
      objectUri: `s3://release-evidence/sha256/${"c".repeat(64)}/bundle.json`,
    },
    source: {
      code: "USDA_FDC",
      displayName: "USDA FoodData Central",
      kind: "government",
      homepageUrl: "https://fdc.nal.usda.gov/",
      accessUrl: "https://fdc.nal.usda.gov/download-datasets/",
    },
    release: {
      releaseKey: "fdc-2026-04",
      publishedOn: "2026-04-30",
      acquiredAt: "2026-08-15T12:00:00.000Z",
      upstreamSchemaVersion: "15.0",
    },
    artifact: {
      downloadUrl,
      permittedResolvedUrls: [downloadUrl],
      objectUri: `s3://food-source-artifacts/fdc/sha256/${sha256}/release.zip`,
      mediaType: "application/zip",
      sha256,
      byteSize: 123,
      publisherIntegrity: {
        publisherProvidesSha256: false,
        sha256: null,
        sha256EvidenceUrl: null,
        exactByteSize: null,
        reportedSize: "123 bytes observed",
        metadataUrl: "https://fdc.nal.usda.gov/download-datasets/",
        notes: "Publisher does not provide SHA-256.",
      },
    },
    rights: {
      licenseExpression: "CC0-1.0",
      licenseName: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      termsUrl: "https://fdc.nal.usda.gov/api-guide/",
      commercialUseAllowed: true,
      redistributionAllowed: true,
      licenseAttributionRequired: false,
      productAttributionRequired: true,
      attributionFixture: "USDA FDC {{releaseKey}}",
      databaseRightsNotes: "",
      review: {
        status: "approved",
        reviewedAt: "2026-08-15T09:00:00.000Z",
        reviewedBy: "legal.reviewer",
        evidenceUrls: ["https://fdc.nal.usda.gov/api-guide/"],
        notes: "Reviewed.",
      },
    },
    ingestion: {
      parserPackage: "@nutrition-tracker/ingestion",
      parserVersion: "0.1.0",
      parserBuildSha256: "b".repeat(64),
      dataTypes: ["Foundation"],
      languages: ["en"],
      markets: ["US"],
      sourceIdentityFields: ["fdcId", "dataType"],
      missingValuePolicy: "absent-is-unknown-never-zero",
    },
    validation: {
      rules: ["archive member set is exact"],
      expectedFiles: ["release.json"],
      releaseSpecificExpectations: { expectedFoodCount: 395 },
    },
  };
}

function artifact(value: Record<string, unknown>): Record<string, unknown> {
  return value.artifact as Record<string, unknown>;
}

function evidenceBundle(value: Record<string, unknown>): Record<string, unknown> {
  return value.evidenceBundle as Record<string, unknown>;
}

function ingestion(value: Record<string, unknown>): Record<string, unknown> {
  return value.ingestion as Record<string, unknown>;
}

function rightsReview(value: Record<string, unknown>): Record<string, unknown> {
  return (value.rights as Record<string, unknown>).review as Record<string, unknown>;
}

function validation(value: Record<string, unknown>): Record<string, unknown> {
  return value.validation as Record<string, unknown>;
}
