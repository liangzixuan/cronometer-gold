import { writeFile } from "node:fs/promises";
import {
  type AuthenticatedReleaseEvidenceBundleV1,
  assembleAcquisitionReviewCandidate,
  authenticatedReleaseEvidenceBundleSha256,
  canonicalJson,
  type FoodSourceManifestV4,
  manifestAuthoritySubjectSha256,
  parseAuthenticatedReleaseEvidenceBundle,
  parseFoodSourceManifest,
  sha256CanonicalJson,
} from "@nutrition-tracker/ingestion";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SYNTHETIC_EVIDENCE_BASE_MS = Date.now();
const syntheticInstant = (offsetMs: number): string =>
  new Date(SYNTHETIC_EVIDENCE_BASE_MS + offsetMs).toISOString();
const ACQUISITION_VERIFIED_AT = syntheticInstant(-9 * MINUTE_MS);
const ACQUISITION_OBSERVED_AT = syntheticInstant(-8 * MINUTE_MS);
const STORAGE_VERIFIED_AT = syntheticInstant(-7 * MINUTE_MS);
const MANIFEST_ACQUIRED_AT = syntheticInstant(-7 * MINUTE_MS);
const ARTIFACT_RETAINED_AT = syntheticInstant(-6 * MINUTE_MS);
const SERVICE_CHECKSUM_VERIFIED_AT = syntheticInstant(-5 * MINUTE_MS);
const RECEIPT_RECORDED_AT = syntheticInstant(-4 * MINUTE_MS);
const RETENTION_VERIFIER_VERIFIED_AT = syntheticInstant(-3 * MINUTE_MS - 30_000);
const RETENTION_CHECKED_AT = syntheticInstant(-3 * MINUTE_MS);
const REVIEWER_VERIFIED_AT = syntheticInstant(-2 * MINUTE_MS);
const DECIDED_AT = syntheticInstant(-MINUTE_MS);
const RETENTION_VALID_UNTIL = syntheticInstant(DAY_MS - 3 * MINUTE_MS);
const RETAIN_UNTIL = syntheticInstant(365 * DAY_MS);

export const SYNTHETIC_EVIDENCE_EVALUATED_AT = syntheticInstant(0);
export const SYNTHETIC_EVIDENCE_EXPIRED_AT = syntheticInstant(DAY_MS - 3 * MINUTE_MS + 1);

export interface SyntheticEvidenceRunner {
  readonly authenticationMethod: "oidc" | "workload-identity";
  readonly principalId: string;
  readonly runId: string;
  readonly runReference: string;
}

export interface SyntheticReleaseEvidenceFixture {
  readonly bundle: AuthenticatedReleaseEvidenceBundleV1;
  readonly manifest: FoodSourceManifestV4;
}

export function bindSyntheticReleaseEvidence(
  input: FoodSourceManifestV4,
  runner: SyntheticEvidenceRunner,
): SyntheticReleaseEvidenceFixture {
  const downloadUrl = requiredString(input.artifact.downloadUrl, "artifact download URL");
  const resolvedUrl = requiredString(
    input.artifact.permittedResolvedUrls[0],
    "first permitted resolved URL",
  );
  const objectUri = requiredString(input.artifact.objectUri, "artifact object URI");
  const mediaType = requiredString(input.artifact.mediaType, "artifact media type");
  const sha256 = requiredString(input.artifact.sha256, "artifact SHA-256");
  const byteSize = input.artifact.byteSize;
  if (byteSize === null || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error("artifact byte size must be a positive safe integer");
  }
  const retainedObject = parseS3ObjectUri(objectUri);
  const acquisition = (
    actorPrincipalId: string,
    runId: string,
    acquisitionId: string,
  ): Record<string, unknown> => ({
    contractVersion: 1,
    kind: "authenticated-acquisition",
    observation: {
      acquisitionId,
      observedAt: ACQUISITION_OBSERVED_AT,
      operatorPrincipalId: actorPrincipalId,
      tool: "synthetic-ingest-cli-test/1.0.0",
      transport: "https",
      freshDownload: true,
      downloadUrl,
      resolvedUrl,
      etag: null,
      lastModified: null,
      sha256,
      byteSize,
    },
    runnerClaims: {
      verification: "externally-verified",
      authenticationMethod: "oidc",
      actorPrincipalId,
      runId,
      runReference: `urn:nutrition-tracker:test:acquisition:${runId}`,
      issuer: "https://identity.example.test/",
      subject: `acquisition:${actorPrincipalId}`,
      audience: "artifact-acquisition",
      verifiedAt: ACQUISITION_VERIFIED_AT,
      repository: "liangzixuan/cronometer-gold",
      workflow: "synthetic-acquisition-fixture",
      ref: "refs/heads/codex/retention-features",
      sourceSha: "1".repeat(40),
      acquisitionContext: {
        isolation: "dedicated",
        sharedCache: false,
        contextId: `synthetic-context-${runId}`,
      },
    },
  });
  const receipt = {
    contractVersion: 1,
    kind: "retained-artifact-receipt",
    receiptId: "synthetic-receipt-20260904-0001",
    retainedAt: ARTIFACT_RETAINED_AT,
    recordedAt: RECEIPT_RECORDED_AT,
    provider: "synthetic-s3",
    providerNamespace: "synthetic-test-account",
    bucket: retainedObject.bucket,
    objectUri,
    objectKey: retainedObject.objectKey,
    objectVersionId: "synthetic-version=0001~opaque",
    mediaType,
    sha256,
    byteSize,
    storageWorkload: {
      verification: "externally-verified",
      authenticationMethod: "workload-identity",
      principalId: "service:synthetic-artifact-retainer",
      runId: "synthetic-retention-write-1",
      runReference: "urn:nutrition-tracker:test:retention:synthetic-retention-write-1",
      issuer: "https://identity.example.test/",
      subject: "workload:synthetic-artifact-retainer",
      audience: "artifact-retention",
      verifiedAt: STORAGE_VERIFIED_AT,
    },
    infrastructureControls: { versioningEnabled: true, preventDestroy: true },
    writeProof: {
      method: "conditional-create",
      condition: "object-absent",
      outcome: "created",
      noOverwrite: true,
      serviceRequestId: "synthetic-request=0001~opaque",
    },
    serviceChecksum: {
      algorithm: "sha256",
      value: sha256,
      verified: true,
      verifiedAt: SERVICE_CHECKSUM_VERIFIED_AT,
    },
    retention: {
      status: "active-at-recording",
      mode: "compliance",
      enforced: true,
      retainUntil: RETAIN_UNTIL,
    },
  };
  const candidate = assembleAcquisitionReviewCandidate({
    acquisitions: [
      acquisition(
        "principal:synthetic-acquisition-a",
        "synthetic-acquisition-a-1",
        "11111111-1111-4111-8111-111111111111",
      ),
      acquisition(
        "principal:synthetic-acquisition-b",
        "synthetic-acquisition-b-1",
        "22222222-2222-4222-8222-222222222222",
      ),
    ],
    receipt,
  });
  const candidateSha256 = sha256CanonicalJson(candidate);
  const currentRetention = {
    contractVersion: 1,
    kind: "current-retention-verification",
    checkedAt: RETENTION_CHECKED_AT,
    validUntil: RETENTION_VALID_UNTIL,
    provider: receipt.provider,
    providerNamespace: receipt.providerNamespace,
    bucket: receipt.bucket,
    objectUri: receipt.objectUri,
    objectKey: receipt.objectKey,
    objectVersionId: receipt.objectVersionId,
    mediaType: receipt.mediaType,
    sha256: receipt.sha256,
    byteSize: receipt.byteSize,
    verifierClaims: {
      verification: "externally-verified",
      authenticationMethod: "workload-identity",
      principalId: "service:synthetic-retention-verifier",
      runId: "synthetic-retention-check-1",
      runReference: "urn:nutrition-tracker:test:retention:synthetic-retention-check-1",
      issuer: "https://identity.example.test/",
      subject: "workload:synthetic-retention-verifier",
      audience: "artifact-retention-verification",
      verifiedAt: RETENTION_VERIFIER_VERIFIED_AT,
    },
    retention: {
      status: "active",
      mode: receipt.retention.mode,
      enforced: true,
      retainUntil: receipt.retention.retainUntil,
    },
  };
  const currentRetentionSha256 = sha256CanonicalJson(currentRetention);
  const placeholderDigest = "0".repeat(64);
  let manifest = parseFoodSourceManifest({
    ...input,
    manifestVersion: 4,
    templateOnly: false,
    releaseClass: "fixture-nonrelease",
    evidenceBundle: {
      contractVersion: 1,
      sha256: placeholderDigest,
      objectUri: `s3://synthetic-release-evidence/sha256/${placeholderDigest}/bundle.json`,
    },
    release: {
      ...input.release,
      acquiredAt: MANIFEST_ACQUIRED_AT,
    },
  });
  const authorityDecision = {
    contractVersion: 1,
    kind: "food-release-authority-decision",
    decision: "approved-for-fixture-staging",
    decidedAt: DECIDED_AT,
    releaseClass: "fixture-nonrelease",
    candidateSha256,
    currentRetentionSha256,
    manifestAuthoritySubjectSha256: manifestAuthoritySubjectSha256(manifest),
    scope: {
      sourceCode: manifest.source.code,
      releaseKey: manifest.release.releaseKey,
      artifact: {
        downloadUrl,
        resolvedUrl,
        objectUri,
        objectVersionId: receipt.objectVersionId,
        mediaType,
        sha256,
        byteSize,
      },
    },
    reviewerClaims: {
      verification: "externally-verified",
      authenticationMethod: runner.authenticationMethod,
      reviewerPrincipalId: runner.principalId,
      runId: runner.runId,
      runReference: runner.runReference,
      issuer: "https://identity.example.test/",
      subject: `reviewer:${runner.principalId}`,
      audience: "food-release-authority",
      verifiedAt: REVIEWER_VERIFIED_AT,
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
      objectUri: `s3://synthetic-release-evidence/sha256/${bundleSha256}/bundle.json`,
    },
  });
  return { bundle, manifest };
}

export async function writeCanonicalReleaseEvidence(
  path: string,
  bundle: AuthenticatedReleaseEvidenceBundleV1,
): Promise<void> {
  await writeFile(path, `${canonicalJson(bundle)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function parseS3ObjectUri(value: string): { readonly bucket: string; readonly objectKey: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/u.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error("artifact object URI must identify an S3 object");
  }
  return { bucket: match[1], objectKey: match[2] };
}

function requiredString(value: string | null | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}
