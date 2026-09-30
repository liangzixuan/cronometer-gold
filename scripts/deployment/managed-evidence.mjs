import { createHash, randomBytes, verify } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
  reviewerKeyWasActiveAt,
  validateReviewerTrustStore,
} from "../../apps/mobile/scripts/reviewer-trust.mjs";
import { canonicalJson } from "../../packages/contracts/dist/canonical-json.js";

export const BACKEND_ADMISSION_SCHEMA = "nutrition-tracker-backend-admission-v1";
export const MANAGED_DEPLOYMENT_SCHEMA = "nutrition-tracker-release-deployment-v8";
export const QUALIFICATION_BUNDLE_SCHEMA = "nutrition-tracker-managed-qualification-bundle-v1";
export const MANAGED_PROFILE = "appwrite-cloud-azure-v1";
export const BACKEND_COMPONENTS = ["api", "worker", "migrator", "caddy", "postgres", "meilisearch"];
export const EVIDENCE_LIMITS = Object.freeze({
  bundleBytes: 512 * 1024,
  reportBytes: 64 * 1024,
  reviewMs: 24 * 60 * 60 * 1000,
  observationMs: 60 * 60 * 1000,
  futureSkewMs: 5 * 60 * 1000,
});
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{2,127}$/;
const NONCE = /^[a-f0-9]{64}$/;
const BACKEND_REPORTS = ["host", "security", "access", "restore", "readiness"];
const RUNTIME_REPORTS = ["build", "ssr", "preview"];
export const CAPTURE_REVIEW_SCHEMA = "nutrition-tracker-browser-capture-review-v1";
const POLICY_URL = new URL("../appwrite/managed-runtime-policy.json", import.meta.url);
const TRUST_URL = new URL(
  "../../apps/mobile/config/release-deployment-reviewers.json",
  import.meta.url,
);

export class QualificationEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "QualificationEvidenceError";
    this.code = code;
  }
}
function fail(code) {
  throw new QualificationEvidenceError(code);
}
export function canonicalEvidence(value) {
  return canonicalJson(value);
}
export function evidenceSha256(value) {
  return createHash("sha256").update(canonicalEvidence(value)).digest("hex");
}
export const configurationSha256 = evidenceSha256;
function record(value, keys, code) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail(code);
  return value;
}
function equal(actual, expected, code) {
  if (canonicalEvidence(actual) !== canonicalEvidence(expected)) fail(code);
}
function hash(value, code) {
  if (typeof value !== "string" || !HASH.test(value)) fail(code);
  return value;
}
function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code);
}
function instant(value, code) {
  if (typeof value !== "string" || !INSTANT.test(value)) fail(code);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return time;
}
function fresh(value, now, age, code) {
  if (!Number.isFinite(now)) fail("qualification_clock_invalid");
  const time = instant(value, code);
  if (time > now + EVIDENCE_LIMITS.futureSkewMs || now - time > age) fail(code);
  return time;
}
export function loadReviewerTrustStore() {
  return JSON.parse(readFileSync(TRUST_URL, "utf8"));
}
export function loadManagedPolicy() {
  const policy = JSON.parse(readFileSync(POLICY_URL, "utf8"));
  if (
    policy.schemaVersion !== "nutrition-tracker-managed-runtime-policy-v1" ||
    policy.profile !== MANAGED_PROFILE
  )
    fail("managed_policy_invalid");
  return policy;
}
export function policySha256(policy = loadManagedPolicy()) {
  return evidenceSha256(policy);
}
function signed(recordValue, keys, trustStore, now) {
  record(
    recordValue,
    [...keys, "deployedBy", "reviewedBy", "reviewedAt", "reviewerAttestation"],
    "signed_evidence_shape_invalid",
  );
  identifier(recordValue.deployedBy, "deployment_operator_invalid");
  identifier(recordValue.reviewedBy, "deployment_reviewer_invalid");
  if (recordValue.deployedBy.toLowerCase() === recordValue.reviewedBy.toLowerCase())
    fail("independent_reviewer_required");
  const reviewedAt = fresh(recordValue.reviewedAt, now, EVIDENCE_LIMITS.reviewMs, "review_stale");
  const attestation = record(
    recordValue.reviewerAttestation,
    ["keyId", "algorithm", "signatureBase64"],
    "reviewer_attestation_invalid",
  );
  if (
    attestation.algorithm !== "Ed25519" ||
    typeof attestation.signatureBase64 !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(attestation.signatureBase64)
  )
    fail("reviewer_attestation_invalid");
  const signature = Buffer.from(attestation.signatureBase64, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== attestation.signatureBase64)
    fail("reviewer_attestation_invalid");
  let reviewers;
  try {
    reviewers = validateReviewerTrustStore(trustStore, {
      expectedSchema: RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
      label: "deployment reviewer trust store",
    });
  } catch {
    fail("reviewer_trust_invalid");
  }
  const trusted = reviewers.find(
    (key) =>
      key.keyId === attestation.keyId &&
      key.principal === recordValue.reviewedBy &&
      reviewerKeyWasActiveAt(key, reviewedAt),
  );
  if (!trusted) fail("reviewer_key_not_trusted");
  const payload = {
    ...recordValue,
    reviewerAttestation: { keyId: attestation.keyId, algorithm: attestation.algorithm },
  };
  if (!verify(null, Buffer.from(canonicalEvidence(payload)), trusted.publicKey, signature))
    fail("reviewer_signature_invalid");
  return reviewedAt;
}
function common(value, expected, policy) {
  if (
    value.profile !== MANAGED_PROFILE ||
    value.target !== expected.target ||
    value.apiOrigin !== expected.apiOrigin ||
    value.sourceRevision !== expected.sourceRevision ||
    value.configurationSha256 !== expected.configurationSha256 ||
    value.policySha256 !== policySha256(policy)
  )
    fail("qualification_context_mismatch");
  if (!["staging", "production"].includes(value.target) || !COMMIT.test(value.sourceRevision))
    fail("qualification_context_invalid");
}
function images(value) {
  record(value, BACKEND_COMPONENTS, "backend_images_invalid");
  for (const component of BACKEND_COMPONENTS) {
    if (
      typeof value[component] !== "string" ||
      !new RegExp(`^ghcr\\.io/liangzixuan/cronometer-gold-${component}@sha256:[0-9a-f]{64}$`).test(
        value[component],
      )
    )
      fail("backend_image_digest_invalid");
  }
}
function reportSet(reports, names, digests) {
  record(reports, names, "qualification_reports_invalid");
  record(digests, names, "qualification_report_digests_invalid");
  for (const name of names) {
    hash(digests[name], "qualification_report_digest_invalid");
    if (
      Buffer.byteLength(canonicalEvidence(reports[name])) > EVIDENCE_LIMITS.reportBytes ||
      evidenceSha256(reports[name]) !== digests[name]
    )
      fail("qualification_report_mismatch");
  }
}
function observed(report, kind, backend, reviewedAt, now) {
  record(
    report,
    [
      "schemaVersion",
      "kind",
      "target",
      "apiOrigin",
      "sourceRevision",
      "observedAt",
      "measurementCodeSha256",
      "nonce",
      "details",
    ],
    "observation_shape_invalid",
  );
  if (
    report.schemaVersion !== "nutrition-tracker-qualification-observation-v1" ||
    report.kind !== kind ||
    report.target !== backend.target ||
    report.apiOrigin !== backend.apiOrigin ||
    report.sourceRevision !== backend.sourceRevision
  )
    fail("observation_context_mismatch");
  hash(report.measurementCodeSha256, "observation_measurement_unbound");
  if (typeof report.nonce !== "string" || !NONCE.test(report.nonce))
    fail("observation_nonce_invalid");
  const observedAt = fresh(
    report.observedAt,
    now,
    EVIDENCE_LIMITS.observationMs,
    "observation_stale",
  );
  if (observedAt > reviewedAt) fail("observation_after_review");
  return report.details;
}
export function validateBackendAdmission(
  bundle,
  expected,
  trustStore = loadReviewerTrustStore(),
  policy = loadManagedPolicy(),
) {
  const backend = bundle.backend;
  const reviewedAt = signed(
    backend,
    [
      "schemaVersion",
      "profile",
      "target",
      "apiOrigin",
      "sourceRevision",
      "configurationSha256",
      "policySha256",
      "host",
      "images",
      "isolation",
      "reports",
    ],
    trustStore,
    expected.now,
  );
  if (backend.schemaVersion !== BACKEND_ADMISSION_SCHEMA) fail("backend_schema_invalid");
  common(backend, expected, policy);
  record(
    backend.host,
    ["azureResourceId", "virtualMachineId", "architecture"],
    "backend_host_invalid",
  );
  if (
    backend.host.architecture !== "arm64" ||
    typeof backend.host.azureResourceId !== "string" ||
    !/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.Compute\/virtualMachines\/[A-Za-z0-9-]{1,64}$/.test(
      backend.host.azureResourceId,
    ) ||
    typeof backend.host.virtualMachineId !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(backend.host.virtualMachineId)
  )
    fail("backend_host_invalid");
  images(backend.images);
  record(
    backend.isolation,
    ["databaseSha256", "searchNamespaceSha256", "storagePrincipalSha256", "dataScope"],
    "backend_isolation_invalid",
  );
  for (const key of ["databaseSha256", "searchNamespaceSha256", "storagePrincipalSha256"])
    hash(backend.isolation[key], "backend_isolation_invalid");
  if (backend.isolation.dataScope !== (backend.target === "staging" ? "synthetic" : "personal"))
    fail("backend_data_scope_invalid");
  reportSet(bundle.backendReports, BACKEND_REPORTS, backend.reports);
  const details = Object.fromEntries(
    BACKEND_REPORTS.map((name) => [
      name,
      observed(bundle.backendReports[name], name, backend, reviewedAt, expected.now),
    ]),
  );
  record(details.host, ["host", "images", "containers"], "host_observation_invalid");
  equal(details.host.host, backend.host, "host_identity_mismatch");
  equal(details.host.images, backend.images, "host_images_mismatch");
  if (!Array.isArray(details.host.containers) || details.host.containers.length !== 6)
    fail("host_runtime_not_qualified");
  const components = new Set();
  for (const container of details.host.containers) {
    record(
      container,
      [
        "component",
        "containerId",
        "imageId",
        "image",
        "sourceRevision",
        "architecture",
        "runtimeAdmission",
      ],
      "host_container_invalid",
    );
    if (
      !BACKEND_COMPONENTS.includes(container.component) ||
      components.has(container.component) ||
      container.image !== backend.images[container.component] ||
      container.sourceRevision !== backend.sourceRevision ||
      container.architecture !== "arm64" ||
      !/^[0-9a-f]{64}$/.test(container.containerId) ||
      !/^sha256:[0-9a-f]{64}$/.test(container.imageId)
    )
      fail("host_container_identity_mismatch");
    components.add(container.component);
    record(
      container.runtimeAdmission,
      ["helperSha256", "exitCode", "configuration"],
      "runtime_admission_invalid",
    );
    if (
      container.runtimeAdmission.exitCode !== 0 ||
      container.runtimeAdmission.helperSha256 !==
        createHash("sha256")
          .update(
            readFileSync(new URL("../../infra/oci/files/image-admission.py", import.meta.url)),
          )
          .digest("hex")
    )
      fail("runtime_admission_invalid");
    const config = container.runtimeAdmission.configuration;
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      !config.Labels ||
      config.Labels["org.opencontainers.image.revision"] !== backend.sourceRevision ||
      config.Labels["org.opencontainers.image.source"] !==
        "https://github.com/liangzixuan/cronometer-gold" ||
      config.Labels["org.opencontainers.image.title"] !==
        `cronometer-gold-${container.component}` ||
      Buffer.byteLength(canonicalEvidence(config)) > 8192
    )
      fail("runtime_configuration_invalid");
  }
  record(details.security, ["images", "imageChecks"], "security_observation_invalid");
  equal(details.security.images, backend.images, "security_images_mismatch");
  if (!Array.isArray(details.security.imageChecks) || details.security.imageChecks.length !== 6)
    fail("backend_security_not_qualified");
  const checkedImages = new Set();
  for (const check of details.security.imageChecks) {
    record(
      check,
      [
        "component",
        "image",
        "signature",
        "provenance",
        "scan",
        "licenses",
        "nativeInventory",
        "releaseAgeMinutes",
      ],
      "security_check_invalid",
    );
    if (
      !BACKEND_COMPONENTS.includes(check.component) ||
      checkedImages.has(check.component) ||
      check.image !== backend.images[check.component]
    )
      fail("security_images_mismatch");
    checkedImages.add(check.component);
    const digest = check.image.split("@")[1];
    record(
      check.signature,
      ["subjectDigest", "identity", "issuer", "verifiedAt"],
      "signature_observation_invalid",
    );
    if (
      check.signature.subjectDigest !== digest ||
      check.signature.identity !==
        "https://github.com/liangzixuan/cronometer-gold/.github/workflows/container-supply-chain.yml@refs/heads/codex/retention-features" ||
      check.signature.issuer !== "https://token.actions.githubusercontent.com"
    )
      fail("image_signature_identity_mismatch");
    fresh(
      check.signature.verifiedAt,
      expected.now,
      EVIDENCE_LIMITS.observationMs,
      "image_signature_stale",
    );
    record(
      check.provenance,
      ["subjectDigest", "sourceRevision", "predicateType", "materialsSha256"],
      "image_provenance_invalid",
    );
    if (
      check.provenance.subjectDigest !== digest ||
      check.provenance.sourceRevision !== backend.sourceRevision ||
      check.provenance.predicateType !== "https://slsa.dev/provenance/v0.2"
    )
      fail("image_provenance_mismatch");
    hash(check.provenance.materialsSha256, "image_materials_unbound");
    record(
      check.scan,
      ["scanner", "version", "databaseUpdatedAt", "vulnerabilities", "ignores"],
      "image_scan_invalid",
    );
    if (
      check.scan.scanner !== "trivy" ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(check.scan.version) ||
      !Array.isArray(check.scan.ignores) ||
      check.scan.ignores.length ||
      !Array.isArray(check.scan.vulnerabilities) ||
      check.scan.vulnerabilities.length > 200
    )
      fail("image_scan_invalid");
    fresh(
      check.scan.databaseUpdatedAt,
      expected.now,
      EVIDENCE_LIMITS.reviewMs,
      "scan_database_stale",
    );
    for (const vulnerability of check.scan.vulnerabilities) {
      record(vulnerability, ["id", "severity", "package", "version"], "vulnerability_invalid");
      if (!["UNKNOWN", "LOW", "MEDIUM"].includes(vulnerability.severity))
        fail("image_vulnerability_blocked");
      for (const key of ["id", "package", "version"])
        identifier(vulnerability[key], "vulnerability_invalid");
    }
    record(check.licenses, ["inventorySha256", "violations"], "image_license_invalid");
    hash(check.licenses.inventorySha256, "image_license_invalid");
    if (!Array.isArray(check.licenses.violations) || check.licenses.violations.length)
      fail("image_license_blocked");
    if (
      !Array.isArray(check.nativeInventory) ||
      !check.nativeInventory.length ||
      check.nativeInventory.length > 100
    )
      fail("native_inventory_missing");
    for (const binary of check.nativeInventory) {
      record(binary, ["path", "sha256", "architecture"], "native_inventory_invalid");
      if (
        typeof binary.path !== "string" ||
        !/^\/[A-Za-z0-9_./+-]{1,180}$/.test(binary.path) ||
        binary.path.includes("..") ||
        binary.architecture !== "arm64"
      )
        fail("native_inventory_invalid");
      hash(binary.sha256, "native_inventory_invalid");
    }
    if (!Number.isSafeInteger(check.releaseAgeMinutes) || check.releaseAgeMinutes < 1440)
      fail("release_age_not_qualified");
  }
  record(
    details.access,
    [
      "policySha256",
      "apiInstances",
      "probes",
      "anonymousRoutes",
      "privateAuthorization",
      "crossAccount",
      "admin",
      "dependencies",
      "forwardedIdentity",
      "bffOrigin",
      "rateLimits",
    ],
    "access_observation_invalid",
  );
  hash(details.access.policySha256, "access_policy_unbound");
  if (
    details.access.apiInstances !== 1 ||
    ["anonymousRoutes", "privateAuthorization", "bffOrigin", "rateLimits"].some(
      (key) => details.access[key] !== "passed",
    ) ||
    details.access.crossAccount !== "denied" ||
    details.access.admin !== "restricted" ||
    details.access.dependencies !== "private" ||
    details.access.forwardedIdentity !== "rejected"
  )
    fail("backend_access_not_qualified");
  if (!Array.isArray(details.access.probes) || details.access.probes.length !== 4)
    fail("access_probes_missing");
  equal(
    details.access.probes.map((probe) => [probe.kind, probe.method, probe.httpStatus]),
    [
      ["authenticated", "GET", 200],
      ["anonymous-private", "GET", 401],
      ["cross-account", "GET", 404],
      ["admin-anonymous", "GET", 404],
    ],
    "access_probes_invalid",
  );
  for (const probe of details.access.probes) {
    record(probe, ["kind", "method", "path", "httpStatus"], "access_probe_invalid");
    if (typeof probe.path !== "string" || !/^\/[A-Za-z0-9_/-]{1,180}$/.test(probe.path))
      fail("access_probe_invalid");
  }
  record(
    details.restore,
    [
      "encryptedOffHostBackup",
      "cleanRestore",
      "identifierHistory",
      "ledger",
      "privacy",
      "egress",
      "credentialRotation",
      "storageAllowance",
      "restoreEpochSha256",
      "completedAt",
      "backup",
      "restoredDatabaseSha256",
    ],
    "restore_observation_invalid",
  );
  for (const key of [
    "encryptedOffHostBackup",
    "cleanRestore",
    "identifierHistory",
    "ledger",
    "privacy",
    "egress",
    "credentialRotation",
    "storageAllowance",
  ])
    if (details.restore[key] !== "passed") fail("backend_restore_not_qualified");
  record(
    details.restore.backup,
    ["objectVersionId", "encryptedBytes", "encryption", "createdAt"],
    "backup_observation_invalid",
  );
  identifier(details.restore.backup.objectVersionId, "backup_version_invalid");
  if (
    !Number.isSafeInteger(details.restore.backup.encryptedBytes) ||
    details.restore.backup.encryptedBytes < 1 ||
    details.restore.backup.encryption !== "AES-256-GCM"
  )
    fail("backup_encryption_invalid");
  fresh(details.restore.backup.createdAt, expected.now, EVIDENCE_LIMITS.reviewMs, "backup_stale");
  hash(details.restore.restoredDatabaseSha256, "restored_database_unbound");
  hash(details.restore.restoreEpochSha256, "restore_epoch_unbound");
  fresh(details.restore.completedAt, expected.now, EVIDENCE_LIMITS.reviewMs, "restore_stale");
  record(
    details.readiness,
    ["postgres", "search", "worker", "storage"],
    "backend_readiness_invalid",
  );
  record(
    details.readiness.postgres,
    ["migrationCount", "restoreEpochSha256"],
    "postgres_readiness_invalid",
  );
  if (
    !Number.isSafeInteger(details.readiness.postgres.migrationCount) ||
    details.readiness.postgres.migrationCount < 1 ||
    details.readiness.postgres.restoreEpochSha256 !== details.restore.restoreEpochSha256
  )
    fail("postgres_readiness_invalid");
  record(details.readiness.search, ["indexUidSha256", "httpStatus"], "search_readiness_invalid");
  hash(details.readiness.search.indexUidSha256, "search_readiness_invalid");
  if (details.readiness.search.httpStatus !== 200) fail("search_readiness_invalid");
  record(
    details.readiness.worker,
    ["sourceRevision", "heartbeatAt", "queueConnected"],
    "worker_readiness_invalid",
  );
  if (
    details.readiness.worker.sourceRevision !== backend.sourceRevision ||
    details.readiness.worker.queueConnected !== true
  )
    fail("worker_readiness_invalid");
  fresh(
    details.readiness.worker.heartbeatAt,
    expected.now,
    EVIDENCE_LIMITS.observationMs,
    "worker_heartbeat_stale",
  );
  record(
    details.readiness.storage,
    ["credentialPrincipalSha256", "putHttpStatus", "getHttpStatus", "deleteHttpStatus"],
    "storage_readiness_invalid",
  );
  if (
    details.readiness.storage.credentialPrincipalSha256 !==
      backend.isolation.storagePrincipalSha256 ||
    details.readiness.storage.putHttpStatus !== 200 ||
    details.readiness.storage.getHttpStatus !== 200 ||
    details.readiness.storage.deleteHttpStatus !== 204
  )
    fail("storage_readiness_invalid");
  return backend;
}
export function validateManagedDeployment(
  bundle,
  expected,
  trustStore = loadReviewerTrustStore(),
  policy = loadManagedPolicy(),
) {
  const backend = validateBackendAdmission(bundle, expected, trustStore, policy);
  const deployment = bundle.deployment;
  const reviewedAt = signed(
    deployment,
    [
      "schemaVersion",
      "profile",
      "target",
      "apiOrigin",
      "sourceRevision",
      "configurationSha256",
      "policySha256",
      "backendAdmissionSha256",
      "captureReviewSha256",
      "web",
      "reports",
    ],
    trustStore,
    expected.now,
  );
  if (deployment.schemaVersion !== MANAGED_DEPLOYMENT_SCHEMA)
    fail("managed_deployment_schema_invalid");
  common(deployment, expected, policy);
  if (deployment.backendAdmissionSha256 !== evidenceSha256(backend))
    fail("backend_admission_mismatch");
  if (deployment.captureReviewSha256 !== evidenceSha256(bundle.captureReview))
    fail("capture_review_binding_mismatch");
  record(
    deployment.web,
    [
      "endpoint",
      "projectId",
      "siteId",
      "deploymentId",
      "webOrigin",
      "sourceArchiveSha256",
      "output",
    ],
    "managed_web_invalid",
  );
  const web = deployment.web;
  if (
    web.endpoint !== policy.endpoint ||
    web.projectId !== policy.projectId ||
    web.siteId !== expected.siteId ||
    web.deploymentId !== expected.deploymentId ||
    web.webOrigin !== expected.webOrigin
  )
    fail("managed_web_identity_mismatch");
  hash(web.sourceArchiveSha256, "managed_source_archive_invalid");
  if (
    expected.sourceArchiveSha256 !== undefined &&
    web.sourceArchiveSha256 !== expected.sourceArchiveSha256
  )
    fail("managed_source_archive_mismatch");
  equal(web.output, expected.output, "managed_output_mismatch");
  record(
    web.output,
    [
      "revision",
      "tree",
      "sourceManifestSha256",
      "buildId",
      "outputTreeSha256",
      "outputArchiveSha256",
    ],
    "managed_output_invalid",
  );
  if (
    web.output.revision !== expected.sourceRevision ||
    !COMMIT.test(web.output.tree) ||
    typeof web.output.buildId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(web.output.buildId)
  )
    fail("managed_output_invalid");
  for (const key of ["sourceManifestSha256", "outputTreeSha256", "outputArchiveSha256"])
    hash(web.output[key], "managed_output_invalid");
  reportSet(bundle.runtimeReports, RUNTIME_REPORTS, deployment.reports);
  for (const name of ["build", "ssr"]) {
    const runtime = observed(bundle.runtimeReports[name], name, backend, reviewedAt, expected.now);
    record(
      runtime,
      [
        "endpoint",
        "projectId",
        "siteId",
        "deploymentId",
        "outputTreeSha256",
        "node",
        "openssl",
        "platform",
        "architecture",
        "libc",
        "nativeInventory",
        "advisoryAssessment",
        "opensslFixCommit",
        "high",
        "critical",
      ],
      "managed_runtime_invalid",
    );
    if (
      runtime.endpoint !== web.endpoint ||
      runtime.projectId !== web.projectId ||
      runtime.siteId !== web.siteId ||
      runtime.deploymentId !== web.deploymentId ||
      runtime.outputTreeSha256 !== web.output.outputTreeSha256
    )
      fail("managed_runtime_identity_mismatch");
    if (
      runtime.node !== policy.observableRuntime.node ||
      runtime.openssl !== policy.observableRuntime.openssl ||
      runtime.platform !== "linux" ||
      !policy.observableRuntime.architectures.includes(runtime.architecture) ||
      typeof runtime.libc !== "string" ||
      !/^(glibc|musl)@[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(runtime.libc) ||
      runtime.advisoryAssessment !== "passed" ||
      runtime.opensslFixCommit !== policy.observableRuntime.opensslFixCommit ||
      runtime.high !== 0 ||
      runtime.critical !== 0
    )
      fail("managed_runtime_not_qualified");
    if (
      !Array.isArray(runtime.nativeInventory) ||
      !runtime.nativeInventory.length ||
      runtime.nativeInventory.length > 100
    )
      fail("managed_native_inventory_unbound");
    for (const binary of runtime.nativeInventory) {
      record(binary, ["path", "sha256"], "managed_native_inventory_invalid");
      if (
        typeof binary.path !== "string" ||
        !/^\/[A-Za-z0-9_./+-]{1,180}$/.test(binary.path) ||
        binary.path.includes("..")
      )
        fail("managed_native_inventory_invalid");
      hash(binary.sha256, "managed_native_inventory_invalid");
    }
  }
  const preview = observed(
    bundle.runtimeReports.preview,
    "preview",
    backend,
    reviewedAt,
    expected.now,
  );
  record(
    preview,
    ["siteId", "deploymentId", "authorized", "unauthorized", "capturePrivacy", "expectedOutput"],
    "preview_observation_invalid",
  );
  if (
    preview.siteId !== web.siteId ||
    preview.deploymentId !== web.deploymentId ||
    preview.authorized !== "passed" ||
    preview.unauthorized !== "denied" ||
    preview.capturePrivacy !== "passed" ||
    preview.expectedOutput !== "passed"
  )
    fail("preview_not_qualified");
  return deployment;
}
export function validateCaptureReview(capture, expected, trustStore = loadReviewerTrustStore()) {
  signed(
    capture,
    [
      "schemaVersion",
      "sourceRevision",
      "summarySha256",
      "sessionId",
      "runId",
      "attempt",
      "observedAt",
      "observations",
    ],
    trustStore,
    expected.now,
  );
  if (
    capture.schemaVersion !== CAPTURE_REVIEW_SCHEMA ||
    capture.sourceRevision !== expected.sourceRevision ||
    capture.summarySha256 !== expected.summarySha256 ||
    capture.sessionId !== expected.sessionId ||
    capture.runId !== expected.runId ||
    capture.attempt !== expected.attempt
  )
    fail("capture_review_context_mismatch");
  hash(capture.summarySha256, "capture_summary_invalid");
  if (
    !Number.isSafeInteger(capture.runId) ||
    capture.runId < 1 ||
    !Number.isSafeInteger(capture.attempt) ||
    capture.attempt < 1 ||
    typeof capture.sessionId !== "string" ||
    !/^[A-Za-z0-9-]{1,100}$/.test(capture.sessionId)
  )
    fail("capture_review_context_invalid");
  const observedAt = fresh(
    capture.observedAt,
    expected.now,
    EVIDENCE_LIMITS.reviewMs,
    "capture_review_stale",
  );
  if (observedAt > Date.parse(capture.reviewedAt)) fail("capture_observation_after_review");
  equal(
    capture.observations,
    {
      video: "disabled",
      network: "disabled",
      console: "disabled",
      playwright: "disabled",
      screenshots: "absent-in-complete-timeline",
      credentialMasking: "observed-redacted",
    },
    "capture_policy_unresolved",
  );
  return capture;
}
export function validateStagingIsolation(productionBackend, stagingBackend) {
  if (
    productionBackend.target !== "production" ||
    stagingBackend.target !== "staging" ||
    productionBackend.apiOrigin === stagingBackend.apiOrigin
  )
    fail("staging_isolation_invalid");
  for (const key of ["databaseSha256", "searchNamespaceSha256", "storagePrincipalSha256"])
    if (productionBackend.isolation[key] === stagingBackend.isolation[key])
      fail("staging_isolation_invalid");
}
export function parseQualificationBundle(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > EVIDENCE_LIMITS.bundleBytes)
    fail("qualification_bundle_too_large");
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch {
    fail("qualification_json_invalid");
  }
  const canonical = canonicalEvidence(bundle);
  if (raw !== canonical && raw !== `${canonical}\n`) fail("qualification_json_not_canonical");
  record(
    bundle,
    [
      "schemaVersion",
      "backend",
      "backendReports",
      "deployment",
      "runtimeReports",
      "captureReview",
      "staging",
    ],
    "qualification_bundle_invalid",
  );
  if (bundle.schemaVersion !== QUALIFICATION_BUNDLE_SCHEMA) fail("qualification_bundle_invalid");
  if (bundle.staging !== null) {
    record(
      bundle.staging,
      [
        "schemaVersion",
        "backend",
        "backendReports",
        "deployment",
        "runtimeReports",
        "captureReview",
        "staging",
      ],
      "staging_bundle_invalid",
    );
    if (
      bundle.staging.schemaVersion !== QUALIFICATION_BUNDLE_SCHEMA ||
      bundle.staging.staging !== null
    )
      fail("staging_bundle_invalid");
  }
  return bundle;
}
export function readQualificationBundle(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > EVIDENCE_LIMITS.bundleBytes ||
      (before.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    )
      fail("qualification_file_invalid");
    const data = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < data.length) {
      const count = readSync(fd, data, bytes, data.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    const after = fstatSync(fd);
    if (
      bytes !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      before.uid !== after.uid
    )
      fail("qualification_file_changed");
    const raw = data.subarray(0, bytes);
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw)) fail("qualification_utf8_invalid");
    return parseQualificationBundle(text);
  } catch (error) {
    if (error instanceof QualificationEvidenceError) throw error;
    fail("qualification_file_unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function qualificationNonce() {
  return randomBytes(32).toString("hex");
}
export const managedPolicyPath = fileURLToPath(POLICY_URL);

export const MANAGED_ACTIVATION_SCHEMA = "nutrition-tracker-managed-activation-v1";
export function validateManagedActivation(
  activation,
  expected,
  trustStore = loadReviewerTrustStore(),
) {
  const reviewedAt = signed(
    activation,
    [
      "schemaVersion",
      "profile",
      "target",
      "sourceRevision",
      "apiOrigin",
      "deploymentSha256",
      "observedAt",
      "provider",
    ],
    trustStore,
    expected.now,
  );
  if (
    activation.schemaVersion !== MANAGED_ACTIVATION_SCHEMA ||
    activation.profile !== MANAGED_PROFILE ||
    activation.target !== "production" ||
    activation.sourceRevision !== expected.sourceRevision ||
    activation.apiOrigin !== expected.apiOrigin ||
    activation.deploymentSha256 !== expected.deploymentSha256
  )
    fail("activation_context_mismatch");
  hash(activation.deploymentSha256, "activation_deployment_unbound");
  const observedAt = fresh(
    activation.observedAt,
    expected.now,
    EVIDENCE_LIMITS.observationMs,
    "activation_observation_stale",
  );
  if (observedAt > reviewedAt) fail("activation_observation_after_review");
  const provider = record(
    activation.provider,
    ["endpoint", "projectId", "site", "deployment"],
    "activation_provider_invalid",
  );
  const policy = loadManagedPolicy();
  if (provider.endpoint !== policy.endpoint || provider.projectId !== policy.projectId)
    fail("activation_provider_mismatch");
  record(provider.site, ["$id", "deploymentId", "enabled", "live"], "activation_site_invalid");
  record(
    provider.deployment,
    ["$id", "resourceId", "resourceType", "status"],
    "activation_deployment_invalid",
  );
  if (
    provider.site.$id !== expected.siteId ||
    provider.site.deploymentId !== expected.deploymentId ||
    provider.site.enabled !== true ||
    provider.site.live !== true ||
    provider.deployment.$id !== expected.deploymentId ||
    provider.deployment.resourceId !== expected.siteId ||
    provider.deployment.resourceType !== "sites" ||
    provider.deployment.status !== "ready"
  )
    fail("activation_not_confirmed");
  return activation;
}
