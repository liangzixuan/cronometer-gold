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
  parseFoodSourceManifest,
  runResumableBatch,
} from "../src/index.js";

describe("food source manifest v3 contract", () => {
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
      expect(manifest.manifestVersion).toBe(3);
      expect(manifest.templateOnly).toBe(true);
      expect(() => assertImportReadyManifest(manifest)).toThrowError(
        expect.objectContaining({ code: "INVALID_MANIFEST" }),
      );
    }
  });

  it("accepts a pinned two-operator fresh HTTPS consensus", () => {
    const ready = readyManifest();
    const parsed = importReadyManifest(ready);
    expect(parsed.artifact.sha256).toBe("a".repeat(64));
    expect(INGESTION_PARSER_PACKAGE).toBe("@nutrition-tracker/ingestion");
    expect(INGESTION_PARSER_VERSION).toBe("0.1.0");
    expect(() => assertManifestParserIdentity(parsed)).not.toThrow();
    expect(Object.isFrozen(parsed.artifact.acquisitionObservations)).toBe(true);
  });

  it("accepts an exact reviewed cross-host resolution and rejects an unlisted resource", () => {
    const ready = readyManifest();
    const downloadUrl = String(artifact(ready).downloadUrl);
    const resolvedUrl = "https://storage.example.test/resources/release-id/release.zip";
    artifact(ready).permittedResolvedUrls = [downloadUrl, resolvedUrl];
    for (const item of observations(ready)) item.resolvedUrl = resolvedUrl;
    expect(() => importReadyManifest(ready)).not.toThrow();

    observationAt(ready, 1).resolvedUrl =
      "https://storage.example.test/resources/other-release/release.zip";
    expect(() => importReadyManifest(ready)).toThrowError(
      expect.objectContaining({ code: "INVALID_MANIFEST" }),
    );
  });

  it("rejects same-principal, duplicate-acquisition, stale/cache, and mismatched observations", () => {
    const cases = [
      (value: Record<string, unknown>) => {
        observationAt(value, 1).operatorPrincipalId = "OPERATOR.ONE";
      },
      (value: Record<string, unknown>) => {
        observationAt(value, 1).acquisitionId = observationAt(value, 0).acquisitionId;
      },
      (value: Record<string, unknown>) => {
        observationAt(value, 1).freshDownload = false;
      },
      (value: Record<string, unknown>) => {
        observationAt(value, 1).sha256 = "b".repeat(64);
      },
      (value: Record<string, unknown>) => {
        observationAt(value, 1).resolvedUrl = "https://evil.example/release.zip";
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
        rightsReview(value).reviewedBy = "reviewer.one ";
      },
      (value: Record<string, unknown>) => {
        rightsReview(value).reviewedAt = null;
      },
      (value: Record<string, unknown>) => {
        observationAt(value, 0).observedAt = "2026-02-30T12:00:00Z";
      },
      (value: Record<string, unknown>) => {
        observationAt(value, 1).observedAt = "2026-08-16T12:00:00Z";
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
    manifestVersion: 3,
    templateOnly: false,
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
      acquisitionObservations: [
        observation(
          "11111111-1111-4111-8111-111111111111",
          "operator.one",
          "2026-08-15T10:00:00.000Z",
        ),
        observation(
          "22222222-2222-4222-8222-222222222222",
          "operator.two",
          "2026-08-15T11:00:00.000Z",
        ),
      ],
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

  function observation(acquisitionId: string, operatorPrincipalId: string, observedAt: string) {
    return {
      acquisitionId,
      observedAt,
      operatorPrincipalId,
      tool: "nutrition-ingestion/0.1.0",
      transport: "https",
      freshDownload: true,
      downloadUrl,
      resolvedUrl: downloadUrl,
      etag: null,
      lastModified: "2026-04-30T00:00:00.000Z",
      sha256,
      byteSize: 123,
    };
  }
}

function artifact(value: Record<string, unknown>): Record<string, unknown> {
  return value.artifact as Record<string, unknown>;
}

function observations(value: Record<string, unknown>): Record<string, unknown>[] {
  return artifact(value).acquisitionObservations as Record<string, unknown>[];
}

function observationAt(value: Record<string, unknown>, index: number): Record<string, unknown> {
  const observation = observations(value)[index];
  if (!observation) {
    throw new Error(`Missing fixture observation ${index}`);
  }
  return observation;
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
