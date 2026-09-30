// Synthetic test fixture only. All signing keys are ephemeral and never persisted.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BACKEND_ADMISSION_SCHEMA,
  BACKEND_COMPONENTS,
  CAPTURE_REVIEW_SCHEMA,
  canonicalEvidence,
  configurationSha256,
  evidenceSha256,
  loadManagedPolicy,
  MANAGED_ACTIVATION_SCHEMA,
  MANAGED_DEPLOYMENT_SCHEMA,
  MANAGED_PROFILE,
  policySha256,
  QUALIFICATION_BUNDLE_SCHEMA,
} from "../deployment/managed-evidence.mjs";

export const NOW = Date.parse("2026-09-29T20:00:00.000Z");
export const OBSERVED = "2026-09-29T19:45:00.000Z";
export const REVIEWED = "2026-09-29T19:50:00.000Z";
export const SHA = "1".repeat(64);
export const REVISION = "1".repeat(40);
export function fixture(target = "staging") {
  // Ephemeral test-only trust. Never saved or supplied by the production CLI.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trust = {
    schemaVersion: "nutrition-tracker-release-deployment-reviewer-trust-v1",
    reviewers: [
      {
        algorithm: "Ed25519",
        keyId: "fixture-key",
        principal: "fixture-reviewer",
        publicKeySpkiDerBase64: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        validFrom: "2026-09-28T00:00:00.000Z",
        validUntil: "2026-10-01T00:00:00.000Z",
      },
    ],
  };
  const policy = loadManagedPolicy();
  const config = {
    target,
    siteId: `${target}-site`,
    otherSiteId: target === "staging" ? "production-site" : "staging-site",
    webOrigin:
      target === "production" ? "https://nourishing.app" : "https://staging.nourishing.app",
    apiOrigin:
      target === "production" ? "https://api.nourishing.app" : "https://staging-api.nourishing.app",
    buildSpecification: "s-1vcpu-512mb",
    runtimeSpecification: "s-1vcpu-512mb",
  };
  const signRecord = (input) => {
    const value = {
      ...input,
      deployedBy: "fixture-operator",
      reviewedBy: "fixture-reviewer",
      reviewedAt: REVIEWED,
      reviewerAttestation: { keyId: "fixture-key", algorithm: "Ed25519" },
    };
    return {
      ...value,
      reviewerAttestation: {
        ...value.reviewerAttestation,
        signatureBase64: sign(null, Buffer.from(canonicalEvidence(value)), privateKey).toString(
          "base64",
        ),
      },
    };
  };
  const images = Object.fromEntries(
    BACKEND_COMPONENTS.map((component) => [
      component,
      `ghcr.io/liangzixuan/cronometer-gold-${component}@sha256:${SHA}`,
    ]),
  );
  const host = {
    azureResourceId:
      "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture/providers/Microsoft.Compute/virtualMachines/fixture",
    virtualMachineId: "11111111-1111-1111-1111-111111111111",
    architecture: "arm64",
  };
  const isolation = {
    databaseSha256: (target === "staging" ? "a" : "b").repeat(64),
    searchNamespaceSha256: (target === "staging" ? "c" : "d").repeat(64),
    storagePrincipalSha256: (target === "staging" ? "e" : "f").repeat(64),
    dataScope: target === "staging" ? "synthetic" : "personal",
  };
  const observe = (kind, details) => ({
    schemaVersion: "nutrition-tracker-qualification-observation-v1",
    kind,
    target,
    apiOrigin: config.apiOrigin,
    sourceRevision: REVISION,
    observedAt: OBSERVED,
    measurementCodeSha256: SHA,
    nonce: SHA,
    details,
  });
  const backendReports = {
    host: observe("host", {
      host,
      images,
      containers: BACKEND_COMPONENTS.map((component) => ({
        component,
        containerId: SHA,
        imageId: `sha256:${SHA}`,
        image: images[component],
        sourceRevision: REVISION,
        architecture: "arm64",
        runtimeAdmission: {
          helperSha256: createHash("sha256")
            .update(
              readFileSync(new URL("../../infra/oci/files/image-admission.py", import.meta.url)),
            )
            .digest("hex"),
          exitCode: 0,
          configuration: {
            Labels: {
              "org.opencontainers.image.revision": REVISION,
              "org.opencontainers.image.source": "https://github.com/liangzixuan/cronometer-gold",
              "org.opencontainers.image.title": `cronometer-gold-${component}`,
            },
          },
        },
      })),
    }),
    security: observe("security", {
      images,
      imageChecks: BACKEND_COMPONENTS.map((component) => ({
        component,
        image: images[component],
        signature: {
          subjectDigest: `sha256:${SHA}`,
          identity:
            "https://github.com/liangzixuan/cronometer-gold/.github/workflows/container-supply-chain.yml@refs/heads/codex/retention-features",
          issuer: "https://token.actions.githubusercontent.com",
          verifiedAt: OBSERVED,
        },
        provenance: {
          subjectDigest: `sha256:${SHA}`,
          sourceRevision: REVISION,
          predicateType: "https://slsa.dev/provenance/v0.2",
          materialsSha256: SHA,
        },
        scan: {
          scanner: "trivy",
          version: "0.67.2",
          databaseUpdatedAt: OBSERVED,
          vulnerabilities: [],
          ignores: [],
        },
        licenses: { inventorySha256: SHA, violations: [] },
        nativeInventory: [{ path: "/fixture/binary", sha256: SHA, architecture: "arm64" }],
        releaseAgeMinutes: 1440,
      })),
    }),
    access: observe("access", {
      policySha256: SHA,
      apiInstances: 1,
      anonymousRoutes: "passed",
      privateAuthorization: "passed",
      crossAccount: "denied",
      admin: "restricted",
      dependencies: "private",
      forwardedIdentity: "rejected",
      bffOrigin: "passed",
      rateLimits: "passed",
      probes: [
        { kind: "authenticated", method: "GET", path: "/v1/diary", httpStatus: 200 },
        { kind: "anonymous-private", method: "GET", path: "/v1/diary", httpStatus: 401 },
        { kind: "cross-account", method: "GET", path: "/v1/diary/other", httpStatus: 404 },
        { kind: "admin-anonymous", method: "GET", path: "/ready", httpStatus: 404 },
      ],
    }),
    restore: observe("restore", {
      encryptedOffHostBackup: "passed",
      cleanRestore: "passed",
      identifierHistory: "passed",
      ledger: "passed",
      privacy: "passed",
      egress: "passed",
      credentialRotation: "passed",
      storageAllowance: "passed",
      restoreEpochSha256: SHA,
      completedAt: OBSERVED,
      backup: {
        objectVersionId: "fixture-version",
        encryptedBytes: 1024,
        encryption: "AES-256-GCM",
        createdAt: OBSERVED,
      },
      restoredDatabaseSha256: SHA,
    }),
    readiness: observe("readiness", {
      postgres: { migrationCount: 100, restoreEpochSha256: SHA },
      search: { indexUidSha256: SHA, httpStatus: 200 },
      worker: { sourceRevision: REVISION, heartbeatAt: OBSERVED, queueConnected: true },
      storage: {
        credentialPrincipalSha256: isolation.storagePrincipalSha256,
        putHttpStatus: 200,
        getHttpStatus: 200,
        deleteHttpStatus: 204,
      },
    }),
  };
  const backend = signRecord({
    schemaVersion: BACKEND_ADMISSION_SCHEMA,
    profile: MANAGED_PROFILE,
    target,
    apiOrigin: config.apiOrigin,
    sourceRevision: REVISION,
    configurationSha256: configurationSha256(config),
    policySha256: policySha256(policy),
    host,
    images,
    isolation,
    reports: Object.fromEntries(
      Object.entries(backendReports).map(([key, value]) => [key, evidenceSha256(value)]),
    ),
  });
  const output = {
    revision: REVISION,
    tree: REVISION,
    sourceManifestSha256: SHA,
    buildId: "fixtureBuild",
    outputTreeSha256: SHA,
    outputArchiveSha256: SHA,
  };
  const web = {
    endpoint: policy.endpoint,
    projectId: policy.projectId,
    siteId: config.siteId,
    deploymentId: "fixture-deployment",
    webOrigin: config.webOrigin,
    sourceArchiveSha256: SHA,
    output,
  };
  const runtime = {
    endpoint: web.endpoint,
    projectId: web.projectId,
    siteId: web.siteId,
    deploymentId: web.deploymentId,
    outputTreeSha256: output.outputTreeSha256,
    node: policy.observableRuntime.node,
    openssl: policy.observableRuntime.openssl,
    platform: "linux",
    architecture: "arm64",
    libc: "glibc@2.41",
    nativeInventory: [{ path: "/fixture/node", sha256: SHA }],
    advisoryAssessment: "passed",
    opensslFixCommit: policy.observableRuntime.opensslFixCommit,
    high: 0,
    critical: 0,
  };
  const runtimeReports = {
    build: observe("build", { ...runtime }),
    ssr: observe("ssr", { ...runtime }),
    preview: observe("preview", {
      siteId: web.siteId,
      deploymentId: web.deploymentId,
      authorized: "passed",
      unauthorized: "denied",
      capturePrivacy: "passed",
      expectedOutput: "passed",
    }),
  };
  let deployment = signRecord({
    schemaVersion: MANAGED_DEPLOYMENT_SCHEMA,
    profile: MANAGED_PROFILE,
    target,
    apiOrigin: config.apiOrigin,
    sourceRevision: REVISION,
    configurationSha256: configurationSha256(config),
    policySha256: policySha256(policy),
    backendAdmissionSha256: evidenceSha256(backend),
    captureReviewSha256: "",
    web,
    reports: Object.fromEntries(
      Object.entries(runtimeReports).map(([key, value]) => [key, evidenceSha256(value)]),
    ),
  });
  const captureReview = signRecord({
    schemaVersion: CAPTURE_REVIEW_SCHEMA,
    sourceRevision: REVISION,
    summarySha256: SHA,
    sessionId: "fixture-session",
    runId: 123,
    attempt: 1,
    observedAt: OBSERVED,
    observations: {
      video: "disabled",
      network: "disabled",
      console: "disabled",
      playwright: "disabled",
      screenshots: "absent-in-complete-timeline",
      credentialMasking: "observed-redacted",
    },
  });
  deployment = signRecord({ ...deployment, captureReviewSha256: evidenceSha256(captureReview) });
  const bundle = {
    schemaVersion: QUALIFICATION_BUNDLE_SCHEMA,
    backend,
    backendReports,
    deployment,
    runtimeReports,
    captureReview,
    staging: null,
  };
  const expected = {
    target,
    apiOrigin: config.apiOrigin,
    sourceRevision: REVISION,
    configurationSha256: configurationSha256(config),
    now: NOW,
    webOrigin: config.webOrigin,
    siteId: config.siteId,
    deploymentId: web.deploymentId,
    output,
  };
  const context = {
    config,
    source: { revision: REVISION, archiveSha256: SHA },
    deploymentId: web.deploymentId,
    output,
    githubEvidence: {
      revision: REVISION,
      browser: { summarySha256: SHA, summary: { browser: { sessionId: "fixture-session" } } },
      requiredRuns: [{ workflow: "browserstack-web.yml", run: { id: 123, run_attempt: 1 } }],
    },
  };
  const activation = signRecord({
    schemaVersion: MANAGED_ACTIVATION_SCHEMA,
    profile: MANAGED_PROFILE,
    target: "production",
    sourceRevision: REVISION,
    apiOrigin: config.apiOrigin,
    deploymentSha256: evidenceSha256(deployment),
    observedAt: OBSERVED,
    provider: {
      endpoint: policy.endpoint,
      projectId: policy.projectId,
      site: { $id: config.siteId, deploymentId: web.deploymentId, enabled: true, live: true },
      deployment: {
        $id: web.deploymentId,
        resourceId: config.siteId,
        resourceType: "sites",
        status: "ready",
      },
    },
  });
  return {
    activation,
    trust,
    policy,
    config,
    signRecord,
    observe,
    backendReports,
    backend,
    deployment,
    runtimeReports,
    captureReview,
    bundle,
    expected,
    context,
  };
}
