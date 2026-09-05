import type { ArtifactAcquisitionObservation } from "./acquisition.js";
import { canonicalJson, sha256CanonicalJson } from "./deterministic.js";
import { IngestionError, invariant } from "./errors.js";
import {
  assertImportReadyManifest,
  type FoodSourceManifestV4,
  type FoodSourceReleaseClass,
  manifestAuthoritySubjectSha256,
  parseFoodSourceManifest,
} from "./manifest.js";

export const ACQUISITION_EVIDENCE_CONTRACT_VERSION = 1 as const;

/**
 * A credential-free sidecar binding a fresh acquisition observation to claims
 * independently verified by the runner that performed it.
 */
export interface AuthenticatedAcquisitionSidecarV1 {
  readonly contractVersion: typeof ACQUISITION_EVIDENCE_CONTRACT_VERSION;
  readonly kind: "authenticated-acquisition";
  readonly observation: ArtifactAcquisitionObservation & {
    readonly transport: "https";
    readonly freshDownload: true;
  };
  readonly runnerClaims: {
    /** Claims were verified externally; this parser does not validate identity tokens. */
    readonly verification: "externally-verified";
    readonly authenticationMethod: "oidc" | "workload-identity";
    readonly actorPrincipalId: string;
    readonly runId: string;
    readonly runReference: string;
    readonly issuer: string;
    readonly subject: string;
    readonly audience: string;
    readonly verifiedAt: string;
    readonly repository: string;
    readonly workflow: string;
    readonly ref: string;
    /** The immutable Git source object ID used by the acquisition runner. */
    readonly sourceSha: string;
    readonly acquisitionContext: {
      readonly isolation: "dedicated";
      readonly sharedCache: false;
      readonly contextId: string;
    };
  };
}

/**
 * Storage-service evidence for the immutable, content-addressed raw artifact.
 * This contains identifiers and checksums only; credentials are never valid.
 */
export interface RetainedArtifactReceiptV1 {
  readonly contractVersion: typeof ACQUISITION_EVIDENCE_CONTRACT_VERSION;
  readonly kind: "retained-artifact-receipt";
  readonly receiptId: string;
  readonly retainedAt: string;
  readonly recordedAt: string;
  readonly provider: string;
  readonly providerNamespace: string;
  readonly bucket: string;
  readonly objectUri: string;
  readonly objectKey: string;
  readonly objectVersionId: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly storageWorkload: {
    /** Claims were verified externally; this parser does not validate identity tokens. */
    readonly verification: "externally-verified";
    readonly authenticationMethod: "oidc" | "workload-identity";
    readonly principalId: string;
    readonly runId: string;
    readonly runReference: string;
    readonly issuer: string;
    readonly subject: string;
    readonly audience: string;
    readonly verifiedAt: string;
  };
  readonly infrastructureControls: {
    readonly versioningEnabled: true;
    readonly preventDestroy: true;
  };
  readonly writeProof: {
    readonly method: "conditional-create";
    readonly condition: "object-absent";
    readonly outcome: "created";
    readonly noOverwrite: true;
    readonly serviceRequestId: string;
  };
  readonly serviceChecksum: {
    readonly algorithm: "sha256";
    readonly value: string;
    readonly verified: true;
    readonly verifiedAt: string;
  };
  readonly retention: {
    /** Evidence of enforced retention when recorded; future consumers must revalidate current state. */
    readonly status: "active-at-recording";
    /** Governance is review evidence only and is not irreversible compliance approval. */
    readonly mode: "governance" | "compliance";
    readonly enforced: true;
    readonly retainUntil: string;
  };
}

/**
 * Canonical, deterministic consensus evidence awaiting human/source review.
 * This is deliberately not a manifest and cannot grant import readiness.
 */
export interface AcquisitionReviewCandidateV1 {
  readonly contractVersion: typeof ACQUISITION_EVIDENCE_CONTRACT_VERSION;
  readonly kind: "acquisition-review-candidate";
  readonly reviewStatus: "pending-review";
  readonly importReadiness: "not-granted";
  readonly artifact: {
    readonly downloadUrl: string;
    readonly resolvedUrl: string;
    readonly mediaType: string;
    readonly sha256: string;
    readonly byteSize: number;
    readonly provider: string;
    readonly providerNamespace: string;
    readonly bucket: string;
    readonly objectUri: string;
    readonly objectKey: string;
    readonly objectVersionId: string;
  };
  readonly acquisitions: readonly [
    AuthenticatedAcquisitionSidecarV1,
    AuthenticatedAcquisitionSidecarV1,
  ];
  readonly receipt: RetainedArtifactReceiptV1;
}

export interface CurrentRetentionVerificationV1 {
  readonly contractVersion: typeof ACQUISITION_EVIDENCE_CONTRACT_VERSION;
  readonly kind: "current-retention-verification";
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly provider: string;
  readonly providerNamespace: string;
  readonly bucket: string;
  readonly objectUri: string;
  readonly objectKey: string;
  readonly objectVersionId: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly verifierClaims: {
    readonly verification: "externally-verified";
    readonly authenticationMethod: "oidc" | "workload-identity";
    readonly principalId: string;
    readonly runId: string;
    readonly runReference: string;
    readonly issuer: string;
    readonly subject: string;
    readonly audience: string;
    readonly verifiedAt: string;
  };
  readonly retention: {
    readonly status: "active";
    readonly mode: "governance" | "compliance";
    readonly enforced: true;
    readonly retainUntil: string;
  };
}

export interface FoodReleaseAuthorityDecisionV1 {
  readonly contractVersion: typeof ACQUISITION_EVIDENCE_CONTRACT_VERSION;
  readonly kind: "food-release-authority-decision";
  readonly decision: "approved-for-fixture-staging" | "approved-for-live-staging";
  readonly decidedAt: string;
  readonly releaseClass: FoodSourceReleaseClass;
  readonly candidateSha256: string;
  readonly currentRetentionSha256: string;
  readonly manifestAuthoritySubjectSha256: string;
  readonly scope: {
    readonly sourceCode: string;
    readonly releaseKey: string;
    readonly artifact: {
      readonly downloadUrl: string;
      readonly resolvedUrl: string;
      readonly objectUri: string;
      readonly objectVersionId: string;
      readonly mediaType: string;
      readonly sha256: string;
      readonly byteSize: number;
    };
  };
  readonly reviewerClaims: {
    readonly verification: "externally-verified";
    readonly authenticationMethod: "oidc" | "workload-identity";
    readonly reviewerPrincipalId: string;
    readonly runId: string;
    readonly runReference: string;
    readonly issuer: string;
    readonly subject: string;
    readonly audience: string;
    readonly verifiedAt: string;
  };
}

export interface AuthenticatedReleaseEvidenceBundleV1 {
  readonly contractVersion: typeof ACQUISITION_EVIDENCE_CONTRACT_VERSION;
  readonly kind: "authenticated-release-evidence-bundle";
  readonly candidate: AcquisitionReviewCandidateV1;
  readonly candidateSha256: string;
  readonly currentRetention: CurrentRetentionVerificationV1;
  readonly currentRetentionSha256: string;
  readonly authorityDecision: FoodReleaseAuthorityDecisionV1;
}

export interface AssembleAcquisitionReviewCandidateOptions {
  readonly acquisitions: readonly unknown[];
  readonly receipt: unknown;
}

export function parseAuthenticatedAcquisitionSidecar(
  input: unknown,
): AuthenticatedAcquisitionSidecarV1 {
  return parseAuthenticatedAcquisitionSnapshot(
    snapshotEvidence(input, "authenticated acquisition sidecar"),
  );
}

function parseAuthenticatedAcquisitionSnapshot(input: unknown): AuthenticatedAcquisitionSidecarV1 {
  const root = exactObject(input, "$", ["contractVersion", "kind", "observation", "runnerClaims"]);
  equal(root.contractVersion, ACQUISITION_EVIDENCE_CONTRACT_VERSION, "$.contractVersion");
  equal(root.kind, "authenticated-acquisition", "$.kind");

  const observation = exactObject(root.observation, "$.observation", [
    "acquisitionId",
    "observedAt",
    "operatorPrincipalId",
    "tool",
    "transport",
    "freshDownload",
    "downloadUrl",
    "resolvedUrl",
    "etag",
    "lastModified",
    "sha256",
    "byteSize",
  ]);
  uuidV4(observation.acquisitionId, "$.observation.acquisitionId");
  instant(observation.observedAt, "$.observation.observedAt");
  stablePrincipal(observation.operatorPrincipalId, "$.observation.operatorPrincipalId");
  stableLabel(observation.tool, "$.observation.tool");
  equal(observation.transport, "https", "$.observation.transport");
  equal(observation.freshDownload, true, "$.observation.freshDownload");
  credentialFreeHttpsUrl(observation.downloadUrl, "$.observation.downloadUrl");
  credentialFreeHttpsUrl(observation.resolvedUrl, "$.observation.resolvedUrl");
  nullableMetadata(observation.etag, "$.observation.etag");
  nullableInstant(observation.lastModified, "$.observation.lastModified");
  sha256(observation.sha256, "$.observation.sha256");
  positiveInteger(observation.byteSize, "$.observation.byteSize");
  if (observation.lastModified !== null) {
    invariant(
      Date.parse(observation.lastModified as string) <=
        Date.parse(observation.observedAt as string),
      "INVALID_ARTIFACT",
      "Artifact Last-Modified cannot be later than its observation",
    );
  }

  const runnerClaims = exactObject(root.runnerClaims, "$.runnerClaims", [
    "verification",
    "authenticationMethod",
    "actorPrincipalId",
    "runId",
    "runReference",
    "issuer",
    "subject",
    "audience",
    "verifiedAt",
    "repository",
    "workflow",
    "ref",
    "sourceSha",
    "acquisitionContext",
  ]);
  validateExternallyVerifiedIdentity(
    runnerClaims,
    "actorPrincipalId",
    "$.runnerClaims",
    observation.observedAt,
  );
  stableIdentifier(runnerClaims.repository, "$.runnerClaims.repository");
  stableIdentifier(runnerClaims.workflow, "$.runnerClaims.workflow");
  sourceRef(runnerClaims.ref, "$.runnerClaims.ref");
  sourceSha(runnerClaims.sourceSha, "$.runnerClaims.sourceSha");
  const acquisitionContext = exactObject(
    runnerClaims.acquisitionContext,
    "$.runnerClaims.acquisitionContext",
    ["isolation", "sharedCache", "contextId"],
  );
  equal(acquisitionContext.isolation, "dedicated", "$.runnerClaims.acquisitionContext.isolation");
  equal(acquisitionContext.sharedCache, false, "$.runnerClaims.acquisitionContext.sharedCache");
  stableIdentifier(acquisitionContext.contextId, "$.runnerClaims.acquisitionContext.contextId");
  invariant(
    runnerClaims.actorPrincipalId === observation.operatorPrincipalId,
    "INVALID_ARTIFACT",
    "Runner actor principal must exactly match the acquisition operator principal",
  );

  return deepFreeze({
    contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    kind: "authenticated-acquisition",
    observation: {
      acquisitionId: observation.acquisitionId as string,
      observedAt: observation.observedAt as string,
      operatorPrincipalId: observation.operatorPrincipalId as string,
      tool: observation.tool as string,
      transport: "https",
      freshDownload: true,
      downloadUrl: canonicalUrl(observation.downloadUrl as string),
      resolvedUrl: canonicalUrl(observation.resolvedUrl as string),
      etag: observation.etag as string | null,
      lastModified: observation.lastModified as string | null,
      sha256: observation.sha256 as string,
      byteSize: observation.byteSize as number,
    },
    runnerClaims: {
      verification: "externally-verified",
      authenticationMethod: runnerClaims.authenticationMethod as "oidc" | "workload-identity",
      actorPrincipalId: runnerClaims.actorPrincipalId as string,
      runId: runnerClaims.runId as string,
      runReference: canonicalUrl(runnerClaims.runReference as string),
      issuer: canonicalUrl(runnerClaims.issuer as string),
      subject: runnerClaims.subject as string,
      audience: runnerClaims.audience as string,
      verifiedAt: runnerClaims.verifiedAt as string,
      repository: runnerClaims.repository as string,
      workflow: runnerClaims.workflow as string,
      ref: runnerClaims.ref as string,
      sourceSha: runnerClaims.sourceSha as string,
      acquisitionContext: {
        isolation: "dedicated",
        sharedCache: false,
        contextId: acquisitionContext.contextId as string,
      },
    },
  });
}

export function parseRetainedArtifactReceipt(input: unknown): RetainedArtifactReceiptV1 {
  return parseRetainedArtifactReceiptSnapshot(snapshotEvidence(input, "retained artifact receipt"));
}

function parseRetainedArtifactReceiptSnapshot(input: unknown): RetainedArtifactReceiptV1 {
  const root = exactObject(input, "$", [
    "contractVersion",
    "kind",
    "receiptId",
    "retainedAt",
    "recordedAt",
    "provider",
    "providerNamespace",
    "bucket",
    "objectUri",
    "objectKey",
    "objectVersionId",
    "mediaType",
    "sha256",
    "byteSize",
    "storageWorkload",
    "infrastructureControls",
    "writeProof",
    "serviceChecksum",
    "retention",
  ]);
  equal(root.contractVersion, ACQUISITION_EVIDENCE_CONTRACT_VERSION, "$.contractVersion");
  equal(root.kind, "retained-artifact-receipt", "$.kind");
  stableIdentifier(root.receiptId, "$.receiptId");
  instant(root.retainedAt, "$.retainedAt");
  instant(root.recordedAt, "$.recordedAt");
  stableIdentifier(root.provider, "$.provider");
  stableIdentifier(root.providerNamespace, "$.providerNamespace");
  bucket(root.bucket, "$.bucket");
  objectKey(root.objectKey, "$.objectKey");
  opaqueProviderIdentifier(root.objectVersionId, "$.objectVersionId");
  sha256(root.sha256, "$.sha256");
  contentAddressedS3Uri(root.objectUri, root.bucket, root.objectKey, root.sha256);
  mediaType(root.mediaType, "$.mediaType");
  positiveInteger(root.byteSize, "$.byteSize");

  const storageWorkload = exactObject(root.storageWorkload, "$.storageWorkload", [
    "verification",
    "authenticationMethod",
    "principalId",
    "runId",
    "runReference",
    "issuer",
    "subject",
    "audience",
    "verifiedAt",
  ]);
  validateExternallyVerifiedIdentity(
    storageWorkload,
    "principalId",
    "$.storageWorkload",
    root.retainedAt,
  );

  const infrastructureControls = exactObject(
    root.infrastructureControls,
    "$.infrastructureControls",
    ["versioningEnabled", "preventDestroy"],
  );
  equal(
    infrastructureControls.versioningEnabled,
    true,
    "$.infrastructureControls.versioningEnabled",
  );
  equal(infrastructureControls.preventDestroy, true, "$.infrastructureControls.preventDestroy");

  const writeProof = exactObject(root.writeProof, "$.writeProof", [
    "method",
    "condition",
    "outcome",
    "noOverwrite",
    "serviceRequestId",
  ]);
  equal(writeProof.method, "conditional-create", "$.writeProof.method");
  equal(writeProof.condition, "object-absent", "$.writeProof.condition");
  equal(writeProof.outcome, "created", "$.writeProof.outcome");
  equal(writeProof.noOverwrite, true, "$.writeProof.noOverwrite");
  opaqueProviderIdentifier(writeProof.serviceRequestId, "$.writeProof.serviceRequestId");

  const serviceChecksum = exactObject(root.serviceChecksum, "$.serviceChecksum", [
    "algorithm",
    "value",
    "verified",
    "verifiedAt",
  ]);
  equal(serviceChecksum.algorithm, "sha256", "$.serviceChecksum.algorithm");
  sha256(serviceChecksum.value, "$.serviceChecksum.value");
  equal(serviceChecksum.verified, true, "$.serviceChecksum.verified");
  instant(serviceChecksum.verifiedAt, "$.serviceChecksum.verifiedAt");
  invariant(
    serviceChecksum.value === root.sha256,
    "INVALID_ARTIFACT",
    "Service checksum must match the retained artifact SHA-256",
  );

  const retention = exactObject(root.retention, "$.retention", [
    "status",
    "mode",
    "enforced",
    "retainUntil",
  ]);
  equal(retention.status, "active-at-recording", "$.retention.status");
  enumeration(retention.mode, "$.retention.mode", ["governance", "compliance"]);
  equal(retention.enforced, true, "$.retention.enforced");
  instant(retention.retainUntil, "$.retention.retainUntil");

  const retainedAt = Date.parse(root.retainedAt as string);
  const verifiedAt = Date.parse(serviceChecksum.verifiedAt as string);
  const recordedAt = Date.parse(root.recordedAt as string);
  const retainUntil = Date.parse(retention.retainUntil as string);
  invariant(
    retainedAt <= verifiedAt && verifiedAt <= recordedAt,
    "INVALID_ARTIFACT",
    "Receipt chronology must place checksum verification between retention and recording",
  );
  invariant(
    recordedAt < retainUntil,
    "INVALID_ARTIFACT",
    "Retention must be active when the receipt is recorded",
  );

  return deepFreeze({
    contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    kind: "retained-artifact-receipt",
    receiptId: root.receiptId as string,
    retainedAt: root.retainedAt as string,
    recordedAt: root.recordedAt as string,
    provider: root.provider as string,
    providerNamespace: root.providerNamespace as string,
    bucket: root.bucket as string,
    objectUri: canonicalS3Uri(root.objectUri as string, root.objectKey as string),
    objectKey: root.objectKey as string,
    objectVersionId: root.objectVersionId as string,
    mediaType: root.mediaType as string,
    sha256: root.sha256 as string,
    byteSize: root.byteSize as number,
    storageWorkload: {
      verification: "externally-verified",
      authenticationMethod: storageWorkload.authenticationMethod as "oidc" | "workload-identity",
      principalId: storageWorkload.principalId as string,
      runId: storageWorkload.runId as string,
      runReference: canonicalUrl(storageWorkload.runReference as string),
      issuer: canonicalUrl(storageWorkload.issuer as string),
      subject: storageWorkload.subject as string,
      audience: storageWorkload.audience as string,
      verifiedAt: storageWorkload.verifiedAt as string,
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
      serviceRequestId: writeProof.serviceRequestId as string,
    },
    serviceChecksum: {
      algorithm: "sha256",
      value: serviceChecksum.value as string,
      verified: true,
      verifiedAt: serviceChecksum.verifiedAt as string,
    },
    retention: {
      status: "active-at-recording",
      mode: retention.mode as "governance" | "compliance",
      enforced: true,
      retainUntil: retention.retainUntil as string,
    },
  });
}

export function assembleAcquisitionReviewCandidate(
  options: AssembleAcquisitionReviewCandidateOptions,
): AcquisitionReviewCandidateV1 {
  const root = exactObject(snapshotEvidence(options, "review candidate input"), "$", [
    "acquisitions",
    "receipt",
  ]);
  invariant(
    Array.isArray(root.acquisitions) && root.acquisitions.length === 2,
    "INVALID_ARTIFACT",
    "A review candidate requires exactly two authenticated acquisitions",
  );
  const orderedAcquisitions: [
    AuthenticatedAcquisitionSidecarV1,
    AuthenticatedAcquisitionSidecarV1,
  ] = [
    parseAuthenticatedAcquisitionSnapshot(root.acquisitions[0]),
    parseAuthenticatedAcquisitionSnapshot(root.acquisitions[1]),
  ];
  orderedAcquisitions.sort((left, right) =>
    lexicalCompare(acquisitionOrderKey(left), acquisitionOrderKey(right)),
  );
  const [first, second] = orderedAcquisitions;
  const receipt = parseRetainedArtifactReceiptSnapshot(root.receipt);

  const firstPrincipal = normalizedPrincipal(first.runnerClaims.actorPrincipalId);
  const secondPrincipal = normalizedPrincipal(second.runnerClaims.actorPrincipalId);
  invariant(
    firstPrincipal !== secondPrincipal,
    "INVALID_ARTIFACT",
    "Authenticated acquisition actors must be distinct",
  );
  invariant(
    first.observation.acquisitionId !== second.observation.acquisitionId,
    "INVALID_ARTIFACT",
    "Authenticated acquisition IDs must be distinct",
  );
  invariant(
    first.runnerClaims.runId !== second.runnerClaims.runId,
    "INVALID_ARTIFACT",
    "Authenticated acquisition runner IDs must be distinct",
  );
  invariant(
    first.runnerClaims.runReference !== second.runnerClaims.runReference,
    "INVALID_ARTIFACT",
    "Authenticated acquisition run references must be distinct",
  );
  invariant(
    first.runnerClaims.acquisitionContext.contextId !==
      second.runnerClaims.acquisitionContext.contextId,
    "INVALID_ARTIFACT",
    "Authenticated acquisition contexts must be distinct",
  );
  const storagePrincipal = normalizedPrincipal(receipt.storageWorkload.principalId);
  invariant(
    storagePrincipal !== firstPrincipal && storagePrincipal !== secondPrincipal,
    "INVALID_ARTIFACT",
    "Retained storage workload principal must differ from both acquisition actors",
  );
  const authenticatedSubjects = new Set([
    authenticatedSubjectKey(first.runnerClaims.issuer, first.runnerClaims.subject),
    authenticatedSubjectKey(second.runnerClaims.issuer, second.runnerClaims.subject),
    authenticatedSubjectKey(receipt.storageWorkload.issuer, receipt.storageWorkload.subject),
  ]);
  invariant(
    authenticatedSubjects.size === 3,
    "INVALID_ARTIFACT",
    "Acquisition actors and storage workload must have distinct authenticated issuer-subject identities",
  );

  const observationsMatch =
    first.observation.sha256 === second.observation.sha256 &&
    first.observation.byteSize === second.observation.byteSize &&
    first.observation.tool === second.observation.tool &&
    canonicalUrl(first.observation.downloadUrl) === canonicalUrl(second.observation.downloadUrl) &&
    canonicalUrl(first.observation.resolvedUrl) === canonicalUrl(second.observation.resolvedUrl);
  invariant(
    observationsMatch,
    "INVALID_ARTIFACT",
    "Authenticated acquisitions must agree on artifact identity and source URLs",
  );

  const runnerSourceMatches =
    first.runnerClaims.repository === second.runnerClaims.repository &&
    first.runnerClaims.workflow === second.runnerClaims.workflow &&
    first.runnerClaims.ref === second.runnerClaims.ref &&
    first.runnerClaims.sourceSha === second.runnerClaims.sourceSha;
  invariant(
    runnerSourceMatches,
    "INVALID_ARTIFACT",
    "Authenticated acquisitions must use the same reviewed runner source identity",
  );
  invariant(
    receipt.sha256 === first.observation.sha256 && receipt.byteSize === first.observation.byteSize,
    "INVALID_ARTIFACT",
    "Retained artifact receipt must match the acquisition consensus",
  );
  const retainedAt = Date.parse(receipt.retainedAt);
  invariant(
    Date.parse(first.observation.observedAt) <= retainedAt &&
      Date.parse(second.observation.observedAt) <= retainedAt,
    "INVALID_ARTIFACT",
    "Authenticated acquisitions must complete before the matching artifact is retained",
  );

  return deepFreeze({
    contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    kind: "acquisition-review-candidate",
    reviewStatus: "pending-review",
    importReadiness: "not-granted",
    artifact: {
      downloadUrl: first.observation.downloadUrl,
      resolvedUrl: first.observation.resolvedUrl,
      mediaType: receipt.mediaType,
      sha256: receipt.sha256,
      byteSize: receipt.byteSize,
      provider: receipt.provider,
      providerNamespace: receipt.providerNamespace,
      bucket: receipt.bucket,
      objectUri: receipt.objectUri,
      objectKey: receipt.objectKey,
      objectVersionId: receipt.objectVersionId,
    },
    acquisitions: [first, second],
    receipt,
  });
}

const MAXIMUM_RETENTION_VERIFICATION_VALIDITY_MS = 24 * 60 * 60 * 1_000;

export function parseAuthenticatedReleaseEvidenceBundle(
  input: unknown,
): AuthenticatedReleaseEvidenceBundleV1 {
  return parseAuthenticatedReleaseEvidenceBundleSnapshot(
    snapshotEvidence(input, "authenticated release evidence bundle"),
  );
}

export function authenticatedReleaseEvidenceBundleSha256(
  bundle: AuthenticatedReleaseEvidenceBundleV1,
): string {
  return sha256CanonicalJson(parseAuthenticatedReleaseEvidenceBundle(bundle));
}

export function assertAuthenticatedReleaseEvidenceBundle(
  manifest: FoodSourceManifestV4,
  bundle: AuthenticatedReleaseEvidenceBundleV1,
  evaluatedAt = new Date().toISOString(),
): void {
  const parsedManifest = parseFoodSourceManifest(manifest);
  assertImportReadyManifest(parsedManifest);
  const parsedBundle = parseAuthenticatedReleaseEvidenceBundle(bundle);
  instant(evaluatedAt, "$evaluatedAt");

  const bundleSha256 = sha256CanonicalJson(parsedBundle);
  invariant(
    parsedManifest.evidenceBundle.sha256 === bundleSha256,
    "INVALID_ARTIFACT",
    "Manifest evidence-bundle digest does not match the supplied canonical bundle",
  );
  invariant(
    parsedBundle.authorityDecision.manifestAuthoritySubjectSha256 ===
      manifestAuthoritySubjectSha256(parsedManifest),
    "INVALID_ARTIFACT",
    "Authority decision does not bind the exact manifest authority subject",
  );
  invariant(
    parsedBundle.authorityDecision.releaseClass === parsedManifest.releaseClass,
    "INVALID_ARTIFACT",
    "Authority decision release class does not match the manifest",
  );
  const expectedDecision =
    parsedManifest.releaseClass === "live-reviewed"
      ? "approved-for-live-staging"
      : "approved-for-fixture-staging";
  invariant(
    parsedBundle.authorityDecision.decision === expectedDecision,
    "INVALID_ARTIFACT",
    "Authority decision does not approve the manifest release class",
  );

  const scope = parsedBundle.authorityDecision.scope;
  const candidateArtifact = parsedBundle.candidate.artifact;
  const manifestArtifact = parsedManifest.artifact;
  invariant(
    scope.sourceCode === parsedManifest.source.code &&
      scope.releaseKey === parsedManifest.release.releaseKey,
    "INVALID_ARTIFACT",
    "Authority decision source or release scope does not match the manifest",
  );
  invariant(
    manifestArtifact.downloadUrl !== null &&
      manifestArtifact.objectUri !== null &&
      manifestArtifact.sha256 !== null &&
      manifestArtifact.byteSize !== null &&
      canonicalUrl(candidateArtifact.downloadUrl) === canonicalUrl(manifestArtifact.downloadUrl) &&
      parsedManifest.artifact.permittedResolvedUrls
        .map(canonicalUrl)
        .includes(canonicalUrl(candidateArtifact.resolvedUrl)) &&
      candidateArtifact.objectUri === manifestArtifact.objectUri &&
      candidateArtifact.mediaType === manifestArtifact.mediaType &&
      candidateArtifact.sha256 === manifestArtifact.sha256 &&
      candidateArtifact.byteSize === manifestArtifact.byteSize,
    "INVALID_ARTIFACT",
    "Authenticated evidence artifact does not match the manifest",
  );

  const acquiredAt = Date.parse(parsedManifest.release.acquiredAt);
  const latestObservation = Math.max(
    ...parsedBundle.candidate.acquisitions.map((entry) => Date.parse(entry.observation.observedAt)),
  );
  invariant(
    latestObservation <= acquiredAt &&
      acquiredAt <= Date.parse(parsedBundle.candidate.receipt.retainedAt),
    "INVALID_ARTIFACT",
    "Manifest acquisition time must follow both acquisitions and not follow retention",
  );

  const evaluationTime = Date.parse(evaluatedAt);
  invariant(
    Date.parse(parsedBundle.authorityDecision.decidedAt) <= evaluationTime &&
      evaluationTime < Date.parse(parsedBundle.currentRetention.validUntil),
    "INVALID_ARTIFACT",
    "Authority evidence is not current at the requested evaluation time",
  );
}

function parseAuthenticatedReleaseEvidenceBundleSnapshot(
  input: unknown,
): AuthenticatedReleaseEvidenceBundleV1 {
  const root = exactObject(input, "$", [
    "contractVersion",
    "kind",
    "candidate",
    "candidateSha256",
    "currentRetention",
    "currentRetentionSha256",
    "authorityDecision",
  ]);
  equal(root.contractVersion, ACQUISITION_EVIDENCE_CONTRACT_VERSION, "$.contractVersion");
  equal(root.kind, "authenticated-release-evidence-bundle", "$.kind");
  const candidate = parseAcquisitionReviewCandidateSnapshot(root.candidate);
  sha256(root.candidateSha256, "$.candidateSha256");
  invariant(
    root.candidateSha256 === sha256CanonicalJson(candidate),
    "INVALID_ARTIFACT",
    "Evidence bundle candidate digest does not match its canonical candidate",
  );
  const currentRetention = parseCurrentRetentionVerificationSnapshot(root.currentRetention);
  sha256(root.currentRetentionSha256, "$.currentRetentionSha256");
  invariant(
    root.currentRetentionSha256 === sha256CanonicalJson(currentRetention),
    "INVALID_ARTIFACT",
    "Evidence bundle retention digest does not match its canonical verification",
  );
  const authorityDecision = parseFoodReleaseAuthorityDecisionSnapshot(root.authorityDecision);
  invariant(
    authorityDecision.candidateSha256 === root.candidateSha256 &&
      authorityDecision.currentRetentionSha256 === root.currentRetentionSha256,
    "INVALID_ARTIFACT",
    "Authority decision does not bind the exact candidate and retention digests",
  );

  const artifact = candidate.artifact;
  const receipt = candidate.receipt;
  invariant(
    currentRetention.provider === receipt.provider &&
      currentRetention.providerNamespace === receipt.providerNamespace &&
      currentRetention.bucket === receipt.bucket &&
      currentRetention.objectUri === receipt.objectUri &&
      currentRetention.objectKey === receipt.objectKey &&
      currentRetention.objectVersionId === receipt.objectVersionId &&
      currentRetention.mediaType === receipt.mediaType &&
      currentRetention.sha256 === receipt.sha256 &&
      currentRetention.byteSize === receipt.byteSize,
    "INVALID_ARTIFACT",
    "Current-retention verification does not match the retained artifact receipt",
  );

  const acquisitionOne = candidate.acquisitions[0];
  const acquisitionTwo = candidate.acquisitions[1];
  const acquisitionAndStoragePrincipals = new Set([
    normalizedPrincipal(acquisitionOne.runnerClaims.actorPrincipalId),
    normalizedPrincipal(acquisitionTwo.runnerClaims.actorPrincipalId),
    normalizedPrincipal(receipt.storageWorkload.principalId),
  ]);
  const retentionVerifierPrincipal = normalizedPrincipal(
    currentRetention.verifierClaims.principalId,
  );
  invariant(
    !acquisitionAndStoragePrincipals.has(retentionVerifierPrincipal),
    "INVALID_ARTIFACT",
    "Current-retention verifier principal must differ from acquisition and storage principals",
  );
  const acquisitionAndStorageSubjects = new Set([
    authenticatedSubjectKey(
      acquisitionOne.runnerClaims.issuer,
      acquisitionOne.runnerClaims.subject,
    ),
    authenticatedSubjectKey(
      acquisitionTwo.runnerClaims.issuer,
      acquisitionTwo.runnerClaims.subject,
    ),
    authenticatedSubjectKey(receipt.storageWorkload.issuer, receipt.storageWorkload.subject),
  ]);
  const retentionVerifierSubject = authenticatedSubjectKey(
    currentRetention.verifierClaims.issuer,
    currentRetention.verifierClaims.subject,
  );
  invariant(
    !acquisitionAndStorageSubjects.has(retentionVerifierSubject),
    "INVALID_ARTIFACT",
    "Current-retention verifier identity must differ from acquisition and storage identities",
  );

  invariant(
    authorityDecision.scope.artifact.downloadUrl === artifact.downloadUrl &&
      authorityDecision.scope.artifact.resolvedUrl === artifact.resolvedUrl &&
      authorityDecision.scope.artifact.objectUri === artifact.objectUri &&
      authorityDecision.scope.artifact.objectVersionId === artifact.objectVersionId &&
      authorityDecision.scope.artifact.mediaType === artifact.mediaType &&
      authorityDecision.scope.artifact.sha256 === artifact.sha256 &&
      authorityDecision.scope.artifact.byteSize === artifact.byteSize,
    "INVALID_ARTIFACT",
    "Authority decision artifact scope does not match the acquisition candidate",
  );

  const receiptRecordedAt = Date.parse(receipt.recordedAt);
  const checkedAt = Date.parse(currentRetention.checkedAt);
  const validUntil = Date.parse(currentRetention.validUntil);
  const decidedAt = Date.parse(authorityDecision.decidedAt);
  invariant(
    receiptRecordedAt <= checkedAt &&
      checkedAt <= decidedAt &&
      decidedAt < validUntil &&
      validUntil - checkedAt <= MAXIMUM_RETENTION_VERIFICATION_VALIDITY_MS,
    "INVALID_ARTIFACT",
    "Release evidence chronology or retention-verification validity is invalid",
  );
  invariant(
    validUntil <= Date.parse(receipt.retention.retainUntil) &&
      currentRetention.retention.retainUntil === receipt.retention.retainUntil &&
      currentRetention.retention.mode === receipt.retention.mode,
    "INVALID_ARTIFACT",
    "Retained-object policy does not cover the authority evidence validity window",
  );

  const reviewerPrincipal = normalizedPrincipal(
    authorityDecision.reviewerClaims.reviewerPrincipalId,
  );
  invariant(
    !acquisitionAndStoragePrincipals.has(reviewerPrincipal),
    "INVALID_ARTIFACT",
    "Authority reviewer principal must differ from acquisition and storage principals",
  );
  const reviewerSubject = authenticatedSubjectKey(
    authorityDecision.reviewerClaims.issuer,
    authorityDecision.reviewerClaims.subject,
  );
  invariant(
    !acquisitionAndStorageSubjects.has(reviewerSubject),
    "INVALID_ARTIFACT",
    "Authority reviewer identity must differ from acquisition and storage identities",
  );

  return deepFreeze({
    contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    kind: "authenticated-release-evidence-bundle",
    candidate,
    candidateSha256: root.candidateSha256 as string,
    currentRetention,
    currentRetentionSha256: root.currentRetentionSha256 as string,
    authorityDecision,
  });
}

function parseAcquisitionReviewCandidateSnapshot(input: unknown): AcquisitionReviewCandidateV1 {
  const root = exactObject(input, "$.candidate", [
    "contractVersion",
    "kind",
    "reviewStatus",
    "importReadiness",
    "artifact",
    "acquisitions",
    "receipt",
  ]);
  equal(root.contractVersion, ACQUISITION_EVIDENCE_CONTRACT_VERSION, "$.candidate.contractVersion");
  equal(root.kind, "acquisition-review-candidate", "$.candidate.kind");
  equal(root.reviewStatus, "pending-review", "$.candidate.reviewStatus");
  equal(root.importReadiness, "not-granted", "$.candidate.importReadiness");
  invariant(
    Array.isArray(root.acquisitions) && root.acquisitions.length === 2,
    "INVALID_ARTIFACT",
    "Evidence bundle candidate requires exactly two acquisitions",
  );
  const acquisitions = [
    parseAuthenticatedAcquisitionSnapshot(root.acquisitions[0]),
    parseAuthenticatedAcquisitionSnapshot(root.acquisitions[1]),
  ] as const;
  const receipt = parseRetainedArtifactReceiptSnapshot(root.receipt);
  const suppliedArtifact = parseCandidateArtifact(root.artifact);
  const supplied: AcquisitionReviewCandidateV1 = {
    contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    kind: "acquisition-review-candidate",
    reviewStatus: "pending-review",
    importReadiness: "not-granted",
    artifact: suppliedArtifact,
    acquisitions,
    receipt,
  };
  const assembled = assembleAcquisitionReviewCandidate({ acquisitions, receipt });
  invariant(
    canonicalJson(supplied) === canonicalJson(assembled),
    "INVALID_ARTIFACT",
    "Supplied acquisition candidate is not the deterministic assembled candidate",
  );
  return assembled;
}

function parseCandidateArtifact(input: unknown): AcquisitionReviewCandidateV1["artifact"] {
  const artifact = exactObject(input, "$.candidate.artifact", [
    "downloadUrl",
    "resolvedUrl",
    "mediaType",
    "sha256",
    "byteSize",
    "provider",
    "providerNamespace",
    "bucket",
    "objectUri",
    "objectKey",
    "objectVersionId",
  ]);
  credentialFreeHttpsUrl(artifact.downloadUrl, "$.candidate.artifact.downloadUrl");
  credentialFreeHttpsUrl(artifact.resolvedUrl, "$.candidate.artifact.resolvedUrl");
  mediaType(artifact.mediaType, "$.candidate.artifact.mediaType");
  sha256(artifact.sha256, "$.candidate.artifact.sha256");
  positiveInteger(artifact.byteSize, "$.candidate.artifact.byteSize");
  stableIdentifier(artifact.provider, "$.candidate.artifact.provider");
  stableIdentifier(artifact.providerNamespace, "$.candidate.artifact.providerNamespace");
  bucket(artifact.bucket, "$.candidate.artifact.bucket");
  objectKey(artifact.objectKey, "$.candidate.artifact.objectKey");
  opaqueProviderIdentifier(artifact.objectVersionId, "$.candidate.artifact.objectVersionId");
  contentAddressedS3Uri(artifact.objectUri, artifact.bucket, artifact.objectKey, artifact.sha256);
  return {
    downloadUrl: canonicalUrl(artifact.downloadUrl as string),
    resolvedUrl: canonicalUrl(artifact.resolvedUrl as string),
    mediaType: artifact.mediaType as string,
    sha256: artifact.sha256 as string,
    byteSize: artifact.byteSize as number,
    provider: artifact.provider as string,
    providerNamespace: artifact.providerNamespace as string,
    bucket: artifact.bucket as string,
    objectUri: canonicalS3Uri(artifact.objectUri as string, artifact.objectKey as string),
    objectKey: artifact.objectKey as string,
    objectVersionId: artifact.objectVersionId as string,
  };
}

function parseCurrentRetentionVerificationSnapshot(input: unknown): CurrentRetentionVerificationV1 {
  const root = exactObject(input, "$.currentRetention", [
    "contractVersion",
    "kind",
    "checkedAt",
    "validUntil",
    "provider",
    "providerNamespace",
    "bucket",
    "objectUri",
    "objectKey",
    "objectVersionId",
    "mediaType",
    "sha256",
    "byteSize",
    "verifierClaims",
    "retention",
  ]);
  equal(
    root.contractVersion,
    ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    "$.currentRetention.contractVersion",
  );
  equal(root.kind, "current-retention-verification", "$.currentRetention.kind");
  instant(root.checkedAt, "$.currentRetention.checkedAt");
  instant(root.validUntil, "$.currentRetention.validUntil");
  stableIdentifier(root.provider, "$.currentRetention.provider");
  stableIdentifier(root.providerNamespace, "$.currentRetention.providerNamespace");
  bucket(root.bucket, "$.currentRetention.bucket");
  objectKey(root.objectKey, "$.currentRetention.objectKey");
  opaqueProviderIdentifier(root.objectVersionId, "$.currentRetention.objectVersionId");
  mediaType(root.mediaType, "$.currentRetention.mediaType");
  sha256(root.sha256, "$.currentRetention.sha256");
  positiveInteger(root.byteSize, "$.currentRetention.byteSize");
  contentAddressedS3Uri(root.objectUri, root.bucket, root.objectKey, root.sha256);

  const verifierClaims = exactObject(root.verifierClaims, "$.currentRetention.verifierClaims", [
    "verification",
    "authenticationMethod",
    "principalId",
    "runId",
    "runReference",
    "issuer",
    "subject",
    "audience",
    "verifiedAt",
  ]);
  validateExternallyVerifiedIdentity(
    verifierClaims,
    "principalId",
    "$.currentRetention.verifierClaims",
    root.checkedAt,
  );
  const retention = exactObject(root.retention, "$.currentRetention.retention", [
    "status",
    "mode",
    "enforced",
    "retainUntil",
  ]);
  equal(retention.status, "active", "$.currentRetention.retention.status");
  enumeration(retention.mode, "$.currentRetention.retention.mode", ["governance", "compliance"]);
  equal(retention.enforced, true, "$.currentRetention.retention.enforced");
  instant(retention.retainUntil, "$.currentRetention.retention.retainUntil");
  const checkedAt = Date.parse(root.checkedAt as string);
  const validUntil = Date.parse(root.validUntil as string);
  invariant(
    checkedAt < validUntil &&
      validUntil - checkedAt <= MAXIMUM_RETENTION_VERIFICATION_VALIDITY_MS &&
      validUntil <= Date.parse(retention.retainUntil as string),
    "INVALID_ARTIFACT",
    "Current-retention verification must be valid for at most 24 hours within retention",
  );

  return deepFreeze({
    contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    kind: "current-retention-verification",
    checkedAt: root.checkedAt as string,
    validUntil: root.validUntil as string,
    provider: root.provider as string,
    providerNamespace: root.providerNamespace as string,
    bucket: root.bucket as string,
    objectUri: canonicalS3Uri(root.objectUri as string, root.objectKey as string),
    objectKey: root.objectKey as string,
    objectVersionId: root.objectVersionId as string,
    mediaType: root.mediaType as string,
    sha256: root.sha256 as string,
    byteSize: root.byteSize as number,
    verifierClaims: {
      verification: "externally-verified",
      authenticationMethod: verifierClaims.authenticationMethod as "oidc" | "workload-identity",
      principalId: verifierClaims.principalId as string,
      runId: verifierClaims.runId as string,
      runReference: canonicalUrl(verifierClaims.runReference as string),
      issuer: canonicalUrl(verifierClaims.issuer as string),
      subject: verifierClaims.subject as string,
      audience: verifierClaims.audience as string,
      verifiedAt: verifierClaims.verifiedAt as string,
    },
    retention: {
      status: "active",
      mode: retention.mode as "governance" | "compliance",
      enforced: true,
      retainUntil: retention.retainUntil as string,
    },
  });
}

function parseFoodReleaseAuthorityDecisionSnapshot(input: unknown): FoodReleaseAuthorityDecisionV1 {
  const root = exactObject(input, "$.authorityDecision", [
    "contractVersion",
    "kind",
    "decision",
    "decidedAt",
    "releaseClass",
    "candidateSha256",
    "currentRetentionSha256",
    "manifestAuthoritySubjectSha256",
    "scope",
    "reviewerClaims",
  ]);
  equal(
    root.contractVersion,
    ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    "$.authorityDecision.contractVersion",
  );
  equal(root.kind, "food-release-authority-decision", "$.authorityDecision.kind");
  enumeration(root.decision, "$.authorityDecision.decision", [
    "approved-for-fixture-staging",
    "approved-for-live-staging",
  ]);
  instant(root.decidedAt, "$.authorityDecision.decidedAt");
  enumeration(root.releaseClass, "$.authorityDecision.releaseClass", [
    "live-reviewed",
    "fixture-nonrelease",
  ]);
  const expectedDecision =
    root.releaseClass === "live-reviewed"
      ? "approved-for-live-staging"
      : "approved-for-fixture-staging";
  invariant(
    root.decision === expectedDecision,
    "INVALID_ARTIFACT",
    "Authority decision does not match its release class",
  );
  sha256(root.candidateSha256, "$.authorityDecision.candidateSha256");
  sha256(root.currentRetentionSha256, "$.authorityDecision.currentRetentionSha256");
  sha256(root.manifestAuthoritySubjectSha256, "$.authorityDecision.manifestAuthoritySubjectSha256");

  const scope = exactObject(root.scope, "$.authorityDecision.scope", [
    "sourceCode",
    "releaseKey",
    "artifact",
  ]);
  stableIdentifier(scope.sourceCode, "$.authorityDecision.scope.sourceCode");
  stableLabel(scope.releaseKey, "$.authorityDecision.scope.releaseKey");
  const artifact = parseAuthorityDecisionArtifact(scope.artifact);
  const reviewerClaims = exactObject(root.reviewerClaims, "$.authorityDecision.reviewerClaims", [
    "verification",
    "authenticationMethod",
    "reviewerPrincipalId",
    "runId",
    "runReference",
    "issuer",
    "subject",
    "audience",
    "verifiedAt",
  ]);
  validateExternallyVerifiedIdentity(
    reviewerClaims,
    "reviewerPrincipalId",
    "$.authorityDecision.reviewerClaims",
    root.decidedAt,
  );

  return deepFreeze({
    contractVersion: ACQUISITION_EVIDENCE_CONTRACT_VERSION,
    kind: "food-release-authority-decision",
    decision: root.decision as FoodReleaseAuthorityDecisionV1["decision"],
    decidedAt: root.decidedAt as string,
    releaseClass: root.releaseClass as FoodSourceReleaseClass,
    candidateSha256: root.candidateSha256 as string,
    currentRetentionSha256: root.currentRetentionSha256 as string,
    manifestAuthoritySubjectSha256: root.manifestAuthoritySubjectSha256 as string,
    scope: {
      sourceCode: scope.sourceCode as string,
      releaseKey: scope.releaseKey as string,
      artifact,
    },
    reviewerClaims: {
      verification: "externally-verified",
      authenticationMethod: reviewerClaims.authenticationMethod as "oidc" | "workload-identity",
      reviewerPrincipalId: reviewerClaims.reviewerPrincipalId as string,
      runId: reviewerClaims.runId as string,
      runReference: canonicalUrl(reviewerClaims.runReference as string),
      issuer: canonicalUrl(reviewerClaims.issuer as string),
      subject: reviewerClaims.subject as string,
      audience: reviewerClaims.audience as string,
      verifiedAt: reviewerClaims.verifiedAt as string,
    },
  });
}

function parseAuthorityDecisionArtifact(
  input: unknown,
): FoodReleaseAuthorityDecisionV1["scope"]["artifact"] {
  const artifact = exactObject(input, "$.authorityDecision.scope.artifact", [
    "downloadUrl",
    "resolvedUrl",
    "objectUri",
    "objectVersionId",
    "mediaType",
    "sha256",
    "byteSize",
  ]);
  credentialFreeHttpsUrl(artifact.downloadUrl, "$.authorityDecision.scope.artifact.downloadUrl");
  credentialFreeHttpsUrl(artifact.resolvedUrl, "$.authorityDecision.scope.artifact.resolvedUrl");
  opaqueProviderIdentifier(
    artifact.objectVersionId,
    "$.authorityDecision.scope.artifact.objectVersionId",
  );
  mediaType(artifact.mediaType, "$.authorityDecision.scope.artifact.mediaType");
  sha256(artifact.sha256, "$.authorityDecision.scope.artifact.sha256");
  positiveInteger(artifact.byteSize, "$.authorityDecision.scope.artifact.byteSize");
  requiredString(artifact.objectUri, "$.authorityDecision.scope.artifact.objectUri");
  return {
    downloadUrl: canonicalUrl(artifact.downloadUrl as string),
    resolvedUrl: canonicalUrl(artifact.resolvedUrl as string),
    objectUri: artifact.objectUri as string,
    objectVersionId: artifact.objectVersionId as string,
    mediaType: artifact.mediaType as string,
    sha256: artifact.sha256 as string,
    byteSize: artifact.byteSize as number,
  };
}

function contentAddressedS3Uri(
  value: unknown,
  expectedBucket: unknown,
  expectedObjectKey: unknown,
  expectedSha256: unknown,
): asserts value is string {
  requiredString(value, "$.objectUri", 1, 2048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IngestionError("INVALID_ARTIFACT", "$.objectUri must be a valid S3 URI");
  }
  const key = expectedObjectKey as string;
  const digest = expectedSha256 as string;
  const pathSegments = key.split("/");
  const digestIsBound = pathSegments.some(
    (segment, index) => segment === "sha256" && pathSegments[index + 1] === digest,
  );
  const canonicalHostname = url.hostname.toLowerCase();
  const canonicalObjectUri = `s3://${expectedBucket}/${key}`;
  const bucketIsValid =
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(canonicalHostname) &&
    !canonicalHostname.includes("..") &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(canonicalHostname);
  invariant(
    url.protocol === "s3:" &&
      bucketIsValid &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      canonicalHostname === expectedBucket &&
      value === canonicalObjectUri &&
      url.pathname === `/${key}` &&
      digestIsBound,
    "INVALID_ARTIFACT",
    "Artifact objectUri must be a canonical credential-free content-addressed S3 URI matching objectKey",
  );
}

function bucket(value: unknown, path: string): asserts value is string {
  requiredString(value, path, 3, 63);
  invariant(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value as string) &&
      !(value as string).includes("..") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(value as string),
    "INVALID_ARTIFACT",
    `${path} must be a canonical S3 bucket identifier`,
    { path },
  );
}

function immutableRunReference(
  value: unknown,
  expectedRunId: unknown,
  path: string,
): asserts value is string {
  requiredString(value, path, 1, 2048);
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    throw new IngestionError(
      "INVALID_ARTIFACT",
      `${path} must be an immutable credential-free HTTPS URL or URN`,
      { path },
    );
  }
  const validHttps =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "";
  const validUrn =
    url.protocol === "urn:" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,2044}$/.test((value as string).slice(4));
  invariant(
    validHttps || validUrn,
    "INVALID_ARTIFACT",
    `${path} must be an immutable credential-free HTTPS URL or URN`,
    { path },
  );
  const runId = expectedRunId as string;
  const identitySegments = validHttps
    ? url.pathname.split("/").filter(Boolean)
    : (value as string).slice(4).split(":");
  invariant(
    identitySegments.includes(runId),
    "INVALID_ARTIFACT",
    `${path} must bind the exact runner ID`,
    { path },
  );
}

function credentialFreeHttpsUrl(value: unknown, path: string): asserts value is string {
  requiredString(value, path, 1, 2048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IngestionError("INVALID_ARTIFACT", `${path} must be a valid URL`, { path });
  }
  invariant(
    url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "",
    "INVALID_ARTIFACT",
    `${path} must be a credential-free HTTPS URL without a query or fragment`,
    { path },
  );
}

function objectKey(value: unknown, path: string): asserts value is string {
  requiredString(value, path, 1, 1024);
  const segments = (value as string).split("/");
  invariant(
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(segment),
    ),
    "INVALID_ARTIFACT",
    `${path} must be a canonical credential-free object key`,
    { path },
  );
}

function authenticationMethod(value: unknown, path: string): asserts value is string {
  enumeration(value, path, ["oidc", "workload-identity"]);
}

function validateExternallyVerifiedIdentity(
  identity: Readonly<Record<string, unknown>>,
  principalField: "actorPrincipalId" | "principalId" | "reviewerPrincipalId",
  path: string,
  authorizedActionAt: unknown,
): void {
  equal(identity.verification, "externally-verified", `${path}.verification`);
  authenticationMethod(identity.authenticationMethod, `${path}.authenticationMethod`);
  stablePrincipal(identity[principalField], `${path}.${principalField}`);
  stableIdentifier(identity.runId, `${path}.runId`);
  immutableRunReference(identity.runReference, identity.runId, `${path}.runReference`);
  credentialFreeHttpsUrl(identity.issuer, `${path}.issuer`);
  opaqueProviderIdentifier(identity.subject, `${path}.subject`);
  opaqueProviderIdentifier(identity.audience, `${path}.audience`);
  instant(identity.verifiedAt, `${path}.verifiedAt`);
  instant(authorizedActionAt, `${path}.authorizedActionAt`);
  invariant(
    Date.parse(identity.verifiedAt as string) <= Date.parse(authorizedActionAt as string),
    "INVALID_ARTIFACT",
    `${path}.verifiedAt cannot be later than the authorized action`,
    { path },
  );
}

function stablePrincipal(value: unknown, path: string): asserts value is string {
  requiredString(value, path, 3, 256);
  invariant(
    (value as string).normalize("NFC") === value &&
      /^[a-z][-a-z0-9._:@/]{2,255}$/.test(value as string),
    "INVALID_ARTIFACT",
    `${path} must be a stable principal identifier`,
    { path },
  );
}

function opaqueProviderIdentifier(value: unknown, path: string): asserts value is string {
  requiredString(value, path, 1, 512);
  invariant(
    /^[A-Za-z0-9][A-Za-z0-9._~+/:@=-]{0,511}$/.test(value as string),
    "INVALID_ARTIFACT",
    `${path} must be a bounded provider-neutral opaque identifier`,
    { path },
  );
}

function stableIdentifier(value: unknown, path: string): asserts value is string {
  requiredString(value, path, 1, 512);
  invariant(
    (value as string).normalize("NFC") === value &&
      /^[A-Za-z0-9][A-Za-z0-9@._:/+-]{0,510}$/.test(value as string),
    "INVALID_ARTIFACT",
    `${path} must be a stable identifier`,
    { path },
  );
}

function sourceRef(value: unknown, path: string): asserts value is string {
  stableIdentifier(value, path);
  invariant(
    (value as string).startsWith("refs/") && !(value as string).includes(".."),
    "INVALID_ARTIFACT",
    `${path} must be a full runner ref claim; sourceSha supplies immutable identity`,
    { path },
  );
}

function sourceSha(value: unknown, path: string): asserts value is string {
  patternString(value, path, /^[0-9a-f]{40}$/);
}

function sha256(value: unknown, path: string): asserts value is string {
  patternString(value, path, /^[0-9a-f]{64}$/);
}

function uuidV4(value: unknown, path: string): asserts value is string {
  patternString(
    value,
    path,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
}

function mediaType(value: unknown, path: string): asserts value is string {
  patternString(value, path, /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);
}

function nullableMetadata(value: unknown, path: string): asserts value is string | null {
  invariant(
    value === null ||
      (typeof value === "string" &&
        value === value.trim() &&
        value.length > 0 &&
        value.length <= 2048 &&
        !hasControlCharacters(value)),
    "INVALID_ARTIFACT",
    `${path} must be null or safe response metadata`,
    { path },
  );
}

function nullableInstant(value: unknown, path: string): asserts value is string | null {
  if (value !== null) instant(value, path);
}

function instant(value: unknown, path: string): asserts value is string {
  requiredString(value, path);
  const parsed = Date.parse(value as string);
  invariant(
    !Number.isNaN(parsed) && new Date(parsed).toISOString() === value,
    "INVALID_ARTIFACT",
    `${path} must be a canonical UTC timestamp`,
    { path },
  );
}

function positiveInteger(value: unknown, path: string): asserts value is number {
  invariant(
    Number.isSafeInteger(value) && (value as number) > 0,
    "INVALID_ARTIFACT",
    `${path} must be a positive safe integer`,
    { path },
  );
}

function stableLabel(value: unknown, path: string): asserts value is string {
  requiredString(value, path, 1, 256);
  invariant(
    !hasControlCharacters(value as string),
    "INVALID_ARTIFACT",
    `${path} cannot contain control characters`,
    { path },
  );
}

function patternString(value: unknown, path: string, pattern: RegExp): asserts value is string {
  invariant(
    typeof value === "string" && pattern.test(value),
    "INVALID_ARTIFACT",
    `${path} has an invalid format`,
    { path },
  );
}

function enumeration<T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
): asserts value is T {
  invariant(
    typeof value === "string" && choices.includes(value as T),
    "INVALID_ARTIFACT",
    `${path} is not an allowed value`,
    { path },
  );
}

function equal<T>(value: unknown, expected: T, path: string): asserts value is T {
  invariant(value === expected, "INVALID_ARTIFACT", `${path} must equal ${String(expected)}`, {
    path,
  });
}

function requiredString(
  value: unknown,
  path: string,
  minLength = 1,
  maxLength = 2048,
): asserts value is string {
  invariant(
    typeof value === "string" &&
      value === value.trim() &&
      value.length >= minLength &&
      value.length <= maxLength,
    "INVALID_ARTIFACT",
    `${path} must be a bounded string without surrounding whitespace`,
    { path },
  );
}

function exactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  invariant(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
    "INVALID_ARTIFACT",
    `${path} must be a plain object`,
    { path },
  );
  const record = value as Readonly<Record<string, unknown>>;
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    invariant(expected.has(key), "INVALID_ARTIFACT", `Unexpected evidence field at ${path}`, {
      path,
    });
  }
  for (const key of keys) {
    invariant(
      Object.hasOwn(record, key),
      "INVALID_ARTIFACT",
      `Missing evidence field ${path}.${key}`,
      {
        path: `${path}.${key}`,
      },
    );
  }
  return record;
}

function normalizedPrincipal(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function authenticatedSubjectKey(issuer: string, subject: string): string {
  return `${canonicalUrl(issuer)}\u0000${subject}`;
}

function acquisitionOrderKey(value: AuthenticatedAcquisitionSidecarV1): string {
  return [
    normalizedPrincipal(value.runnerClaims.actorPrincipalId),
    value.observation.acquisitionId,
    value.runnerClaims.runId,
  ].join("\u0000");
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalUrl(value: string): string {
  return new URL(value).href;
}

function canonicalS3Uri(value: string, objectKey: string): string {
  return `s3://${new URL(value).hostname.toLowerCase()}/${objectKey}`;
}

function snapshotEvidence(input: unknown, label: string): unknown {
  try {
    return structuredClone(input);
  } catch {
    throw new IngestionError("INVALID_ARTIFACT", `${label} could not be safely snapshotted`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
