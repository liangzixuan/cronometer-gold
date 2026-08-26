import { describe, expect, it, vi } from "vitest";

import {
  resolveEasPostInstallPlan,
  runEasBuildPostInstall,
  validatePhysicalDeviceApiUrl,
} from "./check-eas-build-post-install.mjs";
import { EAS_PROJECT_ID } from "./eas-build-contract.mjs";

const buildId = "a1111111-1111-4111-8111-111111111111";
const gitCommit = "a".repeat(40);

function easEnvironment(overrides = {}) {
  return {
    CI: "1",
    EAS_BUILD: "true",
    EAS_BUILD_RUNNER: "eas-build",
    EAS_BUILD_ID: buildId,
    EAS_BUILD_PROJECT_ID: EAS_PROJECT_ID,
    EAS_BUILD_PLATFORM: "ios",
    EAS_BUILD_PROFILE: "production",
    EAS_BUILD_GIT_COMMIT_HASH: gitCommit,
    ...overrides,
  };
}

describe("EAS profile-aware post-install checks", () => {
  it.each(["ios", "android"])(
    "keeps ordinary %s production compilation on the pre-build release gate only",
    (platform) => {
      const runScript = vi.fn();
      expect(
        runEasBuildPostInstall(easEnvironment({ EAS_BUILD_PLATFORM: platform }), { runScript }),
      ).toEqual({
        profile: "production",
        script: "release:check",
      });
      expect(runScript).toHaveBeenCalledOnce();
      expect(runScript).toHaveBeenCalledWith("release:check");
      expect(runScript).not.toHaveBeenCalledWith("release:health-evidence");
    },
  );

  it.each(["ios", "android"])(
    "allows only the standalone %s physical-device profile to use its internal gate",
    (platform) => {
      const runScript = vi.fn();
      expect(
        runEasBuildPostInstall(
          easEnvironment({
            EAS_BUILD_PLATFORM: platform,
            EAS_BUILD_PROFILE: "physical-device",
            EXPO_PUBLIC_API_URL: "https://nutrition-api.tail1234.ts.net",
          }),
          { runScript },
        ),
      ).toEqual({
        apiOrigin: "https://nutrition-api.tail1234.ts.net",
        profile: "physical-device",
        script: "config:check",
      });
      expect(runScript).toHaveBeenCalledOnce();
      expect(runScript).toHaveBeenCalledWith("config:check");
    },
  );

  it.each([
    undefined,
    "",
    "preview",
    "development",
    "production-copy",
    "PRODUCTION",
    "production\n",
  ])("rejects an absent or unknown EAS build profile (%s)", (profile) => {
    const runScript = vi.fn();
    expect(() =>
      runEasBuildPostInstall(
        easEnvironment({
          EAS_BUILD_PROFILE: profile,
          EXPO_PUBLIC_API_URL: "https://nutrition-api.tail1234.ts.net",
        }),
        { runScript },
      ),
    ).toThrow(/EAS_BUILD_PROFILE must be exactly production or physical-device/u);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("requires the physical-device API origin explicitly", () => {
    expect(() =>
      resolveEasPostInstallPlan(easEnvironment({ EAS_BUILD_PROFILE: "physical-device" })),
    ).toThrow(/EXPO_PUBLIC_API_URL is required/u);
  });

  it.each([
    ["CI", undefined],
    ["CI", "true"],
    ["EAS_BUILD", undefined],
    ["EAS_BUILD", "1"],
    ["EAS_BUILD_RUNNER", undefined],
    ["EAS_BUILD_RUNNER", "local-build-plugin"],
    ["EAS_BUILD_RUNNER", "EAS-BUILD"],
    ["EAS_BUILD_PROJECT_ID", undefined],
    ["EAS_BUILD_PROJECT_ID", "22222222-2222-4222-8222-222222222222"],
    ["EAS_BUILD_PROJECT_ID", `${EAS_PROJECT_ID}\n`],
    ["EAS_BUILD_ID", undefined],
    ["EAS_BUILD_ID", "not-a-build-id"],
    ["EAS_BUILD_ID", buildId.toUpperCase()],
    ["EAS_BUILD_ID", `${buildId}\n`],
    ["EAS_BUILD_PLATFORM", undefined],
    ["EAS_BUILD_PLATFORM", "all"],
    ["EAS_BUILD_PLATFORM", "IOS"],
    ["EAS_BUILD_PLATFORM", "ios\n"],
    ["EAS_BUILD_GIT_COMMIT_HASH", undefined],
    ["EAS_BUILD_GIT_COMMIT_HASH", "a".repeat(39)],
    ["EAS_BUILD_GIT_COMMIT_HASH", gitCommit.toUpperCase()],
    ["EAS_BUILD_GIT_COMMIT_HASH", `${gitCommit}\n`],
  ])("rejects an invalid EAS cloud-build field %s=%s before running a script", (name, value) => {
    const runScript = vi.fn();
    expect(() => runEasBuildPostInstall(easEnvironment({ [name]: value }), { runScript })).toThrow(
      new RegExp(name, "u"),
    );
    expect(runScript).not.toHaveBeenCalled();
  });

  it.each([
    "http://nutrition-api.tail1234.ts.net",
    "https://127.0.0.1",
    "https://10.0.2.2",
    "https://nutrition-api.local",
    "https://api.github.com",
    "https://ts.net",
    "https://tail1234.ts.net",
    "https://extra.nutrition-api.tail1234.ts.net",
    "https://nutrition-api.tail1234.ts.net.example.com",
    "https://nutrition-api.tail1234.ts.net.evil.test",
    "https://nutrition-api.tail1234.ts.net:4000",
    "https://nutrition-api.tail1234.ts.net:4566",
    "https://nutrition-api.tail1234.ts.net:5432",
    "https://nutrition-api.tail1234.ts.net:7700",
    "https://localstack.tail1234.ts.net",
    "https://localstackgateway.tail1234.ts.net",
    "https://api-postgres.tail1234.ts.net",
    "https://meilisearch-api.tail1234.ts.net",
    "https://user:password@nutrition-api.tail1234.ts.net",
    "https://nutrition-api.tail1234.ts.net/v1",
    "https://nutrition-api.tail1234.ts.net/",
  ])("rejects an unsafe physical-device API origin: %s", (value) => {
    expect(() => validatePhysicalDeviceApiUrl(value)).toThrow();
  });
});
