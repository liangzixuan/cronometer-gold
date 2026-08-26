import { execFileSync } from "node:child_process";
import { createHash, verify } from "node:crypto";
import {
  closeSync,
  createReadStream,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { extname, isAbsolute, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "@nutrition-tracker/contracts";

import { validatePhysicalDeviceApiUrl } from "./physical-device-api-url.mjs";
import {
  HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
  reviewerKeyWasActiveAt,
  validateReviewerTrustStore,
} from "./reviewer-trust.mjs";

export const HEALTH_RELEASE_EVIDENCE_SCHEMA = "nutrition-tracker-health-release-evidence-v4";
export { HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA } from "./reviewer-trust.mjs";
export const PHYSICAL_DEVICE_RELAY_REPORT_SCHEMA =
  "nutrition-tracker-physical-device-relay-report-v2";
const PHYSICAL_DEVICE_RELAY_TRUST_BOUNDARY =
  "unsigned-structural-candidate-requires-independent-ed25519-manifest-review";

const RELEASE_NUMBERING_SCHEMA = "nutrition-tracker-release-numbering-v1";
const MAX_MANIFEST_BYTES = 32_768;
const MAX_RELAY_REPORT_BYTES = 65_536;
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RELAY_SESSION_MS = 24 * 60 * 60 * 1_000;
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
const BASELINE_DENIED_TCP_PORTS = Object.freeze([
  22, 80, 1025, 2181, 4000, 4566, 5432, 7700, 8025, 8080, 8081, 9000, 9001, 9092,
]);
const PHYSICAL_PHONE_ALIASES = Object.freeze([
  "nutrition-tracker-phone-1",
  "nutrition-tracker-phone-2",
]);

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

function assertSha256(value, name) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${name} must be one lowercase SHA-256 digest.`);
  }
}

function assertExactResult(value, expected, name) {
  if (value !== expected) throw new TypeError(`${name} must equal ${expected}.`);
}

function assertSortedPortArray(value, name, { allowEmpty = false, allowHttps = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 1_024) {
    throw new TypeError(`${name} must be a bounded TCP-port array.`);
  }
  let previous = 0;
  for (const port of value) {
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      (!allowHttps && port === 443) ||
      port <= previous
    ) {
      throw new TypeError(`${name} must contain unique ascending TCP ports in range.`);
    }
    previous = port;
  }
  return value;
}

function assertPhysicalDeviceApiRelay(relay, environment) {
  assertExactKeys(relay, ["apiOrigin", "reportSha256"], "manifest.physicalDeviceApiRelay");
  const url = validatePhysicalDeviceApiUrl(relay.apiOrigin);
  if (relay.apiOrigin !== url.origin) {
    throw new TypeError("manifest.physicalDeviceApiRelay.apiOrigin must be canonical.");
  }
  if (environment.NUTRITION_PHYSICAL_DEVICE_API_ORIGIN !== relay.apiOrigin) {
    throw new TypeError(
      "NUTRITION_PHYSICAL_DEVICE_API_ORIGIN must exactly pin the reviewed physical-device API origin.",
    );
  }
  assertSha256(relay.reportSha256, "manifest.physicalDeviceApiRelay.reportSha256");
  return relay;
}

function assertRelayProbe(
  probe,
  platform,
  artifact,
  inventoriedPorts,
  tailnetAccess,
  startedAt,
  executedAt,
) {
  const name = `physical-device relay report.deviceProbes.${platform}`;
  assertExactKeys(
    probe,
    [
      "testedEasBuildId",
      "phoneAlias",
      "observedAt",
      "policySha256",
      "configurationLogEventSha256",
      "publicCaAndHostname",
      "readyHttpStatus",
      "openTcpPorts",
      "blockedTcpPorts",
      "tailscaleDisabledHttps",
    ],
    name,
  );
  assertEasBuildId(probe.testedEasBuildId, `${name}.testedEasBuildId`);
  if (probe.testedEasBuildId !== artifact.easBuildId) {
    throw new TypeError(`${name}.testedEasBuildId must bind the ${platform} physical artifact.`);
  }
  const expectedAlias = platform === "ios" ? PHYSICAL_PHONE_ALIASES[0] : PHYSICAL_PHONE_ALIASES[1];
  if (probe.phoneAlias !== expectedAlias) {
    throw new TypeError(`${name}.phoneAlias must bind the distinct reviewed ${platform} phone.`);
  }
  const observedAt = parseInstant(probe.observedAt, `${name}.observedAt`);
  if (observedAt < startedAt || observedAt > executedAt) {
    throw new TypeError(`${name}.observedAt must fall inside the reviewed active test session.`);
  }
  if (
    probe.policySha256 !== tailnetAccess.policySha256 ||
    probe.configurationLogEventSha256 !== tailnetAccess.configurationLogEventSha256
  ) {
    throw new TypeError(`${name} must bind the same reviewed two-phone policy and event.`);
  }
  assertExactResult(probe.publicCaAndHostname, "passed", `${name}.publicCaAndHostname`);
  if (probe.readyHttpStatus !== 200) {
    throw new TypeError(`${name}.readyHttpStatus must equal 200.`);
  }
  if (
    !Array.isArray(probe.openTcpPorts) ||
    probe.openTcpPorts.length !== 1 ||
    probe.openTcpPorts[0] !== 443
  ) {
    throw new TypeError(`${name}.openTcpPorts must contain only TCP/443.`);
  }
  assertSortedPortArray(probe.blockedTcpPorts, `${name}.blockedTcpPorts`);
  if (
    probe.blockedTcpPorts.length !== inventoriedPorts.length ||
    probe.blockedTcpPorts.some((port, index) => port !== inventoriedPorts[index])
  ) {
    throw new TypeError(`${name}.blockedTcpPorts must equal the complete listener inventory.`);
  }
  assertExactResult(probe.tailscaleDisabledHttps, "blocked", `${name}.tailscaleDisabledHttps`);
}

function validatePhysicalDeviceRelayReport(report, relay, artifacts, executedAt, reviewedAt) {
  assertExactKeys(
    report,
    [
      "schemaVersion",
      "trustBoundary",
      "sourceCaptureBundleSha256",
      "apiOrigin",
      "startedAt",
      "executedAt",
      "completedAt",
      "preflight",
      "serve",
      "tailnetAccess",
      "listenerInventory",
      "deviceProbes",
      "teardown",
    ],
    "physical-device relay report",
  );
  if (report.schemaVersion !== PHYSICAL_DEVICE_RELAY_REPORT_SCHEMA) {
    throw new TypeError(
      `physical-device relay report.schemaVersion must equal ${PHYSICAL_DEVICE_RELAY_REPORT_SCHEMA}.`,
    );
  }
  if (report.trustBoundary !== PHYSICAL_DEVICE_RELAY_TRUST_BOUNDARY) {
    throw new TypeError(
      "physical-device relay report must remain an unsigned structural candidate until independent Ed25519 manifest review.",
    );
  }
  assertSha256(
    report.sourceCaptureBundleSha256,
    "physical-device relay report.sourceCaptureBundleSha256",
  );
  const reportOrigin = validatePhysicalDeviceApiUrl(report.apiOrigin);
  if (report.apiOrigin !== reportOrigin.origin || report.apiOrigin !== relay.apiOrigin) {
    throw new TypeError("Physical-device relay report API origin must match signed evidence.");
  }
  const startedAt = parseInstant(report.startedAt, "physical-device relay report.startedAt");
  const reportExecutedAt = parseInstant(
    report.executedAt,
    "physical-device relay report.executedAt",
  );
  const completedAt = parseInstant(report.completedAt, "physical-device relay report.completedAt");
  if (
    startedAt > executedAt ||
    reportExecutedAt !== executedAt ||
    executedAt > completedAt ||
    completedAt > reviewedAt ||
    completedAt - startedAt > MAX_RELAY_SESSION_MS
  ) {
    throw new TypeError(
      "Physical-device relay timing must exactly bind signed execution, finish before review, and span at most 24 hours.",
    );
  }

  assertExactKeys(
    report.preflight,
    [
      "firstConnectionShieldsUp",
      "initialServeAndFunnelStatus",
      "incomingAccessHeldUntilPolicyTests",
      "macIdentityRevalidated",
      "iosIdentityRevalidated",
      "androidIdentityRevalidated",
      "shieldsUpStatusSha256",
      "initialServeStatusSha256",
      "initialFunnelStatusSha256",
      "identityStatusSha256",
      "accessControlTimelineSha256",
    ],
    "physical-device relay report.preflight",
  );
  for (const field of [
    "firstConnectionShieldsUp",
    "incomingAccessHeldUntilPolicyTests",
    "macIdentityRevalidated",
    "iosIdentityRevalidated",
    "androidIdentityRevalidated",
  ]) {
    assertExactResult(
      report.preflight[field],
      "passed",
      `physical-device relay report.preflight.${field}`,
    );
  }
  assertExactResult(
    report.preflight.initialServeAndFunnelStatus,
    "empty",
    "physical-device relay report.preflight.initialServeAndFunnelStatus",
  );
  for (const field of [
    "shieldsUpStatusSha256",
    "initialServeStatusSha256",
    "initialFunnelStatusSha256",
    "identityStatusSha256",
    "accessControlTimelineSha256",
  ]) {
    assertSha256(report.preflight[field], `physical-device relay report.preflight.${field}`);
  }

  assertExactKeys(
    report.serve,
    [
      "mode",
      "httpsPort",
      "handlerPath",
      "upstream",
      "persistentConfiguration",
      "foregroundSessionCount",
      "funnelEnabled",
      "serveStatusSha256",
      "funnelStatusSha256",
    ],
    "physical-device relay report.serve",
  );
  assertExactResult(report.serve.mode, "foreground", "physical-device relay report.serve.mode");
  if (
    report.serve.httpsPort !== 443 ||
    report.serve.handlerPath !== "/" ||
    report.serve.upstream !== "http://127.0.0.1:4000" ||
    report.serve.persistentConfiguration !== "empty" ||
    report.serve.foregroundSessionCount !== 1 ||
    report.serve.funnelEnabled !== false
  ) {
    throw new TypeError(
      "Physical-device relay report must prove one foreground HTTPS/443 root proxy to exact API loopback with no persistent Serve or Funnel.",
    );
  }
  assertSha256(
    report.serve.serveStatusSha256,
    "physical-device relay report.serve.serveStatusSha256",
  );
  assertSha256(
    report.serve.funnelStatusSha256,
    "physical-device relay report.serve.funnelStatusSha256",
  );

  assertExactKeys(
    report.tailnetAccess,
    [
      "policySha256",
      "configurationLogEventSha256",
      "approvedPhoneAliases",
      "testedPhonesToMacTcp443Only",
      "noOverlappingAclOrGrant",
      "policyTests",
      "unapprovedPeerHttps443",
    ],
    "physical-device relay report.tailnetAccess",
  );
  assertSha256(
    report.tailnetAccess.policySha256,
    "physical-device relay report.tailnetAccess.policySha256",
  );
  assertSha256(
    report.tailnetAccess.configurationLogEventSha256,
    "physical-device relay report.tailnetAccess.configurationLogEventSha256",
  );
  if (
    !Array.isArray(report.tailnetAccess.approvedPhoneAliases) ||
    report.tailnetAccess.approvedPhoneAliases.length !== PHYSICAL_PHONE_ALIASES.length ||
    report.tailnetAccess.approvedPhoneAliases.some(
      (alias, index) => alias !== PHYSICAL_PHONE_ALIASES[index],
    )
  ) {
    throw new TypeError(
      "Physical-device relay policy must bind exactly the reviewed iOS and Android phone aliases.",
    );
  }
  for (const field of ["testedPhonesToMacTcp443Only", "noOverlappingAclOrGrant", "policyTests"]) {
    assertExactResult(
      report.tailnetAccess[field],
      "passed",
      `physical-device relay report.tailnetAccess.${field}`,
    );
  }
  assertExactResult(
    report.tailnetAccess.unapprovedPeerHttps443,
    "blocked",
    "physical-device relay report.tailnetAccess.unapprovedPeerHttps443",
  );

  assertExactKeys(
    report.listenerInventory,
    [
      "snapshotSha256",
      "requiredServicesIpv4Loopback",
      "inventoriedNon443TcpPorts",
      "wildcardNon443TcpPorts",
    ],
    "physical-device relay report.listenerInventory",
  );
  assertSha256(
    report.listenerInventory.snapshotSha256,
    "physical-device relay report.listenerInventory.snapshotSha256",
  );
  assertExactResult(
    report.listenerInventory.requiredServicesIpv4Loopback,
    "passed",
    "physical-device relay report.listenerInventory.requiredServicesIpv4Loopback",
  );
  const inventoriedPorts = assertSortedPortArray(
    report.listenerInventory.inventoriedNon443TcpPorts,
    "physical-device relay report.listenerInventory.inventoriedNon443TcpPorts",
  );
  for (const required of BASELINE_DENIED_TCP_PORTS) {
    if (!inventoriedPorts.includes(required)) {
      throw new TypeError(
        `Physical-device relay listener inventory must include denied TCP/${required}.`,
      );
    }
  }
  const wildcardPorts = assertSortedPortArray(
    report.listenerInventory.wildcardNon443TcpPorts,
    "physical-device relay report.listenerInventory.wildcardNon443TcpPorts",
    { allowEmpty: true },
  );
  if (wildcardPorts.some((port) => !inventoriedPorts.includes(port))) {
    throw new TypeError(
      "Physical-device relay wildcard listeners must be a subset of the complete inventory.",
    );
  }

  assertExactKeys(
    report.deviceProbes,
    ["ios", "android"],
    "physical-device relay report.deviceProbes",
  );
  assertRelayProbe(
    report.deviceProbes.ios,
    "ios",
    artifacts.physicalDevice.ios,
    inventoriedPorts,
    report.tailnetAccess,
    startedAt,
    executedAt,
  );
  assertRelayProbe(
    report.deviceProbes.android,
    "android",
    artifacts.physicalDevice.android,
    inventoriedPorts,
    report.tailnetAccess,
    startedAt,
    executedAt,
  );

  assertExactKeys(
    report.teardown,
    [
      "serveAndFunnelStatus",
      "shieldsUpRestored",
      "macDisconnected",
      "serveStatusSha256",
      "funnelStatusSha256",
      "shieldsUpStatusSha256",
      "disconnectStatusSha256",
    ],
    "physical-device relay report.teardown",
  );
  assertExactResult(
    report.teardown.serveAndFunnelStatus,
    "empty",
    "physical-device relay report.teardown.serveAndFunnelStatus",
  );
  assertExactResult(
    report.teardown.shieldsUpRestored,
    "passed",
    "physical-device relay report.teardown.shieldsUpRestored",
  );
  assertExactResult(
    report.teardown.macDisconnected,
    "passed",
    "physical-device relay report.teardown.macDisconnected",
  );
  for (const field of [
    "serveStatusSha256",
    "funnelStatusSha256",
    "shieldsUpStatusSha256",
    "disconnectStatusSha256",
  ]) {
    assertSha256(report.teardown[field], `physical-device relay report.teardown.${field}`);
  }
  return report;
}

/**
 * Structural review aid only. This does not authenticate a relay candidate or
 * replace validateHealthReleaseEvidence's trusted Ed25519 manifest gate.
 */
export function validateUnsignedRelayCandidateStructureForReview(
  candidate,
  relay,
  artifacts,
  executedAt,
  reviewedAt,
) {
  return validatePhysicalDeviceRelayReport(candidate, relay, artifacts, executedAt, reviewedAt);
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
  const reviewers = validateReviewerTrustStore(trustStore, {
    expectedSchema: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
    label: "health reviewer trust store",
  });
  const trusted = reviewers.find(
    (reviewer) =>
      reviewer.keyId === manifest.reviewerAttestation.keyId &&
      reviewerKeyWasActiveAt(reviewer, reviewedAt),
  );
  if (!trusted?.publicKey || trusted.principal !== manifest.reviewedBy) {
    throw new TypeError("Reviewer attestation does not match an active checked-in trusted key.");
  }
  const { signatureBase64: _signature, ...signedAttestation } = manifest.reviewerAttestation;
  const signedManifest = { ...manifest, reviewerAttestation: signedAttestation };
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

function defaultReleaseMetadata() {
  const appConfig = JSON.parse(
    readFileSync(fileURLToPath(new URL("../app.json", import.meta.url)), "utf8"),
  );
  const releaseNumbering = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../config/release-numbering.json", import.meta.url)),
      "utf8",
    ),
  );
  return { appConfig, releaseNumbering };
}

function assertSourceControlledReleaseMetadata(manifest, metadata) {
  assertExactKeys(
    metadata,
    ["appConfig", "releaseNumbering"],
    "source-controlled release metadata",
  );
  const appConfig = assertPlainRecord(metadata.appConfig, "source-controlled app config");
  const expo = assertPlainRecord(appConfig.expo, "source-controlled app config.expo");
  if (
    typeof expo.version !== "string" ||
    !SAFE_VERSION.test(expo.version) ||
    manifest.appVersion !== expo.version
  ) {
    throw new TypeError("manifest.appVersion must equal the exact source-controlled app version.");
  }

  const numbering = metadata.releaseNumbering;
  assertExactKeys(
    numbering,
    ["schemaVersion", "identifierHistoryConfirmed", "iosBuildNumber", "androidVersionCode"],
    "source-controlled release numbering",
  );
  if (numbering.schemaVersion !== RELEASE_NUMBERING_SCHEMA) {
    throw new TypeError("Source-controlled release-numbering schema is unsupported.");
  }
  if (numbering.identifierHistoryConfirmed !== true) {
    throw new TypeError(
      "Package-identifier history and source-controlled native build versions must be confirmed before signed-device release evidence can pass.",
    );
  }
  if (
    typeof numbering.iosBuildNumber !== "string" ||
    !IOS_BUILD_NUMBER.test(numbering.iosBuildNumber) ||
    expo.ios?.buildNumber !== numbering.iosBuildNumber
  ) {
    throw new TypeError(
      "The app config and release-numbering record must agree on one confirmed iOS build number.",
    );
  }
  if (
    !Number.isInteger(numbering.androidVersionCode) ||
    numbering.androidVersionCode < 1 ||
    numbering.androidVersionCode > 2_100_000_000 ||
    expo.android?.versionCode !== numbering.androidVersionCode
  ) {
    throw new TypeError(
      "The app config and release-numbering record must agree on one confirmed Android version code.",
    );
  }
  for (const role of ["physicalDevice", "production"]) {
    if (manifest.artifacts[role].ios.nativeBuildVersion !== numbering.iosBuildNumber) {
      throw new TypeError(
        `manifest.artifacts.${role}.ios.nativeBuildVersion must equal the confirmed source-controlled iOS build number.`,
      );
    }
    if (manifest.artifacts[role].android.nativeBuildVersion !== numbering.androidVersionCode) {
      throw new TypeError(
        `manifest.artifacts.${role}.android.nativeBuildVersion must equal the confirmed source-controlled Android version code.`,
      );
    }
  }
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

function relayReportFileIdentity(stat) {
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

function checkedRelayReportPath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    extname(value).toLowerCase() !== ".json"
  ) {
    throw new TypeError(
      "NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_PATH must be an explicit normalized absolute .json path.",
    );
  }
  return value;
}

function assertRelayReportStat(stat, name) {
  if (
    stat === null ||
    typeof stat !== "object" ||
    typeof stat.isFile !== "function" ||
    !stat.isFile() ||
    stat.size < 1 ||
    stat.size > MAX_RELAY_REPORT_BYTES ||
    !Number.isSafeInteger(stat.size) ||
    typeof stat.mode !== "number" ||
    (stat.mode & 0o777) !== 0o600 ||
    relayReportFileIdentity(stat) === null
  ) {
    throw new TypeError(`${name} must identify one bounded mode-0600 regular JSON file.`);
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) {
    throw new TypeError(`${name} must be owned by the current release operator.`);
  }
  return {
    identity: relayReportFileIdentity(stat),
    mode: stat.mode & 0o777,
    mtimeMs: typeof stat.mtimeMs === "number" ? stat.mtimeMs : null,
    size: stat.size,
  };
}

function readBoundedRelayReport(path) {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_NONBLOCK !== "number") {
    throw new TypeError("Safe no-follow relay-report file access is unavailable.");
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
    assertRelayReportStat(before, "Physical-device relay report");
    const buffer = Buffer.alloc(MAX_RELAY_REPORT_BYTES + 1);
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
    throw new TypeError("Unable to safely read the physical-device relay report.", {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateRelayReportReadResult(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !(Buffer.isBuffer(value.bytes) || value.bytes instanceof Uint8Array)
  ) {
    throw new TypeError("Physical-device relay report reader must return bounded exact bytes.");
  }
  const before = assertRelayReportStat(value.before, "Physical-device relay report pre-read stat");
  const after = assertRelayReportStat(value.after, "Physical-device relay report post-read stat");
  const bytes = Buffer.from(value.bytes);
  if (
    bytes.length !== before.size ||
    bytes.length !== after.size ||
    before.identity !== after.identity ||
    before.mode !== after.mode ||
    (before.mtimeMs !== null && after.mtimeMs !== before.mtimeMs)
  ) {
    throw new TypeError("Physical-device relay report changed while it was being reviewed.");
  }
  return bytes;
}

function readPhysicalDeviceRelayReport(
  environment,
  relay,
  artifacts,
  executedAt,
  reviewedAt,
  runtime,
) {
  const inline = environment.NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64;
  const path = environment.NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_PATH;
  const hasInline = typeof inline === "string" && inline.length > 0;
  const hasPath = typeof path === "string" && path.length > 0;
  if (hasInline === hasPath) {
    throw new TypeError(
      "Supply physical-device relay evidence through exactly one bounded base64 value or absolute report path.",
    );
  }

  let bytes;
  if (hasInline) {
    bytes = decodeStandardBase64(
      inline,
      "NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64",
      MAX_RELAY_REPORT_BYTES,
    );
  } else {
    const checked = checkedRelayReportPath(path);
    bytes = validateRelayReportReadResult(runtime.readRelayReport(checked));
  }

  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== relay.reportSha256) {
    throw new TypeError("Physical-device relay report SHA-256 does not match signed evidence.");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new TypeError("Physical-device relay report must use valid UTF-8.");
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new TypeError("Physical-device relay report is not valid JSON.");
  }
  const canonical = canonicalJson(report);
  if (text !== canonical && text !== `${canonical}\n`) {
    throw new TypeError(
      "Physical-device relay report JSON must use canonical field order and encoding.",
    );
  }
  rejectHealthPayloadEvidence(report, "physical-device relay report");
  return {
    report: validatePhysicalDeviceRelayReport(report, relay, artifacts, executedAt, reviewedAt),
    reportSha256: actualDigest,
  };
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
    readReleaseMetadata: defaultReleaseMetadata,
    readRelayReport: readBoundedRelayReport,
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
  const canonicalManifest = canonicalJson(manifest);
  if (raw !== canonicalManifest && raw !== `${canonicalManifest}\n`) {
    throw new TypeError(
      "Health release evidence JSON must use canonical field order and encoding.",
    );
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
      "physicalDeviceApiRelay",
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
  if (nowTime - executedAt > MAX_EVIDENCE_AGE_MS) {
    throw new TypeError("Physical-device execution is older than 30 days and must be rerun.");
  }

  assertArtifacts(manifest.artifacts, manifest.gitCommit);
  assertExactKeys(manifest.devices, ["ios", "android"], "manifest.devices");
  assertDevice(manifest.devices.ios, "ios", manifest.artifacts.physicalDevice.ios);
  assertDevice(manifest.devices.android, "android", manifest.artifacts.physicalDevice.android);
  const relay = assertPhysicalDeviceApiRelay(manifest.physicalDeviceApiRelay, environment);
  verifyReviewerAttestation(manifest, trustStore, reviewedAt);

  if (typeof runtime.readReleaseMetadata !== "function") {
    throw new TypeError("Source-controlled release metadata reader is unavailable.");
  }
  assertSourceControlledReleaseMetadata(manifest, runtime.readReleaseMetadata());

  const actualGitHead = runtime.gitHead();
  if (!GIT_COMMIT.test(actualGitHead) || actualGitHead !== manifest.gitCommit) {
    throw new TypeError("Reviewed health evidence does not match the actual Git HEAD.");
  }
  if (runtime.gitStatus().trim() !== "") {
    throw new TypeError("Signed-device health release verification requires a clean Git tree.");
  }
  const relayEvidence = readPhysicalDeviceRelayReport(
    environment,
    relay,
    manifest.artifacts,
    executedAt,
    reviewedAt,
    runtime,
  );
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
    physicalDeviceApiRelay: {
      apiOrigin: relay.apiOrigin,
      reportSha256: relayEvidence.reportSha256,
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
