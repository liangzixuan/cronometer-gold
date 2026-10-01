import type { ConfigContext, ExpoConfig } from "expo/config";
import { mobileProfileKey, resolveMobileProfile } from "./src/config/mobile-profile";

export default function mobileConfig({ config }: ConfigContext): ExpoConfig {
  if (!config.name || !config.slug)
    throw new TypeError("The static mobile name and slug are required.");
  if (!config.plugins) throw new TypeError("The reviewed native plugin configuration is required.");
  const selector = process.env.EXPO_PUBLIC_NOURISHING_PROFILE;
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  const profile = resolveMobileProfile({ selector, apiUrl, platform: "ios" });
  const development = profile.name === "hosted-development";
  if (
    development &&
    (process.env.EAS_BUILD === "true" ||
      process.env.EAS_BUILD_PROFILE !== undefined ||
      process.env.EAS_ENVIRONMENT === "production" ||
      process.env.EAS_ENVIRONMENT === "preview")
  ) {
    throw new TypeError("Hosted development is not an approved native build or release profile.");
  }
  const nativeHealth = { ...config.extra?.nativeHealth };
  delete nativeHealth.deviceSigningKeyAlias;
  nativeHealth.deviceSigningKeyPolicy = "exact-api-origin-v1";
  if (apiUrl !== undefined)
    nativeHealth.deviceSigningKeyAlias = mobileProfileKey(
      profile,
      "nutrition-tracker-health-import-v1",
    );
  return {
    ...config,
    name: development ? "Nutrition Tracker Development" : config.name,
    slug: config.slug,
    ios: { ...config.ios, bundleIdentifier: profile.nativeId },
    android: { ...config.android, package: profile.nativeId },
    plugins: config.plugins.map((plugin) =>
      development && Array.isArray(plugin) && plugin[0] === "expo-notifications"
        ? [
            plugin[0],
            { ...plugin[1], defaultChannel: mobileProfileKey(profile, "private-reminders") },
          ]
        : plugin,
    ),
    extra: {
      ...config.extra,
      nativeHealth,
      mobileProfile: {
        name: profile.name,
        ...(apiUrl === undefined ? {} : { apiOrigin: profile.apiOrigin }),
      },
    },
  };
}
