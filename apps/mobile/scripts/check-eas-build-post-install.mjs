import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { validateReleaseApiUrl } from "./check-release-env.mjs";

const PHYSICAL_DEVICE_PROFILE = "physical-device";
const PRODUCTION_PROFILE = "production";
const FORBIDDEN_BACKEND_HOST_TOKENS = new Set([
  "localstack",
  "meilisearch",
  "postgres",
  "postgresql",
]);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function validatePhysicalDeviceApiUrl(value) {
  const url = validateReleaseApiUrl(value);
  const configured = value.trim();

  assert(
    url.port === "",
    "Physical-device EXPO_PUBLIC_API_URL must use the default HTTPS port; never expose an API or backend service port.",
  );
  assert(
    configured === url.origin,
    "Physical-device EXPO_PUBLIC_API_URL must be an exact canonical HTTPS origin.",
  );

  const hostname = url.hostname.toLowerCase();
  assert(
    ![...FORBIDDEN_BACKEND_HOST_TOKENS].some((token) => hostname.includes(token)),
    "Physical-device EXPO_PUBLIC_API_URL must identify the authenticated API, never LocalStack, Postgres, or Meilisearch.",
  );
  return url;
}

export function resolveEasPostInstallPlan(environment) {
  const profile = environment?.EAS_BUILD_PROFILE;
  assert(
    typeof profile === "string" && profile.length > 0,
    "EAS_BUILD_PROFILE is required for every EAS post-install check.",
  );

  if (profile === PRODUCTION_PROFILE) {
    return { profile, script: "release:check" };
  }
  if (profile === PHYSICAL_DEVICE_PROFILE) {
    const apiOrigin = validatePhysicalDeviceApiUrl(environment.EXPO_PUBLIC_API_URL).origin;
    return { apiOrigin, profile, script: "config:check" };
  }
  throw new TypeError(
    `Unsupported EAS_BUILD_PROFILE ${JSON.stringify(profile)}; only production and physical-device may compile.`,
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
