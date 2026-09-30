import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fixture, NOW, REVISION } from "../../../scripts/appwrite/qualification-fixture.mjs";
import { canonicalEvidence } from "../../../scripts/deployment/managed-evidence.mjs";
import unconfirmedDeployment from "../config/release-deployment.json";
import { checkCiReleaseState } from "./check-ci-release-state.mjs";
import {
  MOBILE_RELEASE_BUNDLE_SCHEMA,
  RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
  RELEASE_EXPECTED_BLOCK_EXIT_CODE,
  RELEASE_NUMBERING_UNCONFIRMED_CODE,
} from "./check-release-env.mjs";

const f = fixture("production");
const confirmedDeployment = f.deployment;
const deploymentReviewerTrustStore = f.trust;
const deploymentRuntime = {
  gitHead: () => REVISION,
  gitStatus: () => "",
  now: () => new Date(NOW),
};
const deploymentEvidenceJson = canonicalEvidence({
  schemaVersion: MOBILE_RELEASE_BUNDLE_SCHEMA,
  qualification: f.bundle,
  activation: f.activation,
});
const ciWorkflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
describe("CI release state", () => {
  it("takes the complete signed private bundle from a secret and keeps local paths out of CI", () => {
    expect(ciWorkflow).toContain(
      `NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: \${{ secrets.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON }}`,
    );
    expect(ciWorkflow).not.toContain("vars.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON");
    expect(ciWorkflow).not.toContain("NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH:");
    expect(ciWorkflow).not.toContain("NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64:");
  });
  it("passes only after observing the exact unconfirmed-numbering blocker", () => {
    const runCommand = vi.fn(() => ({
      status: RELEASE_EXPECTED_BLOCK_EXIT_CODE,
      stdout: `${RELEASE_NUMBERING_UNCONFIRMED_CODE}\n`,
      stderr: "",
    }));
    expect(
      checkCiReleaseState(
        { identifierHistoryConfirmed: false },
        unconfirmedDeployment,
        {},
        runCommand,
      ),
    ).toEqual({ mode: "expected-block", output: "" });
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [
      "scripts/check-eas-config.mjs",
      "--release",
      "--machine-readable",
    ]);
  });

  it.each([
    [0, "", ""],
    [1, "", "dependency failure"],
    [
      RELEASE_EXPECTED_BLOCK_EXIT_CODE,
      `${RELEASE_NUMBERING_UNCONFIRMED_CODE}\n`,
      "FATAL unrelated signing failure\n",
    ],
    [
      RELEASE_EXPECTED_BLOCK_EXIT_CODE,
      `${RELEASE_NUMBERING_UNCONFIRMED_CODE}\nFATAL unrelated signing failure\n`,
      "",
    ],
    [RELEASE_EXPECTED_BLOCK_EXIT_CODE, RELEASE_NUMBERING_UNCONFIRMED_CODE, ""],
  ])(
    "rejects ambiguous or unrelated output while unconfirmed (%i, %j, %j)",
    (status, stdout, stderr) => {
      expect(() =>
        checkCiReleaseState(
          { identifierHistoryConfirmed: false },
          unconfirmedDeployment,
          {},
          () => ({ status, stdout, stderr }),
        ),
      ).toThrow(/structured checked-in release blocker/u);
    },
  );

  it("rejects the old human blocker even when a fatal error contains it", () => {
    expect(() =>
      checkCiReleaseState({ identifierHistoryConfirmed: false }, unconfirmedDeployment, {}, () => ({
        status: 1,
        stdout: "",
        stderr:
          "Package-identifier history and explicit native build numbers must be confirmed before release.\nFATAL unrelated signing failure\n",
      })),
    ).toThrow(/structured checked-in release blocker/u);
  });

  it("recognizes the exact deployment blocker after numbering is confirmed", () => {
    const runCommand = vi.fn(() => ({
      status: RELEASE_EXPECTED_BLOCK_EXIT_CODE,
      stdout: `${RELEASE_DEPLOYMENT_UNCONFIRMED_CODE}\n`,
      stderr: "",
    }));
    expect(
      checkCiReleaseState(
        { identifierHistoryConfirmed: true },
        unconfirmedDeployment,
        {},
        runCommand,
      ),
    ).toEqual({ mode: "expected-block", output: "" });
    expect(runCommand).toHaveBeenCalledWith(process.execPath, [
      "scripts/check-release-env.mjs",
      "--machine-readable",
    ]);
  });

  it("requires a real release origin before the confirmed full export", () => {
    const runCommand = vi.fn();
    expect(() =>
      checkCiReleaseState(
        { identifierHistoryConfirmed: true },
        unconfirmedDeployment,
        {
          NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: deploymentEvidenceJson,
        },
        runCommand,
        deploymentRuntime,
        deploymentReviewerTrustStore,
      ),
    ).toThrow(/required/u);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary safe HTTPS origin that differs from the deployment record", () => {
    const runCommand = vi.fn();
    expect(() =>
      checkCiReleaseState(
        { identifierHistoryConfirmed: true },
        unconfirmedDeployment,
        {
          EXPO_PUBLIC_API_URL: "https://api.github.com",
          NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: deploymentEvidenceJson,
        },
        runCommand,
        deploymentRuntime,
        deploymentReviewerTrustStore,
      ),
    ).toThrow(/exactly match/u);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("runs the full release build when numbering and the real origin are present", () => {
    const runCommand = vi.fn(() => ({ status: 0, stdout: "release export", stderr: "" }));
    expect(
      checkCiReleaseState(
        { identifierHistoryConfirmed: true },
        unconfirmedDeployment,
        {
          EXPO_PUBLIC_API_URL: confirmedDeployment.apiOrigin,
          NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: deploymentEvidenceJson,
        },
        runCommand,
        deploymentRuntime,
        deploymentReviewerTrustStore,
      ),
    ).toEqual({ mode: "release", output: "release export" });
    expect(runCommand).toHaveBeenCalledWith("pnpm", ["build:release"]);
  });
});
