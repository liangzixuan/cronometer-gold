import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { validateEasCloudBuildContext } from "./eas-build-contract.mjs";
import { validatePhysicalDeviceApiUrl } from "./physical-device-api-url.mjs";

const PHYSICAL_DEVICE_PROFILE = "physical-device";
const PRODUCTION_PROFILE = "production";

export { validatePhysicalDeviceApiUrl } from "./physical-device-api-url.mjs";

export function resolveEasPostInstallPlan(environment) {
  const { profile } = validateEasCloudBuildContext(environment);

  if (profile === PRODUCTION_PROFILE) {
    return { profile, script: "release:check" };
  }
  if (profile === PHYSICAL_DEVICE_PROFILE) {
    const apiOrigin = validatePhysicalDeviceApiUrl(environment.EXPO_PUBLIC_API_URL).origin;
    return { apiOrigin, profile, script: "physical-device:check" };
  }
  throw new TypeError(
    "Unsupported EAS_BUILD_PROFILE; only production and physical-device may compile.",
  );
}

function runPnpmScript(script, environment) {
  const result = spawnSync("pnpm", [script], {
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new TypeError(`EAS post-install command pnpm ${script} failed.`);
  }
}

export function runEasBuildPostInstall(
  environment,
  { runScript = (script) => runPnpmScript(script, environment) } = {},
) {
  const plan = resolveEasPostInstallPlan(environment);
  runScript(plan.script);
  return plan;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const plan = runEasBuildPostInstall(process.env);
    process.stdout.write(`EAS ${plan.profile} post-install checks passed.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "EAS post-install checks failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
