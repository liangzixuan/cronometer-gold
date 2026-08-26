import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { extname, isAbsolute, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "@nutrition-tracker/contracts";

export const HEALTH_RELEASE_EVIDENCE_SCHEMA = "nutrition-tracker-health-release-evidence-v3";
export const HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA =
  "nutrition-tracker-health-release-reviewer-trust-v1";

const MAX_MANIFEST_BYTES = 32_768;
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const EAS_BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{2,127}$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const IOS_BUILD_NUMBER = /^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const artifactSpecifications = [
  {
    artifactType: "ipa",
    buildIdEnvironment: "NUTRITION_IOS_PHYSICAL_DEVICE_BUILD_ID",
    buildProfile: "physical-device",
    extension: ".ipa",
    label: "physical-device iOS IPA",
    pathEnvironment: "NUTRITION_IOS_PHYSICAL_DEVICE_ARTIFACT_PATH",
    platform: "ios",
    role: "physicalDevice",
  },
  {
    artifactType: "apk",
    buildIdEnvironment: "NUTRITION_ANDROID_PHYSICAL_DEVICE_BUILD_ID",
    buildProfile: "physical-device",
    extension: ".apk",
    label: "physical-device Android APK",
    pathEnvironment: "NUTRITION_ANDROID_PHYSICAL_DEVICE_ARTIFACT_PATH",
    platform: "android",
    role: "physicalDevice",
  },
  {
    artifactType: "ipa",
    buildIdEnvironment: "NUTRITION_IOS_PRODUCTION_BUILD_ID",
    buildProfile: "production",
    extension: ".ipa",
    label: "production iOS IPA",
    pathEnvironment: "NUTRITION_IOS_PRODUCTION_ARTIFACT_PATH",
    platform: "ios",
    role: "production",
  },
  {
    artifactType: "aab",
    buildIdEnvironment: "NUTRITION_ANDROID_PRODUCTION_BUILD_ID",
    buildProfile: "production",
    extension: ".aab",
    label: "production Android AAB",
    pathEnvironment: "NUTRITION_ANDROID_PRODUCTION_ARTIFACT_PATH",
    platform: "android",
    role: "production",
  },
];

const commonMatrixKeys = [
  "inContextPermission",
  "permissionDeniedOrEmptyState",
  "permissionRevokedState",
  "permissionUnavailableState",
  "hardwareBackedSigning",
  "keyInvalidationReregistration",
  "deviceRegistration",
  "initialWeightImport",
  "incrementalWeightImport",
  "editedWeightReconciliation",
  "deletedWeightReconciliation",
  "multiPageReconciliation",
  "cursorExpiryFullReconciliation",
  "lostResponseIdempotentRetry",
  "healthJournalMaximumRoundTrip",
  "healthJournalWriteFailureRecovery",
  "opaquePermissionNoInferredDeletion",
  "revokedPermissionStopsReconciliation",
  "disconnectRetain",
  "disconnectDelete",
  "genericReminderCopy",
  "reminderPauseAndRevoke",
  "reminderTimeZoneReconciliation",
  "terminalPrivateCleanup",
  "erasureStatusAfterSessionRevocation",
  "largeExportArtifactDownload",
];

const forbiddenEvidenceKeys = new Set([
  "challenge",
  "cursor",
  "deviceId",
  "externalId",
  "healthData",
  "nonce",
  "patientId",
  "privateKey",
  "publicKey",
  "recordId",
  "sampleId",
  "token",
  "value",
  "weight",
]);

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

function assertSafeIdentifier(value, name) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new TypeError(`${name} must be a bounded non-secret identifier.`);
  }
}

function parseInstant(value, name) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new TypeError(`${name} must be an ISO-8601 UTC instant with milliseconds.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${name} must be a real canonical UTC instant.`);
  }
  return time;
}

function decodeStandardBase64(value, name, maximumBytes) {
  if (typeof value !== "string" || value.length === 0 || !STANDARD_BASE64.test(value)) {
    throw new TypeError(`${name} must be canonical padded standard base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw new TypeError(`${name} was not canonical or exceeded its bound.`);
  }
  return bytes;
}

function assertPassedMatrix(matrix, name) {
  assertExactKeys(matrix, commonMatrixKeys, name);
  for (const key of commonMatrixKeys) {
    if (matrix[key] !== "passed") throw new TypeError(`${name}.${key} must equal passed.`);
  }
}

function rejectHealthPayloadEvidence(value, path = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      rejectHealthPayloadEvidence(child, `${path}[${index}]`);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenEvidenceKeys.has(key)) {
      throw new TypeError(
        `${path}.${key} must not contain health payloads, identifiers, keys, or tokens.`,
      );
    }
    rejectHealthPayloadEvidence(child, `${path}.${key}`);
  }
}

function assertEasBuildId(value, name) {
  if (typeof value !== "string" || !EAS_BUILD_ID.test(value)) {
    throw new TypeError(`${name} must be an exact lowercase EAS build ID.`);
  }
}

function assertArtifact(artifact, specification, manifestCommit) {
  const name = `manifest.artifacts.${specification.role}.${specification.platform}`;
  assertExactKeys(
    artifact,
    [
      "artifactSha256",
      "artifactType",
      "buildProfile",
      "easBuildId",
      "nativeBuildVersion",
      "platform",
      "signingIdentitySha256",
      "sourceCommit",
    ],
    name,
  );
  if (
    artifact.platform !== specification.platform ||
    artifact.buildProfile !== specification.buildProfile ||
    artifact.artifactType !== specification.artifactType
  ) {
    throw new TypeError(
      `${name} must be the ${specification.buildProfile} ${specification.platform} ${specification.artifactType} artifact.`,
    );
  }
  assertEasBuildId(artifact.easBuildId, `${name}.easBuildId`);
  if (artifact.sourceCommit !== manifestCommit) {
    throw new TypeError(`${name}.sourceCommit must equal manifest.gitCommit.`);
  }
  if (typeof artifact.artifactSha256 !== "string" || !SHA256_HEX.test(artifact.artifactSha256)) {
    throw new TypeError(`${name}.artifactSha256 must bind the exact signed binary.`);
  }
  if (
    typeof artifact.signingIdentitySha256 !== "string" ||
    !SHA256_HEX.test(artifact.signingIdentitySha256)
  ) {
    throw new TypeError(`${name}.signingIdentitySha256 must bind the signing identity.`);
  }
  if (specification.platform === "ios") {
    if (
      typeof artifact.nativeBuildVersion !== "string" ||
      !IOS_BUILD_NUMBER.test(artifact.nativeBuildVersion)
    ) {
      throw new TypeError(`${name}.nativeBuildVersion must be the exact iOS build number.`);
    }
  } else if (
    !Number.isInteger(artifact.nativeBuildVersion) ||
    artifact.nativeBuildVersion < 1 ||
    artifact.nativeBuildVersion > 2_100_000_000
  ) {
    throw new TypeError(`${name}.nativeBuildVersion must be the exact Android version code.`);
  }
  return artifact;
}

function assertArtifacts(artifacts, manifestCommit) {
  assertExactKeys(artifacts, ["physicalDevice", "production"], "manifest.artifacts");
  assertExactKeys(
    artifacts.physicalDevice,
    ["ios", "android"],
    "manifest.artifacts.physicalDevice",
  );
  assertExactKeys(artifacts.production, ["ios", "android"], "manifest.artifacts.production");

  const buildIds = new Set();
  const artifactDigests = new Set();
  for (const specification of artifactSpecifications) {
    const artifact = assertArtifact(
      artifacts[specification.role][specification.platform],
      specification,
      manifestCommit,
    );
    if (buildIds.has(artifact.easBuildId)) {
      throw new TypeError("Every reviewed artifact must have a distinct exact EAS build ID.");
    }
    buildIds.add(artifact.easBuildId);
    if (artifactDigests.has(artifact.artifactSha256)) {
      throw new TypeError("Every reviewed artifact must have a distinct exact SHA-256 digest.");
    }
    artifactDigests.add(artifact.artifactSha256);
  }

  for (const platform of ["ios", "android"]) {
    if (
      artifacts.physicalDevice[platform].nativeBuildVersion !==
      artifacts.production[platform].nativeBuildVersion
    ) {
      throw new TypeError(
        `The physical-device and production ${platform} artifacts must use the same source-controlled native build version.`,
      );
    }
  }
}

function assertDevice(device, platform, testedArtifact) {
  assertExactKeys(
    device,
    [
      "platform",
      "physicalDevice",
      "model",
      "osVersion",
      "testedEasBuildId",
      "declarations",
      "matrix",
      "healthJournalBenchmark",
    ],
    `manifest.devices.${platform}`,
  );
  if (device.platform !== platform || device.physicalDevice !== true) {
    throw new TypeError(
      `manifest.devices.${platform} must identify a physical ${platform} device.`,
    );
  }
  assertSafeIdentifier(device.model, `manifest.devices.${platform}.model`);
  assertSafeIdentifier(device.osVersion, `manifest.devices.${platform}.osVersion`);
  assertEasBuildId(device.testedEasBuildId, `manifest.devices.${platform}.testedEasBuildId`);
  if (device.testedEasBuildId !== testedArtifact.easBuildId) {
    throw new TypeError(
      `manifest.devices.${platform}.testedEasBuildId must bind the physical-device artifact.`,
    );
  }
  const declarations =
    platform === "ios"
      ? ["healthKitCapability", "readOnlyBodyWeightPurpose", "noWriteOrBackgroundScope"]
      : ["healthConnectManifest", "playBodyWeightDeclaration", "minSdk26"];
  assertExactKeys(device.declarations, declarations, `manifest.devices.${platform}.declarations`);
  for (const [key, result] of Object.entries(device.declarations)) {
    if (result !== "passed") {
      throw new TypeError(`manifest.devices.${platform}.declarations.${key} must equal passed.`);
    }
  }
  assertPassedMatrix(device.matrix, `manifest.devices.${platform}.matrix`);
  assertExactKeys(
    device.healthJournalBenchmark,
    [
      "knownRevisionCount",
      "signedRecordCount",
      "serializedBytes",
      "chunkCount",
      "writeMilliseconds",
      "readMilliseconds",
    ],
    `manifest.devices.${platform}.healthJournalBenchmark`,
  );
  const benchmark = device.healthJournalBenchmark;
  if (
    benchmark.knownRevisionCount !== 10_000 ||
    benchmark.signedRecordCount !== 100 ||
    !Number.isSafeInteger(benchmark.serializedBytes) ||
    benchmark.serializedBytes < 1 ||
    benchmark.serializedBytes > 1_228_800 ||
    !Number.isSafeInteger(benchmark.chunkCount) ||
    benchmark.chunkCount < 1 ||
    benchmark.chunkCount > 1_024 ||
    !Number.isSafeInteger(benchmark.writeMilliseconds) ||
    benchmark.writeMilliseconds < 1 ||
    benchmark.writeMilliseconds > 3_600_000 ||
    !Number.isSafeInteger(benchmark.readMilliseconds) ||
    benchmark.readMilliseconds < 1 ||
    benchmark.readMilliseconds > 3_600_000
  ) {
    throw new TypeError(
      `manifest.devices.${platform}.healthJournalBenchmark must record the bounded 10,000-revision/100-record physical round trip.`,
    );
  }
}

function parseTrustStore(trustStore, reviewedAt) {
  assertExactKeys(trustStore, ["schemaVersion", "reviewers"], "reviewer trust store");
  if (trustStore.schemaVersion !== HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA) {
    throw new TypeError("Reviewer trust-store schema is unsupported.");
  }
  if (!Array.isArray(trustStore.reviewers) || trustStore.reviewers.length > 20) {
    throw new TypeError("Reviewer trust store must contain at most 20 keys.");
  }
  const seen = new Set();
  return trustStore.reviewers.map((reviewer, index) => {
    const name = `reviewer trust store.reviewers[${index}]`;
    assertExactKeys(
      reviewer,
      ["keyId", "principal", "algorithm", "publicKeySpkiDerBase64", "validFrom", "validUntil"],
      name,
    );
    if (
      typeof reviewer.keyId !== "string" ||
      !SAFE_KEY_ID.test(reviewer.keyId) ||
      seen.has(reviewer.keyId)
    ) {
      throw new TypeError(`${name}.keyId was invalid or duplicated.`);
    }
    seen.add(reviewer.keyId);
    assertSafeIdentifier(reviewer.principal, `${name}.principal`);
    if (reviewer.algorithm !== "Ed25519") throw new TypeError(`${name}.algorithm must be Ed25519.`);
    const validFrom = parseInstant(reviewer.validFrom, `${name}.validFrom`);
    const validUntil = parseInstant(reviewer.validUntil, `${name}.validUntil`);
    if (validFrom > reviewedAt || reviewedAt > validUntil) {
      return { ...reviewer, active: false, publicKey: null };
    }
    const der = decodeStandardBase64(
      reviewer.publicKeySpkiDerBase64,
      `${name}.publicKeySpkiDerBase64`,
      256,
    );
    let publicKey;
    try {
      publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      throw new TypeError(`${name} was not a valid SPKI public key.`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`${name} was not an Ed25519 public key.`);
    }
    return { ...reviewer, active: true, publicKey };
  });
}

function verifyReviewerAttestation(manifest, trustStore, reviewedAt) {
  assertExactKeys(
    manifest.reviewerAttestation,
    ["keyId", "algorithm", "signatureBase64"],
    "manifest.reviewerAttestation",
  );
  if (
    typeof manifest.reviewerAttestation.keyId !== "string" ||
    !SAFE_KEY_ID.test(manifest.reviewerAttestation.keyId) ||
    manifest.reviewerAttestation.algorithm !== "Ed25519"
  ) {
    throw new TypeError("Reviewer attestation algorithm or key ID was invalid.");
  }
  const signature = decodeStandardBase64(
    manifest.reviewerAttestation.signatureBase64,
    "manifest.reviewerAttestation.signatureBase64",
    128,
  );
  if (signature.length !== 64) throw new TypeError("Reviewer attestation signature was invalid.");
  const reviewers = parseTrustStore(trustStore, reviewedAt);
  const trusted = reviewers.find(
    (reviewer) => reviewer.keyId === manifest.reviewerAttestation.keyId && reviewer.active,
  );
  if (!trusted?.publicKey || trusted.principal !== manifest.reviewedBy) {
    throw new TypeError("Reviewer attestation does not match an active checked-in trusted key.");
  }
  const { reviewerAttestation: _signature, ...signedManifest } = manifest;
  if (
    !verify(null, Buffer.from(canonicalJson(signedManifest), "utf8"), trusted.publicKey, signature)
  ) {
    throw new TypeError("Reviewer attestation signature verification failed.");
  }
}

function defaultTrustStore() {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../config/health-release-reviewers.json", import.meta.url)),
      "utf8",
    ),
  );
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

async function streamSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function checkedArtifactPath(value, extension, name, statArtifact) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    extname(value).toLowerCase() !== extension
  ) {
    throw new TypeError(`${name} must be an explicit normalized absolute ${extension} path.`);
  }
  const stat = statArtifact(value);
  if (!stat.isFile() || stat.size < 1 || stat.size > 4 * 1_024 * 1_024 * 1_024) {
    throw new TypeError(`${name} must be a bounded regular signed-binary file.`);
  }
  let filesystemIdentity = null;
  if (
    typeof stat.dev === "number" &&
    typeof stat.ino === "number" &&
    Number.isSafeInteger(stat.dev) &&
    Number.isSafeInteger(stat.ino) &&
    stat.dev >= 0 &&
    stat.ino > 0
  ) {
    filesystemIdentity = `${stat.dev}:${stat.ino}`;
  } else if (
    typeof stat.dev === "bigint" &&
    typeof stat.ino === "bigint" &&
    stat.dev >= 0n &&
    stat.ino > 0n
  ) {
    filesystemIdentity = `${stat.dev}:${stat.ino}`;
  }
  return { filesystemIdentity, path: value };
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
    hashArtifact: streamSha256,
    statArtifact: lstatSync,
  };
}

/** Ordinary CI must never construct this externally reviewed physical-device evidence. */
export async function validateHealthReleaseEvidence(
  environment,
  now = new Date(),
  trustStore = defaultTrustStore(),
  runtime = defaultReleaseRuntime(),
) {
  const raw = environment.NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(
      "Signed-device health release evidence is absent. Supply a cryptographically reviewed physical-device manifest.",
    );
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new TypeError(`Health release evidence exceeds ${MAX_MANIFEST_BYTES} bytes.`);
  }
  const expectedManifestDigest = environment.NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256;
  if (typeof expectedManifestDigest !== "string" || !SHA256_HEX.test(expectedManifestDigest)) {
    throw new TypeError("NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256 must pin the evidence manifest.");
  }
  const actualManifestDigest = createHash("sha256").update(raw, "utf8").digest("hex");
  if (actualManifestDigest !== expectedManifestDigest) {
    throw new TypeError("Health release evidence checksum does not match the pinned manifest.");
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new TypeError("Health release evidence is not valid JSON.");
  }
  rejectHealthPayloadEvidence(manifest);
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "appVersion",
      "gitCommit",
      "executedBy",
      "executedAt",
      "reviewedBy",
      "reviewedAt",
      "artifacts",
      "devices",
      "reviewerAttestation",
    ],
    "manifest",
  );
  if (manifest.schemaVersion !== HEALTH_RELEASE_EVIDENCE_SCHEMA) {
    throw new TypeError(`manifest.schemaVersion must equal ${HEALTH_RELEASE_EVIDENCE_SCHEMA}.`);
  }
  if (typeof manifest.appVersion !== "string" || !SAFE_VERSION.test(manifest.appVersion)) {
    throw new TypeError("manifest.appVersion must be a bounded semantic version.");
  }
  if (typeof manifest.gitCommit !== "string" || !GIT_COMMIT.test(manifest.gitCommit)) {
    throw new TypeError("manifest.gitCommit must be a full lowercase Git commit.");
  }
  assertSafeIdentifier(manifest.executedBy, "manifest.executedBy");
  assertSafeIdentifier(manifest.reviewedBy, "manifest.reviewedBy");
  if (manifest.executedBy.toLowerCase() === manifest.reviewedBy.toLowerCase()) {
    throw new TypeError("Physical-device evidence requires an independent reviewer principal.");
  }
  const executedAt = parseInstant(manifest.executedAt, "manifest.executedAt");
  const reviewedAt = parseInstant(manifest.reviewedAt, "manifest.reviewedAt");
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) throw new TypeError("Release-check time is invalid.");
  if (reviewedAt < executedAt || reviewedAt > nowTime + MAX_CLOCK_SKEW_MS) {
    throw new TypeError("Evidence review time must follow execution and cannot be in the future.");
  }
  if (nowTime - reviewedAt > MAX_EVIDENCE_AGE_MS) {
    throw new TypeError("Signed-device evidence is older than 30 days and must be rerun.");
  }

  assertArtifacts(manifest.artifacts, manifest.gitCommit);
  assertExactKeys(manifest.devices, ["ios", "android"], "manifest.devices");
  assertDevice(manifest.devices.ios, "ios", manifest.artifacts.physicalDevice.ios);
  assertDevice(manifest.devices.android, "android", manifest.artifacts.physicalDevice.android);
  verifyReviewerAttestation(manifest, trustStore, reviewedAt);

  const actualGitHead = runtime.gitHead();
  if (!GIT_COMMIT.test(actualGitHead) || actualGitHead !== manifest.gitCommit) {
    throw new TypeError("Reviewed health evidence does not match the actual Git HEAD.");
  }
  if (runtime.gitStatus().trim() !== "") {
    throw new TypeError("Signed-device health release verification requires a clean Git tree.");
  }
  const checkedArtifacts = artifactSpecifications.map((specification) => {
    const artifact = manifest.artifacts[specification.role][specification.platform];
    const checkedPath = checkedArtifactPath(
      environment[specification.pathEnvironment],
      specification.extension,
      specification.pathEnvironment,
      runtime.statArtifact,
    );
    if (environment[specification.buildIdEnvironment] !== artifact.easBuildId) {
      throw new TypeError(
        `The ${specification.label} EAS build ID does not match reviewed evidence.`,
      );
    }
    return { artifact, ...checkedPath, specification };
  });
  const artifactPaths = checkedArtifacts.map(({ path }) => path);
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new TypeError("Every reviewed artifact must use a distinct normalized absolute path.");
  }
  const filesystemIdentities = checkedArtifacts
    .map(({ filesystemIdentity }) => filesystemIdentity)
    .filter((identity) => identity !== null);
  if (new Set(filesystemIdentities).size !== filesystemIdentities.length) {
    throw new TypeError("Every reviewed artifact must identify a distinct filesystem file.");
  }
  const actualDigests = await Promise.all(
    checkedArtifacts.map(({ path }) => runtime.hashArtifact(path)),
  );
  if (new Set(actualDigests).size !== actualDigests.length) {
    throw new TypeError("Every reviewed artifact file must have a distinct actual SHA-256 digest.");
  }
  for (const [index, actualDigest] of actualDigests.entries()) {
    const { artifact, specification } = checkedArtifacts[index];
    if (!SHA256_HEX.test(actualDigest)) {
      throw new TypeError(`${specification.label} did not produce a lowercase SHA-256 digest.`);
    }
    if (actualDigest !== artifact.artifactSha256) {
      throw new TypeError(
        `The actual ${specification.label} digest does not match reviewed evidence.`,
      );
    }
  }
  return {
    manifestSha256: actualManifestDigest,
    gitCommit: manifest.gitCommit,
    artifactSha256: {
      physicalDevice: {
        ios: manifest.artifacts.physicalDevice.ios.artifactSha256,
        android: manifest.artifacts.physicalDevice.android.artifactSha256,
      },
      production: {
        ios: manifest.artifacts.production.ios.artifactSha256,
        android: manifest.artifacts.production.android.artifactSha256,
      },
    },
    reviewerKeyId: manifest.reviewerAttestation.keyId,
  };
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const evidence = await validateHealthReleaseEvidence(process.env);
    process.stdout.write(
      `Trusted reviewer attestation ${evidence.reviewerKeyId} verified for evidence ${evidence.manifestSha256}.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Health release evidence failed."}\n`,
    );
    process.exitCode = 1;
  }
}
