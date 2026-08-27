import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REVIEWED_INDEX_DIGEST =
  "sha256:8d6643d86d71fad6ad3cba92cde7ccfce9e4d6c384bda67598eb553571c32431";
const REVIEWED_ARM64_DIGEST =
  "sha256:b4a0a1f9545ae1dd8e12a750fa4416ef3f4b421ed0758c430d0c46182ad233ee";
const REVIEWED_SOURCE_REVISION = "577f7af28942b71782eab1e59f44ad8296ce0a92";

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

function assertHttpsEvidence(value, label) {
  if (!Array.isArray(value) || value.length < 2 || new Set(value).size !== value.length) {
    throw new TypeError(`${label} must contain at least two distinct evidence URLs.`);
  }
  value.forEach((entry, index) => {
    assertHttpsUrl(entry, `${label}[${index}]`);
  });
}

export function validateExternalImageLock(lock) {
  assertExactKeys(
    lock,
    ["schemaVersion", "reviewedAt", "purpose", "platform", "images"],
    "Image lock",
  );
  if (lock.schemaVersion !== 2) throw new TypeError("Image lock schemaVersion must be 2.");
  assertCanonicalDate(lock.reviewedAt, "Image lock reviewedAt");
  if (lock.purpose !== "derivative-bootstrap-input-only" || lock.platform !== "linux/arm64") {
    throw new TypeError("Image lock must be restricted to ARM64 upstream build inputs.");
  }

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
      "usage",
      "directDeploymentApproved",
      "remediation",
      "provenance",
    ],
    "MEILI_IMAGE",
  );
  if (
    image.repository !== "docker.io/getmeili/meilisearch" ||
    image.version !== "v1.53.1" ||
    image.platform !== "linux/arm64" ||
    typeof image.digest !== "string" ||
    !SHA256_PATTERN.test(image.digest) ||
    image.digest !== REVIEWED_INDEX_DIGEST ||
    typeof image.arm64Digest !== "string" ||
    !SHA256_PATTERN.test(image.arm64Digest) ||
    image.arm64Digest !== REVIEWED_ARM64_DIGEST ||
    image.ref !== `${image.repository}@${image.digest}` ||
    image.usage !== "derivative-bootstrap-input-only" ||
    image.directDeploymentApproved !== false
  ) {
    throw new TypeError("MEILI_IMAGE must remain an immutable, non-deployable ARM64 build input.");
  }

  const remediation = assertPlainObject(image.remediation, "MEILI_IMAGE remediation");
  assertExactKeys(
    remediation,
    ["derivativeRepository", "findings", "requiredPackages", "evidence", "review"],
    "MEILI_IMAGE remediation",
  );
  if (remediation.derivativeRepository !== "ghcr.io/liangzixuan/cronometer-gold-meilisearch") {
    throw new TypeError("MEILI_IMAGE derivative repository is not the reviewed GHCR package.");
  }
  const expectedFindings = [
    {
      vulnerability: "CVE-2026-14456",
      severity: "HIGH",
      package: "libcrypto3",
      installedVersion: "3.5.7-r0",
      fixedVersion: "3.5.8-r0",
    },
    {
      vulnerability: "CVE-2026-14456",
      severity: "HIGH",
      package: "libssl3",
      installedVersion: "3.5.7-r0",
      fixedVersion: "3.5.8-r0",
    },
  ];
  if (!Array.isArray(remediation.findings) || remediation.findings.length !== 2) {
    throw new TypeError("MEILI_IMAGE remediation must retain the two reviewed findings.");
  }
  remediation.findings.forEach((finding, index) => {
    assertExactKeys(
      finding,
      ["vulnerability", "severity", "package", "installedVersion", "fixedVersion"],
      `MEILI_IMAGE remediation finding ${index}`,
    );
    if (JSON.stringify(finding) !== JSON.stringify(expectedFindings[index])) {
      throw new TypeError("MEILI_IMAGE remediation finding differs from hosted scan evidence.");
    }
  });
  if (
    !Array.isArray(remediation.requiredPackages) ||
    remediation.requiredPackages.length !== 2 ||
    remediation.requiredPackages[0] !== "libcrypto3=3.5.8-r0" ||
    remediation.requiredPackages[1] !== "libssl3=3.5.8-r0"
  ) {
    throw new TypeError("MEILI_IMAGE remediation packages must remain exactly pinned.");
  }
  assertHttpsEvidence(remediation.evidence, "MEILI_IMAGE remediation evidence");
  if (
    remediation.evidence[0] !==
      "https://gitlab.alpinelinux.org/alpine/aports/-/commit/1b80b7c3bf5ba3f13eb748ae953d9215d5a4bb62" ||
    remediation.evidence[1] !== "https://openssl-library.org/news/secadv/20260813.txt"
  ) {
    throw new TypeError("MEILI_IMAGE remediation evidence differs from the reviewed sources.");
  }
  assertSafeString(remediation.review, "MEILI_IMAGE remediation review", 80);

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
  if (
    provenance.sourceRepository !== "https://github.com/meilisearch/meilisearch" ||
    typeof provenance.sourceRevision !== "string" ||
    !GIT_SHA_PATTERN.test(provenance.sourceRevision) ||
    provenance.sourceRevision !== REVIEWED_SOURCE_REVISION ||
    provenance.sourcePath !== "Dockerfile"
  ) {
    throw new TypeError("MEILI_IMAGE source identity differs from the reviewed release.");
  }
  const expectedIdentity =
    "https://github.com/meilisearch/meilisearch/.github/workflows/" +
    `publish-docker-images.yml@refs/tags/${image.version}`;
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
  assertHttpsEvidence(provenance.evidence, "MEILI_IMAGE provenance evidence");
  const expectedEvidence = [
    `https://github.com/meilisearch/meilisearch/blob/${REVIEWED_SOURCE_REVISION}/.github/workflows/publish-docker-images.yml`,
    `https://github.com/meilisearch/meilisearch/blob/${REVIEWED_SOURCE_REVISION}/Dockerfile`,
    "https://github.com/meilisearch/meilisearch/releases/tag/v1.53.1",
  ];
  if (
    provenance.evidence.length !== expectedEvidence.length ||
    provenance.evidence.some((entry, index) => entry !== expectedEvidence[index])
  ) {
    throw new TypeError("MEILI_IMAGE provenance evidence differs from the reviewed release.");
  }
  assertSafeString(provenance.review, "MEILI_IMAGE provenance review", 80);

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
