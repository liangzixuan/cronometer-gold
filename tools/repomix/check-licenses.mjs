import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateLicensePolicy } from "../../scripts/license-policy.mjs";

const applicationPolicy = JSON.parse(
  readFileSync(new URL("../../config/license-policy.json", import.meta.url), "utf8"),
);
const toolPolicy = JSON.parse(
  readFileSync(new URL("./license-policy.json", import.meta.url), "utf8"),
);
const notices = readFileSync(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");

export function evaluateToolLicenses(report, scopedPolicy = toolPolicy) {
  return evaluateLicensePolicy(
    {
      allowedLicenseGroups: applicationPolicy.allowedLicenseGroups,
      alwaysDeniedIdentifiers: applicationPolicy.alwaysDeniedIdentifiers,
      reviewedExceptions: scopedPolicy.reviewedExceptions,
    },
    notices,
    report,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(
    execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      maxBuffer: 20000000,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const result = evaluateToolLicenses(report);
  if (result.violations.length) {
    console.error("Isolated tooling license policy failed.");
    process.exitCode = 1;
  } else
    console.log(
      `Tool license policy passed: ${result.packageCount} packages, ${result.reviewedExceptionCount} scoped exceptions.`,
    );
}
