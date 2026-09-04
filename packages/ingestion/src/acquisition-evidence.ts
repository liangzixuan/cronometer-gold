import type { ArtifactAcquisitionObservation } from "./acquisition.js";
import { IngestionError, invariant } from "./errors.js";

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
      url.pathname === `/${key}` &&
      digestIsBound,
    "INVALID_ARTIFACT",
    "Artifact objectUri must be a credential-free content-addressed S3 URI matching objectKey",
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
  principalField: "actorPrincipalId" | "principalId",
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
