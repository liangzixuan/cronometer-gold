import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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
const androidManifest = config._internal?.modResults?.android?.manifest?.manifest;
const androidApplication = androidManifest?.application?.[0]?.$;
const mergedPermissions = androidManifest?.["uses-permission"] ?? [];
const activePermissions = mergedPermissions
  .filter((permission) => permission.$?.["tools:node"] !== "remove")
  .map((permission) => permission.$?.["android:name"])
  .sort();
const removedPermissions = mergedPermissions
  .filter((permission) => permission.$?.["tools:node"] === "remove")
  .map((permission) => permission.$?.["android:name"])
  .sort();

if (config.ios?.bundleIdentifier === "com.example.nutritiontracker") {
  failures.push("iOS bundle identifier still uses the example namespace");
}
if (config.android?.package === "com.example.nutritiontracker") {
  failures.push("Android package still uses the example namespace");
}
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
const expectedActivePermissions = ["android.permission.INTERNET"];
const expectedRemovedPermissions = [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.VIBRATE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
].sort();
if (JSON.stringify(activePermissions) !== JSON.stringify(expectedActivePermissions)) {
  failures.push("Android merged manifest exceeds the reviewed INTERNET-only active baseline");
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
  "Native configuration matches the reviewed transport, backup, and permission baseline.",
);
