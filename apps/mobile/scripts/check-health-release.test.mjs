import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "@nutrition-tracker/contracts";

import { describe, expect, it, vi } from "vitest";

import {
  HEALTH_RELEASE_EVIDENCE_SCHEMA,
  HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
  PHYSICAL_DEVICE_RELAY_REPORT_SCHEMA,
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

function relayProbe(testedEasBuildId) {
  return {
    testedEasBuildId,
    phoneAlias:
      testedEasBuildId === buildIds.physicalDevice.ios
        ? "nutrition-tracker-phone-1"
        : "nutrition-tracker-phone-2",
    observedAt:
      testedEasBuildId === buildIds.physicalDevice.ios
        ? "2026-08-16T07:30:00.000Z"
        : "2026-08-16T07:45:00.000Z",
    policySha256: "4".repeat(64),
    configurationLogEventSha256: "5".repeat(64),
    publicCaAndHostname: "passed",
    readyHttpStatus: 200,
    openTcpPorts: [443],
    blockedTcpPorts: [...inventoriedNon443TcpPorts],
    tailscaleDisabledHttps: "blocked",
  };
}

function physicalDeviceRelayReport() {
  return {
    schemaVersion: PHYSICAL_DEVICE_RELAY_REPORT_SCHEMA,
    apiOrigin: physicalDeviceApiOrigin,
    startedAt: "2026-08-16T07:00:00.000Z",
    completedAt: "2026-08-16T08:30:00.000Z",
    preflight: {
      firstConnectionShieldsUp: "passed",
      initialServeAndFunnelStatus: "empty",
      incomingAccessHeldUntilPolicyTests: "passed",
      macIdentityRevalidated: "passed",
      iosIdentityRevalidated: "passed",
      androidIdentityRevalidated: "passed",
      shieldsUpStatusSha256: "7".repeat(64),
      initialServeStatusSha256: "8".repeat(64),
      initialFunnelStatusSha256: "8".repeat(64),
      identityStatusSha256: "9".repeat(64),
      accessControlTimelineSha256: "d".repeat(64),
    },
    serve: {
      mode: "foreground",
      httpsPort: 443,
      handlerPath: "/",
      upstream: "http://127.0.0.1:4000",
      persistentConfiguration: "empty",
      foregroundSessionCount: 1,
      funnelEnabled: false,
      serveStatusSha256: "3".repeat(64),
      funnelStatusSha256: "3".repeat(64),
    },
    tailnetAccess: {
      policySha256: "4".repeat(64),
      configurationLogEventSha256: "5".repeat(64),
      approvedPhoneAliases: ["nutrition-tracker-phone-1", "nutrition-tracker-phone-2"],
      testedPhonesToMacTcp443Only: "passed",
      noOverlappingAclOrGrant: "passed",
      policyTests: "passed",
      unapprovedPeerHttps443: "blocked",
    },
    listenerInventory: {
      snapshotSha256: "6".repeat(64),
      requiredServicesIpv4Loopback: "passed",
      inventoriedNon443TcpPorts: [...inventoriedNon443TcpPorts],
      wildcardNon443TcpPorts: [2181, 8080, 9092],
    },
    deviceProbes: {
      ios: relayProbe(buildIds.physicalDevice.ios),
      android: relayProbe(buildIds.physicalDevice.android),
    },
    teardown: {
      serveAndFunnelStatus: "empty",
      shieldsUpRestored: "passed",
      macDisconnected: "passed",
      serveStatusSha256: "a".repeat(64),
      funnelStatusSha256: "a".repeat(64),
      shieldsUpStatusSha256: "b".repeat(64),
      disconnectStatusSha256: "c".repeat(64),
    },
  };
}

function relayReportBytes(report = physicalDeviceRelayReport()) {
  return Buffer.from(`${canonicalJson(report)}\n`, "utf8");
}

function relayReportDigest(report = physicalDeviceRelayReport()) {
  return createHash("sha256").update(relayReportBytes(report)).digest("hex");
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

function unsignedManifest(report = physicalDeviceRelayReport()) {
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

function environmentFor(manifest = attest(), report = physicalDeviceRelayReport()) {
  const raw = `${canonicalJson(manifest)}\n`;
  return {
    NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON: raw,
    NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256: createHash("sha256")
      .update(raw, "utf8")
      .digest("hex"),
    NUTRITION_PHYSICAL_DEVICE_API_ORIGIN: physicalDeviceApiOrigin,
    NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64: relayReportBytes(report).toString("base64"),
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
      reviewerKeyId,
    });
  });

  it("requires signed v4 relay evidence with exact keys", async () => {
    const legacy = unsignedManifest();
    legacy.schemaVersion = "nutrition-tracker-health-release-evidence-v3";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(legacy)),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/health-release-evidence-v4/u);

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
  });

  it("binds one reviewed ts.net origin and the exact canonical relay-report bytes", async () => {
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
    wrongOriginReport.apiOrigin = "https://other.tail1234.ts.net";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(wrongOriginReport)), wrongOriginReport),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/origin must match/u);

    const unsafeOriginReport = physicalDeviceRelayReport();
    unsafeOriginReport.apiOrigin = "https://api.github.com";
    const unsafeOriginManifest = unsignedManifest(unsafeOriginReport);
    unsafeOriginManifest.physicalDeviceApiRelay.apiOrigin = unsafeOriginReport.apiOrigin;
    await expect(
      validateHealthReleaseEvidence(
        {
          ...environmentFor(attest(unsafeOriginManifest), unsafeOriginReport),
          NUTRITION_PHYSICAL_DEVICE_API_ORIGIN: unsafeOriginReport.apiOrigin,
        },
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/machine.*tailnet.*ts\.net/u);

    const changedReport = physicalDeviceRelayReport();
    changedReport.teardown.shieldsUpRestored = "failed";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(), changedReport),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/SHA-256/u);
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

  it("requires the signed v4 manifest itself to use canonical unambiguous JSON", async () => {
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

  it("rejects weakened Serve, policy, inventory, probe, and teardown claims", async () => {
    const cases = [
      [
        "first connection exposed",
        (report) => (report.preflight.firstConnectionShieldsUp = "failed"),
        /firstConnectionShieldsUp/u,
      ],
      [
        "initial Serve present",
        (report) => (report.preflight.initialServeAndFunnelStatus = "present"),
        /initialServeAndFunnelStatus/u,
      ],
      [
        "incoming enabled early",
        (report) => (report.preflight.incomingAccessHeldUntilPolicyTests = "failed"),
        /incomingAccessHeldUntilPolicyTests/u,
      ],
      [
        "phone identity not revalidated",
        (report) => (report.preflight.androidIdentityRevalidated = "failed"),
        /androidIdentityRevalidated/u,
      ],
      [
        "Funnel enabled",
        (report) => (report.serve.funnelEnabled = true),
        /no persistent Serve or Funnel/u,
      ],
      [
        "wrong upstream",
        (report) => (report.serve.upstream = "http://127.0.0.1:4566"),
        /exact API loopback/u,
      ],
      [
        "broad policy",
        (report) => (report.tailnetAccess.testedPhonesToMacTcp443Only = "failed"),
        /testedPhonesToMacTcp443Only/u,
      ],
      [
        "overlap",
        (report) => (report.tailnetAccess.noOverlappingAclOrGrant = "failed"),
        /noOverlappingAclOrGrant/u,
      ],
      [
        "unapproved peer",
        (report) => (report.tailnetAccess.unapprovedPeerHttps443 = "allowed"),
        /unapprovedPeerHttps443/u,
      ],
      [
        "one-phone policy",
        (report) => report.tailnetAccess.approvedPhoneAliases.pop(),
        /exactly the reviewed iOS and Android phone aliases/u,
      ],
      [
        "swapped phone alias",
        (report) => (report.deviceProbes.ios.phoneAlias = "nutrition-tracker-phone-2"),
        /distinct reviewed ios phone/u,
      ],
      [
        "probe changed policy",
        (report) => (report.deviceProbes.android.policySha256 = "d".repeat(64)),
        /same reviewed two-phone policy/u,
      ],
      [
        "missing baseline",
        (report) => report.listenerInventory.inventoriedNon443TcpPorts.shift(),
        /denied TCP\/22/u,
      ],
      [
        "wildcard outside inventory",
        (report) => report.listenerInventory.wildcardNon443TcpPorts.push(65535),
        /subset/u,
      ],
      [
        "extra open port",
        (report) => report.deviceProbes.ios.openTcpPorts.push(4000),
        /only TCP\/443/u,
      ],
      [
        "probe mismatch",
        (report) => report.deviceProbes.android.blockedTcpPorts.pop(),
        /complete listener inventory/u,
      ],
      [
        "wrong build",
        (report) => (report.deviceProbes.ios.testedEasBuildId = buildIds.production.ios),
        /bind the ios physical artifact/u,
      ],
      [
        "CA failure",
        (report) => (report.deviceProbes.android.publicCaAndHostname = "failed"),
        /publicCaAndHostname/u,
      ],
      [
        "off-tailnet access",
        (report) => (report.deviceProbes.android.tailscaleDisabledHttps = "reachable"),
        /tailscaleDisabledHttps/u,
      ],
      [
        "teardown failure",
        (report) => (report.teardown.serveAndFunnelStatus = "present"),
        /serveAndFunnelStatus/u,
      ],
      [
        "Mac not disconnected",
        (report) => (report.teardown.macDisconnected = "failed"),
        /macDisconnected/u,
      ],
      [
        "missing teardown source digest",
        (report) => (report.teardown.shieldsUpStatusSha256 = "not-a-digest"),
        /shieldsUpStatusSha256/u,
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
    ).rejects.toThrow(/contain execution/u);

    const leaked = physicalDeviceRelayReport();
    leaked.tailnetAccess.token = "must-not-be-recorded";
    await expect(
      validateHealthReleaseEvidence(
        environmentFor(attest(unsignedManifest(leaked)), leaked),
        checkTime,
        trustStore,
        releaseRuntime,
      ),
    ).rejects.toThrow(/must not contain/u);
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
