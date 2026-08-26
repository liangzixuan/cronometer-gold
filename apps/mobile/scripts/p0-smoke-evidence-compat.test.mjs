import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import {
  P0_CLIENT_SMOKE_FLOW_IDS,
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
      expect(report.trustBoundary).toBe(
        "unsigned-structural-candidate-requires-independent-ed25519-health-manifest-review",
      );
      expect(report.dataClassification).toBe("synthetic-only");
      expect(report.sourceCaptureBundleSha256).toMatch(/^[0-9a-f]{64}$/u);
      for (const role of ["browser", "ios", "android"]) {
        expect(report.clients[role].results.map(({ flowId }) => flowId)).toEqual(
          P0_CLIENT_SMOKE_FLOW_IDS,
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
          Date.parse("2026-08-26T00:57:00.000Z"),
          Date.parse("2026-08-26T01:00:00.000Z"),
        ),
      ).toEqual(report);

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
