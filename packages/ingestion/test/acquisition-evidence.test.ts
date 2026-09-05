import { describe, expect, it } from "vitest";
import {
  ACQUISITION_EVIDENCE_CONTRACT_VERSION,
  type AuthenticatedReleaseEvidenceBundleV1,
  assembleAcquisitionReviewCandidate,
  assertAuthenticatedReleaseEvidenceBundle,
  authenticatedReleaseEvidenceBundleSha256,
  type CurrentRetentionVerificationV1,
  type FoodReleaseAuthorityDecisionV1,
  type FoodSourceManifestV4,
  manifestAuthoritySubjectSha256,
  parseAuthenticatedAcquisitionSidecar,
  parseAuthenticatedReleaseEvidenceBundle,
  parseFoodSourceManifest,
  parseRetainedArtifactReceipt,
  sha256CanonicalJson,
} from "../src/index.js";

const sha256 = "a".repeat(64);

describe("authenticated acquisition evidence v1", () => {
  it("binds a fresh HTTPS observation to verified runner claims", () => {
    const input = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
    const parsed = parseAuthenticatedAcquisitionSidecar(input);

    expect(parsed).toMatchObject({
      contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
      kind: "authenticated-acquisition",
      observation: {
        operatorPrincipalId: "operator.one",
        freshDownload: true,
        transport: "https",
      },
      runnerClaims: {
        verification: "externally-verified",
        actorPrincipalId: "operator.one",
        runReference: "urn:ci:run:run-1",
        issuer: "https://identity.example.test/",
        subject: "operator:operator.one",
        audience: "artifact-acquisition",
        verifiedAt: "2026-09-04T08:59:00.000Z",
        sourceSha: "1".repeat(40),
        acquisitionContext: {
          isolation: "dedicated",
          sharedCache: false,
          contextId: "context-run-1",
        },
      },
    });
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.observation)).toBe(true);
    expect(Object.isFrozen(parsed.runnerClaims)).toBe(true);
  });

  it("rejects unauthenticated, cache-derived, unbound, and non-canonical claims", () => {
    const cases = [
      (value: Record<string, unknown>) => {
        runner(value).verification = "self-asserted";
      },
      (value: Record<string, unknown>) => {
        runner(value).authenticationMethod = "anonymous";
      },
      (value: Record<string, unknown>) => {
        runner(value).authenticationMethod = "signed-runner-attestation";
      },
      (value: Record<string, unknown>) => {
        observation(value).freshDownload = false;
      },
      (value: Record<string, unknown>) => {
        observation(value).transport = "cache";
      },
      (value: Record<string, unknown>) => {
        runner(value).actorPrincipalId = "another.operator";
      },
      (value: Record<string, unknown>) => {
        runner(value).actorPrincipalId = "Operator.One";
        observation(value).operatorPrincipalId = "Operator.One";
      },
      (value: Record<string, unknown>) => {
        runner(value).runReference = "https://user:secret@ci.example.test/runs/run-1";
      },
      (value: Record<string, unknown>) => {
        runner(value).runReference = "urn:ci:run:another-run";
      },
      (value: Record<string, unknown>) => {
        runner(value).issuer = "https://actor:secret@identity.example.test/";
      },
      (value: Record<string, unknown>) => {
        runner(value).verifiedAt = "2026-09-04T09:00:01.000Z";
      },
      (value: Record<string, unknown>) => {
        runnerContext(value).sharedCache = true;
      },
      (value: Record<string, unknown>) => {
        observation(value).downloadUrl = "https://user:secret@data.example.test/release.zip";
      },
      (value: Record<string, unknown>) => {
        runner(value).sourceSha = `${"ABC".repeat(13)}A`;
      },
      (value: Record<string, unknown>) => {
        runner(value).unexpected = "claim";
      },
    ];

    for (const mutate of cases) {
      const input = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
      mutate(input);
      expect(() => parseAuthenticatedAcquisitionSidecar(input)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARTIFACT" }),
      );
    }

    const redactionInput = acquisition(
      "operator.one",
      "run-1",
      "11111111-1111-4111-8111-111111111111",
    );
    runner(redactionInput).runReference = "https://actor:do-not-leak@ci.example.test/runs/run-1";
    try {
      parseAuthenticatedAcquisitionSidecar(redactionInput);
      throw new Error("expected invalid run reference");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("do-not-leak");
    }
  });

  it("snapshots getter-backed URL and tool fields exactly once before validation", () => {
    const input = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
    let urlReads = 0;
    let toolReads = 0;
    defineFlippingGetter(observation(input), "downloadUrl", () => {
      urlReads += 1;
      return urlReads === 1
        ? "HTTPS://DATA.EXAMPLE.TEST:443/release.zip"
        : "https://evil.example.test/replaced.zip";
    });
    defineFlippingGetter(observation(input), "tool", () => {
      toolReads += 1;
      return toolReads === 1 ? "artifact-acquirer/1" : "replacement-tool/9";
    });

    const parsed = parseAuthenticatedAcquisitionSidecar(input);

    expect(urlReads).toBe(1);
    expect(toolReads).toBe(1);
    expect(parsed.observation.downloadUrl).toBe("https://data.example.test/release.zip");
    expect(parsed.observation.tool).toBe("artifact-acquirer/1");
  });

  it("wraps snapshot failures without exposing getter error data", () => {
    const input = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
    defineFlippingGetter(input, "observation", () => {
      throw new Error("do-not-leak-from-getter");
    });

    try {
      parseAuthenticatedAcquisitionSidecar(input);
      throw new Error("expected snapshot failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_ARTIFACT" });
      expect(JSON.stringify(error)).not.toContain("do-not-leak-from-getter");
    }
  });
});

describe("retained artifact receipt v1", () => {
  it("validates conditional create, service checksum, and receipt-time object retention", () => {
    const parsed = parseRetainedArtifactReceipt(receipt());

    expect(parsed).toMatchObject({
      objectKey: `fdc/sha256/${sha256}/release.zip`,
      objectUri: `s3://food-source-artifacts/fdc/sha256/${sha256}/release.zip`,
      provider: "synthetic-s3",
      providerNamespace: "synthetic-account-1",
      bucket: "food-source-artifacts",
      objectVersionId: "version=0001~opaque",
      sha256,
      storageWorkload: {
        verification: "externally-verified",
        authenticationMethod: "workload-identity",
        principalId: "storage.retainer",
      },
      infrastructureControls: { versioningEnabled: true, preventDestroy: true },
      writeProof: {
        method: "conditional-create",
        condition: "object-absent",
        outcome: "created",
        noOverwrite: true,
      },
      serviceChecksum: { algorithm: "sha256", value: sha256, verified: true },
      retention: { status: "active-at-recording", mode: "compliance", enforced: true },
    });
    expect(Object.isFrozen(parsed.retention)).toBe(true);
  });

  it("rejects credential-bearing or mutable storage and unsupported proof claims", () => {
    const cases = [
      (value: Record<string, unknown>) => {
        value.objectUri = `s3://user:secret@food-source-artifacts/fdc/sha256/${sha256}/release.zip`;
      },
      (value: Record<string, unknown>) => {
        value.objectUri = "s3://food-source-artifacts/fdc/latest/release.zip";
        value.objectKey = "fdc/latest/release.zip";
      },
      (value: Record<string, unknown>) => {
        value.objectUri = `${String(value.objectUri)}?credential=secret`;
      },
      (value: Record<string, unknown>) => {
        value.objectUri = `s3://food-source-artifacts/fdc/junk/../sha256/${sha256}/release.zip`;
      },
      (value: Record<string, unknown>) => {
        value.objectUri = `s3://food-source-artifacts/fdc//sha256/${sha256}/release.zip`;
      },
      (value: Record<string, unknown>) => {
        value.objectUri = `s3://food-source-artifacts/fdc/%2e%2e/sha256/${sha256}/release.zip`;
      },
      (value: Record<string, unknown>) => {
        value.bucket = "different-artifact-bucket";
      },
      (value: Record<string, unknown>) => {
        storageWorkload(value).verification = "self-asserted";
      },
      (value: Record<string, unknown>) => {
        storageWorkload(value).principalId = "Storage.Retainer";
      },
      (value: Record<string, unknown>) => {
        storageWorkload(value).issuer = "https://workload:secret@identity.example.test/";
      },
      (value: Record<string, unknown>) => {
        storageWorkload(value).verifiedAt = "2026-09-04T09:01:01.000Z";
      },
      (value: Record<string, unknown>) => {
        writeProof(value).noOverwrite = false;
      },
      (value: Record<string, unknown>) => {
        infrastructureControls(value).versioningEnabled = false;
      },
      (value: Record<string, unknown>) => {
        infrastructureControls(value).preventDestroy = false;
      },
      (value: Record<string, unknown>) => {
        checksum(value).verified = false;
      },
      (value: Record<string, unknown>) => {
        checksum(value).value = "b".repeat(64);
      },
      (value: Record<string, unknown>) => {
        retention(value).status = "expired";
      },
      (value: Record<string, unknown>) => {
        retention(value).enforced = false;
      },
      (value: Record<string, unknown>) => {
        retention(value).retainUntil = "2026-09-04T09:01:00.000Z";
      },
    ];

    for (const mutate of cases) {
      const input = receipt();
      mutate(input);
      expect(() => parseRetainedArtifactReceipt(input)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARTIFACT" }),
      );
    }
  });

  it("snapshots getter-backed receipt fields once and returns their canonical values", () => {
    const input = receipt();
    let uriReads = 0;
    let mediaTypeReads = 0;
    defineFlippingGetter(input, "objectUri", () => {
      uriReads += 1;
      return uriReads === 1
        ? `s3://food-source-artifacts/fdc/sha256/${sha256}/release.zip`
        : `s3://evil-bucket/fdc/sha256/${sha256}/replacement.zip`;
    });
    defineFlippingGetter(input, "mediaType", () => {
      mediaTypeReads += 1;
      return mediaTypeReads === 1 ? "application/zip" : "text/plain";
    });

    const parsed = parseRetainedArtifactReceipt(input);

    expect(uriReads).toBe(1);
    expect(mediaTypeReads).toBe(1);
    expect(parsed.objectUri).toBe(`s3://food-source-artifacts/fdc/sha256/${sha256}/release.zip`);
    expect(parsed.mediaType).toBe("application/zip");
  });
});

describe("acquisition review candidate v1", () => {
  it("assembles exactly two independent matches and cannot grant import readiness", () => {
    const first = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
    const second = acquisition("operator.two", "run-2", "22222222-2222-4222-8222-222222222222");
    const storageReceipt = receipt();
    const candidate = assembleAcquisitionReviewCandidate({
      acquisitions: [first, second],
      receipt: storageReceipt,
    });

    expect(candidate).toMatchObject({
      contractVersion: 1,
      kind: "acquisition-review-candidate",
      reviewStatus: "pending-review",
      importReadiness: "not-granted",
      artifact: {
        downloadUrl: "https://data.example.test/release.zip",
        resolvedUrl: "https://storage.example.test/release.zip",
        mediaType: "application/zip",
        sha256,
        byteSize: 481_517_495,
        provider: "synthetic-s3",
        providerNamespace: "synthetic-account-1",
        bucket: "food-source-artifacts",
        objectVersionId: "version=0001~opaque",
      },
    });
    expect(candidate.acquisitions).toHaveLength(2);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.acquisitions)).toBe(true);
    expect(Object.isFrozen(candidate.artifact)).toBe(true);
    expect(first).not.toBe(candidate.acquisitions[0]);
    expect(storageReceipt).not.toBe(candidate.receipt);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(storageReceipt)).toBe(false);
  });

  it("canonicalizes sidecar order, property order, and equivalent identity URL spellings", () => {
    const first = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
    const second = acquisition("operator.two", "run-2", "22222222-2222-4222-8222-222222222222");

    const canonical = assembleAcquisitionReviewCandidate({
      acquisitions: [first, second],
      receipt: receipt(),
    });

    observation(first).downloadUrl = "HTTPS://DATA.EXAMPLE.TEST:443/release.zip";
    observation(first).resolvedUrl = "HTTPS://STORAGE.EXAMPLE.TEST:443/release.zip";
    runner(first).issuer = "HTTPS://IDENTITY.EXAMPLE.TEST:443/";
    runner(first).runReference = "URN:ci:run:run-1";
    observation(second).downloadUrl = "https://DATA.example.test:443/release.zip";
    observation(second).resolvedUrl = "https://STORAGE.example.test:443/release.zip";
    runner(second).issuer = "https://IDENTITY.example.test:443/";
    runner(second).runReference = "URN:ci:run:run-2";
    const equivalentReceipt = receipt();
    storageWorkload(equivalentReceipt).issuer = "HTTPS://IDENTITY.EXAMPLE.TEST:443/";
    storageWorkload(equivalentReceipt).runReference = "URN:ci:storage:storage-run-1";

    const permutedAndReversed = assembleAcquisitionReviewCandidate({
      acquisitions: [reversePropertyOrder(second), reversePropertyOrder(first)],
      receipt: reversePropertyOrder(equivalentReceipt),
    });

    expect(JSON.stringify(permutedAndReversed)).toBe(JSON.stringify(canonical));
    expect(
      permutedAndReversed.acquisitions.map((item) => item.runnerClaims.actorPrincipalId),
    ).toEqual(["operator.one", "operator.two"]);
  });

  it("requires pairwise-distinct authenticated issuer-subject identities", () => {
    const cases = [
      (
        first: Record<string, unknown>,
        second: Record<string, unknown>,
        _storageReceipt: Record<string, unknown>,
      ) => {
        runner(second).issuer = runner(first).issuer;
        runner(second).subject = runner(first).subject;
      },
      (
        first: Record<string, unknown>,
        second: Record<string, unknown>,
        _storageReceipt: Record<string, unknown>,
      ) => {
        runner(second).issuer = "HTTPS://IDENTITY.EXAMPLE.TEST:443";
        runner(second).subject = runner(first).subject;
      },
      (
        first: Record<string, unknown>,
        _second: Record<string, unknown>,
        storageReceipt: Record<string, unknown>,
      ) => {
        storageWorkload(storageReceipt).issuer = runner(first).issuer;
        storageWorkload(storageReceipt).subject = runner(first).subject;
      },
      (
        _first: Record<string, unknown>,
        second: Record<string, unknown>,
        storageReceipt: Record<string, unknown>,
      ) => {
        storageWorkload(storageReceipt).issuer = runner(second).issuer;
        storageWorkload(storageReceipt).subject = runner(second).subject;
      },
    ];

    for (const mutate of cases) {
      const first = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
      const second = acquisition("operator.two", "run-2", "22222222-2222-4222-8222-222222222222");
      const storageReceipt = receipt();
      mutate(first, second, storageReceipt);

      expect(() =>
        assembleAcquisitionReviewCandidate({
          acquisitions: [first, second],
          receipt: storageReceipt,
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    }
  });

  it("keeps governance retention evidence pending and non-import-ready", () => {
    const storageReceipt = receipt();
    retention(storageReceipt).mode = "governance";
    const candidate = assembleAcquisitionReviewCandidate({
      acquisitions: [
        acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111"),
        acquisition("operator.two", "run-2", "22222222-2222-4222-8222-222222222222"),
      ],
      receipt: storageReceipt,
    });

    expect(candidate.receipt.retention.mode).toBe("governance");
    expect(candidate.reviewStatus).toBe("pending-review");
    expect(candidate.importReadiness).toBe("not-granted");
  });

  it("requires exactly two distinct acquisitions", () => {
    const first = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
    const second = acquisition("operator.two", "run-2", "22222222-2222-4222-8222-222222222222");
    expect(() =>
      assembleAcquisitionReviewCandidate({ acquisitions: [first], receipt: receipt() }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    expect(() =>
      assembleAcquisitionReviewCandidate({
        acquisitions: [
          first,
          second,
          acquisition("operator.three", "run-3", "33333333-3333-4333-8333-333333333333"),
        ],
        receipt: receipt(),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));

    runner(second).actorPrincipalId = "operator.one";
    observation(second).operatorPrincipalId = "operator.one";
    expect(() =>
      assembleAcquisitionReviewCandidate({ acquisitions: [first, second], receipt: receipt() }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
  });

  it("rejects acquisition, runner-source, and receipt disagreement", () => {
    const cases = [
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        observation(second).sha256 = "b".repeat(64);
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        observation(second).byteSize = 481_517_496;
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        observation(second).resolvedUrl = "https://storage.example.test/other.zip";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        observation(second).tool = "another-acquirer/1";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        observation(second).observedAt = "2026-09-04T09:01:01.000Z";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        runner(second).runId = "run-1";
        runner(second).runReference = "urn:ci:run:run-1";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        runnerContext(second).contextId = "context-run-1";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        runner(second).repository = "another/repository";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        runner(second).workflow = "other-acquisition-workflow";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        runner(second).ref = "refs/heads/other";
      },
      (second: Record<string, unknown>, _receipt: Record<string, unknown>) => {
        runner(second).sourceSha = "2".repeat(40);
      },
      (_second: Record<string, unknown>, storageReceipt: Record<string, unknown>) => {
        storageReceipt.byteSize = 481_517_496;
      },
      (_second: Record<string, unknown>, storageReceipt: Record<string, unknown>) => {
        storageWorkload(storageReceipt).principalId = "operator.one";
      },
    ];

    for (const mutate of cases) {
      const first = acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111");
      const second = acquisition("operator.two", "run-2", "22222222-2222-4222-8222-222222222222");
      const storageReceipt = receipt();
      mutate(second, storageReceipt);
      expect(() =>
        assembleAcquisitionReviewCandidate({
          acquisitions: [first, second],
          receipt: storageReceipt,
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    }
  });
});

describe("authenticated release evidence bundle v1", () => {
  it("binds deterministic acquisition, current retention, named authority, and manifest scope", () => {
    const fixture = releaseEvidenceFixture("live-reviewed");
    const parsed = parseAuthenticatedReleaseEvidenceBundle(fixture.bundle);

    expect(parsed).toMatchObject({
      contractVersion: 1,
      kind: "authenticated-release-evidence-bundle",
      candidate: {
        reviewStatus: "pending-review",
        importReadiness: "not-granted",
      },
      currentRetention: {
        kind: "current-retention-verification",
        retention: { status: "active", enforced: true },
      },
      authorityDecision: {
        decision: "approved-for-live-staging",
        releaseClass: "live-reviewed",
        reviewerClaims: { reviewerPrincipalId: "release.reviewer" },
      },
    });
    expect(authenticatedReleaseEvidenceBundleSha256(parsed)).toBe(
      fixture.manifest.evidenceBundle?.sha256,
    );
    expect(() =>
      assertAuthenticatedReleaseEvidenceBundle(
        fixture.manifest,
        parsed,
        "2026-09-04T09:06:00.000Z",
      ),
    ).not.toThrow();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.currentRetention)).toBe(true);
    expect(Object.isFrozen(parsed.authorityDecision.reviewerClaims)).toBe(true);
  });

  it("keeps fixture authorization explicit and structural candidates non-authorizing", () => {
    const fixture = releaseEvidenceFixture("fixture-nonrelease");
    expect(fixture.bundle.authorityDecision.decision).toBe("approved-for-fixture-staging");
    expect(() =>
      assertAuthenticatedReleaseEvidenceBundle(
        fixture.manifest,
        fixture.bundle,
        "2026-09-04T09:06:00.000Z",
      ),
    ).not.toThrow();
    expect(() => parseAuthenticatedReleaseEvidenceBundle(fixture.bundle.candidate)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT" }),
    );
    expect(fixture.bundle.candidate.importReadiness).toBe("not-granted");
  });

  it("requires the current-retention verifier to be independent from acquisition and storage identities", () => {
    const identityCollisions: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        currentRetentionClaims(value).principalId = "operator.one";
      },
      (value) => {
        currentRetentionClaims(value).principalId = "operator.two";
      },
      (value) => {
        currentRetentionClaims(value).principalId = "storage.retainer";
      },
      (value) => {
        currentRetentionClaims(value).subject = "operator:operator.one";
      },
      (value) => {
        currentRetentionClaims(value).subject = "operator:operator.two";
      },
      (value) => {
        currentRetentionClaims(value).subject = "workload:artifact-retainer";
      },
    ];

    for (const collideIdentity of identityCollisions) {
      const value = structuredClone(
        releaseEvidenceFixture("live-reviewed").bundle,
      ) as unknown as Record<string, unknown>;
      collideIdentity(value);
      rebindRetentionDigest(value);
      expect(() => parseAuthenticatedReleaseEvidenceBundle(value)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARTIFACT" }),
      );
    }

    const reviewerReuse = structuredClone(
      releaseEvidenceFixture("live-reviewed").bundle,
    ) as unknown as Record<string, unknown>;
    currentRetentionClaims(reviewerReuse).principalId = "release.reviewer";
    currentRetentionClaims(reviewerReuse).subject = "reviewer:release.reviewer";
    rebindRetentionDigest(reviewerReuse);
    expect(() => parseAuthenticatedReleaseEvidenceBundle(reviewerReuse)).not.toThrow();
  });

  it("canonicalizes property order but rejects a non-deterministic candidate ordering", () => {
    const fixture = releaseEvidenceFixture("live-reviewed");
    const reversedProperties = parseAuthenticatedReleaseEvidenceBundle(
      reversePropertyOrder(fixture.bundle),
    );
    expect(authenticatedReleaseEvidenceBundleSha256(reversedProperties)).toBe(
      authenticatedReleaseEvidenceBundleSha256(fixture.bundle),
    );

    const reversedCandidate = structuredClone(fixture.bundle) as unknown as Record<string, unknown>;
    const candidate = bundleCandidate(reversedCandidate);
    candidate.acquisitions = [...(candidate.acquisitions as unknown[])].reverse();
    expect(() => parseAuthenticatedReleaseEvidenceBundle(reversedCandidate)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT" }),
    );
  });

  it("rejects component, chronology, retention, authority, and identity drift", () => {
    const cases: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        value.candidateSha256 = "f".repeat(64);
      },
      (value) => {
        currentRetention(value).objectVersionId = "version=other";
        rebindRetentionDigest(value);
      },
      (value) => {
        currentRetention(value).validUntil = "2026-09-05T09:04:00.001Z";
        currentRetentionRecord(value).retainUntil = "2033-09-04T09:03:00.000Z";
        rebindRetentionDigest(value);
      },
      (value) => {
        currentRetention(value).checkedAt = "2026-09-04T09:06:00.000Z";
        currentRetentionClaims(value).verifiedAt = "2026-09-04T09:05:00.000Z";
        rebindRetentionDigest(value);
      },
      (value) => {
        authorityDecision(value).decision = "pending-review";
      },
      (value) => {
        authorityDecision(value).candidateSha256 = "e".repeat(64);
      },
      (value) => {
        authorityScope(value).objectVersionId = "version=other";
      },
      (value) => {
        reviewerClaims(value).reviewerPrincipalId = "operator.one";
        reviewerClaims(value).subject = "operator:operator.one";
      },
      (value) => {
        reviewerClaims(value).issuer = "https://identity.example.test/";
        reviewerClaims(value).subject = "workload:artifact-retainer";
      },
      (value) => {
        authorityDecision(value).unexpected = true;
      },
    ];

    for (const mutate of cases) {
      const value = structuredClone(
        releaseEvidenceFixture("live-reviewed").bundle,
      ) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => parseAuthenticatedReleaseEvidenceBundle(value)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARTIFACT" }),
      );
    }
  });

  it("treats current-retention validUntil as an exclusive decision and evaluation boundary", () => {
    const fixture = releaseEvidenceFixture("live-reviewed");
    const decisionAtExpiry = structuredClone(fixture.bundle) as unknown as Record<string, unknown>;
    authorityDecision(decisionAtExpiry).decidedAt = currentRetention(decisionAtExpiry).validUntil;
    expect(() => parseAuthenticatedReleaseEvidenceBundle(decisionAtExpiry)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARTIFACT" }),
    );

    expect(() =>
      assertAuthenticatedReleaseEvidenceBundle(
        fixture.manifest,
        fixture.bundle,
        "2026-09-05T09:03:59.999Z",
      ),
    ).not.toThrow();
    expect(() =>
      assertAuthenticatedReleaseEvidenceBundle(
        fixture.manifest,
        fixture.bundle,
        "2026-09-05T09:04:00.000Z",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
  });

  it("rejects stale evaluation and every manifest authority-scope mismatch", () => {
    const fixture = releaseEvidenceFixture("live-reviewed");
    expect(() =>
      assertAuthenticatedReleaseEvidenceBundle(
        fixture.manifest,
        fixture.bundle,
        "2026-09-05T09:04:00.001Z",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));

    const wrongDigest = {
      ...fixture.manifest,
      evidenceBundle: {
        contractVersion: 1 as const,
        sha256: "f".repeat(64),
        objectUri: `s3://release-evidence/sha256/${"f".repeat(64)}/bundle.json`,
      },
    };
    expect(() =>
      assertAuthenticatedReleaseEvidenceBundle(
        wrongDigest,
        fixture.bundle,
        "2026-09-04T09:06:00.000Z",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));

    for (const mutate of [
      (value: Record<string, unknown>) => {
        source(value).displayName = "Changed source name";
      },
      (value: Record<string, unknown>) => {
        release(value).releaseKey = "different-release";
      },
      (value: Record<string, unknown>) => {
        manifestArtifact(value).mediaType = "application/octet-stream";
      },
      (value: Record<string, unknown>) => {
        value.releaseClass = "fixture-nonrelease";
      },
    ]) {
      const manifest = structuredClone(fixture.manifest) as unknown as Record<string, unknown>;
      mutate(manifest);
      expect(() =>
        assertAuthenticatedReleaseEvidenceBundle(
          manifest as unknown as FoodSourceManifestV4,
          fixture.bundle,
          "2026-09-04T09:06:00.000Z",
        ),
      ).toThrowError(expect.objectContaining({ code: "INVALID_ARTIFACT" }));
    }
  });
});

function releaseEvidenceFixture(releaseClass: FoodSourceManifestV4["releaseClass"]): {
  readonly bundle: AuthenticatedReleaseEvidenceBundleV1;
  readonly manifest: FoodSourceManifestV4;
} {
  const candidate = assembleAcquisitionReviewCandidate({
    acquisitions: [
      acquisition("operator.one", "run-1", "11111111-1111-4111-8111-111111111111"),
      acquisition("operator.two", "run-2", "22222222-2222-4222-8222-222222222222"),
    ],
    receipt: receipt(),
  });
  const candidateSha256 = sha256CanonicalJson(candidate);
  const currentRetention: CurrentRetentionVerificationV1 = {
    contractVersion: 1,
    kind: "current-retention-verification",
    checkedAt: "2026-09-04T09:04:00.000Z",
    validUntil: "2026-09-05T09:04:00.000Z",
    provider: candidate.receipt.provider,
    providerNamespace: candidate.receipt.providerNamespace,
    bucket: candidate.receipt.bucket,
    objectUri: candidate.receipt.objectUri,
    objectKey: candidate.receipt.objectKey,
    objectVersionId: candidate.receipt.objectVersionId,
    mediaType: candidate.receipt.mediaType,
    sha256: candidate.receipt.sha256,
    byteSize: candidate.receipt.byteSize,
    verifierClaims: {
      verification: "externally-verified",
      authenticationMethod: "workload-identity",
      principalId: "retention.verifier",
      runId: "retention-run-1",
      runReference: "urn:ci:retention:retention-run-1",
      issuer: "https://identity.example.test/",
      subject: "workload:retention-verifier",
      audience: "artifact-retention-verification",
      verifiedAt: "2026-09-04T09:03:30.000Z",
    },
    retention: {
      status: "active",
      mode: candidate.receipt.retention.mode,
      enforced: true,
      retainUntil: candidate.receipt.retention.retainUntil,
    },
  };
  const currentRetentionSha256 = sha256CanonicalJson(currentRetention);
  const placeholderDigest = "0".repeat(64);
  let manifest = parseFoodSourceManifest({
    manifestVersion: 4,
    templateOnly: false,
    releaseClass,
    evidenceBundle: {
      contractVersion: 1,
      sha256: placeholderDigest,
      objectUri: `s3://release-evidence/sha256/${placeholderDigest}/bundle.json`,
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
      acquiredAt: "2026-09-04T09:00:30.000Z",
      upstreamSchemaVersion: "fdc-v1",
    },
    artifact: {
      downloadUrl: candidate.artifact.downloadUrl,
      permittedResolvedUrls: [candidate.artifact.downloadUrl, candidate.artifact.resolvedUrl],
      objectUri: candidate.artifact.objectUri,
      mediaType: candidate.artifact.mediaType,
      sha256: candidate.artifact.sha256,
      byteSize: candidate.artifact.byteSize,
      publisherIntegrity: {
        publisherProvidesSha256: false,
        sha256: null,
        sha256EvidenceUrl: null,
        exactByteSize: null,
        reportedSize: "publisher display value only",
        metadataUrl: "https://fdc.nal.usda.gov/download-datasets/",
        notes: "Publisher did not provide SHA-256.",
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
      attributionFixture: "USDA FoodData Central {{releaseKey}}",
      databaseRightsNotes: "Synthetic contract fixture.",
      review: {
        status: "approved",
        reviewedAt: "2026-09-04T08:55:00.000Z",
        reviewedBy: "rights.reviewer",
        evidenceUrls: ["https://fdc.nal.usda.gov/api-guide/"],
        notes: "Synthetic contract fixture only.",
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
      releaseSpecificExpectations: { expectedFoodCount: 1 },
    },
  });
  const authorityDecision: FoodReleaseAuthorityDecisionV1 = {
    contractVersion: 1,
    kind: "food-release-authority-decision",
    decision:
      releaseClass === "live-reviewed"
        ? "approved-for-live-staging"
        : "approved-for-fixture-staging",
    decidedAt: "2026-09-04T09:05:00.000Z",
    releaseClass,
    candidateSha256,
    currentRetentionSha256,
    manifestAuthoritySubjectSha256: manifestAuthoritySubjectSha256(manifest),
    scope: {
      sourceCode: manifest.source.code,
      releaseKey: manifest.release.releaseKey,
      artifact: {
        downloadUrl: candidate.artifact.downloadUrl,
        resolvedUrl: candidate.artifact.resolvedUrl,
        objectUri: candidate.artifact.objectUri,
        objectVersionId: candidate.artifact.objectVersionId,
        mediaType: candidate.artifact.mediaType,
        sha256: candidate.artifact.sha256,
        byteSize: candidate.artifact.byteSize,
      },
    },
    reviewerClaims: {
      verification: "externally-verified",
      authenticationMethod: "oidc",
      reviewerPrincipalId: "release.reviewer",
      runId: "review-run-1",
      runReference: "urn:ci:review:review-run-1",
      issuer: "https://identity.example.test/",
      subject: "reviewer:release.reviewer",
      audience: "food-release-authority",
      verifiedAt: "2026-09-04T09:04:30.000Z",
    },
  };
  const bundle = parseAuthenticatedReleaseEvidenceBundle({
    contractVersion: 1,
    kind: "authenticated-release-evidence-bundle",
    candidate,
    candidateSha256,
    currentRetention,
    currentRetentionSha256,
    authorityDecision,
  });
  const bundleSha256 = authenticatedReleaseEvidenceBundleSha256(bundle);
  manifest = parseFoodSourceManifest({
    ...manifest,
    evidenceBundle: {
      contractVersion: 1,
      sha256: bundleSha256,
      objectUri: `s3://release-evidence/sha256/${bundleSha256}/bundle.json`,
    },
  });
  return { bundle, manifest };
}

function acquisition(
  principal: string,
  runId: string,
  acquisitionId: string,
): Record<string, unknown> {
  return {
    contractVersion: 1,
    kind: "authenticated-acquisition",
    observation: {
      acquisitionId,
      observedAt: "2026-09-04T09:00:00.000Z",
      operatorPrincipalId: principal,
      tool: "artifact-acquirer/1",
      transport: "https",
      freshDownload: true,
      downloadUrl: "https://data.example.test/release.zip",
      resolvedUrl: "https://storage.example.test/release.zip",
      etag: '"release-etag"',
      lastModified: "2026-08-19T20:12:46.000Z",
      sha256,
      byteSize: 481_517_495,
    },
    runnerClaims: {
      verification: "externally-verified",
      authenticationMethod: "oidc",
      actorPrincipalId: principal,
      runId,
      runReference: `urn:ci:run:${runId}`,
      issuer: "https://identity.example.test/",
      subject: `operator:${principal}`,
      audience: "artifact-acquisition",
      verifiedAt: "2026-09-04T08:59:00.000Z",
      repository: "liangzixuan/cronometer-gold",
      workflow: "acquire-artifact-workflow",
      ref: "refs/heads/codex/retention-features",
      sourceSha: "1".repeat(40),
      acquisitionContext: {
        isolation: "dedicated",
        sharedCache: false,
        contextId: `context-${runId}`,
      },
    },
  };
}

function receipt(): Record<string, unknown> {
  const objectKey = `fdc/sha256/${sha256}/release.zip`;
  return {
    contractVersion: 1,
    kind: "retained-artifact-receipt",
    receiptId: "receipt-20260904-0001",
    retainedAt: "2026-09-04T09:01:00.000Z",
    recordedAt: "2026-09-04T09:03:00.000Z",
    provider: "synthetic-s3",
    providerNamespace: "synthetic-account-1",
    bucket: "food-source-artifacts",
    objectUri: `s3://food-source-artifacts/${objectKey}`,
    objectKey,
    objectVersionId: "version=0001~opaque",
    mediaType: "application/zip",
    sha256,
    byteSize: 481_517_495,
    storageWorkload: {
      verification: "externally-verified",
      authenticationMethod: "workload-identity",
      principalId: "storage.retainer",
      runId: "storage-run-1",
      runReference: "urn:ci:storage:storage-run-1",
      issuer: "https://identity.example.test/",
      subject: "workload:artifact-retainer",
      audience: "artifact-retention",
      verifiedAt: "2026-09-04T09:00:30.000Z",
    },
    infrastructureControls: {
      versioningEnabled: true,
      preventDestroy: true,
    },
    writeProof: {
      method: "conditional-create",
      condition: "object-absent",
      outcome: "created",
      noOverwrite: true,
      serviceRequestId: "request=0001~opaque",
    },
    serviceChecksum: {
      algorithm: "sha256",
      value: sha256,
      verified: true,
      verifiedAt: "2026-09-04T09:02:00.000Z",
    },
    retention: {
      status: "active-at-recording",
      mode: "compliance",
      enforced: true,
      retainUntil: "2033-09-04T09:03:00.000Z",
    },
  };
}

function observation(value: Record<string, unknown>): Record<string, unknown> {
  return value.observation as Record<string, unknown>;
}

function runner(value: Record<string, unknown>): Record<string, unknown> {
  return value.runnerClaims as Record<string, unknown>;
}

function writeProof(value: Record<string, unknown>): Record<string, unknown> {
  return value.writeProof as Record<string, unknown>;
}

function runnerContext(value: Record<string, unknown>): Record<string, unknown> {
  return runner(value).acquisitionContext as Record<string, unknown>;
}

function infrastructureControls(value: Record<string, unknown>): Record<string, unknown> {
  return value.infrastructureControls as Record<string, unknown>;
}

function storageWorkload(value: Record<string, unknown>): Record<string, unknown> {
  return value.storageWorkload as Record<string, unknown>;
}

function checksum(value: Record<string, unknown>): Record<string, unknown> {
  return value.serviceChecksum as Record<string, unknown>;
}

function retention(value: Record<string, unknown>): Record<string, unknown> {
  return value.retention as Record<string, unknown>;
}

function bundleCandidate(value: Record<string, unknown>): Record<string, unknown> {
  return value.candidate as Record<string, unknown>;
}

function currentRetention(value: Record<string, unknown>): Record<string, unknown> {
  return value.currentRetention as Record<string, unknown>;
}

function currentRetentionClaims(value: Record<string, unknown>): Record<string, unknown> {
  return currentRetention(value).verifierClaims as Record<string, unknown>;
}

function currentRetentionRecord(value: Record<string, unknown>): Record<string, unknown> {
  return currentRetention(value).retention as Record<string, unknown>;
}

function authorityDecision(value: Record<string, unknown>): Record<string, unknown> {
  return value.authorityDecision as Record<string, unknown>;
}

function authorityScope(value: Record<string, unknown>): Record<string, unknown> {
  const scope = authorityDecision(value).scope as Record<string, unknown>;
  return scope.artifact as Record<string, unknown>;
}

function reviewerClaims(value: Record<string, unknown>): Record<string, unknown> {
  return authorityDecision(value).reviewerClaims as Record<string, unknown>;
}

function rebindRetentionDigest(value: Record<string, unknown>): void {
  const digest = sha256CanonicalJson(currentRetention(value));
  value.currentRetentionSha256 = digest;
  authorityDecision(value).currentRetentionSha256 = digest;
}

function source(value: Record<string, unknown>): Record<string, unknown> {
  return value.source as Record<string, unknown>;
}

function release(value: Record<string, unknown>): Record<string, unknown> {
  return value.release as Record<string, unknown>;
}

function manifestArtifact(value: Record<string, unknown>): Record<string, unknown> {
  return value.artifact as Record<string, unknown>;
}

function defineFlippingGetter(
  value: Record<string, unknown>,
  key: string,
  read: () => unknown,
): void {
  Object.defineProperty(value, key, {
    configurable: true,
    enumerable: true,
    get: read,
  });
}

function reversePropertyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversePropertyOrder);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reversePropertyOrder(child)]),
  );
}
