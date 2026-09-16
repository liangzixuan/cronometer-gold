import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import {
  P0_CLIENT_SMOKE_FLOW_IDS_BY_CLIENT,
  P0_CLIENT_SMOKE_REPORT_SCHEMA,
  validateHealthReleaseEvidence,
  validateUnsignedP0ClientSmokeCandidateStructureForReview,
} from "./check-health-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const normalizer = join(repositoryRoot, "infra", "smoke", "p0_client_smoke.py");
const iosBuildId = "11111111-1111-4111-8111-111111111111";
const androidBuildId = "22222222-2222-4222-8222-222222222222";

describe("P0 client-smoke review-package normalizer trust boundary", () => {
  it("emits a structurally compatible unsigned candidate that remains untrusted alone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nutrition-p0-smoke-compat-"));
    try {
      const indexPath = execFileSync(
        "python3",
        [
          "-B",
          "-c",
          [
            "import sys",
            "from pathlib import Path",
            "from infra.smoke.tests.test_p0_client_smoke import CaptureBundle",
            "print(CaptureBundle(Path(sys.argv[1])).write())",
          ].join("; "),
          directory,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      ).trim();
      const reportBytes = execFileSync(
        "python3",
        ["-B", normalizer, "--capture-index", indexPath, "--acknowledge-unsigned-candidate"],
        { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const report = JSON.parse(reportBytes);
      expect(reportBytes).toBe(`${canonicalJson(report)}\n`);
      expect(report.schemaVersion).toBe(P0_CLIENT_SMOKE_REPORT_SCHEMA);
      expect(report.schemaVersion).toBe("nutrition-tracker-p0-client-smoke-report-v3");
      expect(Object.keys(P0_CLIENT_SMOKE_FLOW_IDS_BY_CLIENT)).toEqual([
        "browser",
        "ios",
        "android",
      ]);
      expect(Object.isFrozen(P0_CLIENT_SMOKE_FLOW_IDS_BY_CLIENT)).toBe(true);
      const historicalIds = [
        "unauthenticated-entry",
        "register",
        "sign-in",
        "session-restore",
        "unauthorized-session-rejection",
        "food-search",
        "diary-add-edit-delete",
        "diary-repeat",
        "diary-pagination",
        "recipe-create-revise-log",
        "goal-create-revise-progress",
        "retention-trends",
        "custom-food-create-revise-log",
        "biometric-create-edit-delete",
        "reminder-create-pause-revoke",
        "account-export-download",
        "sign-out-private-cleanup",
        "account-erasure",
        "erasure-status-after-session-revocation",
      ];
      for (const role of ["browser", "ios", "android"]) {
        const ids = P0_CLIENT_SMOKE_FLOW_IDS_BY_CLIENT[role];
        expect(Object.isFrozen(ids)).toBe(true);
        expect(ids).toHaveLength(role === "browser" ? 21 : 22);
        expect(ids.filter((flowId) => historicalIds.includes(flowId))).toEqual(historicalIds);
        expect(ids[ids.indexOf("diary-pagination") + 1]).toBe("diary-group-configuration");
        expect(ids[ids.indexOf("custom-food-create-revise-log") + 1]).toBe("diary-day-note");
        if (role === "browser") expect(ids).not.toContain("camera-barcode-capture");
        else expect(ids[ids.indexOf("food-search") + 1]).toBe("camera-barcode-capture");
      }
      expect(report.trustBoundary).toBe(
        "unsigned-structural-candidate-requires-independent-ed25519-health-manifest-review",
      );
      expect(report.dataClassification).toBe("synthetic-only");
      expect(report.sourceCaptureBundleSha256).toMatch(/^[0-9a-f]{64}$/u);
      for (const role of ["browser", "ios", "android"]) {
        expect(report.clients[role].results.map(({ flowId }) => flowId)).toEqual(
          P0_CLIENT_SMOKE_FLOW_IDS_BY_CLIENT[role],
        );
      }
      expect(
        validateUnsignedP0ClientSmokeCandidateStructureForReview(
          report,
          { apiOrigin: report.apiOrigin },
          report.gitCommit,
          {
            physicalDevice: {
              ios: { easBuildId: iosBuildId },
              android: { easBuildId: androidBuildId },
            },
          },
          Date.parse(report.executedAt),
          Date.parse("2026-08-26T01:10:00.000Z"),
        ),
      ).toEqual(report);

      for (const version of [1, 2]) {
        expect(() =>
          validateUnsignedP0ClientSmokeCandidateStructureForReview(
            { ...report, schemaVersion: `nutrition-tracker-p0-client-smoke-report-v${version}` },
            { apiOrigin: report.apiOrigin },
            report.gitCommit,
            {
              physicalDevice: {
                ios: { easBuildId: iosBuildId },
                android: { easBuildId: androidBuildId },
              },
            },
            Date.parse(report.executedAt),
            Date.parse("2026-08-26T01:10:00.000Z"),
          ),
        ).toThrow(/p0-client-smoke-report-v3/u);
      }

      await expect(
        validateHealthReleaseEvidence({
          NUTRITION_P0_CLIENT_SMOKE_REPORT_BASE64: Buffer.from(reportBytes).toString("base64"),
        }),
      ).rejects.toThrow(
        "Signed-device health release evidence is absent. Supply a cryptographically reviewed physical-device manifest.",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
