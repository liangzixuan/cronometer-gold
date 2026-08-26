import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const keys = Object.keys(assertPlainObject(value, label)).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain only: ${expected.join(", ")}.`);
  }
}

function assertCanonicalDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical ISO date.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} must be a real calendar date.`);
  }
}

function assertCanonicalInstant(value, label) {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical UTC instant.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
    throw new TypeError(`${label} must be a real canonical UTC instant.`);
  }
}

function assertSafeString(value, label, minimumLength = 1) {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    containsControlCharacter(value)
  ) {
    throw new TypeError(`${label} must be a nonempty string without control characters.`);
  }
}

function assertHttpsUrl(value, label) {
  assertSafeString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.href !== value
  ) {
    throw new TypeError(`${label} must be a canonical credential-free HTTPS URL.`);
  }
}

function assertStringMap(value, label) {
  const map = assertPlainObject(value, label);
  for (const [key, entry] of Object.entries(map)) {
    assertSafeString(key, `${label} key`);
    assertSafeString(entry, `${label}.${key}`);
  }
}

export function validateExternalImageLock(lock) {
  assertExactKeys(lock, ["schemaVersion", "reviewedAt", "policy", "images"], "Image lock");
  if (lock.schemaVersion !== 1) throw new TypeError("Image lock schemaVersion must be 1.");
  assertCanonicalDate(lock.reviewedAt, "Image lock reviewedAt");

  assertExactKeys(
    lock.policy,
    [
      "platform",
      "scanner",
      "scannerVersion",
      "databaseUpdatedAt",
      "severities",
      "includeUnfixed",
      "ignorePolicy",
    ],
    "Image lock policy",
  );
  if (
    lock.policy.platform !== "linux/arm64" ||
    lock.policy.scanner !== "Trivy" ||
    lock.policy.scannerVersion !== "v0.74.0" ||
    lock.policy.includeUnfixed !== true ||
    lock.policy.ignorePolicy !== "explicit-empty" ||
    !Array.isArray(lock.policy.severities) ||
    lock.policy.severities.length !== 2 ||
    lock.policy.severities[0] !== "HIGH" ||
    lock.policy.severities[1] !== "CRITICAL"
  ) {
    throw new TypeError("Image lock policy does not match the strict ARM64 Trivy contract.");
  }
  assertCanonicalInstant(lock.policy.databaseUpdatedAt, "Image lock databaseUpdatedAt");

  assertExactKeys(lock.images, ["MEILI_IMAGE"], "Image lock images");
  const image = assertPlainObject(lock.images.MEILI_IMAGE, "MEILI_IMAGE");
  assertExactKeys(
    image,
    [
      "repository",
      "version",
      "platform",
      "digest",
      "arm64Digest",
      "ref",
      "approved",
      "scan",
      "provenance",
    ],
    "MEILI_IMAGE",
  );
  if (
    image.repository !== "docker.io/getmeili/meilisearch" ||
    typeof image.version !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(image.version) ||
    image.platform !== "linux/arm64" ||
    typeof image.digest !== "string" ||
    !SHA256_PATTERN.test(image.digest) ||
    typeof image.arm64Digest !== "string" ||
    !SHA256_PATTERN.test(image.arm64Digest) ||
    image.ref !== `${image.repository}@${image.digest}` ||
    typeof image.approved !== "boolean"
  ) {
    throw new TypeError("MEILI_IMAGE identity does not match the immutable ARM64 contract.");
  }

  assertExactKeys(image.scan, ["critical", "high", "total", "result"], "MEILI_IMAGE scan");
  for (const field of ["critical", "high", "total"]) {
    if (!Number.isSafeInteger(image.scan[field]) || image.scan[field] < 0) {
      throw new TypeError(`MEILI_IMAGE scan.${field} must be a nonnegative integer.`);
    }
  }
  if (image.scan.total !== image.scan.critical + image.scan.high) {
    throw new TypeError("MEILI_IMAGE scan total must equal critical plus high findings.");
  }
  if (
    (image.approved && (image.scan.total !== 0 || image.scan.result !== "passed")) ||
    (!image.approved && image.scan.result !== "blocked")
  ) {
    throw new TypeError("MEILI_IMAGE approval and vulnerability result disagree.");
  }

  const provenance = assertPlainObject(image.provenance, "MEILI_IMAGE provenance");
  assertExactKeys(
    provenance,
    [
      "method",
      "containerSignature",
      "sourceRepository",
      "sourceRevision",
      "sourcePath",
      "expectedRuntime",
      "certificateIdentity",
      "certificateOidcIssuer",
      "evidence",
      "review",
    ],
    "MEILI_IMAGE provenance",
  );
  if (provenance.method !== "sigstore-keyless" || provenance.containerSignature !== "verified") {
    throw new TypeError("MEILI_IMAGE requires a verified Sigstore keyless container signature.");
  }
  if (provenance.sourceRepository !== "https://github.com/meilisearch/meilisearch") {
    throw new TypeError(
      "MEILI_IMAGE source repository must be the reviewed Meilisearch repository.",
    );
  }
  if (
    typeof provenance.sourceRevision !== "string" ||
    !GIT_SHA_PATTERN.test(provenance.sourceRevision)
  ) {
    throw new TypeError("MEILI_IMAGE source revision must be a full lowercase Git SHA.");
  }
  assertSafeString(provenance.sourcePath, "MEILI_IMAGE sourcePath");
  const expectedIdentity =
    `https://github.com/meilisearch/meilisearch/.github/workflows/` +
    `publish-docker-images.yml@refs/tags/${image.version}`;
  if (typeof provenance.certificateIdentity === "string") {
    assertSafeString(provenance.certificateIdentity, "MEILI_IMAGE certificateIdentity");
  }
  if (
    provenance.certificateIdentity !== expectedIdentity ||
    provenance.certificateOidcIssuer !== "https://token.actions.githubusercontent.com"
  ) {
    throw new TypeError("MEILI_IMAGE signing certificate identity or OIDC issuer is not reviewed.");
  }

  assertExactKeys(
    provenance.expectedRuntime,
    ["descriptorAnnotations", "labels", "environment"],
    "MEILI_IMAGE expectedRuntime",
  );
  assertStringMap(
    provenance.expectedRuntime.descriptorAnnotations,
    "MEILI_IMAGE descriptorAnnotations",
  );
  assertStringMap(provenance.expectedRuntime.labels, "MEILI_IMAGE labels");
  const expectedLabels = provenance.expectedRuntime.labels;
  if (
    expectedLabels["org.opencontainers.image.revision"] !== provenance.sourceRevision ||
    expectedLabels["org.opencontainers.image.source"] !== provenance.sourceRepository ||
    expectedLabels["org.opencontainers.image.version"] !== image.version
  ) {
    throw new TypeError("MEILI_IMAGE expected labels do not bind the reviewed source and version.");
  }
  if (
    !Array.isArray(provenance.expectedRuntime.environment) ||
    provenance.expectedRuntime.environment.length !== 1 ||
    provenance.expectedRuntime.environment[0] !== "MEILI_SERVER_PROVIDER=docker"
  ) {
    throw new TypeError("MEILI_IMAGE expected environment must match the reviewed Docker runtime.");
  }
  if (!Array.isArray(provenance.evidence) || provenance.evidence.length < 2) {
    throw new TypeError("MEILI_IMAGE provenance requires at least two evidence URLs.");
  }
  provenance.evidence.forEach((value, index) => {
    assertHttpsUrl(value, `MEILI_IMAGE evidence[${index}]`);
  });
  assertSafeString(provenance.review, "MEILI_IMAGE review", 41);

  return image;
}

export function readAndValidateExternalImageLock(path) {
  const raw = readFileSync(path, "utf8");
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    throw new TypeError("External image lock must contain valid JSON.");
  }
  return validateExternalImageLock(lock);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    if (process.argv.length !== 3) {
      throw new TypeError("Usage: node scripts/verify-external-image-lock.mjs <lock-file>");
    }
    readAndValidateExternalImageLock(process.argv[2]);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "External image lock validation failed."}\n`,
    );
    process.exitCode = 1;
  }
}
