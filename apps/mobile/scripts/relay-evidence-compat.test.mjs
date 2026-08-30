import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import {
  validateHealthReleaseEvidence,
  validateUnsignedRelayCandidateStructureForReview,
} from "./check-health-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const normalizer = join(repositoryRoot, "infra", "tailscale", "relay_evidence.py");
const iosBuildId = "11111111-1111-4111-8111-111111111111";
const androidBuildId = "22222222-2222-4222-8222-222222222222";
const physicalDeviceApiOrigin = "https://relay.example.ts.net";
const sourceCommit = "a".repeat(40);
const syntheticRelayVersionAdapter = Object.freeze({
  adapterId: "test-synthetic-windows-contract-v1",
  adapterKind: "test",
  platform: "windows-host",
  corpusSchemaVersion: "nutrition-tracker-tailscale-windows-output-corpus-v1",
  corpusSha256: "b5408c3681e21ef7533ef6e0b064437e867254d28e7d35f7bd010f66c3f432b7",
  windowsVersion: "11.0.26100",
  wslVersion: "2.5.10.0",
  ubuntuVersion: "24.04",
  dockerDesktopVersion: "4.44.3",
  dockerEngineVersion: "29.0.0",
  tailscaleClientVersion: "0.0.0-test",
  tailscaleDaemonVersion: "0.0.0-test",
  clientHelpSha256: createHash("sha256").update("client-help").digest("hex"),
  daemonHelpSha256: createHash("sha256").update("daemon-help").digest("hex"),
});

describe("Windows Tailscale relay review-package normalizer trust boundary", () => {
  it("emits v4 only through a test adapter and remains rejected without a signed manifest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nutrition-relay-compat-"));
    try {
      const indexPath = execFileSync(
        "python3",
        [
          "-B",
          "-c",
          [
            "from pathlib import Path",
            "from infra.tailscale.tests.test_relay_evidence import CaptureBundle",
            "import sys",
            "print(CaptureBundle(Path(sys.argv[1])).write())",
          ].join("; "),
          directory,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      ).trim();
      const reportBytes = execFileSync(
        "python3",
        [
          "-B",
          "-c",
          [
            "from infra.tailscale.tests.test_relay_evidence import normalize_synthetic",
            "from pathlib import Path",
            "import sys",
            "sys.stdout.buffer.write(normalize_synthetic(Path(sys.argv[1])))",
          ].join("; "),
          indexPath,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      const report = JSON.parse(reportBytes);
      expect(reportBytes).toBe(`${canonicalJson(report)}\n`);
      expect(report.schemaVersion).toBe("nutrition-tracker-physical-device-relay-report-v4");
      expect(report.versionAdapter).toMatchObject(syntheticRelayVersionAdapter);
      expect(report).not.toHaveProperty("apiOrigin");
      expect(report.apiOriginCommitmentSha256).toBe(
        "324c46636c4c63c6dd63502c753892fcc8cdbce343fd0d760fa29417397ee19e",
      );
      expect(report.trustBoundary).toBe(
        "unsigned-structural-candidate-requires-independent-ed25519-manifest-review",
      );
      expect(report.sourceCommit).toBe(sourceCommit);
      expect(report.sourceCaptureBundleSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        validateUnsignedRelayCandidateStructureForReview(
          report,
          { apiOrigin: physicalDeviceApiOrigin },
          sourceCommit,
          {
            physicalDevice: {
              ios: { easBuildId: iosBuildId },
              android: { easBuildId: androidBuildId },
            },
          },
          Date.parse(report.executedAt),
          Date.parse(report.completedAt) + 60_000,
          [syntheticRelayVersionAdapter],
        ),
      ).toEqual(report);

      let cliFailure;
      try {
        execFileSync(
          "python3",
          ["-B", normalizer, "--capture-index", indexPath, "--acknowledge-unsigned-candidate"],
          { cwd: repositoryRoot, encoding: "utf8" },
        );
      } catch (error) {
        cliFailure = error;
      }
      expect(cliFailure).toBeDefined();
      expect(cliFailure.status).toBe(1);
      expect(cliFailure.stdout).toBe("");
      expect(cliFailure.stderr).toContain(
        "The exact Windows Tailscale version/output adapter is not supported.",
      );

      const reportPath = join(directory, "unsigned-relay-candidate.json");
      writeFileSync(reportPath, reportBytes, { mode: 0o600 });
      chmodSync(reportPath, 0o600);
      await expect(
        validateHealthReleaseEvidence({
          NUTRITION_PHYSICAL_DEVICE_API_ORIGIN: physicalDeviceApiOrigin,
          NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_PATH: reportPath,
        }),
      ).rejects.toThrow(
        "Signed-device health release evidence is absent. Supply a cryptographically reviewed physical-device manifest.",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
