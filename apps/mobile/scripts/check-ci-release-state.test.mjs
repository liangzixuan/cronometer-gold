import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "@nutrition-tracker/contracts";

import { describe, expect, it, vi } from "vitest";

import { checkCiReleaseState } from "./check-ci-release-state.mjs";
import {
  RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
  RELEASE_DEPLOYMENT_SCHEMA,
  RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
  RELEASE_EXPECTED_BLOCK_EXIT_CODE,
  RELEASE_NUMBERING_UNCONFIRMED_CODE,
} from "./check-release-env.mjs";

const serviceGitCommit = "a".repeat(40);
const deploymentOperator = "deployment.operator@example.test";
const reviewerKeys = generateKeyPairSync("ed25519");
const reviewerPrincipal = "independent.deployment.reviewer@example.test";
const reviewerKeyId = "deployment-reviewer-2026-01";
const externalHttpsReport = Buffer.from('{"result":"passed","type":"external-https"}\n');
const reviewerAccessReport = Buffer.from('{"result":"passed","type":"reviewer-access"}\n');
const deploymentReviewerTrustStore = {
  schemaVersion: RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
  reviewers: [
    {
      keyId: reviewerKeyId,
      principal: reviewerPrincipal,
      algorithm: "Ed25519",
      publicKeySpkiDerBase64: reviewerKeys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    },
  ],
};
const serviceImages = Object.fromEntries(
  ["api", "web", "worker", "migrator", "caddy", "postgres"].map((component, index) => [
    component,
    `ghcr.io/liangzixuan/cronometer-gold-${component}@sha256:${String(index + 1).repeat(64)}`,
  ]),
);
const unconfirmedDeployment = {
  schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
  deploymentPlatform: "azure",
  deploymentConfirmed: false,
  apiOrigin: null,
  serviceGitCommit: null,
  serviceImages: null,
  deployedBy: null,
  externalHttpsEvidenceSha256: null,
  reviewerAccessEvidenceSha256: null,
  reviewedBy: null,
  reviewerAttestation: null,
  reviewedAt: null,
};
const unsignedConfirmedDeployment = {
  schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
  deploymentPlatform: "azure",
  deploymentConfirmed: true,
  apiOrigin: "https://api.nourishing.app",
  serviceGitCommit,
  serviceImages,
  deployedBy: deploymentOperator,
  externalHttpsEvidenceSha256: createHash("sha256").update(externalHttpsReport).digest("hex"),
  reviewerAccessEvidenceSha256: createHash("sha256").update(reviewerAccessReport).digest("hex"),
  reviewedBy: reviewerPrincipal,
  reviewedAt: "2026-08-25T18:00:00.000Z",
  reviewerAttestation: {
    keyId: reviewerKeyId,
    algorithm: "Ed25519",
  },
};
const confirmedDeployment = {
  ...unsignedConfirmedDeployment,
  reviewerAttestation: {
    ...unsignedConfirmedDeployment.reviewerAttestation,
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(unsignedConfirmedDeployment), "utf8"),
      reviewerKeys.privateKey,
    ).toString("base64"),
  },
};
const deploymentRuntime = {
  gitHead: () => serviceGitCommit,
  gitStatus: () => "",
  now: () => new Date("2026-08-25T18:30:00.000Z"),
  readEvidence: () => "",
  readReport: () => Buffer.alloc(0),
  statEvidence: () => ({ isFile: () => true, size: 1 }),
  statReport: () => ({ isFile: () => true, size: 1 }),
};
const deploymentEvidenceJson = JSON.stringify({
  schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
  deploymentPlatform: confirmedDeployment.deploymentPlatform,
  deploymentConfirmed: true,
  apiOrigin: confirmedDeployment.apiOrigin,
  serviceGitCommit,
  serviceImages,
  deployedBy: confirmedDeployment.deployedBy,
  externalHttpsEvidenceSha256: confirmedDeployment.externalHttpsEvidenceSha256,
  reviewerAccessEvidenceSha256: confirmedDeployment.reviewerAccessEvidenceSha256,
  reviewedBy: confirmedDeployment.reviewedBy,
  reviewedAt: confirmedDeployment.reviewedAt,
  reviewerAttestation: confirmedDeployment.reviewerAttestation,
});
const deploymentReportEnvironment = {
  NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64: externalHttpsReport.toString("base64"),
  NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64: reviewerAccessReport.toString("base64"),
};
const ciWorkflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

describe("mobile CI release-state gate", () => {
  it("maps inline deployment evidence from a non-secret CI variable and keeps paths local-only", () => {
    const releaseStateStep = ciWorkflow.match(
      /- name: Exercise the mobile release readiness state[\s\S]*?(?=\n {6}- name:)/u,
    )?.[0];

    expect(releaseStateStep).toBeDefined();
    expect(releaseStateStep).toContain(`EXPO_PUBLIC_API_URL: \${{ vars.EXPO_PUBLIC_API_URL }}`);
    expect(releaseStateStep).toContain(
      `NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: \${{ vars.NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON }}`,
    );
    expect(releaseStateStep).toContain(
      `NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64: \${{ secrets.NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64 }}`,
    );
    expect(releaseStateStep).toContain(
      `NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64: \${{ secrets.NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64 }}`,
    );
    expect(releaseStateStep).not.toContain(`vars.NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64`);
    expect(releaseStateStep).not.toContain(`vars.NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64`);
    expect(ciWorkflow).not.toContain("NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH:");
    expect(ciWorkflow).not.toContain("NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_PATH:");
    expect(ciWorkflow).not.toContain("NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_PATH:");
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
          ...deploymentReportEnvironment,
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
          ...deploymentReportEnvironment,
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
          ...deploymentReportEnvironment,
        },
        runCommand,
        deploymentRuntime,
        deploymentReviewerTrustStore,
      ),
    ).toEqual({ mode: "release", output: "release export" });
    expect(runCommand).toHaveBeenCalledWith("pnpm", ["build:release"]);
  });
});
