import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const expoHome = fileURLToPath(new URL("../.expo/home/", import.meta.url));
mkdirSync(expoHome, { recursive: true });

const result = spawnSync("expo", ["config", "--type", "introspect", "--json"], {
  encoding: "utf8",
  env: {
    ...process.env,
    __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
    EXPO_NO_TELEMETRY: "1",
  },
  maxBuffer: 20_000_000,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(result.stderr.trim() || "Expo native configuration introspection failed.");
  process.exit(1);
}

const config = JSON.parse(result.stdout);
const failures = [];
const iosTransport = config.ios?.infoPlist?.NSAppTransportSecurity;
const iosInfo = config.ios?.infoPlist ?? {};
const iosEntitlements = config.ios?.entitlements ?? {};
const androidManifest = config._internal?.modResults?.android?.manifest?.manifest;
const androidApplicationNode = androidManifest?.application?.[0];
const androidApplication = androidApplicationNode?.$;
const mainActivity = androidApplicationNode?.activity?.find(
  (activity) => activity.$?.["android:name"] === ".MainActivity",
);
const gradleProperties = new Map(
  (config._internal?.modResults?.android?.gradleProperties ?? [])
    .filter((entry) => entry.type === "property")
    .map((entry) => [entry.key, entry.value]),
);
const mergedPermissions = androidManifest?.["uses-permission"] ?? [];
const activePermissions = mergedPermissions
  .filter((permission) => permission.$?.["tools:node"] !== "remove")
  .map((permission) => permission.$?.["android:name"])
  .sort();
const removedPermissions = mergedPermissions
  .filter((permission) => permission.$?.["tools:node"] === "remove")
  .map((permission) => permission.$?.["android:name"])
  .sort();

if (config.ios?.bundleIdentifier !== "com.nutritionledger.app") {
  failures.push("iOS bundle identifier still uses the example namespace");
}
if (config.android?.package !== "com.nutritionledger.app") {
  failures.push("Android package still uses the example namespace");
}
if (config.newArchEnabled !== true)
  failures.push("Native health modules require the new architecture");
if (iosTransport?.NSAllowsArbitraryLoads !== false) {
  failures.push("iOS must reject arbitrary insecure transport");
}
const exceptionDomains = Object.keys(iosTransport?.NSExceptionDomains ?? {});
if (exceptionDomains.length !== 0)
  failures.push("Production iOS config cannot have ATS exceptions");
if (
  config.android?.allowBackup !== false ||
  androidApplication?.["android:allowBackup"] !== "false"
) {
  failures.push("Android application backup must remain disabled");
}
if (iosEntitlements["com.apple.developer.healthkit"] !== true) {
  failures.push("Generated iOS entitlements must enable HealthKit");
}
if ("com.apple.developer.healthkit.background-delivery" in iosEntitlements) {
  failures.push("Weight-only import must not enable HealthKit background delivery");
}
if (
  "aps-environment" in iosEntitlements ||
  iosInfo.UIBackgroundModes?.includes?.("remote-notification")
) {
  failures.push("Local-only reminders must not ship remote-push capabilities");
}
if (
  iosInfo.NSHealthShareUsageDescription !==
  "Allow Nutrition Tracker to import weight after you choose to connect Apple Health."
) {
  failures.push("Generated iOS Info.plist is missing the reviewed weight-read purpose string");
}
if ("NSHealthUpdateUsageDescription" in iosInfo) {
  failures.push("Read-only HealthKit scope must not declare an update purpose string");
}
if ("NSFaceIDUsageDescription" in iosInfo) {
  failures.push("Prompt-free device signing must not declare an unused Face ID purpose string");
}
const expectedActivePermissions = [
  "android.permission.INTERNET",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.health.READ_WEIGHT",
].sort();
const expectedRemovedPermissions = [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.VIBRATE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
].sort();
if (JSON.stringify(activePermissions) !== JSON.stringify(expectedActivePermissions)) {
  failures.push(
    "Android generated manifest exceeds the reviewed INTERNET, notification, and weight-read baseline",
  );
}

const rationaleIntent = mainActivity?.["intent-filter"]?.some((filter) =>
  filter.action?.some(
    (action) => action.$?.["android:name"] === "androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE",
  ),
);
if (!rationaleIntent) failures.push("Health Connect permission rationale intent is missing");
const permissionUsageAlias = androidApplicationNode?.["activity-alias"]?.find(
  (alias) => alias.$?.["android:name"] === "ViewPermissionUsageActivity",
);
if (
  permissionUsageAlias?.$?.["android:exported"] !== "true" ||
  permissionUsageAlias?.$?.["android:permission"] !==
    "android.permission.START_VIEW_PERMISSION_USAGE"
) {
  failures.push("Android 14 Health Connect permission-usage activity alias is missing");
}
if (
  gradleProperties.get("android.minSdkVersion") !== "26" ||
  gradleProperties.get("android.compileSdkVersion") !== "36" ||
  gradleProperties.get("android.targetSdkVersion") !== "36"
) {
  failures.push("Health Connect builds require minSdk 26 and compile/target SDK 36");
}

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const exactDependencies = {
  "@kingstinct/react-native-healthkit": "14.0.2",
  "@sbaiahmed1/react-native-biometrics": "0.16.0",
  "expo-build-properties": "57.0.12",
  "expo-notifications": "57.0.12",
  "react-native-health-connect": "4.1.3",
  "react-native-nitro-modules": "0.36.5",
};
for (const [dependency, version] of Object.entries(exactDependencies)) {
  if (packageJson.dependencies?.[dependency] !== version) {
    failures.push(`${dependency} must remain exactly pinned to ${version}`);
  }
}
try {
  const providerManifest = readFileSync(
    fileURLToPath(
      new URL(
        "../node_modules/react-native-health-connect/android/src/main/AndroidManifest.xml",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  if (!providerManifest.includes('<package android:name="com.google.android.apps.healthdata"')) {
    failures.push(
      "Health Connect provider package visibility is missing from the native dependency manifest",
    );
  }
} catch {
  failures.push("Health Connect native dependency manifest is unavailable");
}
if (JSON.stringify(removedPermissions) !== JSON.stringify(expectedRemovedPermissions)) {
  failures.push("Android merged manifest has an unexpected blocked-permission removal set");
}

if (failures.length > 0) {
  console.error(
    `Unsafe native configuration:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
  process.exit(1);
}

console.log(
  "Generated native configuration matches the reviewed transport, HealthKit, Health Connect, notification, and permission baseline.",
);
