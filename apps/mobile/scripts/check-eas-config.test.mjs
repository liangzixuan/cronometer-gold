import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import appConfig from "../app.json";
import healthReviewerTrustStore from "../config/health-release-reviewers.json";
import releaseDeployment from "../config/release-deployment.json";
import deploymentReviewerTrustStore from "../config/release-deployment-reviewers.json";
import releaseNumbering from "../config/release-numbering.json";
import easConfig from "../eas.json";
import packageConfig from "../package.json";
import { validateEasReleaseConfig } from "./check-eas-config.mjs";
import {
  ExpectedReleaseBlockError,
  RELEASE_NUMBERING_UNCONFIRMED_CODE,
} from "./check-release-env.mjs";

function configuration() {
  return structuredClone({
    appConfig,
    deploymentReviewerTrustStore,
    easConfig,
    healthReviewerTrustStore,
    packageConfig,
    releaseDeployment,
    releaseNumbering,
  });
}

describe("EAS signed build configuration", () => {
  it("pins the linked project, toolchain, signed artifacts, and mandatory preflight", () => {
    expect(() => validateEasReleaseConfig(configuration())).not.toThrow();
  });

  it("keeps every profile behind the clean committed-tree requirement", () => {
    const config = configuration();
    config.easConfig.cli.requireCommit = false;
    expect(() => validateEasReleaseConfig(config)).toThrow(/committed Git tree/u);
  });

  it("validates inactive reviewer roots during ordinary configuration checks", () => {
    const config = configuration();
    config.healthReviewerTrustStore.reviewers.push({
      algorithm: "Ed25519",
      keyId: "future-health-reviewer",
      principal: "independent.health.reviewer@example.test",
      publicKeySpkiDerBase64: Buffer.from("not-a-public-key").toString("base64"),
      validFrom: "2027-01-01T00:00:00.000Z",
      validUntil: "2028-01-01T00:00:00.000Z",
    });
    expect(() => validateEasReleaseConfig(config)).toThrow(/valid SPKI public key/u);
  });

  it("rejects reviewer key material reused across health and deployment trust", () => {
    const config = configuration();
    const publicKeySpkiDerBase64 = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    config.healthReviewerTrustStore.reviewers.push({
      algorithm: "Ed25519",
      keyId: "health-reviewer-2026",
      principal: "independent.health.reviewer@example.test",
      publicKeySpkiDerBase64,
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    });
    config.deploymentReviewerTrustStore.reviewers.push({
      algorithm: "Ed25519",
      keyId: "deployment-reviewer-2026",
      principal: "independent.deployment.reviewer@example.test",
      publicKeySpkiDerBase64,
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    });
    expect(() => validateEasReleaseConfig(config)).toThrow(/public key material is reused across/u);
  });

  it.each([
    [
      "production inheritance",
      (config) => {
        config.easConfig.build["physical-device"].extends = "development";
      },
      /inherit the reviewed production toolchain/u,
    ],
    [
      "internal distribution",
      (config) => {
        config.easConfig.build["physical-device"].distribution = "store";
      },
      /signed internal distribution/u,
    ],
    [
      "a standalone app",
      (config) => {
        config.easConfig.build["physical-device"].developmentClient = true;
      },
      /standalone signed app/u,
    ],
    [
      "the preview environment",
      (config) => {
        config.easConfig.build["physical-device"].environment = "production";
      },
      /isolated EAS preview environment/u,
    ],
    [
      "an installable Android APK",
      (config) => {
        config.easConfig.build["physical-device"].android.buildType = "app-bundle";
      },
      /directly installable APK/u,
    ],
    [
      "a signed Android artifact",
      (config) => {
        config.easConfig.build["physical-device"].android.withoutCredentials = true;
      },
      /Android output must retain signing credentials/u,
    ],
    [
      "an iOS device artifact",
      (config) => {
        config.easConfig.build["physical-device"].ios.simulator = true;
      },
      /signed device IPA/u,
    ],
    [
      "a signed iOS artifact",
      (config) => {
        config.easConfig.build["physical-device"].ios.withoutCredentials = true;
      },
      /iOS output must retain signing credentials/u,
    ],
  ])("requires physical-device builds to preserve %s", (_label, mutate, message) => {
    const config = configuration();
    mutate(config);
    expect(() => validateEasReleaseConfig(config)).toThrow(message);
  });

  it("rejects replacing the reviewed native-health configuration while linking EAS", () => {
    const config = configuration();
    config.appConfig.expo.extra.nativeHealth.androidReadRecordTypes.push("HeartRate");
    expect(() => validateEasReleaseConfig(config)).toThrow(/weight-only/u);
  });

  it("rejects a committed build-time API value", () => {
    const config = configuration();
    config.easConfig.build.production.env = {
      EXPO_PUBLIC_API_URL: "https://api.example.invalid",
    };
    expect(() => validateEasReleaseConfig(config)).toThrow(/EAS production environment/u);
  });

  it("rejects a committed physical-device API value", () => {
    const config = configuration();
    config.easConfig.build["physical-device"].env = {
      EXPO_PUBLIC_API_URL: "https://api.example.invalid",
    };
    expect(() => validateEasReleaseConfig(config)).toThrow(/EAS preview environment/u);
  });

  it("rejects an API origin claim before deployment confirmation", () => {
    const config = configuration();
    config.releaseDeployment.apiOrigin = "https://api.github.com";
    expect(() => validateEasReleaseConfig(config)).toThrow(/must not claim/u);
  });

  it("rejects bypassing the mandatory release checks", () => {
    const config = configuration();
    config.packageConfig.scripts["eas-build-post-install"] = "true";
    expect(() => validateEasReleaseConfig(config)).toThrow(/before compilation/u);
  });

  it.each([
    ["ci:release-state", "node scripts/check-ci-release-state.mjs", /CI release-state/u],
    [
      "config:check",
      "node scripts/check-native-config.mjs && node scripts/check-eas-config.mjs",
      /configuration checks/u,
    ],
    [
      "eas-build-post-install",
      "node scripts/check-eas-build-post-install.mjs",
      /before compilation/u,
    ],
    ["eas:check", "node scripts/check-eas-config.mjs", /Standalone EAS/u],
    [
      "release:check",
      "node scripts/check-eas-config.mjs --release && node scripts/check-release-env.mjs && node scripts/check-native-config.mjs",
      /release preflight/u,
    ],
    [
      "release:health-evidence",
      "node scripts/check-health-release.mjs",
      /four-artifact evidence verifier/u,
    ],
    [
      "release:submit",
      "node scripts/submit-reviewed-release.mjs",
      /four-artifact evidence wrapper/u,
    ],
  ])("rejects %s when it skips the contracts build", (script, replacement, message) => {
    const config = configuration();
    config.packageConfig.scripts[script] = replacement;
    expect(() => validateEasReleaseConfig(config)).toThrow(message);
  });

  it("rejects bypassing the reviewed four-artifact submission gate", () => {
    const config = configuration();
    config.packageConfig.scripts["release:submit"] = "eas submit";
    expect(() => validateEasReleaseConfig(config)).toThrow(/four-artifact evidence wrapper/u);
  });

  it.each([
    ["release:check", "true", /release preflight/u],
    ["release:health-evidence", "true", /four-artifact evidence verifier/u],
  ])(
    "rejects weakening the %s command used by the submission wrapper",
    (script, value, message) => {
      const config = configuration();
      config.packageConfig.scripts[script] = value;
      expect(() => validateEasReleaseConfig(config)).toThrow(message);
    },
  );

  it("blocks release while package-identifier history and native build numbers are unconfirmed", () => {
    expect(() =>
      validateEasReleaseConfig(configuration(), { requireConfirmedNumbering: true }),
    ).toThrow(/identifier history/u);
    try {
      validateEasReleaseConfig(configuration(), { requireConfirmedNumbering: true });
      throw new Error("Expected numbering blocker was not raised.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExpectedReleaseBlockError);
      expect(error).toMatchObject({ code: RELEASE_NUMBERING_UNCONFIRMED_CODE });
    }
  });

  it("accepts release only when explicit native versions match a confirmed record", () => {
    const config = configuration();
    config.releaseNumbering.identifierHistoryConfirmed = true;
    config.releaseNumbering.iosBuildNumber = "1";
    config.releaseNumbering.androidVersionCode = 1;
    config.appConfig.expo.ios.buildNumber = "1";
    config.appConfig.expo.android.versionCode = 1;
    expect(() =>
      validateEasReleaseConfig(config, { requireConfirmedNumbering: true }),
    ).not.toThrow();

    config.appConfig.expo.android.versionCode = 2;
    expect(() => validateEasReleaseConfig(config, { requireConfirmedNumbering: true })).toThrow(
      /must match/u,
    );
  });

  it("rejects an iOS build number outside App Store component bounds", () => {
    const config = configuration();
    config.releaseNumbering.identifierHistoryConfirmed = true;
    config.releaseNumbering.iosBuildNumber = "12345.1";
    config.releaseNumbering.androidVersionCode = 1;
    config.appConfig.expo.ios.buildNumber = "12345.1";
    config.appConfig.expo.android.versionCode = 1;
    expect(() => validateEasReleaseConfig(config, { requireConfirmedNumbering: true })).toThrow(
      /bounded explicit build number/u,
    );
  });
});
