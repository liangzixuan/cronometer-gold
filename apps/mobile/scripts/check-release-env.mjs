import { execFileSync } from "node:child_process";
import { createHash, verify } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { isIP } from "node:net";
import { extname, isAbsolute, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "@nutrition-tracker/contracts";
import {
  RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
  reviewerKeyWasActiveAt,
  validateReviewerTrustStore,
} from "./reviewer-trust.mjs";

export const RELEASE_DEPLOYMENT_SCHEMA = "nutrition-tracker-release-deployment-v6";
export const RELEASE_EXTERNAL_HTTPS_REPORT_SCHEMA =
  "nutrition-tracker-release-external-https-report-v1";
export const RELEASE_REVIEWER_ACCESS_REPORT_SCHEMA =
  "nutrition-tracker-release-reviewer-access-report-v2";
export { RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA } from "./reviewer-trust.mjs";
export const RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE =
  "The exact API deployment platform and origin must be confirmed before release.";
export const RELEASE_EXPECTED_BLOCK_EXIT_CODE = 42;
export const RELEASE_DEPLOYMENT_UNCONFIRMED_CODE =
  "NUTRITION_RELEASE_BLOCK:DEPLOYMENT_EVIDENCE_UNCONFIRMED";
export const RELEASE_NUMBERING_UNCONFIRMED_CODE =
  "NUTRITION_RELEASE_BLOCK:IDENTIFIER_HISTORY_UNCONFIRMED";
export const RELEASE_API_ORIGIN = "https://api.nourishing.app";

export class ExpectedReleaseBlockError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "ExpectedReleaseBlockError";
    this.code = code;
  }
}

const RELEASE_DEPLOYMENT_PLATFORMS = new Set(["azure", "oci"]);
const SERVICE_IMAGE_COMPONENTS = ["api", "web", "worker", "migrator", "caddy", "postgres"];
const SERVICE_IMAGE_REPOSITORY_PREFIX = "ghcr.io/liangzixuan/cronometer-gold-";
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{2,127}$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_REVIEW_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_EXTERNAL_EVIDENCE_BYTES = 16_384;
const MAX_REPORT_BYTES = 65_536;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const reportSpecifications = [
  {
    base64Environment: "NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64",
    digestField: "externalHttpsEvidenceSha256",
    label: "external HTTPS report",
    pathEnvironment: "NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_PATH",
    validate: validateExternalHttpsReport,
  },
  {
    base64Environment: "NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64",
    digestField: "reviewerAccessEvidenceSha256",
    label: "reviewer-access report",
    pathEnvironment: "NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_PATH",
    validate: validateReviewerAccessReport,
  },
];

const PUBLIC_DNS_NAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const PRIVATE_DNS_SUFFIXES = ["corp", "home", "home.arpa", "internal", "lan", "local"];

function assertPlainRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, expected, name) {
  const actual = Object.keys(assertPlainRecord(value, name)).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(`${name} must contain exactly: ${required.join(", ")}.`);
  }
}

function parseCanonicalInstant(value, name) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new TypeError(`${name} must be a canonical ISO-8601 UTC instant with milliseconds.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${name} must be a real canonical UTC instant.`);
  }
  return timestamp;
}

function assertSafeIdentifier(value, name) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new TypeError(`${name} must be a bounded non-secret identifier.`);
  }
}

function decodeCanonicalBase64(value, name, maximumBytes) {
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    !STANDARD_BASE64.test(value)
  ) {
    throw new TypeError(`${name} must be canonical padded standard base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw new TypeError(`${name} was not canonical or exceeded its byte bound.`);
  }
  return bytes;
}

function validateServiceImages(value) {
  assertExactKeys(value, SERVICE_IMAGE_COMPONENTS, "Release deployment serviceImages");
  const validated = {};
  for (const component of SERVICE_IMAGE_COMPONENTS) {
    const expectedPrefix = `${SERVICE_IMAGE_REPOSITORY_PREFIX}${component}@sha256:`;
    const reference = value[component];
    if (
      typeof reference !== "string" ||
      !reference.startsWith(expectedPrefix) ||
      !SHA256_HEX.test(reference.slice(expectedPrefix.length))
    ) {
      throw new TypeError(
        `Release deployment serviceImages.${component} must be the exact GHCR repository at one lowercase sha256 digest.`,
      );
    }
    validated[component] = reference;
  }
  return validated;
}

function assertSha256(value, name) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${name} must be one lowercase SHA-256 digest.`);
  }
}

function assertReportContext(report, deployment, name) {
  if (report.apiOrigin !== deployment.apiOrigin) {
    throw new TypeError(`${name}.apiOrigin must equal the signed deployment API origin.`);
  }
  if (report.serviceGitCommit !== deployment.serviceGitCommit) {
    throw new TypeError(`${name}.serviceGitCommit must equal the signed deployment commit.`);
  }
}

function assertFreshReportInstant(value, reviewedAt, verifiedAt, name) {
  const timestamp = parseCanonicalInstant(value, name);
  if (
    timestamp > reviewedAt ||
    reviewedAt - timestamp > MAX_REVIEW_AGE_MS ||
    verifiedAt - timestamp > MAX_REVIEW_AGE_MS
  ) {
    throw new TypeError(
      `${name} must fall within the 24 hours before deployment review and release verification.`,
    );
  }
  return timestamp;
}

function assertReadyProbe(probe, name) {
  assertExactKeys(probe, ["httpStatus", "method", "path", "response"], name);
  assertExactKeys(probe.response, ["status"], `${name}.response`);
  if (
    probe.method !== "GET" ||
    probe.path !== "/ready" ||
    probe.httpStatus !== 200 ||
    probe.response.status !== "ok"
  ) {
    throw new TypeError(`${name} must prove exact GET /ready HTTP 200 status-ok routing.`);
  }
}

function validateExternalHttpsReport(report, deployment, reviewedAt, verifiedAt) {
  const name = "external HTTPS report";
  assertExactKeys(
    report,
    ["apiOrigin", "observedAt", "ready", "schemaVersion", "serviceGitCommit", "tls"],
    name,
  );
  if (report.schemaVersion !== RELEASE_EXTERNAL_HTTPS_REPORT_SCHEMA) {
    throw new TypeError(
      `${name}.schemaVersion must equal ${RELEASE_EXTERNAL_HTTPS_REPORT_SCHEMA}.`,
    );
  }
  assertReportContext(report, deployment, name);
  const observedAt = assertFreshReportInstant(
    report.observedAt,
    reviewedAt,
    verifiedAt,
    `${name}.observedAt`,
  );
  assertExactKeys(
    report.tls,
    ["hostnameValidation", "leafCertificateSha256", "notAfter", "publicChainValidation"],
    `${name}.tls`,
  );
  if (report.tls.publicChainValidation !== "passed" || report.tls.hostnameValidation !== "passed") {
    throw new TypeError(`${name}.tls must prove the public chain and hostname.`);
  }
  assertSha256(report.tls.leafCertificateSha256, `${name}.tls.leafCertificateSha256`);
  const notAfter = parseCanonicalInstant(report.tls.notAfter, `${name}.tls.notAfter`);
  if (notAfter <= observedAt || notAfter < reviewedAt + MAX_REVIEW_AGE_MS) {
    throw new TypeError(
      `${name}.tls.notAfter must remain valid throughout the release-review window.`,
    );
  }
  assertReadyProbe(report.ready, `${name}.ready`);
  return report;
}

function validateReviewerAccessReport(report, deployment, reviewedAt, verifiedAt) {
  const name = "reviewer-access report";
  assertExactKeys(
    report,
    [
      "accessPolicyShape",
      "accessPolicySha256",
      "apiOrigin",
      "approvedSourceProbe",
      "completedAt",
      "policyUnchangedDuringProbes",
      "schemaVersion",
      "serviceGitCommit",
      "startedAt",
      "unapprovedSourceProbe",
    ],
    name,
  );
  if (report.schemaVersion !== RELEASE_REVIEWER_ACCESS_REPORT_SCHEMA) {
    throw new TypeError(
      `${name}.schemaVersion must equal ${RELEASE_REVIEWER_ACCESS_REPORT_SCHEMA}.`,
    );
  }
  assertReportContext(report, deployment, name);
  assertSha256(report.accessPolicySha256, `${name}.accessPolicySha256`);
  assertExactKeys(
    report.accessPolicyShape,
    ["addressFamily", "allowedNetworkCount", "networkScope", "prefixLength"],
    `${name}.accessPolicyShape`,
  );
  if (
    report.accessPolicyShape.addressFamily !== "IPv4" ||
    report.accessPolicyShape.allowedNetworkCount !== 1 ||
    report.accessPolicyShape.networkScope !== "globally-routable-unicast" ||
    report.accessPolicyShape.prefixLength !== 32
  ) {
    throw new TypeError(
      `${name}.accessPolicyShape must declare the signed reviewer's assertion of exactly one globally routable unicast IPv4 /32 without recording its address.`,
    );
  }
  if (report.policyUnchangedDuringProbes !== "passed") {
    throw new TypeError(`${name}.policyUnchangedDuringProbes must equal passed.`);
  }
  const startedAt = assertFreshReportInstant(
    report.startedAt,
    reviewedAt,
    verifiedAt,
    `${name}.startedAt`,
  );
  const completedAt = assertFreshReportInstant(
    report.completedAt,
    reviewedAt,
    verifiedAt,
    `${name}.completedAt`,
  );
  if (completedAt < startedAt) {
    throw new TypeError(`${name} time interval must not be inverted.`);
  }
  assertReadyProbe(report.approvedSourceProbe, `${name}.approvedSourceProbe`);
  assertExactKeys(
    report.unapprovedSourceProbe,
    ["connectionOutcome", "method", "path"],
    `${name}.unapprovedSourceProbe`,
  );
  if (
    report.unapprovedSourceProbe.method !== "GET" ||
    report.unapprovedSourceProbe.path !== "/ready" ||
    report.unapprovedSourceProbe.connectionOutcome !== "blocked"
  ) {
    throw new TypeError(
      `${name}.unapprovedSourceProbe must prove blocked GET /ready connectivity.`,
    );
  }
  return report;
}

function defaultReleaseRuntime() {
  return {
    gitHead() {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      }).trim();
    },
    gitStatus() {
      return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      });
    },
    now() {
      return new Date();
    },
    readEvidence(path) {
      return readFileSync(path, "utf8");
    },
    readReport(path) {
      return readBoundedReport(path);
    },
    statEvidence(path) {
      return lstatSync(path);
    },
  };
}

function resolveActualReleaseCommit(environment, runtime) {
  if (environment?.EAS_BUILD === "true") {
    const easCommit = environment.EAS_BUILD_GIT_COMMIT_HASH;
    if (typeof easCommit !== "string" || !GIT_COMMIT.test(easCommit)) {
      throw new TypeError(
        "EAS_BUILD_GIT_COMMIT_HASH must be the canonical full lowercase Git commit on EAS Build.",
      );
    }
    return easCommit;
  }

  const localCommit = runtime.gitHead();
  if (typeof localCommit !== "string" || !GIT_COMMIT.test(localCommit)) {
    throw new TypeError("The local release Git HEAD must be one full lowercase commit.");
  }
  if (runtime.gitStatus().trim() !== "") {
    throw new TypeError("A confirmed mobile release requires a clean Git tree.");
  }
  return localCommit;
}

function deploymentSigningRecord(deployment) {
  return {
    schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
    deploymentPlatform: deployment.deploymentPlatform,
    deploymentConfirmed: true,
    apiOrigin: deployment.apiOrigin,
    serviceGitCommit: deployment.serviceGitCommit,
    serviceImages: Object.fromEntries(
      SERVICE_IMAGE_COMPONENTS.map((component) => [component, deployment.serviceImages[component]]),
    ),
    deployedBy: deployment.deployedBy,
    externalHttpsEvidenceSha256: deployment.externalHttpsEvidenceSha256,
    reviewerAccessEvidenceSha256: deployment.reviewerAccessEvidenceSha256,
    reviewedBy: deployment.reviewedBy,
    reviewedAt: deployment.reviewedAt,
    reviewerAttestation: {
      keyId: deployment.reviewerAttestation.keyId,
      algorithm: deployment.reviewerAttestation.algorithm,
    },
  };
}

function canonicalExternalEvidence(deployment) {
  return JSON.stringify({
    ...deploymentSigningRecord(deployment),
    reviewerAttestation: {
      keyId: deployment.reviewerAttestation.keyId,
      algorithm: deployment.reviewerAttestation.algorithm,
      signatureBase64: deployment.reviewerAttestation.signatureBase64,
    },
  });
}

export function hasExternalReleaseDeploymentEvidence(environment) {
  return [
    environment?.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON,
    environment?.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH,
  ].some((value) => typeof value === "string" && value.length > 0);
}

function defaultDeploymentReviewerTrustStore() {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../config/release-deployment-reviewers.json", import.meta.url)),
      "utf8",
    ),
  );
}

function verifyDeploymentReviewerAttestation(deployment, trustStore) {
  const reviewedAt = parseCanonicalInstant(deployment.reviewedAt, "Release deployment reviewedAt");
  const reviewers = validateReviewerTrustStore(trustStore, {
    expectedSchema: RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
    label: "deployment reviewer trust store",
  });
  const trusted = reviewers.find(
    (reviewer) =>
      reviewer.keyId === deployment.reviewerAttestation.keyId &&
      reviewerKeyWasActiveAt(reviewer, reviewedAt),
  );
  if (!trusted?.publicKey || trusted.principal !== deployment.reviewedBy) {
    throw new TypeError(
      "Deployment reviewer attestation does not match an active checked-in trusted key.",
    );
  }
  const signature = decodeCanonicalBase64(
    deployment.reviewerAttestation.signatureBase64,
    "Release deployment reviewerAttestation.signatureBase64",
    128,
  );
  if (signature.length !== 64) {
    throw new TypeError("Release deployment reviewer attestation signature was invalid.");
  }
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(deploymentSigningRecord(deployment)), "utf8"),
      trusted.publicKey,
      signature,
    )
  ) {
    throw new TypeError("Deployment reviewer attestation signature verification failed.");
  }
}

function checkedReportPath(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    extname(value).toLowerCase() !== ".json"
  ) {
    throw new TypeError(`${name} must be an explicit normalized absolute .json path.`);
  }
  return value;
}

function reportFileIdentity(stat) {
  const dev = stat.dev;
  const ino = stat.ino;
  if (
    ((typeof dev === "number" && Number.isSafeInteger(dev) && dev >= 0) ||
      (typeof dev === "bigint" && dev >= 0n)) &&
    ((typeof ino === "number" && Number.isSafeInteger(ino) && ino > 0) ||
      (typeof ino === "bigint" && ino > 0n))
  ) {
    return `${dev}:${ino}`;
  }
  return null;
}

function assertReportFileStat(stat, name) {
  if (
    stat === null ||
    typeof stat !== "object" ||
    typeof stat.isFile !== "function" ||
    !stat.isFile() ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 1 ||
    stat.size > MAX_REPORT_BYTES ||
    typeof stat.mode !== "number" ||
    (stat.mode & 0o777) !== 0o600 ||
    reportFileIdentity(stat) === null
  ) {
    throw new TypeError(`${name} must identify one bounded mode-0600 regular JSON file.`);
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) {
    throw new TypeError(`${name} must be owned by the current release operator.`);
  }
  return {
    identity: reportFileIdentity(stat),
    mode: stat.mode & 0o777,
    mtimeMs: typeof stat.mtimeMs === "number" ? stat.mtimeMs : null,
    size: stat.size,
  };
}

function readBoundedReport(path) {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_NONBLOCK !== "number") {
    throw new TypeError("Safe no-follow deployment-report file access is unavailable.");
  }
  const flags =
    fsConstants.O_RDONLY |
    fsConstants.O_NOFOLLOW |
    fsConstants.O_NONBLOCK |
    (fsConstants.O_CLOEXEC ?? 0);
  let descriptor;
  try {
    descriptor = openSync(path, flags);
    const before = fstatSync(descriptor);
    assertReportFileStat(before, "Deployment report");
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    return { after, before, bytes: buffer.subarray(0, offset) };
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Unable to safely read the deployment report.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateReportReadResult(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    !(Buffer.isBuffer(value.bytes) || value.bytes instanceof Uint8Array)
  ) {
    throw new TypeError(`${name} reader must return bounded exact bytes.`);
  }
  const before = assertReportFileStat(value.before, `${name} pre-read stat`);
  const after = assertReportFileStat(value.after, `${name} post-read stat`);
  const bytes = Buffer.from(value.bytes);
  if (
    bytes.length !== before.size ||
    bytes.length !== after.size ||
    before.identity !== after.identity ||
    before.mode !== after.mode ||
    (before.mtimeMs !== null && after.mtimeMs !== before.mtimeMs)
  ) {
    throw new TypeError(`${name} changed while it was being reviewed.`);
  }
  return { bytes, identity: before.identity };
}

function readReportBytes(environment, specification, runtime) {
  const inline = environment[specification.base64Environment];
  const path = environment[specification.pathEnvironment];
  const hasInline = typeof inline === "string" && inline.length > 0;
  const hasPath = typeof path === "string" && path.length > 0;
  if (hasInline === hasPath) {
    throw new TypeError(
      `Supply ${specification.label} through exactly one bounded base64 value or absolute report path.`,
    );
  }
  if (hasInline) {
    return {
      bytes: decodeCanonicalBase64(inline, specification.base64Environment, MAX_REPORT_BYTES),
      identity: null,
    };
  }
  const checked = checkedReportPath(path, specification.pathEnvironment);
  return {
    ...validateReportReadResult(runtime.readReport(checked), specification.label),
    path: checked,
  };
}

function parseCanonicalReport(bytes, specification) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new TypeError(`${specification.label} must use valid UTF-8.`);
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new TypeError(`${specification.label} is not valid JSON.`);
  }
  const canonical = canonicalJson(report);
  if (text !== canonical && text !== `${canonical}\n`) {
    throw new TypeError(`${specification.label} JSON must use canonical field order and encoding.`);
  }
  return report;
}

function verifyDeploymentReports(environment, deployment, runtime, verifiedAt) {
  const reports = reportSpecifications.map((specification) => ({
    ...readReportBytes(environment, specification, runtime),
    specification,
  }));
  if (reports[0].path && reports[0].path === reports[1].path) {
    throw new TypeError(
      "External HTTPS and reviewer-access evidence must use distinct report files.",
    );
  }
  if (reports[0].identity !== null && reports[0].identity === reports[1].identity) {
    throw new TypeError(
      "External HTTPS and reviewer-access evidence must use distinct report files.",
    );
  }
  const reviewedAt = parseCanonicalInstant(deployment.reviewedAt, "Release deployment reviewedAt");
  for (const { bytes, specification } of reports) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== deployment[specification.digestField]) {
      throw new TypeError(`${specification.label} SHA-256 does not match reviewed evidence.`);
    }
    specification.validate(
      parseCanonicalReport(bytes, specification),
      deployment,
      reviewedAt,
      verifiedAt,
    );
  }
}

function readExternalDeploymentEvidence(environment, runtime, trustStore) {
  const inline = environment.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON;
  const path = environment.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH;
  const hasInline = typeof inline === "string" && inline.length > 0;
  const hasPath = typeof path === "string" && path.length > 0;
  if (!hasInline && !hasPath) {
    throw new ExpectedReleaseBlockError(
      RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
      RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE,
    );
  }
  if (hasInline && hasPath) {
    throw new TypeError("Supply deployment evidence by exactly one inline JSON or file path.");
  }

  let raw;
  if (hasInline) {
    raw = inline;
  } else {
    if (
      !isAbsolute(path) ||
      normalize(path) !== path ||
      extname(path).toLowerCase() !== ".json" ||
      path.includes("\0")
    ) {
      throw new TypeError(
        "Deployment evidence path must be an explicit normalized absolute .json path.",
      );
    }
    const stat = runtime.statEvidence(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_EXTERNAL_EVIDENCE_BYTES) {
      throw new TypeError("Deployment evidence path must identify one bounded regular JSON file.");
    }
    raw = runtime.readEvidence(path);
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > MAX_EXTERNAL_EVIDENCE_BYTES
  ) {
    throw new TypeError("Deployment evidence JSON is empty or exceeds its byte bound.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("Deployment evidence is not valid JSON.");
  }
  const deployment = validateReleaseDeploymentRecord(parsed);
  if (!deployment.deploymentConfirmed) {
    throw new TypeError(
      "External deployment evidence must explicitly confirm the reviewed deployment.",
    );
  }
  const canonical = canonicalExternalEvidence(deployment);
  if (raw !== canonical && raw !== `${canonical}\n`) {
    throw new TypeError(
      "External deployment evidence JSON must use the canonical field order and encoding.",
    );
  }
  verifyDeploymentReviewerAttestation(deployment, trustStore);
  return deployment;
}

function isKnownLocalTarget(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "10.0.2.2"
  ) {
    return true;
  }

  const unbracketed = normalized.startsWith("[") ? normalized.slice(1, -1) : normalized;
  if (isIP(unbracketed) === 4) {
    const octets = unbracketed.split(".").map(Number);
    return octets[0] === 127 || unbracketed === "0.0.0.0";
  }
  if (isIP(unbracketed) === 6) {
    return (
      unbracketed === "::" ||
      unbracketed === "::1" ||
      unbracketed.startsWith("::7f") ||
      unbracketed.startsWith("::ffff:7f") ||
      unbracketed.startsWith("::ffff:0:7f") ||
      unbracketed === "::ffff:0:0"
    );
  }
  return false;
}

function isReservedDocumentationTarget(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    ["example.com", "example.net", "example.org"].some(
      (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
    )
  ) {
    return true;
  }
  return ["example", "invalid", "test"].some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function isNumericTarget(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  const unbracketed = normalized.startsWith("[") ? normalized.slice(1, -1) : normalized;
  return isIP(unbracketed) !== 0;
}

function isPublicDnsTarget(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized.length > 253 || normalized.endsWith(".") || !PUBLIC_DNS_NAME.test(normalized)) {
    return false;
  }
  return !PRIVATE_DNS_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

export function validatePublicHttpsApiUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("EXPO_PUBLIC_API_URL is required for a mobile release build.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("EXPO_PUBLIC_API_URL must be an absolute HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    isKnownLocalTarget(url.hostname) ||
    isNumericTarget(url.hostname) ||
    !isPublicDnsTarget(url.hostname) ||
    isReservedDocumentationTarget(url.hostname)
  ) {
    throw new TypeError(
      "EXPO_PUBLIC_API_URL must be a credential-free, public-DNS, non-loopback, non-documentation HTTPS origin.",
    );
  }
  return url;
}

export function validateReleaseApiUrl(value) {
  const url = validatePublicHttpsApiUrl(value);
  if (value.trim() !== RELEASE_API_ORIGIN || url.origin !== RELEASE_API_ORIGIN) {
    throw new TypeError(
      `EXPO_PUBLIC_API_URL must exactly match the owned origin ${RELEASE_API_ORIGIN}.`,
    );
  }
  return url;
}

export function validateReleaseDeploymentRecord(record) {
  const evidenceKeys = [
    "apiOrigin",
    "deployedBy",
    "externalHttpsEvidenceSha256",
    "reviewedAt",
    "reviewedBy",
    "reviewerAttestation",
    "reviewerAccessEvidenceSha256",
    "serviceGitCommit",
    "serviceImages",
  ];
  assertExactKeys(
    record,
    ["deploymentConfirmed", "deploymentPlatform", "schemaVersion", ...evidenceKeys],
    "Release deployment record",
  );
  if (record.schemaVersion !== RELEASE_DEPLOYMENT_SCHEMA) {
    throw new TypeError(`Release deployment record must use ${RELEASE_DEPLOYMENT_SCHEMA}.`);
  }
  if (!RELEASE_DEPLOYMENT_PLATFORMS.has(record.deploymentPlatform)) {
    throw new TypeError("Release deployment platform must be exactly azure or oci.");
  }
  if (typeof record.deploymentConfirmed !== "boolean") {
    throw new TypeError("Release deployment confirmation must be an explicit boolean.");
  }
  if (!record.deploymentConfirmed) {
    if (evidenceKeys.some((key) => record[key] !== null)) {
      throw new TypeError(
        "An unconfirmed deployment must not claim evidence; every deployment evidence field must remain null.",
      );
    }
    return {
      apiOrigin: null,
      deployedBy: null,
      deploymentConfirmed: false,
      deploymentPlatform: record.deploymentPlatform,
      externalHttpsEvidenceSha256: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewerAttestation: null,
      reviewerAccessEvidenceSha256: null,
      serviceGitCommit: null,
      serviceImages: null,
    };
  }
  const url = validatePublicHttpsApiUrl(record.apiOrigin);
  if (record.apiOrigin !== url.origin) {
    throw new TypeError("The confirmed API origin must be a canonical HTTPS origin.");
  }
  if (url.origin !== RELEASE_API_ORIGIN) {
    throw new TypeError(`The confirmed API origin must equal ${RELEASE_API_ORIGIN}.`);
  }
  if (typeof record.serviceGitCommit !== "string" || !GIT_COMMIT.test(record.serviceGitCommit)) {
    throw new TypeError(
      "The confirmed deployment must bind one full lowercase service Git commit.",
    );
  }
  const serviceImages = validateServiceImages(record.serviceImages);
  for (const field of ["externalHttpsEvidenceSha256", "reviewerAccessEvidenceSha256"]) {
    if (typeof record[field] !== "string" || !SHA256_HEX.test(record[field])) {
      throw new TypeError(`${field} must be one lowercase SHA-256 evidence digest.`);
    }
  }
  if (record.externalHttpsEvidenceSha256 === record.reviewerAccessEvidenceSha256) {
    throw new TypeError("External HTTPS and reviewer-access evidence must be distinct reports.");
  }
  assertSafeIdentifier(record.deployedBy, "Release deployment deployedBy");
  assertSafeIdentifier(record.reviewedBy, "Release deployment reviewedBy");
  if (record.deployedBy.toLowerCase() === record.reviewedBy.toLowerCase()) {
    throw new TypeError("Release deployment evidence requires an independent reviewer principal.");
  }
  parseCanonicalInstant(record.reviewedAt, "Release deployment reviewedAt");
  assertExactKeys(
    record.reviewerAttestation,
    ["algorithm", "keyId", "signatureBase64"],
    "Release deployment reviewerAttestation",
  );
  if (
    typeof record.reviewerAttestation.keyId !== "string" ||
    !SAFE_KEY_ID.test(record.reviewerAttestation.keyId) ||
    record.reviewerAttestation.algorithm !== "Ed25519"
  ) {
    throw new TypeError("Release deployment reviewer attestation key or algorithm was invalid.");
  }
  const signature = decodeCanonicalBase64(
    record.reviewerAttestation.signatureBase64,
    "Release deployment reviewerAttestation.signatureBase64",
    128,
  );
  if (signature.length !== 64) {
    throw new TypeError("Release deployment reviewer attestation signature was invalid.");
  }
  return {
    apiOrigin: url.origin,
    deployedBy: record.deployedBy,
    deploymentConfirmed: true,
    deploymentPlatform: record.deploymentPlatform,
    externalHttpsEvidenceSha256: record.externalHttpsEvidenceSha256,
    reviewedAt: record.reviewedAt,
    reviewedBy: record.reviewedBy,
    reviewerAttestation: { ...record.reviewerAttestation },
    reviewerAccessEvidenceSha256: record.reviewerAccessEvidenceSha256,
    serviceGitCommit: record.serviceGitCommit,
    serviceImages,
  };
}

export function validateReleaseDeploymentPolicy(record) {
  const policy = validateReleaseDeploymentRecord(record);
  if (policy.deploymentConfirmed) {
    throw new TypeError(
      "The checked-in deployment policy must remain an unconfirmed null template; supply confirmation externally.",
    );
  }
  return policy;
}

export function validateReleaseDeployment(
  environment,
  record,
  runtime = defaultReleaseRuntime(),
  trustStore = defaultDeploymentReviewerTrustStore(),
) {
  const policy = validateReleaseDeploymentPolicy(record);
  const deployment = readExternalDeploymentEvidence(environment, runtime, trustStore);
  if (deployment.deploymentPlatform !== policy.deploymentPlatform) {
    throw new TypeError("External deployment evidence platform must match the checked-in policy.");
  }
  const configured = validateReleaseApiUrl(environment.EXPO_PUBLIC_API_URL);
  if (
    environment.EXPO_PUBLIC_API_URL.trim() !== deployment.apiOrigin ||
    configured.origin !== deployment.apiOrigin
  ) {
    throw new TypeError(
      "EXPO_PUBLIC_API_URL must exactly match the externally confirmed API origin.",
    );
  }
  const actualGitHead = resolveActualReleaseCommit(environment, runtime);
  if (actualGitHead !== deployment.serviceGitCommit) {
    throw new TypeError(
      "The deployed service commit must exactly match the mobile release Git HEAD.",
    );
  }
  const now = runtime.now();
  const nowTime = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowTime)) {
    throw new TypeError("Release deployment verification time is invalid.");
  }
  const reviewedAt = parseCanonicalInstant(deployment.reviewedAt, "Release deployment reviewedAt");
  if (reviewedAt > nowTime + MAX_CLOCK_SKEW_MS) {
    throw new TypeError("Release deployment review cannot be in the future.");
  }
  if (nowTime - reviewedAt > MAX_REVIEW_AGE_MS) {
    throw new TypeError(
      "Release deployment evidence is older than 24 hours and must be reviewed again.",
    );
  }
  verifyDeploymentReports(environment, deployment, runtime, nowTime);
  return configured;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const machineReadable = process.argv.slice(2).includes("--machine-readable");
  try {
    const { default: deploymentRecord } = await import("../config/release-deployment.json", {
      with: { type: "json" },
    });
    validateReleaseDeployment(process.env, deploymentRecord);
    process.stdout.write("Mobile release API configuration is valid.\n");
  } catch (error) {
    if (machineReadable && error instanceof ExpectedReleaseBlockError) {
      process.stdout.write(`${error.code}\n`);
      process.exitCode = RELEASE_EXPECTED_BLOCK_EXIT_CODE;
    } else {
      const message =
        error instanceof Error ? error.message : "Mobile release configuration failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
