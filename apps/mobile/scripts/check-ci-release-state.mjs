import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  hasExternalReleaseDeploymentEvidence,
  RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
  RELEASE_EXPECTED_BLOCK_EXIT_CODE,
  RELEASE_NUMBERING_UNCONFIRMED_CODE,
  validateReleaseDeployment,
} from "./check-release-env.mjs";

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export function checkCiReleaseState(
  releaseNumbering,
  releaseDeployment,
  environment,
  runCommand = (command, arguments_) =>
    spawnSync(command, arguments_, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 20_000_000,
    }),
  deploymentRuntime,
  deploymentReviewerTrustStore,
) {
  const expectedBlocker =
    releaseNumbering?.identifierHistoryConfirmed !== true
      ? {
          arguments: ["scripts/check-eas-config.mjs", "--release", "--machine-readable"],
          code: RELEASE_NUMBERING_UNCONFIRMED_CODE,
        }
      : !hasExternalReleaseDeploymentEvidence(environment)
        ? {
            arguments: ["scripts/check-release-env.mjs", "--machine-readable"],
            code: RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
          }
        : null;
  if (expectedBlocker !== null) {
    const result = runCommand(process.execPath, expectedBlocker.arguments);
    if (result.error) throw result.error;
    if (
      result.status !== RELEASE_EXPECTED_BLOCK_EXIT_CODE ||
      result.stdout !== `${expectedBlocker.code}\n` ||
      result.stderr !== ""
    ) {
      throw new TypeError(
        "Unconfirmed release state must emit only its exact structured checked-in release blocker.",
      );
    }
    return { mode: "expected-block", output: "" };
  }

  validateReleaseDeployment(
    environment,
    releaseDeployment,
    deploymentRuntime,
    deploymentReviewerTrustStore,
  );
  const result = runCommand("pnpm", ["build:release"]);
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
