import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE,
  validateReleaseDeployment,
} from "./check-release-env.mjs";

const UNCONFIRMED_MESSAGE =
  "Package-identifier history and explicit native build numbers must be confirmed before release.";

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export function checkCiReleaseState(
  releaseNumbering,
  releaseDeployment,
  environment,
  runScript = (script) =>
    spawnSync("pnpm", [script], {
      encoding: "utf8",
      env: environment,
      maxBuffer: 20_000_000,
    }),
) {
  const expectedBlocker =
    releaseNumbering?.identifierHistoryConfirmed !== true
      ? UNCONFIRMED_MESSAGE
      : releaseDeployment?.ociDeploymentConfirmed !== true
        ? RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE
        : null;
  if (expectedBlocker !== null) {
    const result = runScript("release:check");
    if (result.error) throw result.error;
    const output = combinedOutput(result);
    if (result.status !== 1 || !output.includes(expectedBlocker)) {
      throw new TypeError(
        "Unconfirmed release state must fail only at its exact checked-in release gate.",
      );
    }
    return { mode: "expected-block", output: "" };
  }

  validateReleaseDeployment(environment, releaseDeployment);
  const result = runScript("build:release");
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new TypeError(`Confirmed mobile release preflight failed:\n${combinedOutput(result)}`);
  }
  return { mode: "release", output: combinedOutput(result) };
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const [{ default: releaseNumbering }, { default: releaseDeployment }] = await Promise.all([
      import("../config/release-numbering.json", { with: { type: "json" } }),
      import("../config/release-deployment.json", { with: { type: "json" } }),
    ]);
    const result = checkCiReleaseState(releaseNumbering, releaseDeployment, process.env);
    if (result.output.length > 0) process.stdout.write(`${result.output}\n`);
    process.stdout.write(
      result.mode === "release"
        ? "Confirmed mobile release preflight and export passed.\n"
        : "Unconfirmed mobile release state failed closed at the expected checked-in gate.\n",
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Mobile CI release-state check failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
