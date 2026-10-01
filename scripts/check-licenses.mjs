import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { evaluateLicensePolicy } from "./license-policy.mjs";

const policy = JSON.parse(
  readFileSync(new URL("../config/license-policy.json", import.meta.url), "utf8"),
);
const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
const report = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 20_000_000,
  }),
);

const { violations, reviewedExceptionCount, packageCount } = evaluateLicensePolicy(
  policy,
  notices,
  report,
);

if (violations.length > 0) {
  console.error("Unapproved production dependency licenses:");
  for (const violation of violations) {
    console.error(
      `- ${violation.name}@${violation.versions.join(",")} (${violation.license}): ${violation.reason}`,
    );
  }
  console.error("Update the dependency or add a narrow, owned, expiring policy exception.");
  process.exitCode = 1;
} else {
  console.log(
    `License policy passed for ${packageCount} production packages (${reviewedExceptionCount} reviewed exceptions).`,
  );
}
