import { describe, expect, it } from "vitest";
import {
  ACQUISITION_EVIDENCE_CONTRACT_VERSION,
  assembleAcquisitionReviewCandidate,
  parseAuthenticatedAcquisitionSidecar,
  parseRetainedArtifactReceipt,
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
        ? `S3://FOOD-SOURCE-ARTIFACTS/fdc/sha256/${sha256}/release.zip`
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

  it("canonicalizes sidecar order, property order, and equivalent URL spellings", () => {
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
    equivalentReceipt.objectUri = `S3://FOOD-SOURCE-ARTIFACTS/fdc/sha256/${sha256}/release.zip`;
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
