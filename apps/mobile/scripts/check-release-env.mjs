import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isIP } from "node:net";
import { extname, isAbsolute, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalEvidence,
  EVIDENCE_LIMITS,
  evidenceSha256,
  loadReviewerTrustStore,
  MANAGED_DEPLOYMENT_SCHEMA,
  MANAGED_PROFILE,
  parseQualificationBundle,
  validateCaptureReview,
  validateManagedActivation,
  validateManagedDeployment,
} from "../../../scripts/deployment/managed-evidence.mjs";

export const RELEASE_DEPLOYMENT_SCHEMA = MANAGED_DEPLOYMENT_SCHEMA;
export const MOBILE_RELEASE_BUNDLE_SCHEMA = "nutrition-tracker-mobile-release-bundle-v1";
export { RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA } from "./reviewer-trust.mjs";
export const RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE =
  "The exact API deployment and active managed web release must be confirmed before release.";
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
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PUBLIC_DNS_NAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const PRIVATE_DNS_SUFFIXES = ["corp", "home", "home.arpa", "internal", "lan", "local"];
const MAX_BYTES = EVIDENCE_LIMITS.bundleBytes + EVIDENCE_LIMITS.reportBytes;
function readPrivateEvidence(path) {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    extname(path) !== ".json" ||
    path.includes("\0")
  )
    throw new TypeError("Release evidence requires a normalized absolute JSON path.");
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > MAX_BYTES ||
      (before.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    )
      throw new TypeError("Release evidence must be a bounded owner-only regular file.");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(fd);
    if (
      count !== before.size ||
      ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "uid"].some(
        (k) => before[k] !== after[k],
      )
    )
      throw new TypeError("Release evidence changed while reading.");
    const raw = bytes.subarray(0, count);
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw)) throw new TypeError("Release evidence UTF-8 is invalid.");
    return text;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function defaultReleaseRuntime() {
  return {
    gitHead: () =>
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        timeout: 10000,
      }).trim(),
    gitStatus: () =>
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        timeout: 10000,
      }),
    now: () => new Date(),
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

export function hasExternalReleaseDeploymentEvidence(environment) {
  return [
    environment?.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON,
    environment?.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH,
  ].some((value) => typeof value === "string" && value.length > 0);
}
export function validateReleaseDeploymentPolicy(record) {
  const expected = {
    schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
    profile: MANAGED_PROFILE,
    target: "production",
    deploymentConfirmed: false,
    apiOrigin: null,
  };
  if (canonicalEvidence(record) !== canonicalEvidence(expected))
    throw new TypeError(
      "The checked-in deployment policy must remain the exact unconfirmed v8 null template.",
    );
  return record;
}
function externalBundle(environment) {
  const inline = environment.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON;
  const path = environment.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH;
  const hasInline = typeof inline === "string" && inline.length > 0;
  const hasPath = typeof path === "string" && path.length > 0;
  if (!hasInline && !hasPath)
    throw new ExpectedReleaseBlockError(
      RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
      RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE,
    );
  if (hasInline && hasPath)
    throw new TypeError("Supply release evidence by exactly one inline JSON or file path.");
  const raw = hasInline ? inline : readPrivateEvidence(path);
  if (Buffer.byteLength(raw) > MAX_BYTES)
    throw new TypeError("Release evidence exceeds its byte bound.");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("Release evidence is invalid JSON.");
  }
  const encoded = canonicalEvidence(value);
  if (raw !== encoded && raw !== `${encoded}\n`)
    throw new TypeError("Release evidence must use canonical JSON.");
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "activation,qualification,schemaVersion" ||
    value.schemaVersion !== MOBILE_RELEASE_BUNDLE_SCHEMA
  )
    throw new TypeError(
      "Release evidence must use the managed mobile bundle; older deployment schemas are rejected.",
    );
  return {
    qualification: parseQualificationBundle(canonicalEvidence(value.qualification)),
    activation: value.activation,
  };
}
export function validateReleaseDeployment(
  environment,
  record,
  runtime = defaultReleaseRuntime(),
  trustStore = loadReviewerTrustStore(),
) {
  validateReleaseDeploymentPolicy(record);
  const { qualification: bundle, activation } = externalBundle(environment);
  const configured = validateReleaseApiUrl(environment.EXPO_PUBLIC_API_URL);
  const revision = resolveActualReleaseCommit(environment, runtime);
  const date = runtime.now();
  const now = date instanceof Date ? date.getTime() : NaN;
  const deployment = bundle.deployment;
  if (
    !deployment?.web ||
    deployment.target !== "production" ||
    deployment.apiOrigin !== configured.origin
  )
    throw new TypeError(
      "Mobile release requires the production managed deployment at the exact API origin.",
    );
  validateManagedDeployment(
    bundle,
    {
      target: "production",
      apiOrigin: configured.origin,
      sourceRevision: revision,
      configurationSha256: deployment.configurationSha256,
      now,
      webOrigin: deployment.web.webOrigin,
      siteId: deployment.web.siteId,
      deploymentId: deployment.web.deploymentId,
      output: deployment.web.output,
    },
    trustStore,
  );
  const capture = bundle.captureReview;
  validateCaptureReview(
    capture,
    {
      sourceRevision: revision,
      summarySha256: capture?.summarySha256,
      sessionId: capture?.sessionId,
      runId: capture?.runId,
      attempt: capture?.attempt,
      now,
    },
    trustStore,
  );
  validateManagedActivation(
    activation,
    {
      deploymentSha256: evidenceSha256(deployment),
      sourceRevision: revision,
      apiOrigin: configured.origin,
      siteId: deployment.web.siteId,
      deploymentId: deployment.web.deploymentId,
      now,
    },
    trustStore,
  );
  return configured;
}
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const { default: policy } = await import("../config/release-deployment.json", {
      with: { type: "json" },
    });
    validateReleaseDeployment(process.env, policy);
    process.stdout.write("Mobile release API configuration is valid.\n");
  } catch (error) {
    if (process.argv.includes("--machine-readable") && error instanceof ExpectedReleaseBlockError) {
      process.stdout.write(`${error.code}\n`);
      process.exitCode = RELEASE_EXPECTED_BLOCK_EXIT_CODE;
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Mobile release validation failed."}\n`,
      );
      process.exitCode = 1;
    }
  }
}
