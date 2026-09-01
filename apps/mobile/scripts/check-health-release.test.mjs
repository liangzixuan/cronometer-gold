import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "@nutrition-tracker/contracts";

import { describe, expect, it, vi } from "vitest";

import {
  HEALTH_RELEASE_EVIDENCE_SCHEMA,
  HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
  P0_CLIENT_SMOKE_FLOW_IDS,
  P0_CLIENT_SMOKE_REPORT_SCHEMA,
  PHYSICAL_DEVICE_RELAY_REPORT_SCHEMA,
  physicalDeviceApiOriginCommitmentSha256,
  validateHealthReleaseEvidence,
} from "./check-health-release.mjs";

const matrix = {
  inContextPermission: "passed",
  permissionDeniedOrEmptyState: "passed",
  permissionRevokedState: "passed",
  permissionUnavailableState: "passed",
  hardwareBackedSigning: "passed",
  keyInvalidationReregistration: "passed",
  deviceRegistration: "passed",
  initialWeightImport: "passed",
  incrementalWeightImport: "passed",
  editedWeightReconciliation: "passed",
  deletedWeightReconciliation: "passed",
  multiPageReconciliation: "passed",
  cursorExpiryFullReconciliation: "passed",
  lostResponseIdempotentRetry: "passed",
  healthJournalMaximumRoundTrip: "passed",
  healthJournalWriteFailureRecovery: "passed",
  opaquePermissionNoInferredDeletion: "passed",
  revokedPermissionStopsReconciliation: "passed",
  disconnectRetain: "passed",
  disconnectDelete: "passed",
  genericReminderCopy: "passed",
  reminderPauseAndRevoke: "passed",
  reminderTimeZoneReconciliation: "passed",
  terminalPrivateCleanup: "passed",
  erasureStatusAfterSessionRevocation: "passed",
  largeExportArtifactDownload: "passed",
};

const reviewerKeys = generateKeyPairSync("ed25519");
const wrongKeys = generateKeyPairSync("ed25519");
const reviewerPrincipal = "independent.reviewer@example.test";
const reviewerKeyId = "release-reviewer-2026-01";
const gitCommit = "a".repeat(40);
const physicalDeviceApiOrigin = "https://nutrition-api.tail1234.ts.net";
const supportedRelayVersionAdapter = Object.freeze({
  adapterId: "synthetic-windows-contract-v1",
  adapterKind: "production",
  platform: "windows-host",
  corpusSchemaVersion: "nutrition-tracker-tailscale-windows-output-corpus-v1",
  corpusSha256: "f".repeat(64),
  windowsVersion: "10.0.26100.4946",
  wslVersion: "2.5.10.0",
  ubuntuVersion: "24.04.3",
  dockerDesktopVersion: "4.45.0",
  dockerEngineVersion: "28.3.3",
  tailscaleClientVersion: "0.0.0-test",
  tailscaleDaemonVersion: "0.0.0-test",
  clientHelpSha256: captureDigest(3),
  daemonHelpSha256: captureDigest(4),
});

const buildIds = {
  physicalDevice: {
    ios: "11111111-1111-4111-8111-111111111111",
    android: "22222222-2222-4222-8222-222222222222",
  },
  production: {
    ios: "33333333-3333-4333-8333-333333333333",
    android: "44444444-4444-4444-8444-444444444444",
  },
};

const artifactPaths = {
  physicalDevice: {
    ios: "/tmp/reviewed-physical-device.ipa",
    android: "/tmp/reviewed-physical-device.apk",
  },
  production: {
    ios: "/tmp/reviewed-production.ipa",
    android: "/tmp/reviewed-production.aab",
  },
};

const artifactDigests = {
  physicalDevice: { ios: "b".repeat(64), android: "c".repeat(64) },
  production: { ios: "d".repeat(64), android: "e".repeat(64) },
};

const confirmedReleaseMetadata = {
  appConfig: {
    expo: {
      version: "0.1.0",
      ios: { buildNumber: "1" },
      android: { versionCode: 1 },
    },
  },
  releaseNumbering: {
    schemaVersion: "nutrition-tracker-release-numbering-v1",
    identifierHistoryConfirmed: true,
    iosBuildNumber: "1",
    androidVersionCode: 1,
  },
};

const inventoriedNon443TcpPorts = [
  22, 80, 1025, 2181, 4000, 4566, 5432, 7700, 8025, 8080, 8081, 9000, 9001, 9092,
];

const readyBodySha256 = "a29ee2b15c494311c52521766e44af56a3ad2248e7a8ab465e5206463c13d288";

function captureDigest(index) {
  return index.toString(16).padStart(64, "0");
}

function boundaryPhase(environmentSha256, offset) {
  return {
    environmentSha256,
    windowsListenersSha256: captureDigest(offset),
    windowsFirewallSha256: captureDigest(offset + 1),
    hyperVFirewallSha256: captureDigest(offset + 2),
    forwardingSha256: captureDigest(offset + 3),
    wslListenersSha256: captureDigest(offset + 4),
    dockerPortsSha256: captureDigest(offset + 5),
  };
}

function approvedRelayProbe(phase, platform) {
  const isActive = phase === "active";
  const isIos = platform === "ios";
  const offset = isActive ? 80 : 120;
  const minutes = isActive ? (isIos ? 20 : 22) : isIos ? 55 : 56;
  return {
    testedEasBuildId: buildIds.physicalDevice[platform],
    phoneAlias: isIos ? "nutrition-tracker-phone-1" : "nutrition-tracker-phone-2",
    observedAt: `2026-08-16T07:${minutes}:00.000Z`,
    captureSha256: captureDigest(offset + (isIos ? 0 : 1)),
    publicCaAndHostname: "passed",
    readyHttpStatus: 200,
    readyBodySha256,
    openTcpPorts: [443],
    blockedTcpPorts: [...inventoriedNon443TcpPorts],
    directWindowsWslDockerTargets: "blocked",
    tailscaleDisabledHttps: "blocked",
  };
}

function deniedRelayProbe(phase) {
  const isActive = phase === "active";
  return {
    observedAt: `2026-08-16T07:${isActive ? "24" : "57"}:00.000Z`,
    captureSha256: captureDigest(isActive ? 82 : 122),
    httpsPort: "blocked",
    blockedTcpPorts: [...inventoriedNon443TcpPorts],
  };
}

function lanRelayProbe(phase) {
  const isActive = phase === "active";
  return {
    observedAt: `2026-08-16T07:${isActive ? "26" : "58"}:00.000Z`,
    captureSha256: captureDigest(isActive ? 83 : 123),
    httpsPort: "blocked",
    blockedTcpPorts: [...inventoriedNon443TcpPorts],
    windowsWslDockerTargets: "blocked",
    ipv4AndIpv6Paths: "blocked",
  };
}

function relayDeviceProbes(phase) {
  return {
    ios: approvedRelayProbe(phase, "ios"),
    android: approvedRelayProbe(phase, "android"),
    unapprovedTailnet: deniedRelayProbe(phase),
    lan: lanRelayProbe(phase),
  };
}

function physicalDeviceRelayReport() {
  const sessionEnvironmentSha256 = captureDigest(10);
  const activeEnvironmentSha256 = captureDigest(11);
  const restartEnvironmentSha256 = captureDigest(12);
  const teardownEnvironmentSha256 = captureDigest(13);
  return {
    schemaVersion: PHYSICAL_DEVICE_RELAY_REPORT_SCHEMA,
    trustBoundary: "unsigned-structural-candidate-requires-independent-ed25519-manifest-review",
    sourceCaptureBundleSha256: captureDigest(1),
    apiOriginCommitmentSha256: "edc56416dfbb4d570d7eae27b291115365d2e274e06c48fed792a48294f4b87c",
    sourceCommit: gitCommit,
    startedAt: "2026-08-16T07:00:00.000Z",
    executedAt: "2026-08-16T08:00:00.000Z",
    completedAt: "2026-08-16T08:30:00.000Z",
    buildIds: { ...buildIds.physicalDevice },
    hostTopology: {
      relayNode: "windows-host",
      applicationNode: "wsl2-ubuntu",
      containerProvider: "docker-desktop-wsl-integration",
      tailscalePlacement: "windows-host-only",
      apiBind: "127.0.0.1:4000",
      serveUpstream: "http://127.0.0.1:4000",
      wslNetworkingMode: "nat",
      hostBoundarySha256: captureDigest(2),
    },
    versionAdapter: {
      adapterId: supportedRelayVersionAdapter.adapterId,
      adapterKind: supportedRelayVersionAdapter.adapterKind,
      platform: supportedRelayVersionAdapter.platform,
      corpusSchemaVersion: supportedRelayVersionAdapter.corpusSchemaVersion,
      corpusSha256: supportedRelayVersionAdapter.corpusSha256,
      windowsVersion: supportedRelayVersionAdapter.windowsVersion,
      wslVersion: supportedRelayVersionAdapter.wslVersion,
      ubuntuVersion: supportedRelayVersionAdapter.ubuntuVersion,
      dockerDesktopVersion: supportedRelayVersionAdapter.dockerDesktopVersion,
      dockerEngineVersion: supportedRelayVersionAdapter.dockerEngineVersion,
      tailscaleClientVersion: supportedRelayVersionAdapter.tailscaleClientVersion,
      tailscaleDaemonVersion: supportedRelayVersionAdapter.tailscaleDaemonVersion,
      clientHelpSha256: supportedRelayVersionAdapter.clientHelpSha256,
      daemonHelpSha256: supportedRelayVersionAdapter.daemonHelpSha256,
      rawStatusSha256: captureDigest(5),
      sessionEnvironmentSha256,
      activeEnvironmentSha256,
      restartEnvironmentSha256,
      teardownEnvironmentSha256,
    },
    policy: {
      approvedPhoneAliases: ["nutrition-tracker-phone-1", "nutrition-tracker-phone-2"],
      incomingAccessHeldUntilPolicyTests: "passed",
      relayHostIdentityRevalidated: "passed",
      testedPhonesToRelayHostTcp443Only: "passed",
      noOverlappingAclOrGrant: "passed",
      policyTests: "passed",
      proposalCaptureSha256: captureDigest(50),
      appliedCaptureSha256: captureDigest(51),
      testsCaptureSha256: captureDigest(52),
      configurationEventCaptureSha256: captureDigest(53),
      gateCaptureSha256: captureDigest(54),
    },
    boundaryEvidence: {
      preflight: boundaryPhase(sessionEnvironmentSha256, 20),
      active: boundaryPhase(activeEnvironmentSha256, 30),
      restart: boundaryPhase(restartEnvironmentSha256, 40),
      teardown: boundaryPhase(teardownEnvironmentSha256, 60),
    },
    active: {
      incoming: "enabled",
      serve: "attended-foreground",
      funnel: "disabled",
      httpsPort: 443,
      handlerPath: "/",
      upstream: "http://127.0.0.1:4000",
      inventoriedNon443TcpPorts: [...inventoriedNon443TcpPorts],
      incomingCaptureSha256: captureDigest(70),
      serveCaptureSha256: captureDigest(71),
      funnelCaptureSha256: captureDigest(72),
      identitiesCaptureSha256: captureDigest(73),
      deviceProbes: relayDeviceProbes("active"),
    },
    restart: {
      preShutdown: {
        incoming: "disabled",
        serve: "disabled",
        funnel: "disabled",
        incomingCaptureSha256: captureDigest(90),
        serveCaptureSha256: captureDigest(91),
        funnelCaptureSha256: captureDigest(92),
      },
      preExposure: {
        incoming: "disabled",
        serve: "disabled",
        funnel: "disabled",
        relayHostIdentityRevalidated: "passed",
        incomingCaptureSha256: captureDigest(93),
        serveCaptureSha256: captureDigest(94),
        funnelCaptureSha256: captureDigest(95),
        identitiesCaptureSha256: captureDigest(96),
      },
      localReadiness: {
        wsl: {
          observedAt: "2026-08-16T07:45:00.000Z",
          captureSha256: captureDigest(110),
          httpStatus: 200,
          bodySha256: readyBodySha256,
        },
        windows: {
          observedAt: "2026-08-16T07:47:00.000Z",
          captureSha256: captureDigest(111),
          httpStatus: 200,
          bodySha256: readyBodySha256,
        },
        migrationsCurrent: "passed",
      },
      reenabledRelay: {
        incoming: "enabled",
        serve: "attended-foreground",
        funnel: "disabled",
        relayHostIdentityRevalidated: "passed",
        incomingCaptureSha256: captureDigest(100),
        serveCaptureSha256: captureDigest(101),
        funnelCaptureSha256: captureDigest(102),
        identitiesCaptureSha256: captureDigest(103),
      },
      deviceProbes: relayDeviceProbes("restart"),
      coldRestartEventSha256: captureDigest(104),
      sourceProcessContinuity: "passed",
      routeRecovered: "passed",
    },
    teardown: {
      incoming: "disabled",
      serve: "disabled",
      funnel: "disabled",
      relayHostDisconnected: "passed",
      boundaryRestored: "passed",
      incomingCaptureSha256: captureDigest(130),
      serveCaptureSha256: captureDigest(131),
      funnelCaptureSha256: captureDigest(132),
      disconnectCaptureSha256: captureDigest(133),
    },
    sessionLedgerSha256: captureDigest(140),
  };
}

function relayReportBytes(report = physicalDeviceRelayReport()) {
  return Buffer.from(`${canonicalJson(report)}\n`, "utf8");
}

function relayReportDigest(report = physicalDeviceRelayReport()) {
  return createHash("sha256").update(relayReportBytes(report)).digest("hex");
}

function p0ClientResults() {
  return P0_CLIENT_SMOKE_FLOW_IDS.map((flowId, index) => ({
    flowId,
    outcome: "passed",
    observedAt: `2026-08-16T07:${String(index + 1).padStart(2, "0")}:00.000Z`,
  }));
}

function p0ClientSmokeReport() {
  const clients = {
    browser: {
      captureSha256: "7".repeat(64),
      testedEasBuildId: null,
      capturedAt: "2026-08-16T07:19:00.000Z",
      results: p0ClientResults(),
    },
    ios: {
      captureSha256: "8".repeat(64),
      testedEasBuildId: buildIds.physicalDevice.ios,
      capturedAt: "2026-08-16T07:19:00.000Z",
      results: p0ClientResults(),
    },
    android: {
      captureSha256: "9".repeat(64),
      testedEasBuildId: buildIds.physicalDevice.android,
      capturedAt: "2026-08-16T07:19:00.000Z",
      results: p0ClientResults(),
    },
  };
  const sourceCaptureBundleDigest = createHash("sha256").update(
    "nutrition-tracker-p0-client-smoke-source-capture-bundle-v2\n",
  );
  for (const role of ["browser", "ios", "android"]) {
    sourceCaptureBundleDigest.update(`${role}\n${clients[role].captureSha256}\n`);
  }
  return {
    schemaVersion: P0_CLIENT_SMOKE_REPORT_SCHEMA,
    trustBoundary:
      "unsigned-structural-candidate-requires-independent-ed25519-health-manifest-review",
    dataClassification: "synthetic-only",
    sourceCaptureBundleSha256: sourceCaptureBundleDigest.digest("hex"),
    gitCommit,
    apiOrigin: physicalDeviceApiOrigin,
    startedAt: "2026-08-16T07:00:00.000Z",
    executedAt: "2026-08-16T08:00:00.000Z",
    completedAt: "2026-08-16T08:30:00.000Z",
    clients,
  };
}

function p0ClientSmokeReportBytes(report = p0ClientSmokeReport()) {
  return Buffer.from(`${canonicalJson(report)}\n`, "utf8");
}

function p0ClientSmokeReportDigest(report = p0ClientSmokeReport()) {
  return createHash("sha256").update(p0ClientSmokeReportBytes(report)).digest("hex");
}

const trustStore = {
  schemaVersion: HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
  reviewers: [
    {
      keyId: reviewerKeyId,
      principal: reviewerPrincipal,
      algorithm: "Ed25519",
      publicKeySpkiDerBase64: reviewerKeys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    },
  ],
};
const checkedInTrustStore = JSON.parse(
  readFileSync(new URL("../config/health-release-reviewers.json", import.meta.url), "utf8"),
);

function reviewedArtifact({ artifactType, buildProfile, digest, easBuildId, platform }) {
  return {
    platform,
    buildProfile,
    artifactType,
    easBuildId,
    sourceCommit: gitCommit,
    nativeBuildVersion: platform === "ios" ? "1" : 1,
    signingIdentitySha256: platform === "ios" ? "1".repeat(64) : "2".repeat(64),
    artifactSha256: digest,
  };
}

function unsignedManifest(
  report = physicalDeviceRelayReport(),
  smokeReport = p0ClientSmokeReport(),
) {
  return {
    schemaVersion: HEALTH_RELEASE_EVIDENCE_SCHEMA,
    appVersion: "0.1.0",
    gitCommit,
    executedBy: "release.operator@example.test",
    executedAt: "2026-08-16T08:00:00.000Z",
    reviewedBy: reviewerPrincipal,
    reviewedAt: "2026-08-16T09:00:00.000Z",
    artifacts: {
      physicalDevice: {
        ios: reviewedArtifact({
          artifactType: "ipa",
          buildProfile: "physical-device",
          digest: artifactDigests.physicalDevice.ios,
          easBuildId: buildIds.physicalDevice.ios,
          platform: "ios",
        }),
        android: reviewedArtifact({
          artifactType: "apk",
          buildProfile: "physical-device",
          digest: artifactDigests.physicalDevice.android,
          easBuildId: buildIds.physicalDevice.android,
          platform: "android",
        }),
      },
      production: {
        ios: reviewedArtifact({
          artifactType: "ipa",
          buildProfile: "production",
          digest: artifactDigests.production.ios,
          easBuildId: buildIds.production.ios,
          platform: "ios",
        }),
        android: reviewedArtifact({
          artifactType: "aab",
          buildProfile: "production",
          digest: artifactDigests.production.android,
          easBuildId: buildIds.production.android,
          platform: "android",
        }),
      },
    },
    devices: {
      ios: {
        platform: "ios",
        physicalDevice: true,
        model: "iPhone 17 Pro",
        osVersion: "iOS 19.6.1",
        testedEasBuildId: buildIds.physicalDevice.ios,
        declarations: {
          healthKitCapability: "passed",
          readOnlyBodyWeightPurpose: "passed",
          noWriteOrBackgroundScope: "passed",
        },
        healthJournalBenchmark: {
          knownRevisionCount: 10_000,
          signedRecordCount: 100,
          serializedBytes: 620_000,
          chunkCount: 517,
          writeMilliseconds: 12_000,
          readMilliseconds: 8_000,
        },
        matrix: { ...matrix },
      },
      android: {
        platform: "android",
        physicalDevice: true,
        model: "Pixel 10 Pro",
        osVersion: "Android 16",
        testedEasBuildId: buildIds.physicalDevice.android,
        declarations: {
          healthConnectManifest: "passed",
          playBodyWeightDeclaration: "passed",
          minSdk26: "passed",
        },
        healthJournalBenchmark: {
          knownRevisionCount: 10_000,
          signedRecordCount: 100,
          serializedBytes: 620_000,
          chunkCount: 517,
          writeMilliseconds: 12_000,
          readMilliseconds: 8_000,
        },
        matrix: { ...matrix },
      },
    },
    physicalDeviceApiRelay: {
      apiOrigin: physicalDeviceApiOrigin,
      reportSha256: relayReportDigest(report),
    },
    p0ClientSmoke: {
      apiOrigin: physicalDeviceApiOrigin,
      reportSha256: p0ClientSmokeReportDigest(smokeReport),
    },
  };
}

function attest(unsigned = unsignedManifest(), privateKey = reviewerKeys.privateKey) {
  const signedAttestation = {
    keyId: reviewerKeyId,
    algorithm: "Ed25519",
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson({ ...unsigned, reviewerAttestation: signedAttestation }), "utf8"),
    privateKey,
  );
  return {
    ...unsigned,
    reviewerAttestation: {
      ...signedAttestation,
      signatureBase64: signature.toString("base64"),
    },
  };
}

function environmentFor(
  manifest = attest(),
  report = physicalDeviceRelayReport(),
  smokeReport = p0ClientSmokeReport(),
) {
  const raw = `${canonicalJson(manifest)}\n`;
  return {
    NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON: raw,
    NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256: createHash("sha256")
      .update(raw, "utf8")
      .digest("hex"),
    NUTRITION_PHYSICAL_DEVICE_API_ORIGIN: physicalDeviceApiOrigin,
    NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64: relayReportBytes(report).toString("base64"),
    NUTRITION_P0_CLIENT_SMOKE_REPORT_BASE64:
      p0ClientSmokeReportBytes(smokeReport).toString("base64"),
    NUTRITION_IOS_PHYSICAL_DEVICE_BUILD_ID: manifest.artifacts.physicalDevice.ios.easBuildId,
    NUTRITION_IOS_PHYSICAL_DEVICE_ARTIFACT_PATH: artifactPaths.physicalDevice.ios,
    NUTRITION_ANDROID_PHYSICAL_DEVICE_BUILD_ID:
      manifest.artifacts.physicalDevice.android.easBuildId,
    NUTRITION_ANDROID_PHYSICAL_DEVICE_ARTIFACT_PATH: artifactPaths.physicalDevice.android,
    NUTRITION_IOS_PRODUCTION_BUILD_ID: manifest.artifacts.production.ios.easBuildId,
    NUTRITION_IOS_PRODUCTION_ARTIFACT_PATH: artifactPaths.production.ios,
    NUTRITION_ANDROID_PRODUCTION_BUILD_ID: manifest.artifacts.production.android.easBuildId,
    NUTRITION_ANDROID_PRODUCTION_ARTIFACT_PATH: artifactPaths.production.android,
  };
}

const checkTime = new Date("2026-08-17T00:00:00.000Z");
const orderedArtifactPaths = [
  artifactPaths.physicalDevice.ios,
  artifactPaths.physicalDevice.android,
  artifactPaths.production.ios,
  artifactPaths.production.android,
];
const releaseRuntime = {
  relayVersionAdapters: Object.freeze([supportedRelayVersionAdapter]),
  gitHead: () => gitCommit,
  gitStatus: () => "",
  readReleaseMetadata: () => structuredClone(confirmedReleaseMetadata),
  statArtifact: (path) => ({
    dev: 7,
    ino: orderedArtifactPaths.indexOf(path) + 101,
    isFile: () => true,
    size: 123,
  }),
  hashArtifact: async (path) => {
    for (const role of ["physicalDevice", "production"]) {
      for (const platform of ["ios", "android"]) {
        if (path === artifactPaths[role][platform]) return artifactDigests[role][platform];
      }
    }
    throw new TypeError(`Unexpected artifact path ${path}`);
  },
};

describe("native health release evidence", () => {
  it("fails closed without externally signed evidence", async () => {
    await expect(
      validateHealthReleaseEvidence({}, checkTime, trustStore, releaseRuntime),
    ).rejects.toThrow(/absent/u);
  });

  it("keeps the checked-in trust root blocked until an independent reviewer is onboarded", async () => {
    expect(checkedInTrustStore.reviewers).toEqual([]);
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(),
        checkTime,
        checkedInTrustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/trusted key/u);
  });

  it("accepts four role-specific artifacts with trusted physical-device evidence", async () => {
    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, releaseRuntime),
    ).resolves.toEqual({
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      gitCommit,
      artifactSha256: artifactDigests,
      physicalDeviceApiRelay: {
        apiOrigin: physicalDeviceApiOrigin,
        reportSha256: relayReportDigest(),
      },
      p0ClientSmoke: {
        apiOrigin: physicalDeviceApiOrigin,
        reportSha256: p0ClientSmokeReportDigest(),
      },
      reviewerKeyId,
    });
  });

  it("requires signed v5 relay and P0 smoke evidence with exact keys", async () => {
    const legacy = unsignedManifest();
    legacy.schemaVersion = "nutrition-tracker-health-release-evidence-v4";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(legacy)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/health-release-evidence-v5/u);

    const missing = unsignedManifest();
    delete missing.physicalDeviceApiRelay;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(missing)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/physicalDeviceApiRelay/u);

    const extra = unsignedManifest();
    extra.physicalDeviceApiRelay.provider = "tailscale-serve";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(extra)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/manifest\.physicalDeviceApiRelay must contain exactly/u);

    const missingSmoke = unsignedManifest();
    delete missingSmoke.p0ClientSmoke;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(missingSmoke)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/p0ClientSmoke/u);
  });

  it("binds the signed origin to the v4 commitment and exact canonical report bytes", async () => {
    expect(physicalDeviceApiOriginCommitmentSha256("https://relay.example.ts.net")).toBe(
      "324c46636c4c63c6dd63502c753892fcc8cdbce343fd0d760fa29417397ee19e",
    );

    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(),
          NUTRITION_PHYSICAL_DEVICE_API_ORIGIN: "https://other.tail1234.ts.net",
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/exactly pin/u);

    const wrongOriginReport = physicalDeviceRelayReport();
    wrongOriginReport.apiOriginCommitmentSha256 = captureDigest(999);
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(wrongOriginReport)), wrongOriginReport),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/API-origin commitment must match/u);

    const rawOriginReport = physicalDeviceRelayReport();
    rawOriginReport.apiOrigin = physicalDeviceApiOrigin;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(rawOriginReport)), rawOriginReport),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/must contain exactly/u);

    const unsafeOriginManifest = unsignedManifest();
    unsafeOriginManifest.physicalDeviceApiRelay.apiOrigin = "https://api.github.com";
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(attest(unsafeOriginManifest)),
          NUTRITION_PHYSICAL_DEVICE_API_ORIGIN:
            unsafeOriginManifest.physicalDeviceApiRelay.apiOrigin,
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/machine.*tailnet.*ts\.net/u);

    const changedReport = physicalDeviceRelayReport();
    changedReport.teardown.boundaryRestored = "failed";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(), changedReport),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/SHA-256/u);
  });

  it("accepts v5 plus relay v4 and rejects legacy v2/v3 before exact-key parsing", async () => {
    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, releaseRuntime),
    ).resolves.toMatchObject({
      physicalDeviceApiRelay: { apiOrigin: physicalDeviceApiOrigin },
    });

    for (const schemaVersion of [
      "nutrition-tracker-physical-device-relay-report-v2",
      "nutrition-tracker-physical-device-relay-report-v3",
    ]) {
      const legacyReport = {
        schemaVersion,
        apiOrigin: physicalDeviceApiOrigin,
        deliberatelyWrongKeys: true,
      };
      await expect(
        validateHealthReleaseEvidence(
          environmentFor(attest(unsignedManifest(legacyReport)), legacyReport),
          checkTime,
          trustStore,
          releaseRuntime,
        ),
      ).rejects.toThrow(/Legacy physical-device relay report v2\/v3 is rejected/u);
    }

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        relayVersionAdapters: [],
      }),
    ).rejects.toThrow(/unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u);

    for (const [relayVersionAdapters, message] of [
      [
        [
          {
            ...supportedRelayVersionAdapter,
            adapterId: "synthetic/windows-contract-v1",
          },
        ],
        /adapter-ID syntax/u,
      ],
      [
        [
          {
            ...supportedRelayVersionAdapter,
            tailscaleClientVersion: "0.0.0 test",
          },
        ],
        /version syntax/u,
      ],
      [
        [{ ...supportedRelayVersionAdapter, adapterKind: "test" }],
        /kind and adapter-ID namespace/u,
      ],
      [
        [{ ...supportedRelayVersionAdapter, platform: "wsl2-ubuntu" }],
        /platform must equal windows-host/u,
      ],
      [
        [{ ...supportedRelayVersionAdapter, corpusSchemaVersion: "legacy" }],
        /corpusSchemaVersion must equal/u,
      ],
      [
        [{ ...supportedRelayVersionAdapter, corpusSha256: "0".repeat(63) }],
        /corpusSha256 must be one lowercase SHA-256 digest/u,
      ],
      [
        [{ ...supportedRelayVersionAdapter, clientHelpSha256: "0".repeat(63) }],
        /clientHelpSha256 must be one lowercase SHA-256 digest/u,
      ],
    ]) {
      await expect(
        validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
          ...releaseRuntime,
          relayVersionAdapters,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("rejects test-kind relay evidence even when runtime injects its exact adapter", async () => {
    const report = physicalDeviceRelayReport();
    const testAdapter = Object.freeze({
      ...supportedRelayVersionAdapter,
      adapterId: "test-synthetic-windows-contract-v1",
      adapterKind: "test",
    });
    Object.assign(report.versionAdapter, testAdapter);
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(report)), report),
        checkTime,
        trustStore,
        {
          ...releaseRuntime,
          relayVersionAdapters: [testAdapter],
        },
      ),
    ).rejects.toThrow(/must use a production version adapter/u);
  });

  it("requires the unsigned v4 trust marker and complete source-capture digest", async () => {
    const wrongBoundary = physicalDeviceRelayReport();
    wrongBoundary.trustBoundary = "trusted";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(wrongBoundary)), wrongBoundary),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/unsigned structural candidate/u);

    const missingDigest = physicalDeviceRelayReport();
    delete missingDigest.sourceCaptureBundleSha256;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(missingDigest)), missingDigest),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/must contain exactly/u);

    const malformedDigest = physicalDeviceRelayReport();
    malformedDigest.sourceCaptureBundleSha256 = "not-a-digest";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(malformedDigest)), malformedDigest),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/sourceCaptureBundleSha256/u);
  });

  it("requires exactly one bounded canonical relay-report input", async () => {
    const base = environmentFor();
    const absent = { ...base };
    delete absent.NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64;
    await expect(
      validateHealthReleaseEvidence(absent, checkTime, trustStore, releaseRuntime),
    ).rejects.toThrow(/exactly one/u);

    await expect(
      validateHealthReleaseEvidence(
        {
          ...base,
          NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_PATH: "/tmp/relay-report.json",
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/exactly one/u);

    await expect(
      validateHealthReleaseEvidence(
        {
          ...base,
          NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64: "A".repeat(87_388),
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/canonical padded standard base64/u);

    const report = physicalDeviceRelayReport();
    const noncanonical = Buffer.from(JSON.stringify(report), "utf8");
    const noncanonicalManifest = unsignedManifest(report);
    noncanonicalManifest.physicalDeviceApiRelay.reportSha256 = createHash("sha256")
      .update(noncanonical)
      .digest("hex");
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(attest(noncanonicalManifest), report),
          NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64: noncanonical.toString("base64"),
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/canonical field order/u);
  });

  it("binds an unsigned synthetic P0 smoke candidate through the signed v5 manifest", async () => {
    const mutations = [
      [
        "legacy v1 report schema",
        (report) => (report.schemaVersion = "nutrition-tracker-p0-client-smoke-report-v1"),
        /p0-client-smoke-report-v2/u,
      ],
      [
        "wrong trust marker",
        (report) => (report.trustBoundary = "trusted"),
        /unsigned structural candidate/u,
      ],
      [
        "wrong classification",
        (report) => (report.dataClassification = "production"),
        /synthetic-only/u,
      ],
      [
        "wrong source commit",
        (report) => (report.gitCommit = "f".repeat(40)),
        /manifest\.gitCommit/u,
      ],
      [
        "wrong private origin",
        (report) => (report.apiOrigin = "https://other.tail1234.ts.net"),
        /origin must match/u,
      ],
      [
        "wrong iOS physical build",
        (report) => (report.clients.ios.testedEasBuildId = buildIds.physicalDevice.android),
        /reviewed physical build/u,
      ],
      [
        "missing flow",
        (report) => report.clients.browser.results.pop(),
        /exact ordered P0 flow inventory/u,
      ],
      [
        "reordered flow",
        (report) => report.clients.ios.results.reverse(),
        /ordered structural pass assertion/u,
      ],
      [
        "failed flow",
        (report) => (report.clients.android.results[4].outcome = "failed"),
        /ordered structural pass assertion/u,
      ],
      [
        "nonmonotonic flow",
        (report) =>
          (report.clients.browser.results[5].observedAt =
            report.clients.browser.results[3].observedAt),
        /ordered structural pass assertion/u,
      ],
      [
        "wrong final capture time",
        (report) => (report.clients.ios.capturedAt = "2026-08-16T07:18:00.000Z"),
        /final ordered observation/u,
      ],
      [
        "execution drift",
        (report) => (report.executedAt = "2026-08-16T07:59:00.000Z"),
        /exactly bind signed execution/u,
      ],
      [
        "duplicate raw capture hash",
        (report) => (report.clients.android.captureSha256 = report.clients.ios.captureSha256),
        /distinct raw capture bytes/u,
      ],
    ];
    for (const [label, mutate, expected] of mutations) {
      const smokeReport = p0ClientSmokeReport();
      mutate(smokeReport);
      const manifest = attest(unsignedManifest(physicalDeviceRelayReport(), smokeReport));
      await expect(
        validateHealthReleaseEvidence(
          environmentFor(manifest, physicalDeviceRelayReport(), smokeReport),
          checkTime,
          trustStore,
          releaseRuntime,
        ),
        label,
      ).rejects.toThrow(expected);
    }
  });

  it("requires P0 smoke completion to precede manifest review strictly", async () => {
    const smokeReport = p0ClientSmokeReport();
    const relayReport = physicalDeviceRelayReport();
    const reviewedAt = unsignedManifest(relayReport, smokeReport).reviewedAt;
    smokeReport.completedAt = reviewedAt;
    const manifest = unsignedManifest(relayReport, smokeReport);
    expect(smokeReport.completedAt).toBe(manifest.reviewedAt);

    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(manifest), relayReport, smokeReport),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/finish before review/u);
  });

  it("rejects malformed P0 smoke source binding and forbidden identifiers", async () => {
    for (const mutate of [
      (report) => delete report.sourceCaptureBundleSha256,
      (report) => (report.sourceCaptureBundleSha256 = "not-a-digest"),
      (report) => (report.sourceCaptureBundleSha256 = "0".repeat(64)),
      (report) => (report.clients.browser.deviceId = "forbidden-device"),
    ]) {
      const smokeReport = p0ClientSmokeReport();
      mutate(smokeReport);
      const manifest = attest(unsignedManifest(physicalDeviceRelayReport(), smokeReport));
      await expect(
        validateHealthReleaseEvidence(
          environmentFor(manifest, physicalDeviceRelayReport(), smokeReport),
          checkTime,
          trustStore,
          releaseRuntime,
        ),
      ).rejects.toThrow(/sourceCaptureBundleSha256|must not contain/u);
    }
  });

  it("requires exactly one bounded canonical P0 smoke-report input", async () => {
    const base = environmentFor();
    const absent = { ...base };
    delete absent.NUTRITION_P0_CLIENT_SMOKE_REPORT_BASE64;
    await expect(
      validateHealthReleaseEvidence(absent, checkTime, trustStore, releaseRuntime),
    ).rejects.toThrow(/exactly one/u);

    await expect(
      validateHealthReleaseEvidence(
        { ...base, NUTRITION_P0_CLIENT_SMOKE_REPORT_PATH: "/tmp/p0-client-smoke.json" },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/exactly one/u);

    const smokeReport = p0ClientSmokeReport();
    const noncanonical = Buffer.from(JSON.stringify(smokeReport), "utf8");
    const manifest = unsignedManifest(physicalDeviceRelayReport(), smokeReport);
    manifest.p0ClientSmoke.reportSha256 = createHash("sha256").update(noncanonical).digest("hex");
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(attest(manifest), physicalDeviceRelayReport(), smokeReport),
          NUTRITION_P0_CLIENT_SMOKE_REPORT_BASE64: noncanonical.toString("base64"),
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/canonical field order/u);
  });

  it("requires the signed v5 manifest itself to use canonical unambiguous JSON", async () => {
    const manifest = attest();
    const noncanonical = JSON.stringify(manifest);
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(manifest),
          NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON: noncanonical,
          NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256: createHash("sha256")
            .update(noncanonical)
            .digest("hex"),
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/canonical field order/u);

    const canonical = canonicalJson(manifest);
    const duplicateKey = `{"schemaVersion":"nutrition-tracker-health-release-evidence-v3",${canonical.slice(1)}`;
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(manifest),
          NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON: duplicateKey,
          NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256: createHash("sha256")
            .update(duplicateKey)
            .digest("hex"),
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/canonical field order/u);
  });

  it("accepts only a stable mode-0600 regular relay-report path", async () => {
    const bytes = relayReportBytes();
    const environment = environmentFor();
    delete environment.NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64;
    environment.NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_PATH = "/tmp/relay-report.json";
    const stableStat = {
      dev: 7,
      ino: 901,
      isFile: () => true,
      mode: 0o100600,
      mtimeMs: 1234,
      size: bytes.length,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    };
    await expect(
      validateHealthReleaseEvidence(environment, checkTime, trustStore, {
        ...releaseRuntime,
        readRelayReport: () => ({ after: stableStat, before: stableStat, bytes }),
      }),
    ).resolves.toMatchObject({
      physicalDeviceApiRelay: { reportSha256: relayReportDigest() },
    });

    for (const [label, stat] of [
      ["symlink", { ...stableStat, isFile: () => false }],
      ["broad mode", { ...stableStat, mode: 0o100644 }],
      ["empty", { ...stableStat, size: 0 }],
      ["oversize", { ...stableStat, size: 65_537 }],
    ]) {
      await expect(
        validateHealthReleaseEvidence(environment, checkTime, trustStore, {
          ...releaseRuntime,
          readRelayReport: () => ({ after: stat, before: stat, bytes }),
        }),
        label,
      ).rejects.toThrow(/mode-0600 regular JSON file/u);
    }

    await expect(
      validateHealthReleaseEvidence(environment, checkTime, trustStore, {
        ...releaseRuntime,
        readRelayReport: () => ({
          before: stableStat,
          after: { ...stableStat, ino: 902 },
          bytes,
        }),
      }),
    ).rejects.toThrow(/changed while/u);
  });

  it("accepts only a stable mode-0600 regular P0 smoke-report path", async () => {
    const bytes = p0ClientSmokeReportBytes();
    const environment = environmentFor();
    delete environment.NUTRITION_P0_CLIENT_SMOKE_REPORT_BASE64;
    environment.NUTRITION_P0_CLIENT_SMOKE_REPORT_PATH = "/tmp/p0-client-smoke.json";
    const stableStat = {
      dev: 7,
      ino: 903,
      isFile: () => true,
      mode: 0o100600,
      mtimeMs: 1234,
      size: bytes.length,
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    };
    await expect(
      validateHealthReleaseEvidence(environment, checkTime, trustStore, {
        ...releaseRuntime,
        readP0ClientSmokeReport: () => ({ after: stableStat, before: stableStat, bytes }),
      }),
    ).resolves.toMatchObject({
      p0ClientSmoke: { reportSha256: p0ClientSmokeReportDigest() },
    });

    for (const stat of [
      { ...stableStat, isFile: () => false },
      { ...stableStat, mode: 0o100644 },
      { ...stableStat, size: 0 },
      { ...stableStat, size: 262_145 },
    ]) {
      await expect(
        validateHealthReleaseEvidence(environment, checkTime, trustStore, {
          ...releaseRuntime,
          readP0ClientSmokeReport: () => ({ after: stat, before: stat, bytes }),
        }),
      ).rejects.toThrow(/mode-0600 regular JSON file/u);
    }

    await expect(
      validateHealthReleaseEvidence(environment, checkTime, trustStore, {
        ...releaseRuntime,
        readP0ClientSmokeReport: () => ({
          before: stableStat,
          after: { ...stableStat, ino: 904 },
          bytes,
        }),
      }),
    ).rejects.toThrow(/changed while/u);
  });

  it("rejects weakened v4 topology, adapter, policy, boundary, probe, restart, and teardown claims", async () => {
    const cases = [
      [
        "unexpected raw origin",
        (report) => (report.apiOrigin = physicalDeviceApiOrigin),
        /must contain exactly/u,
      ],
      [
        "source commit mismatch",
        (report) => (report.sourceCommit = "b".repeat(40)),
        /sourceCommit must equal the signed manifest\.gitCommit/u,
      ],
      [
        "unsupported adapter ID",
        (report) => (report.versionAdapter.adapterId = "unknown-windows-contract-v1"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported client version",
        (report) => (report.versionAdapter.tailscaleClientVersion = "0.0.1-test"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported daemon version",
        (report) => (report.versionAdapter.tailscaleDaemonVersion = "0.0.1-test"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported Windows version",
        (report) => (report.versionAdapter.windowsVersion = "10.0.26100.4947"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported WSL version",
        (report) => (report.versionAdapter.wslVersion = "2.5.10.1"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported Ubuntu version",
        (report) => (report.versionAdapter.ubuntuVersion = "24.04.4"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported Docker Desktop version",
        (report) => (report.versionAdapter.dockerDesktopVersion = "4.45.1"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported Docker Engine version",
        (report) => (report.versionAdapter.dockerEngineVersion = "28.3.4"),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "adapter kind and ID namespace mismatch",
        (report) => (report.versionAdapter.adapterKind = "test"),
        /kind and adapter-ID namespace/u,
      ],
      [
        "unsupported adapter platform",
        (report) => (report.versionAdapter.platform = "wsl2-ubuntu"),
        /platform must equal windows-host/u,
      ],
      [
        "unsupported corpus schema",
        (report) => (report.versionAdapter.corpusSchemaVersion = "legacy"),
        /corpusSchemaVersion must equal/u,
      ],
      [
        "unsupported corpus digest",
        (report) => (report.versionAdapter.corpusSha256 = "e".repeat(64)),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported client help digest",
        (report) => (report.versionAdapter.clientHelpSha256 = "e".repeat(64)),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "unsupported daemon help digest",
        (report) => (report.versionAdapter.daemonHelpSha256 = "e".repeat(64)),
        /unsupported Tailscale adapter\/corpus\/environment\/version\/help tuple/u,
      ],
      [
        "wrong relay node",
        (report) => (report.hostTopology.relayNode = "wsl2"),
        /hostTopology\.relayNode/u,
      ],
      [
        "unsupported WSL mode",
        (report) => (report.hostTopology.wslNetworkingMode = "bridged"),
        /wslNetworkingMode/u,
      ],
      [
        "missing version identity",
        (report) => (report.versionAdapter.tailscaleDaemonVersion = ""),
        /version syntax/u,
      ],
      [
        "Windows path in version",
        (report) => (report.versionAdapter.windowsVersion = "C:\\Windows"),
        /version syntax/u,
      ],
      [
        "principal in version",
        (report) => (report.versionAdapter.wslVersion = "admin@example.test"),
        /version syntax/u,
      ],
      [
        "slash in version",
        (report) => (report.versionAdapter.ubuntuVersion = "24.04/test"),
        /version syntax/u,
      ],
      [
        "space in version",
        (report) => (report.versionAdapter.dockerDesktopVersion = "4.45.0 stable"),
        /version syntax/u,
      ],
      [
        "overlong version",
        (report) => (report.versionAdapter.dockerEngineVersion = "v".repeat(65)),
        /version syntax/u,
      ],
      [
        "invalid adapter path",
        (report) => (report.versionAdapter.adapterId = "../adapter"),
        /adapter-ID syntax/u,
      ],
      [
        "invalid adapter principal",
        (report) => (report.versionAdapter.adapterId = "user@example.test"),
        /adapter-ID syntax/u,
      ],
      [
        "invalid adapter space",
        (report) => (report.versionAdapter.adapterId = "adapter id"),
        /adapter-ID syntax/u,
      ],
      [
        "overlong adapter ID",
        (report) => (report.versionAdapter.adapterId = `a${"b".repeat(64)}`),
        /adapter-ID syntax/u,
      ],
      [
        "environment capture not bound",
        (report) => (report.boundaryEvidence.active.environmentSha256 = captureDigest(999)),
        /bind version-adapter evidence/u,
      ],
      [
        "incoming enabled before policy",
        (report) => (report.policy.incomingAccessHeldUntilPolicyTests = "failed"),
        /incomingAccessHeldUntilPolicyTests/u,
      ],
      [
        "relay identity not revalidated",
        (report) => (report.policy.relayHostIdentityRevalidated = "failed"),
        /relayHostIdentityRevalidated/u,
      ],
      [
        "broad policy",
        (report) => (report.policy.testedPhonesToRelayHostTcp443Only = "failed"),
        /testedPhonesToRelayHostTcp443Only/u,
      ],
      [
        "overlapping policy",
        (report) => (report.policy.noOverlappingAclOrGrant = "failed"),
        /noOverlappingAclOrGrant/u,
      ],
      ["policy tests failed", (report) => (report.policy.policyTests = "failed"), /policyTests/u],
      [
        "one-phone policy",
        (report) => report.policy.approvedPhoneAliases.pop(),
        /reviewed phone aliases/u,
      ],
      [
        "malformed policy gate",
        (report) => (report.policy.gateCaptureSha256 = "not-a-digest"),
        /gateCaptureSha256/u,
      ],
      [
        "incomplete active boundary",
        (report) => delete report.boundaryEvidence.active.dockerPortsSha256,
        /boundaryEvidence\.active must contain exactly/u,
      ],
      [
        "malformed teardown boundary",
        (report) => (report.boundaryEvidence.teardown.forwardingSha256 = "bad"),
        /boundaryEvidence\.teardown\.forwardingSha256/u,
      ],
      [
        "reused boundary capture",
        (report) =>
          (report.boundaryEvidence.active.windowsListenersSha256 =
            report.boundaryEvidence.preflight.windowsListenersSha256),
        /candidate capture roles cannot be reused/u,
      ],
      [
        "reused active state capture",
        (report) =>
          (report.restart.preShutdown.incomingCaptureSha256 = report.active.incomingCaptureSha256),
        /candidate capture roles cannot be reused/u,
      ],
      ["Funnel enabled", (report) => (report.active.funnel = "enabled"), /active\.funnel/u],
      [
        "wrong upstream",
        (report) => (report.active.upstream = "http://127.0.0.1:4566"),
        /active route/u,
      ],
      [
        "missing baseline port",
        (report) => report.active.inventoriedNon443TcpPorts.shift(),
        /include TCP\/22/u,
      ],
      [
        "swapped phone alias",
        (report) => (report.active.deviceProbes.ios.phoneAlias = "nutrition-tracker-phone-2"),
        /distinct reviewed ios phone/u,
      ],
      [
        "extra open port",
        (report) => report.active.deviceProbes.ios.openTcpPorts.push(4000),
        /only TCP\/443/u,
      ],
      [
        "probe mismatch",
        (report) => report.active.deviceProbes.android.blockedTcpPorts.pop(),
        /complete denied-port inventory/u,
      ],
      [
        "wrong active build",
        (report) =>
          (report.active.deviceProbes.ios.testedEasBuildId = buildIds.physicalDevice.android),
        /bind the ios physical artifact/u,
      ],
      [
        "wrong readiness body",
        (report) => (report.active.deviceProbes.android.readyBodySha256 = captureDigest(999)),
        /readyBodySha256/u,
      ],
      [
        "direct target reachable",
        (report) => (report.active.deviceProbes.ios.directWindowsWslDockerTargets = "reachable"),
        /directWindowsWslDockerTargets/u,
      ],
      [
        "off-tailnet access",
        (report) => (report.active.deviceProbes.android.tailscaleDisabledHttps = "reachable"),
        /tailscaleDisabledHttps/u,
      ],
      [
        "unapproved peer reached HTTPS",
        (report) => (report.active.deviceProbes.unapprovedTailnet.httpsPort = "reachable"),
        /unapprovedTailnet\.httpsPort/u,
      ],
      [
        "unapproved peer missed a denied port",
        (report) => report.active.deviceProbes.unapprovedTailnet.blockedTcpPorts.pop(),
        /complete denied-port inventory/u,
      ],
      [
        "LAN target reachable",
        (report) => (report.active.deviceProbes.lan.windowsWslDockerTargets = "reachable"),
        /windowsWslDockerTargets/u,
      ],
      [
        "LAN address family omitted",
        (report) => (report.active.deviceProbes.lan.ipv4AndIpv6Paths = "failed"),
        /ipv4AndIpv6Paths/u,
      ],
      [
        "restart began while incoming enabled",
        (report) => (report.restart.preShutdown.incoming = "enabled"),
        /restart\.preShutdown\.incoming/u,
      ],
      [
        "restart identity stale",
        (report) => (report.restart.preExposure.relayHostIdentityRevalidated = "failed"),
        /restart\.preExposure\.relayHostIdentityRevalidated/u,
      ],
      [
        "migrations stale",
        (report) => (report.restart.localReadiness.migrationsCurrent = "failed"),
        /migrationsCurrent/u,
      ],
      [
        "WSL readiness failed",
        (report) => (report.restart.localReadiness.wsl.httpStatus = 500),
        /localReadiness\.wsl\.httpStatus/u,
      ],
      [
        "Windows readiness body changed",
        (report) => (report.restart.localReadiness.windows.bodySha256 = captureDigest(999)),
        /localReadiness\.windows\.bodySha256/u,
      ],
      [
        "relay not re-enabled",
        (report) => (report.restart.reenabledRelay.serve = "disabled"),
        /reenabledRelay\.serve/u,
      ],
      [
        "wrong restart build",
        (report) =>
          (report.restart.deviceProbes.ios.testedEasBuildId = buildIds.physicalDevice.android),
        /bind the ios physical artifact/u,
      ],
      [
        "restart route not recovered",
        (report) => (report.restart.routeRecovered = "failed"),
        /routeRecovered/u,
      ],
      [
        "source process changed",
        (report) => (report.restart.sourceProcessContinuity = "failed"),
        /sourceProcessContinuity/u,
      ],
      [
        "reused active probe capture",
        (report) =>
          (report.restart.deviceProbes.ios.captureSha256 =
            report.active.deviceProbes.ios.captureSha256),
        /candidate capture roles cannot be reused/u,
      ],
      [
        "swapped active phone times",
        (report) => (report.active.deviceProbes.ios.observedAt = "2026-08-16T07:23:00.000Z"),
        /Active probe observations must be strictly ordered/u,
      ],
      [
        "equal active phone times",
        (report) =>
          (report.active.deviceProbes.android.observedAt =
            report.active.deviceProbes.ios.observedAt),
        /Active probe observations must be strictly ordered/u,
      ],
      [
        "swapped restart readiness times",
        (report) => (report.restart.localReadiness.wsl.observedAt = "2026-08-16T07:48:00.000Z"),
        /Restart readiness and probe observations must be strictly ordered/u,
      ],
      [
        "equal restart phone times",
        (report) =>
          (report.restart.deviceProbes.android.observedAt =
            report.restart.deviceProbes.ios.observedAt),
        /Restart readiness and probe observations must be strictly ordered/u,
      ],
      [
        "active and restart phases share a timestamp",
        (report) =>
          (report.active.deviceProbes.lan.observedAt =
            report.restart.localReadiness.wsl.observedAt),
        /Active probes must finish before post-restart/u,
      ],
      [
        "active probe after restart readiness",
        (report) => (report.active.deviceProbes.lan.observedAt = "2026-08-16T07:50:00.000Z"),
        /Active probes must finish/u,
      ],
      [
        "restart probe before readiness",
        (report) => (report.restart.localReadiness.windows.observedAt = "2026-08-16T07:59:00.000Z"),
        /Restart readiness and probe observations must be strictly ordered/u,
      ],
      [
        "restart probe equals signed execution",
        (report) => (report.restart.deviceProbes.lan.observedAt = report.executedAt),
        /Restart probes must finish before signed relay execution/u,
      ],
      [
        "report build mismatch",
        (report) => (report.buildIds.ios = buildIds.physicalDevice.android),
        /buildIds\.ios.*signed physical artifact/u,
      ],
      [
        "teardown incoming enabled",
        (report) => (report.teardown.incoming = "enabled"),
        /teardown\.incoming/u,
      ],
      [
        "relay host not disconnected",
        (report) => (report.teardown.relayHostDisconnected = "failed"),
        /relayHostDisconnected/u,
      ],
      [
        "boundary not restored",
        (report) => (report.teardown.boundaryRestored = "failed"),
        /boundaryRestored/u,
      ],
      [
        "malformed disconnect capture",
        (report) => (report.teardown.disconnectCaptureSha256 = "not-a-digest"),
        /disconnectCaptureSha256/u,
      ],
      [
        "malformed session ledger",
        (report) => (report.sessionLedgerSha256 = "not-a-digest"),
        /sessionLedgerSha256/u,
      ],
    ];
    for (const [label, mutate, message] of cases) {
      const report = physicalDeviceRelayReport();
      mutate(report);
      await expect(
        validateHealthReleaseEvidence(
          environmentFor(attest(unsignedManifest(report)), report),
          checkTime,
          trustStore,
          releaseRuntime,
        ),
        label,
      ).rejects.toThrow(message);
    }
  });

  it("requires relay completion to follow signed execution strictly", async () => {
    const equalExecutionAndCompletion = physicalDeviceRelayReport();
    equalExecutionAndCompletion.completedAt = equalExecutionAndCompletion.executedAt;

    await expect(
      validateHealthReleaseEvidence(
        environmentFor(
          attest(unsignedManifest(equalExecutionAndCompletion)),
          equalExecutionAndCompletion,
        ),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/exactly bind signed execution/u);
  });

  it("requires relay completion to precede manifest review strictly", async () => {
    const report = physicalDeviceRelayReport();
    const reviewedAt = unsignedManifest(report).reviewedAt;
    report.completedAt = reviewedAt;
    const manifest = unsignedManifest(report);
    expect(report.completedAt).toBe(manifest.reviewedAt);

    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(manifest), report),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/finish before review/u);
  });

  it("requires a fresh relay capture and rejects forbidden report payload keys", async () => {
    const staleCapture = physicalDeviceRelayReport();
    staleCapture.startedAt = "2026-08-14T07:30:00.000Z";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(staleCapture)), staleCapture),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/span at most 24 hours/u);

    const teardownBeforeExecution = physicalDeviceRelayReport();
    teardownBeforeExecution.completedAt = "2026-08-16T07:59:59.000Z";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(teardownBeforeExecution)), teardownBeforeExecution),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/exactly bind signed execution/u);

    const mismatchedExecution = physicalDeviceRelayReport();
    mismatchedExecution.executedAt = "2026-08-16T08:00:01.000Z";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(mismatchedExecution)), mismatchedExecution),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/exactly bind signed execution/u);

    const leaked = physicalDeviceRelayReport();
    leaked.policy.token = "must-not-be-recorded";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(leaked)), leaked),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/must not contain/u);
  });

  it("never reflects attacker-controlled evidence keys in forbidden-payload errors", async () => {
    const secretBearingParentKey = "parent-secret-do-not-echo-7f4b2f";
    const nestedSecret = "nested-secret-do-not-echo-a832c1";
    const report = physicalDeviceRelayReport();
    report[secretBearingParentKey] = { token: nestedSecret };
    let failure;
    try {
      await validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(report)), report),
        checkTime,
        trustStore,
        releaseRuntime,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.message).toBe(
      "Release evidence must not contain health payloads, identifiers, keys, or tokens.",
    );
    expect(failure.message).not.toContain(secretBearingParentKey);
    expect(failure.message).not.toContain(nestedSecret);
  });

  it("hashes each physical-device and production artifact independently", async () => {
    const hashArtifact = vi.fn(releaseRuntime.hashArtifact);
    await validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
      ...releaseRuntime,
      hashArtifact,
    });
    expect(hashArtifact.mock.calls.map(([path]) => path)).toEqual([
      artifactPaths.physicalDevice.ios,
      artifactPaths.physicalDevice.android,
      artifactPaths.production.ios,
      artifactPaths.production.android,
    ]);

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        hashArtifact: async (path) =>
          path === artifactPaths.production.android
            ? "f".repeat(64)
            : releaseRuntime.hashArtifact(path),
      }),
    ).rejects.toThrow(/production Android AAB digest/u);
  });

  it("rejects a claimed reviewer identity signed by the wrong or an untrusted key", async () => {
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(), wrongKeys.privateKey)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/signature verification/u);
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(),
        checkTime,
        { ...trustStore, reviewers: [] },
        releaseRuntime,
      ),
    ).rejects.toThrow(/trusted key/u);

    const relabeled = attest();
    relabeled.reviewerAttestation.keyId = "release-reviewer-2026-02";
    const sameKeyAlternateIdTrustStore = {
      ...trustStore,
      reviewers: [
        ...trustStore.reviewers,
        {
          ...trustStore.reviewers[0],
          keyId: "release-reviewer-2026-02",
          publicKeySpkiDerBase64: wrongKeys.publicKey
            .export({ format: "der", type: "spki" })
            .toString("base64"),
        },
      ],
    };
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(relabeled),
        checkTime,
        sameKeyAlternateIdTrustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/signature verification/u);

    const malformedInactiveTrustStore = {
      ...trustStore,
      reviewers: [
        ...trustStore.reviewers,
        {
          ...trustStore.reviewers[0],
          keyId: "future-release-reviewer-2027",
          publicKeySpkiDerBase64: Buffer.from("not-a-public-key").toString("base64"),
          validFrom: "2027-01-01T00:00:00.000Z",
          validUntil: "2028-01-01T00:00:00.000Z",
        },
      ],
    };
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(),
        checkTime,
        malformedInactiveTrustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/valid SPKI public key/u);
  });

  it("rejects tampering even when the caller recomputes the JSON checksum", async () => {
    const tampered = attest();
    tampered.devices.android.matrix.deletedWeightReconciliation = "passed-but-not-run";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(tampered),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/deletedWeightReconciliation|signature/u);
  });

  it("binds device results only to physical-device IPA/APK builds", async () => {
    const wrongArtifactType = unsignedManifest();
    wrongArtifactType.artifacts.physicalDevice.android.artifactType = "aab";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(wrongArtifactType)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/physical-device android apk artifact/u);

    const productionBuildClaim = unsignedManifest();
    productionBuildClaim.devices.android.testedEasBuildId = buildIds.production.android;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(productionBuildClaim)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/bind the physical-device artifact/u);
  });

  it("binds every artifact to a distinct EAS build, commit, native version, and signer", async () => {
    const wrongCommit = unsignedManifest();
    wrongCommit.artifacts.production.ios.sourceCommit = "f".repeat(40);
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(wrongCommit)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/sourceCommit must equal/u);

    const duplicateBuild = unsignedManifest();
    duplicateBuild.artifacts.production.ios.easBuildId = buildIds.physicalDevice.ios;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(duplicateBuild)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/distinct exact EAS build ID/u);

    const mismatchedVersion = unsignedManifest();
    mismatchedVersion.artifacts.production.android.nativeBuildVersion = 2;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(mismatchedVersion)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/same source-controlled native build version/u);

    const invalidSigner = unsignedManifest();
    invalidSigner.artifacts.production.android.signingIdentitySha256 = "not-a-fingerprint";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(invalidSigner)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/signingIdentitySha256/u);

    const duplicateDigest = unsignedManifest();
    duplicateDigest.artifacts.production.ios.artifactSha256 =
      duplicateDigest.artifacts.physicalDevice.ios.artifactSha256;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(duplicateDigest)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/distinct exact SHA-256 digest/u);
  });

  it("binds signed app and native versions to confirmed source-controlled release metadata", async () => {
    const wrongAppVersion = unsignedManifest();
    wrongAppVersion.appVersion = "0.2.0";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(wrongAppVersion)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/exact source-controlled app version/u);

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        readReleaseMetadata: () => ({
          appConfig: {
            expo: {
              version: "0.1.0",
              ios: {},
              android: {},
            },
          },
          releaseNumbering: {
            schemaVersion: "nutrition-tracker-release-numbering-v1",
            identifierHistoryConfirmed: false,
            iosBuildNumber: null,
            androidVersionCode: null,
          },
        }),
      }),
    ).rejects.toThrow(/must be confirmed/u);

    const wrongIosBuild = unsignedManifest();
    wrongIosBuild.artifacts.physicalDevice.ios.nativeBuildVersion = "2";
    wrongIosBuild.artifacts.production.ios.nativeBuildVersion = "2";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(wrongIosBuild)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/confirmed source-controlled iOS build number/u);

    const wrongAndroidBuild = unsignedManifest();
    wrongAndroidBuild.artifacts.physicalDevice.android.nativeBuildVersion = 2;
    wrongAndroidBuild.artifacts.production.android.nativeBuildVersion = 2;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(wrongAndroidBuild)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/confirmed source-controlled Android version code/u);

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        readReleaseMetadata: () => {
          const metadata = structuredClone(confirmedReleaseMetadata);
          metadata.appConfig.expo.ios.buildNumber = "2";
          return metadata;
        },
      }),
    ).rejects.toThrow(/app config and release-numbering record.*iOS build number/u);

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        readReleaseMetadata: () => {
          const metadata = structuredClone(confirmedReleaseMetadata);
          metadata.releaseNumbering.androidVersionCode = 0;
          metadata.appConfig.expo.android.versionCode = 0;
          return metadata;
        },
      }),
    ).rejects.toThrow(/confirmed Android version code/u);
  });

  it("rejects same paths, hardlinks, symlinks, and duplicate actual artifact bytes", async () => {
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(),
          NUTRITION_IOS_PRODUCTION_ARTIFACT_PATH: artifactPaths.physicalDevice.ios,
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/distinct normalized absolute path/u);

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        statArtifact: (path) => ({
          ...releaseRuntime.statArtifact(path),
          ino:
            path === artifactPaths.production.ios
              ? releaseRuntime.statArtifact(artifactPaths.physicalDevice.ios).ino
              : releaseRuntime.statArtifact(path).ino,
        }),
      }),
    ).rejects.toThrow(/distinct filesystem file/u);

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        statArtifact: (path) => ({
          ...releaseRuntime.statArtifact(path),
          isFile: () => path !== artifactPaths.production.android,
          isSymbolicLink: () => path === artifactPaths.production.android,
        }),
      }),
    ).rejects.toThrow(/bounded regular signed-binary file/u);

    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        hashArtifact: async (path) =>
          path === artifactPaths.production.ios
            ? artifactDigests.physicalDevice.ios
            : releaseRuntime.hashArtifact(path),
      }),
    ).rejects.toThrow(/distinct actual SHA-256 digest/u);
  });

  it("requires role-specific file extensions and exact build-ID environment pins", async () => {
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(),
          NUTRITION_ANDROID_PHYSICAL_DEVICE_ARTIFACT_PATH: "/tmp/not-the-tested-build.aab",
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/absolute \.apk path/u);

    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(),
          NUTRITION_IOS_PRODUCTION_ARTIFACT_PATH: "/tmp/../tmp/reviewed-production.ipa",
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/normalized absolute \.ipa path/u);

    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(),
          NUTRITION_IOS_PRODUCTION_BUILD_ID: buildIds.physicalDevice.ios,
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/production iOS IPA EAS build ID/u);
  });

  it("rejects stale evidence, self-review, and health payload fields", async () => {
    const staleUnsigned = unsignedManifest();
    staleUnsigned.executedAt = "2026-06-01T08:00:00.000Z";
    staleUnsigned.reviewedAt = "2026-06-01T09:00:00.000Z";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(staleUnsigned)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/older/u);

    const revivedOldExecution = unsignedManifest();
    revivedOldExecution.executedAt = "2026-06-01T08:00:00.000Z";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(revivedOldExecution)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/execution is older/u);

    const selfUnsigned = unsignedManifest();
    selfUnsigned.reviewedBy = selfUnsigned.executedBy;
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(selfUnsigned)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/independent reviewer/u);

    const leaked = attest();
    leaked.devices.ios.matrix.token = "do-not-store-this";
    await expect(
      validateHealthReleaseEvidence(environmentFor(leaked), checkTime, trustStore, releaseRuntime),
    ).rejects.toThrow(/must not contain/u);
  });

  it("binds evidence to the actual clean Git tree", async () => {
    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        gitHead: () => "d".repeat(40),
      }),
    ).rejects.toThrow(/actual Git HEAD/u);
    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        gitStatus: () => " M apps/mobile/App.tsx\n",
      }),
    ).rejects.toThrow(/clean Git tree/u);
  });
});
