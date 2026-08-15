import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAuditPolicy } from "./audit-policy.mjs";

const now = Date.parse("2026-08-15T12:00:00Z");
const policy = {
  minimumSeverity: "high",
  reviewedExceptions: [
    {
      advisoryId: "GHSA-reviewed",
      expectedSeverity: "high",
      moduleName: "image-size",
      versions: ["1.2.1"],
      requiredPathPrefix: "apps__mobile>",
      requiredPathSuffix: ">metro>image-size",
      owner: "engineering",
      expires: "2026-09-15",
      reason: "Fixture",
    },
  ],
};

function report(overrides = {}) {
  return {
    advisories: {
      reviewed: {
        findings: [
          {
            paths: ["apps__mobile>expo>metro>image-size"],
            version: "1.2.1",
          },
        ],
        github_advisory_id: "GHSA-reviewed",
        module_name: "image-size",
        severity: "high",
        ...overrides,
      },
    },
  };
}

test("accepts only the exact reviewed advisory shape", () => {
  assert.deepEqual(evaluateAuditPolicy(policy, report(), now), {
    belowThreshold: 0,
    usedExceptions: 1,
    violations: [],
  });
});

test("never permits a critical severity escalation", () => {
  const result = evaluateAuditPolicy(policy, report({ severity: "critical" }), now);
  assert.ok(result.violations.some((violation) => violation.includes("cannot be excepted")));
});

test("rejects empty findings and dependency paths", () => {
  const noFindings = evaluateAuditPolicy(policy, report({ findings: [] }), now);
  assert.ok(noFindings.violations.some((violation) => violation.includes("findings")));

  const noPaths = evaluateAuditPolicy(
    policy,
    report({ findings: [{ paths: [], version: "1.2.1" }] }),
    now,
  );
  assert.ok(noPaths.violations.some((violation) => violation.includes("dependency path")));
});

test("fails expired and unused exceptions", () => {
  assert.throws(
    () => evaluateAuditPolicy(policy, report(), Date.parse("2026-09-16T00:00:00Z")),
    /expired/,
  );
  const unused = evaluateAuditPolicy(policy, { advisories: {} }, now);
  assert.ok(unused.violations.some((violation) => violation.includes("unused")));
});
