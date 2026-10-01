import { describe, expect, it, vi } from "vitest";
import mobileConfig from "../../app.config";
import appJson from "../../app.json";
import {
  DEVELOPMENT_MOBILE_ID,
  MOBILE_EXPO_PROJECT_ID,
  mobileProfileKey,
  resolveMobileProfile,
} from "./mobile-profile";

const dev = {
  selector: "hosted-development",
  apiUrl: "https://dev-api.nourishing.app",
  platform: "android",
} as const;
describe("mobile origin profile", () => {
  it.each([
    undefined,
    "",
    " ",
    "https://api.nourishing.app",
    "http://127.0.0.1:4000",
    "https://other.invalid",
    "https://dev-api.nourishing.app/",
    "https://dev-api.nourishing.app:443",
  ])("rejects a non-exact hosted origin %s", (apiUrl) => {
    expect(() => resolveMobileProfile({ ...dev, apiUrl })).toThrow();
  });
  it.each(["", "production", "HOSTED-DEVELOPMENT"])(
    "rejects an unknown selector %s",
    (selector) => {
      expect(() => resolveMobileProfile({ ...dev, selector })).toThrow();
    },
  );
  it.each(["selector", "apiUrl"] as const)("rejects inherited %s before binding", async (field) => {
    vi.resetModules();
    const policy = await import("./mobile-profile");
    const own = { ...dev };
    const inherited = { [field]: own[field] };
    const input = Object.assign(Object.create(inherited), own);
    delete input[field];
    expect(() => policy.bindMobileProfile(input)).toThrow(/own properties/u);
    expect(() => policy.getMobileProfile()).toThrow(/before protected/u);
  });
  it("keeps optional own undefined fields usable", () => {
    expect(
      resolveMobileProfile({ platform: "android", selector: undefined, apiUrl: undefined })
        .apiOrigin,
    ).toBe("http://10.0.2.2:4000");
  });
  it("uses disjoint safe exact-origin keys for ordinary and development profiles", () => {
    const profiles = [
      resolveMobileProfile(dev),
      ...[
        "https://api.nourishing.app",
        "https://other.invalid",
        "https://other.invalid:444",
        "http://127.0.0.1:4000",
        "http://localhost:4000",
      ].map((apiUrl) => resolveMobileProfile({ apiUrl, platform: "ios" })),
    ];
    const keys = profiles.map((profile) => mobileProfileKey(profile, "session.v1"));
    expect(new Set(keys).size).toBe(profiles.length);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(profiles[0]?.nativeId).toBe(DEVELOPMENT_MOBILE_ID);
    expect(Object.isFrozen(profiles[0])).toBe(true);
  });
  it("requires the development selector for the reserved origin", () => {
    expect(() => resolveMobileProfile({ apiUrl: dev.apiUrl, platform: "ios" })).toThrow(
      /explicit mobile profile/u,
    );
  });
  it("canonicalizes equivalent ordinary origins while preserving platform defaults", () => {
    expect(
      resolveMobileProfile({ apiUrl: "https://EXAMPLE.invalid:443/", platform: "ios" }).namespace,
    ).toBe(resolveMobileProfile({ apiUrl: "https://example.invalid", platform: "ios" }).namespace);
    expect(resolveMobileProfile({ platform: "android" }).apiOrigin).toBe("http://10.0.2.2:4000");
    expect(resolveMobileProfile({ platform: "ios" }).apiOrigin).toBe("http://127.0.0.1:4000");
  });
  it("fails before binding invalid configuration and refuses an in-process origin switch", async () => {
    vi.resetModules();
    const policy = await import("./mobile-profile");
    expect(() => policy.getMobileProfile()).toThrow(/before protected/u);
    expect(() => policy.bindMobileProfile({ ...dev, apiUrl: undefined })).toThrow();
    expect(() => policy.getMobileProfile()).toThrow();
    const bound = policy.bindMobileProfile(dev);
    expect(policy.bindMobileProfile(dev)).toBe(bound);
    expect(() =>
      policy.bindMobileProfile({ apiUrl: "https://other.invalid", platform: "ios" }),
    ).toThrow(/cannot change/u);
    expect(policy.getMobileProfile()).toBe(bound);
  });
});

function configure() {
  return mobileConfig({ config: appJson.expo } as unknown as Parameters<typeof mobileConfig>[0]);
}
describe("native profile configuration", () => {
  it("preserves default identifiers, Expo project and native security configuration", () => {
    vi.stubEnv("EXPO_PUBLIC_NOURISHING_PROFILE", undefined);
    vi.stubEnv("EXPO_PUBLIC_API_URL", undefined);
    try {
      const config = configure();
      expect(config.ios).toEqual(appJson.expo.ios);
      expect(config.android).toEqual(appJson.expo.android);
      expect(config.plugins).toEqual(appJson.expo.plugins);
      expect(config.name).toBe(appJson.expo.name);
      expect(config.extra?.eas.projectId).toBe(MOBILE_EXPO_PROJECT_ID);
      expect(config.extra?.nativeHealth.deviceSigningKeyAlias).toBeUndefined();
      expect(config.extra?.nativeHealth.deviceSigningKeyPolicy).toBe("exact-api-origin-v1");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("selects a separate development identity with exact origin-bound signing and notification aliases", () => {
    vi.stubEnv("EXPO_PUBLIC_NOURISHING_PROFILE", dev.selector);
    vi.stubEnv("EXPO_PUBLIC_API_URL", dev.apiUrl);
    try {
      const config = configure();
      expect(config.name).toBe("Nutrition Tracker Development");
      expect(config.ios?.bundleIdentifier).toBe(DEVELOPMENT_MOBILE_ID);
      expect(config.android?.package).toBe(DEVELOPMENT_MOBILE_ID);
      expect(config.extra?.eas.projectId).toBe(MOBILE_EXPO_PROJECT_ID);
      expect(config.extra?.mobileProfile).toEqual({ name: dev.selector, apiOrigin: dev.apiUrl });
      expect(config.extra?.nativeHealth.deviceSigningKeyAlias).toBe(
        mobileProfileKey(resolveMobileProfile(dev), "nutrition-tracker-health-import-v1"),
      );
      expect(config.ios?.infoPlist).toEqual(appJson.expo.ios.infoPlist);
      expect(config.android?.allowBackup).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    ["EAS_BUILD_PROFILE", "production"],
    ["EAS_BUILD_PROFILE", "physical-device"],
    ["EAS_ENVIRONMENT", "production"],
    ["EAS_ENVIRONMENT", "preview"],
    ["EAS_BUILD", "true"],
  ])("denies development native release with %s=%s before other release checks", (name, value) => {
    vi.stubEnv("EXPO_PUBLIC_NOURISHING_PROFILE", dev.selector);
    vi.stubEnv("EXPO_PUBLIC_API_URL", dev.apiUrl);
    vi.stubEnv(name, value);
    try {
      expect(configure).toThrow(/not an approved native build or release/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
