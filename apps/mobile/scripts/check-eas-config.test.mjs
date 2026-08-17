import { describe, expect, it } from "vitest";

import appConfig from "../app.json";
import releaseDeployment from "../config/release-deployment.json";
import releaseNumbering from "../config/release-numbering.json";
import easConfig from "../eas.json";
import packageConfig from "../package.json";
import { validateEasReleaseConfig } from "./check-eas-config.mjs";

function configuration() {
  return structuredClone({
    appConfig,
    easConfig,
    packageConfig,
    releaseDeployment,
    releaseNumbering,
  });
}

describe("EAS production release configuration", () => {
  it("pins the linked project, toolchain, store artifacts, and mandatory preflight", () => {
    expect(() => validateEasReleaseConfig(configuration())).not.toThrow();
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

  it("rejects an API origin claim before OCI deployment confirmation", () => {
    const config = configuration();
    config.releaseDeployment.apiOrigin = "https://api.github.com";
    expect(() => validateEasReleaseConfig(config)).toThrow(/must not claim/u);
  });

  it("rejects bypassing the mandatory release checks", () => {
    const config = configuration();
    config.packageConfig.scripts["eas-build-post-install"] = "true";
    expect(() => validateEasReleaseConfig(config)).toThrow(/before compilation/u);
  });

  it("blocks release while package-identifier history and native build numbers are unconfirmed", () => {
    expect(() =>
      validateEasReleaseConfig(configuration(), { requireConfirmedNumbering: true }),
    ).toThrow(/identifier history/u);
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
