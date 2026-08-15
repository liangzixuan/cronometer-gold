import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

import { evaluateAuditPolicy } from "./audit-policy.mjs";

const policy = JSON.parse(
  readFileSync(new URL("../config/audit-policy.json", import.meta.url), "utf8"),
);
const audit = spawnSync("pnpm", ["audit", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 30_000_000,
});
if (audit.error) throw audit.error;

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error("Production audit did not return a valid JSON report.");
  if (audit.stderr) console.error(audit.stderr.trim());
  process.exit(1);
}

if (report.error) {
  console.error("Production audit could not obtain an advisory report.");
  process.exit(1);
}

const result = evaluateAuditPolicy(policy, report);
if (result.violations.length > 0) {
  console.error("Production dependency audit failed:");
  for (const violation of result.violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Production audit accepted ${result.usedExceptions} reviewed advisories; ${result.belowThreshold} lower-severity advisory remains visible.`,
);
