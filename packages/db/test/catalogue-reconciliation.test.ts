import { describe, expect, it } from "vitest";

import {
  buildCatalogueReconciliationDocument,
  type CatalogueReconciliationBuildInput,
  type CatalogueReconciliationFoodSnapshot,
  type CatalogueReconciliationMappingSnapshot,
  verifyCatalogueReconciliationDocument,
} from "../src/catalogue-reconciliation.js";
import { canonicalJson, sha256CanonicalJson } from "../src/catalogue-validation.js";
import type { JsonObject, JsonValue } from "../src/types.js";

const BASELINE_BATCH_ID = "11111111-1111-4111-8111-111111111111";
const BASELINE_RELEASE_ID = "11111111-1111-4111-8111-222222222222";
const CANDIDATE_BATCH_ID = "22222222-2222-4222-8222-222222222222";

describe("catalogue reconciliation document", () => {
  it("is byte-identical across insertion-order permutations", () => {
    const baseline = [
      food("food-b", { name: "Barley", protein: "10" }),
      food("food-a", { name: "Oats", protein: "12", serving: true }),
    ];
    const candidate = [
      food("food-c", { name: "Corn", protein: "8" }),
      food("food-a", { name: "Oats", protein: "12", serving: true }),
    ];
    const first = buildCatalogueReconciliationDocument(
      input({ baselineFoods: baseline, candidateFoods: candidate }),
    );
    const second = buildCatalogueReconciliationDocument(
      input({
        baselineFoods: [...baseline].reverse().map(reverseComponents),
        candidateFoods: [...candidate].reverse().map(reverseComponents),
        baselineMappings: [...mappings()].reverse(),
        candidateMappings: [...mappings()].reverse(),
      }),
    );

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.reconciliationSha256).toBe(second.reconciliationSha256);
    expect(() => verifyCatalogueReconciliationDocument(first)).not.toThrow();
    expect(first.evidence.records).toMatchObject({
      added: [{ sourceFoodKey: "food-c" }],
      removed: [{ sourceFoodKey: "food-b" }],
      unchangedCount: "1",
    });
  });

  it("represents first activation with a null baseline and every candidate record added", () => {
    const document = buildCatalogueReconciliationDocument(
      input({
        baseline: null,
        baselineFoods: [],
        baselineMappings: [],
        candidateFoods: [food("food-b"), food("food-a")],
      }),
    );

    expect(document.evidence.baseline).toBeNull();
    expect((document.evidence.barcodes as JsonObject).baselineAssignments).toEqual([]);
    expect(document.evidence.counts).toMatchObject({
      addedRecords: "2",
      baselineRecords: "0",
      candidateRecords: "2",
      recordDelta: "2",
    });
    expect(document.evidence.records).toMatchObject({
      added: [{ sourceFoodKey: "food-a" }, { sourceFoodKey: "food-b" }],
      changed: [],
      removed: [],
      unchangedCount: "0",
    });
  });

  it("distinguishes an existing empty promoted baseline from no baseline", () => {
    const document = buildCatalogueReconciliationDocument(
      input({ baselineFoods: [], baselineMappings: [], candidateFoods: [food("food-a")] }),
    );

    expect(document.evidence.baseline).toMatchObject({ releaseId: BASELINE_RELEASE_ID });
    expect(document.evidence.counts).toMatchObject({ baselineRecords: "0", candidateRecords: "1" });
    expect(document.evidence.records).toMatchObject({
      added: [{ sourceFoodKey: "food-a" }],
      changed: [],
      removed: [],
      unchangedCount: "0",
    });
    expect(() => verifyCatalogueReconciliationDocument(document)).not.toThrow();
  });

  it("rejects catalogue or mapping snapshots when baseline provenance is null", () => {
    expect(() =>
      buildCatalogueReconciliationDocument(
        input({ baseline: null, baselineFoods: [food("food-a")], baselineMappings: [] }),
      ),
    ).toThrow("null baseline cannot have");
    expect(() =>
      buildCatalogueReconciliationDocument(
        input({ baseline: null, baselineFoods: [], baselineMappings: mappings() }),
      ),
    ).toThrow("null baseline cannot have");
  });

  it("reports semantic fields, nutrient, serving, mapping, barcode, and missingness changes", () => {
    const baselineFood = food("food-a", {
      gtin: "00000000000017",
      name: "Oats",
      protein: "0",
      serving: true,
      traceSodium: true,
    });
    const candidateFood = food("food-a", {
      gtin: "00000000000024",
      name: "Oats updated",
      protein: null,
      serving: false,
      sodium: "0",
    });
    const document = buildCatalogueReconciliationDocument(
      input({
        baselineFoods: [baselineFood],
        baselineMappings: mappings(),
        candidateFoods: [candidateFood],
        candidateMappings: [
          { ...mappings()[0], conversionMultiplier: "2", revisionId: revision("9") },
          mappings()[1],
        ],
      }),
    );
    const records = document.evidence.records as JsonObject;
    const changed = (records.changed as readonly JsonObject[])[0];

    expect(changed).toMatchObject({
      barcode: {
        candidate: { gtin: "00000000000024", marketCode: "US" },
        current: { gtin: "00000000000017", marketCode: "US" },
      },
      fields: ["name", "normalizedName"],
      sourceFoodKey: "food-a",
    });
    expect(changed?.nutrients).toMatchObject([
      { identity: "protein", status: "removed" },
      { identity: "sodium", status: "changed" },
    ]);
    expect(changed?.servings).toMatchObject([{ identity: "cup", status: "removed" }]);
    expect(document.evidence.missingnessTransitions).toEqual([
      {
        candidateState: "missing",
        currentState: "zero",
        nutrientCode: "protein",
        sourceFoodKey: "food-a",
      },
      {
        candidateState: "zero",
        currentState: "trace",
        nutrientCode: "sodium",
        sourceFoodKey: "food-a",
      },
    ]);
    expect(document.evidence.mappings).toMatchObject({
      digestChanged: false,
      transitionScope: "materialized-observations-only",
      transitions: [{ sourceNutrientKey: "1003", status: "changed" }],
    });
  });

  it("reports barcode reassignment, collisions, rejected identities, and exact rates", () => {
    const shared = "00000000000017";
    const document = buildCatalogueReconciliationDocument(
      input({
        baselineFoods: [food("old-owner", { gtin: shared })],
        candidateFoods: [
          food("new-owner", { gtin: shared }),
          food("collision-owner", { gtin: shared }),
        ],
        rejectedCandidateBarcodes: [
          {
            marketCode: "US",
            normalizedGtin: null,
            rawValue: "bad",
            reasonCode: "BARCODE_INVALID_GTIN",
            sourceFoodKey: "z",
          },
          {
            marketCode: "US",
            normalizedGtin: "00000000000024",
            rawValue: "00000000000024",
            reasonCode: "BARCODE_CROSS_SOURCE_CONFLICT",
            sourceFoodKey: "a",
          },
        ],
      }),
    );
    const barcodes = document.evidence.barcodes as JsonObject;

    expect(barcodes.baselineAssignments).toEqual([
      { gtin: shared, marketCode: "US", sourceFoodKey: "old-owner" },
    ]);
    expect(barcodes.candidateCollisions).toEqual([
      { gtin: shared, marketCode: "US", sourceFoodKeys: ["collision-owner", "new-owner"] },
    ]);
    expect(barcodes.candidateAssignments).toEqual([
      { gtin: shared, marketCode: "US", sourceFoodKey: "collision-owner" },
      { gtin: shared, marketCode: "US", sourceFoodKey: "new-owner" },
    ]);
    expect(barcodes.markets).toEqual([
      {
        assignmentCount: "3",
        collisionAssignmentCount: "3",
        collisionRate: { denominator: "3", numerator: "3" },
        crossSourceConflictCount: "1",
        marketCode: "US",
        withinCandidateCollisionAssignmentCount: "2",
      },
    ]);
    expect(barcodes.rejectedCandidate).toEqual([
      {
        marketCode: "US",
        normalizedGtin: "00000000000024",
        rawValue: "00000000000024",
        reasonCode: "BARCODE_CROSS_SOURCE_CONFLICT",
        sourceFoodKey: "a",
      },
      {
        marketCode: "US",
        normalizedGtin: null,
        rawValue: "bad",
        reasonCode: "BARCODE_INVALID_GTIN",
        sourceFoodKey: "z",
      },
    ]);
    expect(document.evidence.counts).toMatchObject({
      candidateBarcodes: "2",
      candidateCrossSourceBarcodeConflicts: "1",
      candidateInvalidBarcodes: "1",
      candidateRejectedBarcodes: "2",
    });
  });

  it("keeps large collision populations deterministic and linear", () => {
    const shared = "00000000000017";
    const candidateFoods = Array.from({ length: 4_096 }, (_, index) =>
      food(`food-${String(index).padStart(4, "0")}`, { gtin: shared }),
    );
    const forward = buildCatalogueReconciliationDocument(
      input({ candidateCounts: counts(candidateFoods.length), candidateFoods }),
    );
    const reversed = buildCatalogueReconciliationDocument(
      input({
        candidateCounts: counts(candidateFoods.length),
        candidateFoods: [...candidateFoods].reverse(),
      }),
    );
    const barcodes = forward.evidence.barcodes as JsonObject;
    const collisions = barcodes.candidateCollisions as readonly JsonObject[];

    expect(reversed.reconciliationSha256).toBe(forward.reconciliationSha256);
    expect(barcodes.candidateAssignments).toHaveLength(candidateFoods.length);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.sourceFoodKeys).toHaveLength(candidateFoods.length);
    expect(barcodes.markets).toEqual([
      {
        assignmentCount: "4096",
        collisionAssignmentCount: "4096",
        collisionRate: { denominator: "4096", numerator: "4096" },
        crossSourceConflictCount: "0",
        marketCode: "US",
        withinCandidateCollisionAssignmentCount: "4096",
      },
    ]);
  }, 30_000);

  it("derives exact barcode transitions from complete baseline and candidate populations", () => {
    const firstActivation = buildCatalogueReconciliationDocument(
      input({
        baseline: null,
        baselineFoods: [],
        baselineMappings: [],
        candidateFoods: [food("food-a", { gtin: "00000000000017" })],
      }),
    );
    const missingAdded = mutateAndRehash(firstActivation, (draft) => {
      mutableObjectAt(draft, ["evidence", "barcodes"]).added = [];
    });
    expect(() => verifyCatalogueReconciliationDocument(missingAdded)).toThrow(
      "Barcode added evidence does not match baseline/candidate assignments",
    );

    const existingEmptyBaseline = buildCatalogueReconciliationDocument(
      input({
        baselineFoods: [],
        baselineMappings: [],
        candidateFoods: [food("food-a", { gtin: "00000000000017" })],
      }),
    );
    const missingAddedFromExistingBaseline = mutateAndRehash(existingEmptyBaseline, (draft) => {
      mutableObjectAt(draft, ["evidence", "barcodes"]).added = [];
    });
    expect(() => verifyCatalogueReconciliationDocument(missingAddedFromExistingBaseline)).toThrow(
      "Barcode added evidence does not match baseline/candidate assignments",
    );

    const populatedBaseline = richDocument();
    const missingPopulatedAdded = mutateAndRehash(populatedBaseline, (draft) => {
      mutableObjectAt(draft, ["evidence", "barcodes"]).added = [];
    });
    expect(() => verifyCatalogueReconciliationDocument(missingPopulatedAdded)).toThrow(
      "Barcode added evidence does not match baseline/candidate assignments",
    );

    const missingReassignment = mutateAndRehash(populatedBaseline, (draft) => {
      mutableObjectAt(draft, ["evidence", "barcodes"]).reassigned = [];
    });
    expect(() => verifyCatalogueReconciliationDocument(missingReassignment)).toThrow(
      "Barcode reassigned evidence does not match baseline/candidate assignments",
    );

    const falseRemoval = mutateAndRehash(populatedBaseline, (draft) => {
      const barcodes = mutableObjectAt(draft, ["evidence", "barcodes"]);
      const candidateAssignments = barcodes.candidateAssignments as readonly unknown[];
      barcodes.removed = [clone(candidateAssignments[0])];
    });
    expect(() => verifyCatalogueReconciliationDocument(falseRemoval)).toThrow(
      "Barcode removed evidence does not match baseline/candidate assignments",
    );

    const inventedReassignment = mutateAndRehash(richDocument(), (draft) => {
      mutableObjectAt(draft, ["evidence", "barcodes", "reassigned", 0, "candidate"]).sourceFoodKey =
        "invented-owner";
    });
    expect(() => verifyCatalogueReconciliationDocument(inventedReassignment)).toThrow(
      "Barcode reassigned evidence does not match baseline/candidate assignments",
    );
  });

  it("requires a canonical complete baseline barcode population", () => {
    const firstActivation = buildCatalogueReconciliationDocument(
      input({
        baseline: null,
        baselineFoods: [],
        baselineMappings: [],
        candidateFoods: [food("food-a", { gtin: "00000000000017" })],
      }),
    );
    const nonemptyWithoutBaseline = mutateAndRehash(firstActivation, (draft) => {
      const barcodes = mutableObjectAt(draft, ["evidence", "barcodes"]);
      barcodes.baselineAssignments = clone(barcodes.candidateAssignments);
    });
    expect(() => verifyCatalogueReconciliationDocument(nonemptyWithoutBaseline)).toThrow(
      "null baseline cannot contain baseline barcode assignments",
    );

    const unsorted = mutateAndRehash(richDocument(), (draft) => {
      const barcodes = mutableObjectAt(draft, ["evidence", "barcodes"]);
      barcodes.baselineAssignments = [
        ...(barcodes.baselineAssignments as readonly unknown[]),
      ].reverse();
    });
    expect(() => verifyCatalogueReconciliationDocument(unsorted)).toThrow(
      "strictly code-point sorted",
    );

    const duplicateSourceFood = mutateAndRehash(richDocument(), (draft) => {
      mutableObjectAt(draft, ["evidence", "barcodes", "baselineAssignments", 1]).sourceFoodKey =
        "food-a";
    });
    expect(() => verifyCatalogueReconciliationDocument(duplicateSourceFood)).toThrow(
      "must contain each source food at most once",
    );
  });

  it("sorts immutable quarantine evidence and binds parser exclusions", () => {
    const document = buildCatalogueReconciliationDocument(
      input({
        candidateCounts: {
          parserExcludedNutrients: "3",
          parserExcludedPortions: "2",
          parserExcludedRecords: "1",
          stagedQuarantined: "1",
          stagedValid: "1",
        },
        quarantinedRecords: [
          {
            canonicalPayloadSha256: digest("d"),
            issues: [issue("z", "SECOND"), issue("a", "FIRST")],
            sourceRecordKey: "bad-record",
          },
        ],
      }),
    );
    const quarantine = document.evidence.quarantine as JsonObject;
    const records = quarantine.records as readonly JsonObject[];

    expect(records[0]?.issues).toEqual([issue("a", "FIRST"), issue("z", "SECOND")]);
    expect(quarantine).toMatchObject({
      parserExcludedNutrients: "3",
      parserExcludedPortions: "2",
      parserExcludedRecords: "1",
    });
  });

  it("rejects ambiguous identities, noncanonical values, and inconsistent counts", () => {
    const duplicate = food("duplicate");
    expect(() =>
      buildCatalogueReconciliationDocument(
        input({ candidateFoods: [duplicate, duplicate], candidateCounts: counts(2) }),
      ),
    ).toThrow("duplicate identity");
    expect(() =>
      buildCatalogueReconciliationDocument(
        input({ candidateFoods: [food("a", { protein: "1.0" })] }),
      ),
    ).toThrow("canonical non-negative decimal");
    expect(() =>
      buildCatalogueReconciliationDocument(
        input({ candidateCounts: { ...counts(1), parserExcludedRecords: "01" } }),
      ),
    ).toThrow("canonical unsigned decimal");
    expect(() =>
      buildCatalogueReconciliationDocument(input({ candidateCounts: counts(2) })),
    ).toThrow("stagedValid does not match");
  });

  it("strictly rejects unknown fields and any evidence or digest mutation", () => {
    const document = buildCatalogueReconciliationDocument(input());
    const unknownRoot = clone(document) as unknown as Record<string, unknown>;
    unknownRoot.unexpected = true;
    expect(() => verifyCatalogueReconciliationDocument(unknownRoot)).toThrow(
      "missing or unknown fields",
    );

    const unknownEvidence = clone(document) as unknown as Record<string, unknown>;
    (unknownEvidence.evidence as Record<string, unknown>).unexpected = true;
    unknownEvidence.reconciliationSha256 = sha256CanonicalJson({
      evidence: unknownEvidence.evidence,
      reportType: unknownEvidence.reportType,
      schemaVersion: unknownEvidence.schemaVersion,
    } as JsonValue);
    expect(() => verifyCatalogueReconciliationDocument(unknownEvidence)).toThrow(
      "missing or unknown fields",
    );

    const changedEvidence = clone(document) as unknown as Record<string, unknown>;
    (changedEvidence.evidence as Record<string, unknown>).sourceCode = "OTHER";
    expect(() => verifyCatalogueReconciliationDocument(changedEvidence)).toThrow(
      "digest does not match",
    );

    const changedDigest = clone(document) as unknown as Record<string, unknown>;
    changedDigest.reconciliationSha256 = digest("f");
    expect(() => verifyCatalogueReconciliationDocument(changedDigest)).toThrow(
      "digest does not match",
    );
  });

  it("keeps fixture candidates non-release and legacy evidence baseline-only", () => {
    const fixtureCandidate = buildCatalogueReconciliationDocument(
      input({
        candidate: {
          ...input().candidate,
          releaseClass: "fixture-nonrelease",
        },
      }),
    );
    expect(fixtureCandidate.evidence.candidate).toMatchObject({
      releaseClass: "fixture-nonrelease",
    });

    expect(() =>
      buildCatalogueReconciliationDocument(
        input({
          candidate: {
            ...input().candidate,
            evidenceBundleSha256: null,
            evidenceBundleUri: null,
            evidenceDecisionSha256: null,
            evidenceObjectVersionId: null,
            evidenceValidUntil: null,
            releaseClass: "legacy-unbound",
          },
        }),
      ),
    ).toThrow("only valid for a null-bound baseline");

    const baseline = input().baseline;
    if (!baseline) throw new Error("Expected the default reconciliation baseline");
    expect(() =>
      buildCatalogueReconciliationDocument(
        input({ baseline: { ...baseline, releaseClass: "fixture-nonrelease" } }),
      ),
    ).toThrow("cannot be an active baseline");

    expect(() =>
      buildCatalogueReconciliationDocument(
        input({
          candidate: {
            ...input().candidate,
            evidenceBundleUri: `${input().candidate.evidenceBundleUri}?credential=forbidden`,
          },
        }),
      ),
    ).toThrow("credential-free content-addressed S3 URI");

    for (const evidenceObjectVersionId of [" leading-space", "x".repeat(513), "invalid%escape"]) {
      expect(() =>
        buildCatalogueReconciliationDocument(
          input({
            candidate: {
              ...input().candidate,
              evidenceObjectVersionId,
            },
          }),
        ),
      ).toThrow("bounded provider-neutral opaque identifier");
    }
  });

  it("rejects unknown runtime fields throughout builder inputs", () => {
    const paths: readonly (readonly (string | number)[])[] = [
      [],
      ["candidate"],
      ["baselineFoods", 0],
      ["baselineFoods", 0, "nutrients", 0],
      ["baselineFoods", 0, "nutrients", 0, "metadata"],
      ["baselineFoods", 0, "servings", 0],
      ["baselineFoods", 0, "servings", 0, "metadata"],
      ["baselineMappings", 0],
      ["quarantinedRecords", 0],
      ["quarantinedRecords", 0, "issues", 0],
    ];
    for (const path of paths) {
      const draft = clone(richInput()) as unknown as Record<string, unknown>;
      mutableObjectAt(draft, path).unexpected = true;
      expect(() =>
        buildCatalogueReconciliationDocument(draft as unknown as CatalogueReconciliationBuildInput),
      ).toThrow("missing or unknown fields");
    }
  });

  it("rejects recomputed-digest unknown fields at every report nesting layer", () => {
    const paths: readonly (readonly (string | number)[])[] = [
      ["evidence", "baseline"],
      ["evidence", "candidate"],
      ["evidence", "barcodes", "added", 0],
      ["evidence", "barcodes", "baselineAssignments", 0],
      ["evidence", "barcodes", "candidateAssignments", 0],
      ["evidence", "barcodes", "candidateCollisions", 0],
      ["evidence", "barcodes", "markets", 0, "collisionRate"],
      ["evidence", "barcodes", "reassigned", 0, "candidate"],
      ["evidence", "barcodes", "rejectedCandidate", 0],
      ["evidence", "mappings", "transitions", 0, "candidate"],
      ["evidence", "quarantine", "records", 0],
      ["evidence", "quarantine", "records", 0, "issues", 0],
      ["evidence", "records", "added", 0],
      ["evidence", "records", "changed", 0],
      ["evidence", "records", "changed", 0, "nutrients", 0, "current"],
      ["evidence", "records", "changed", 0, "nutrients", 0, "current", "metadata"],
      ["evidence", "records", "changed", 0, "servings", 0, "current"],
      ["evidence", "records", "changed", 0, "servings", 0, "current", "metadata"],
      ["evidence", "missingnessStateEvidence", 0],
      ["evidence", "missingnessTransitions", 0],
    ];
    for (const path of paths) {
      const tampered = mutateAndRehash(richDocument(), (draft) => {
        mutableObjectAt(draft, path).unexpected = true;
      });
      expect(() => verifyCatalogueReconciliationDocument(tampered)).toThrow(
        "missing or unknown fields",
      );
    }
  });

  it("rejects internally balanced count, delta, digest, rate, status, and null mutations", () => {
    const mutations: readonly ((draft: Record<string, unknown>) => void)[] = [
      (draft) => {
        const counts = mutableObjectAt(draft, ["evidence", "counts"]);
        counts.addedRecords = "3";
        counts.candidateRecords = "4";
        counts.candidateStagedValid = "4";
        counts.recordDelta = "2";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "counts"]).nutrientDelta = "99";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "mappings"]).digestChanged = false;
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "quarantine"]).parserReportSha256 = digest("f");
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "barcodes", "markets", 0, "collisionRate"]).numerator =
          "1";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "mappings", "transitions", 0]).status = "added";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "records", "changed", 0, "nutrients", 1]).status =
          "added";
      },
      (draft) => {
        const barcode = mutableObjectAt(draft, ["evidence", "records", "changed", 0, "barcode"]);
        barcode.candidate = null;
        barcode.current = null;
      },
      (draft) => {
        const transition = mutableObjectAt(draft, ["evidence", "missingnessTransitions", 0]);
        transition.candidateState = transition.currentState;
      },
      (draft) => {
        const state = mutableObjectAt(draft, ["evidence", "missingnessStateEvidence", 0]);
        state.candidateState = state.currentState;
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "quarantine", "records", 0, "issues", 0]).disposition =
          "ignore";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "barcodes", "rejectedCandidate", 0]).reasonCode =
          "UNKNOWN";
      },
      (draft) => {
        mutableObjectAt(draft, [
          "evidence",
          "records",
          "changed",
          0,
          "nutrients",
          0,
          "current",
        ]).valueStatus = "unknown";
      },
      (draft) => {
        mutableObjectAt(draft, [
          "evidence",
          "records",
          "changed",
          0,
          "servings",
          0,
          "current",
        ]).unitKind = "other";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "barcodes", "added", 0]).gtin = "00000000000018";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "barcodes", "candidateAssignments", 0]).gtin =
          "00000000000018";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "barcodes", "baselineAssignments", 0]).sourceFoodKey =
          "changed-baseline-owner";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "counts"]).baselineBarcodes = "99";
      },
      (draft) => {
        mutableObjectAt(draft, ["evidence", "records", "changed", 0]).fields = ["name", "kind"];
      },
    ];
    for (const mutate of mutations) {
      const tampered = mutateAndRehash(richDocument(), mutate);
      expect(() => verifyCatalogueReconciliationDocument(tampered)).toThrow();
    }
  });

  it("keeps search and index measurements explicitly outside database-only evidence", () => {
    const document = buildCatalogueReconciliationDocument(input());
    expect(document.evidence.scope).toBe("database-catalogue-only");
    expect(document.evidence.separateEvidenceRequired).toEqual([
      "high-impact-nutrient-outlier-review",
      "full-nutrient-mapping-registry-review",
      "representative-search-relevance",
      "zero-result-rate",
      "index-document-count",
      "index-build-time",
      "index-p95-latency",
      "index-memory-footprint",
      "index-disk-footprint",
    ]);
    expect(canonicalJson(document)).not.toContain("promotionEligible");
  });
});

function input(
  overrides: Partial<CatalogueReconciliationBuildInput> = {},
): CatalogueReconciliationBuildInput {
  const baselineFoods = overrides.baselineFoods ?? [food("food-a")];
  const candidateFoods = overrides.candidateFoods ?? [food("food-a")];
  return {
    baseline: {
      artifactBytes: "1000",
      artifactSha256: digest("1"),
      batchId: BASELINE_BATCH_ID,
      evidenceBundleSha256: digest("7"),
      evidenceBundleUri: `s3://evidence/sha256/${digest("7")}/baseline.json`,
      evidenceDecisionSha256: digest("8"),
      evidenceObjectVersionId: "baseline-version-1",
      evidenceValidUntil: "2099-01-01T00:00:00.000Z",
      nutrientMappingDigest: digest("2"),
      parserBuildSha256: digest("3"),
      parserReportSha256: digest("4"),
      parserVersion: "fixture-parser@1",
      releaseClass: "live-reviewed",
      releaseId: BASELINE_RELEASE_ID,
      releaseKey: "baseline-release",
      rightsManifestSha256: digest("5"),
      validationDigest: digest("6"),
    },
    baselineFoods,
    baselineMappings: mappings(),
    candidate: {
      artifactBytes: "1001",
      artifactSha256: digest("7"),
      batchId: CANDIDATE_BATCH_ID,
      evidenceBundleSha256: digest("c"),
      evidenceBundleUri: `s3://evidence/sha256/${digest("c")}/candidate.json`,
      evidenceDecisionSha256: digest("d"),
      evidenceObjectVersionId: "candidate-version-1",
      evidenceValidUntil: "2099-01-01T00:00:00.000Z",
      nutrientMappingDigest: digest("2"),
      parserBuildSha256: digest("8"),
      parserReportSha256: digest("9"),
      parserVersion: "fixture-parser@2",
      releaseClass: "live-reviewed",
      releaseKey: "candidate-release",
      rightsManifestSha256: digest("a"),
      validationDigest: digest("b"),
    },
    candidateCounts: counts(candidateFoods.length),
    candidateFoods,
    candidateMappings: mappings(),
    quarantinedRecords: [],
    rejectedCandidateBarcodes: [],
    sourceCode: "FIXTURE",
    ...overrides,
  };
}

function richInput(): CatalogueReconciliationBuildInput {
  const base = input();
  return input({
    baselineFoods: [
      food("food-a", {
        gtin: "00000000000017",
        name: "Oats",
        protein: "0",
        serving: true,
        traceSodium: true,
      }),
      food("old-owner", { gtin: "00000000000024", name: "Old owner" }),
    ],
    baselineMappings: mappings(),
    candidate: { ...base.candidate, nutrientMappingDigest: digest("f") },
    candidateCounts: { ...counts(3), stagedQuarantined: "1" },
    candidateFoods: [
      food("food-a", {
        gtin: "00000000000024",
        name: "Oats updated",
        protein: null,
        serving: false,
        sodium: "0",
      }),
      food("food-b", { gtin: "00000000000031", name: "Collision B" }),
      food("food-c", { gtin: "00000000000031", name: "Collision C" }),
    ],
    candidateMappings: [
      { ...mappings()[0], conversionMultiplier: "2", revisionId: revision("9") },
      mappings()[1],
    ],
    quarantinedRecords: [
      {
        canonicalPayloadSha256: digest("d"),
        issues: [issue("$.identity.name", "INVALID_NAME")],
        sourceRecordKey: "quarantined-record",
      },
    ],
    rejectedCandidateBarcodes: [
      {
        marketCode: "US",
        normalizedGtin: null,
        rawValue: "bad",
        reasonCode: "BARCODE_INVALID_GTIN",
        sourceFoodKey: "food-z",
      },
    ],
  });
}

function richDocument() {
  return buildCatalogueReconciliationDocument(richInput());
}

function mutateAndRehash(
  document: ReturnType<typeof buildCatalogueReconciliationDocument>,
  mutate: (draft: Record<string, unknown>) => void,
): Record<string, unknown> {
  const draft = clone(document) as unknown as Record<string, unknown>;
  mutate(draft);
  draft.reconciliationSha256 = sha256CanonicalJson({
    evidence: draft.evidence,
    reportType: draft.reportType,
    schemaVersion: draft.schemaVersion,
  } as JsonValue);
  return draft;
}

function mutableObjectAt(
  root: Record<string, unknown>,
  path: readonly (string | number)[],
): Record<string, unknown> {
  let current: unknown = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) throw new Error(`Expected array at path segment ${part}`);
      current = current[part];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw new Error(`Expected object at path segment ${part}`);
      }
      current = (current as Record<string, unknown>)[part];
    }
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Expected mutable object at path");
  }
  return current as Record<string, unknown>;
}

function counts(valid: number) {
  return {
    parserExcludedNutrients: "0",
    parserExcludedPortions: "0",
    parserExcludedRecords: "0",
    stagedQuarantined: "0",
    stagedValid: String(valid),
  } as const;
}

function food(
  sourceFoodKey: string,
  options: {
    readonly gtin?: string | null;
    readonly name?: string;
    readonly protein?: string | null;
    readonly serving?: boolean;
    readonly sodium?: string | null;
    readonly traceSodium?: boolean;
  } = {},
): CatalogueReconciliationFoodSnapshot {
  const nutrients = [];
  if (options.protein !== null) {
    nutrients.push(nutrient("protein", "1003", options.protein ?? "12"));
  }
  if (options.traceSodium) nutrients.push(nutrient("sodium", "1093", "0", "trace"));
  else if (options.sodium !== null && options.sodium !== undefined) {
    nutrients.push(nutrient("sodium", "1093", options.sodium));
  }
  const name = options.name ?? "Fixture food";
  return {
    basisQuantity: "100",
    basisUnit: "g",
    brandName: null,
    description: null,
    descriptionFr: null,
    gtin: options.gtin ?? null,
    kind: options.gtin ? "branded" : "generic",
    languageTag: "en",
    marketCode: "US",
    name,
    normalizedName: name.toLowerCase(),
    nutrients,
    servings: options.serving
      ? [
          {
            displayOrder: 0,
            gramWeight: "81",
            isDefault: false,
            label: "1 cup",
            metadata: {},
            milliliterVolume: null,
            quantity: "1",
            sourceServingKey: "cup",
            unit: "cup",
            unitKind: "count",
          },
        ]
      : [],
    sourceDataType: "Foundation",
    sourceFoodKey,
    sourceModifiedAt: "2026-08-15T00:00:00.000Z",
    sourcePayloadSha256: digest(sourceFoodKey === "food-a" ? "c" : "d"),
  };
}

function nutrient(
  nutrientCode: string,
  sourceNutrientKey: string,
  amount: string,
  valueStatus: "calculated" | "estimated" | "label" | "measured" | "trace" = "measured",
) {
  const mappingRevisionId = revision(sourceNutrientKey === "1003" ? "1" : "2");
  return {
    amount,
    canonicalUnit: "g",
    mappingRevisionId,
    metadata: {
      dataPoints: null,
      ...(valueStatus === "trace" ? { detectionLimit: null } : {}),
      derivationCode: null,
      mappingRevisionId,
      sourceName: nutrientCode,
      sourceNutrientId: sourceNutrientKey,
      sourceUnit: "g",
    },
    nutrientCode,
    sourceAmount: valueStatus === "trace" ? null : amount,
    sourceBasisQuantity: valueStatus === "trace" ? null : "100",
    sourceBasisUnit: valueStatus === "trace" ? null : ("g" as const),
    sourceName: nutrientCode,
    sourceNutrientKey,
    sourceUnit: valueStatus === "trace" ? null : "g",
    valueStatus,
  };
}

function mappings(): [
  CatalogueReconciliationMappingSnapshot,
  CatalogueReconciliationMappingSnapshot,
] {
  return [
    {
      canonicalNutrientCode: "protein",
      canonicalUnit: "g",
      conversionMultiplier: "1",
      revisionId: revision("1"),
      sourceNutrientKey: "1003",
      sourceUnit: "g",
    },
    {
      canonicalNutrientCode: "sodium",
      canonicalUnit: "mg",
      conversionMultiplier: "1",
      revisionId: revision("2"),
      sourceNutrientKey: "1093",
      sourceUnit: "mg",
    },
  ];
}

function reverseComponents(value: CatalogueReconciliationFoodSnapshot) {
  return {
    ...value,
    nutrients: [...value.nutrients].reverse(),
    servings: [...value.servings].reverse(),
  };
}

function issue(path: string, code: string): JsonObject {
  return {
    code,
    disposition: "exclude_record",
    message: code,
    path,
    severity: "error",
  };
}

function digest(character: string): string {
  return character.repeat(64);
}

function revision(character: string): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${character.repeat(12)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
