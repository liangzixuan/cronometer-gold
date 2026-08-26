import { describe, expect, it, vi } from "vitest";

import {
  resolveEasPostInstallPlan,
  runEasBuildPostInstall,
  validatePhysicalDeviceApiUrl,
} from "./check-eas-build-post-install.mjs";

describe("EAS profile-aware post-install checks", () => {
  it("keeps ordinary production compilation on the pre-build release gate only", () => {
    const runScript = vi.fn();
    expect(runEasBuildPostInstall({ EAS_BUILD_PROFILE: "production" }, { runScript })).toEqual({
      profile: "production",
      script: "release:check",
    });
    expect(runScript).toHaveBeenCalledOnce();
    expect(runScript).toHaveBeenCalledWith("release:check");
    expect(runScript).not.toHaveBeenCalledWith("release:health-evidence");
  });

  it("allows only the standalone physical-device profile to use its internal gate", () => {
    const runScript = vi.fn();
    expect(
      runEasBuildPostInstall(
        {
          EAS_BUILD_PROFILE: "physical-device",
          EXPO_PUBLIC_API_URL: "https://nutrition-api.tail1234.ts.net",
        },
        { runScript },
      ),
    ).toEqual({
      apiOrigin: "https://nutrition-api.tail1234.ts.net",
      profile: "physical-device",
      script: "config:check",
    });
    expect(runScript).toHaveBeenCalledOnce();
    expect(runScript).toHaveBeenCalledWith("config:check");
  });

  it.each([undefined, "", "preview", "development", "production-copy"])(
    "rejects an absent or unknown EAS build profile (%s)",
    (profile) => {
      const runScript = vi.fn();
      expect(() =>
        runEasBuildPostInstall(
          {
            EAS_BUILD_PROFILE: profile,
            EXPO_PUBLIC_API_URL: "https://nutrition-api.tail1234.ts.net",
          },
          { runScript },
        ),
      ).toThrow(/EAS_BUILD_PROFILE is required|only production and physical-device/u);
      expect(runScript).not.toHaveBeenCalled();
    },
  );

  it("requires the physical-device API origin explicitly", () => {
    expect(() => resolveEasPostInstallPlan({ EAS_BUILD_PROFILE: "physical-device" })).toThrow(
      /EXPO_PUBLIC_API_URL is required/u,
    );
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
