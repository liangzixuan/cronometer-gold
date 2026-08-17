import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "@nutrition-tracker/contracts";

import { describe, expect, it } from "vitest";

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

function unsignedManifest() {
  return {
    schemaVersion: HEALTH_RELEASE_EVIDENCE_SCHEMA,
    appVersion: "0.1.0",
    gitCommit: "a".repeat(40),
    executedBy: "release.operator@example.test",
    executedAt: "2026-08-16T08:00:00.000Z",
    reviewedBy: reviewerPrincipal,
    reviewedAt: "2026-08-16T09:00:00.000Z",
    devices: {
      ios: {
        platform: "ios",
        physicalDevice: true,
        model: "iPhone 17 Pro",
        osVersion: "iOS 19.6.1",
        appBuildId: "ios-release-20260816.1",
        artifactSha256: "b".repeat(64),
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
        appBuildId: "android-release-20260816.1",
        artifactSha256: "c".repeat(64),
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
    NUTRITION_IOS_HEALTH_RELEASE_BUILD_ID: manifest.devices.ios.appBuildId,
    NUTRITION_IOS_HEALTH_RELEASE_ARTIFACT_PATH: "/tmp/reviewed-release.ipa",
    NUTRITION_ANDROID_HEALTH_RELEASE_BUILD_ID: manifest.devices.android.appBuildId,
    NUTRITION_ANDROID_HEALTH_RELEASE_ARTIFACT_PATH: "/tmp/reviewed-release.aab",
  };
}

const checkTime = new Date("2026-08-17T00:00:00.000Z");
const releaseRuntime = {
  gitHead: () => "a".repeat(40),
  gitStatus: () => "",
  statArtifact: () => ({ isFile: () => true, size: 123 }),
  hashArtifact: async (path) => (path.endsWith(".ipa") ? "b".repeat(64) : "c".repeat(64)),
};

describe("native health release evidence", () => {
  it("fails closed without externally signed evidence", async () => {
    await expect(
      validateHealthReleaseEvidence({}, checkTime, trustStore, releaseRuntime),
    ).rejects.toThrow(/absent/u);
  });

  it("accepts distinct pinned iOS/AAB artifacts with a trusted independent signature", async () => {
    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, releaseRuntime),
    ).resolves.toEqual({
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      gitCommit: "a".repeat(40),
      iosArtifactSha256: "b".repeat(64),
      androidArtifactSha256: "c".repeat(64),
      reviewerKeyId,
    });
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

  it("rejects swapping a separately signed platform artifact", async () => {
    const reviewed = attest();
    const environment = environmentFor(reviewed);
    const swapped = {
      ...reviewed,
      devices: {
        ios: {
          ...reviewed.devices.ios,
          artifactSha256: reviewed.devices.android.artifactSha256,
        },
        android: {
          ...reviewed.devices.android,
          artifactSha256: reviewed.devices.ios.artifactSha256,
        },
      },
    };
    const raw = JSON.stringify(swapped);
    environment.NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON = raw;
    environment.NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256 = createHash("sha256")
      .update(raw, "utf8")
      .digest("hex");
    await expect(
      validateHealthReleaseEvidence(environment, checkTime, trustStore, releaseRuntime),
    ).rejects.toThrow(/signature verification/u);
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

  it("binds evidence to the actual Git tree and refuses dirty or newer trees", async () => {
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

  it("hashes the supplied IPA and AAB and rejects swapped or altered binaries", async () => {
    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        hashArtifact: async (path) => (path.endsWith(".ipa") ? "c".repeat(64) : "b".repeat(64)),
      }),
    ).rejects.toThrow(/actual IPA digest/u);
    await expect(
      validateHealthReleaseEvidence(environmentFor(), checkTime, trustStore, {
        ...releaseRuntime,
        hashArtifact: async (path) => (path.endsWith(".ipa") ? "d".repeat(64) : "c".repeat(64)),
      }),
    ).rejects.toThrow(/actual IPA digest/u);
  });
});
