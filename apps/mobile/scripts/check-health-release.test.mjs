import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "@nutrition-tracker/contracts";

import { describe, expect, it, vi } from "vitest";

import {
  HEALTH_RELEASE_EVIDENCE_SCHEMA,
  HEALTH_RELEASE_REVIEWER_TRUST_SCHEMA,
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

function unsignedManifest() {
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
  };
}

function attest(unsigned = unsignedManifest(), privateKey = reviewerKeys.privateKey) {
  const signature = sign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey);
  return {
    ...unsigned,
    reviewerAttestation: {
      keyId: reviewerKeyId,
      algorithm: "Ed25519",
      signatureBase64: signature.toString("base64"),
    },
  };
}

function environmentFor(manifest = attest()) {
  const raw = JSON.stringify(manifest);
  return {
    NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON: raw,
    NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256: createHash("sha256")
      .update(raw, "utf8")
      .digest("hex"),
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
      reviewerKeyId,
    });
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
