import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const expoHome = fileURLToPath(new URL("../.expo/home/", import.meta.url));
mkdirSync(expoHome, { recursive: true });

const result = spawnSync("expo", process.argv.slice(2), {
  env: {
    ...process.env,
    __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
    EXPO_NO_TELEMETRY: "1",
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
