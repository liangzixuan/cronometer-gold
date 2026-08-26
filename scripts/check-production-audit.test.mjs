import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAuditPolicy } from "./audit-policy.mjs";
import { PRODUCTION_AUDIT_TIMEOUT_MS, runProductionAudit } from "./check-production-audit.mjs";

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

const emptyPolicy = { minimumSeverity: "high", reviewedExceptions: [] };

function captureAudit(options = {}) {
  const errors = [];
  const output = [];
  const exitCode = runProductionAudit({
    auditPolicy: emptyPolicy,
    writeError: (message) => errors.push(message),
    writeOutput: (message) => output.push(message),
    ...options,
  });
  return { errors, exitCode, output };
}

test("runs the bounded production-only audit and accepts a valid report", () => {
  let invocation;
  const result = captureAudit({
    environment: {
      KEEP_ME: "safe",
      NODE_EXTRA_CA_CERTS: "/reviewed/oracle-swg-ca.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NPM_CONFIG_STRICT_SSL: "false",
      "npm-config-strict-ssl": "false",
      pnpm_config_strict_ssl: "false",
    },
    spawn: (command, args, options) => {
      invocation = { args, command, options };
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({ advisories: {} }),
      };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.output, [
    "Production audit accepted 0 reviewed advisories; 0 lower-severity advisory remains visible.",
  ]);
  assert.deepEqual(invocation, {
    args: ["audit", "--prod", "--json"],
    command: "pnpm",
    options: {
      encoding: "utf8",
      env: {
        KEEP_ME: "safe",
        NODE_EXTRA_CA_CERTS: "/reviewed/oracle-swg-ca.pem",
        npm_config_strict_ssl: "true",
      },
      killSignal: "SIGKILL",
      maxBuffer: 30_000_000,
      timeout: PRODUCTION_AUDIT_TIMEOUT_MS,
    },
  });
});

test("rejects signal termination and unsupported exit statuses despite valid-looking JSON", async (t) => {
  const validReport = JSON.stringify({ advisories: {} });

  await t.test("signal termination", () => {
    const result = captureAudit({
      spawn: () => ({
        signal: "SIGKILL",
        status: null,
        stderr: "authorization=Bearer signal-secret",
        stdout: validReport,
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join("\n"), /exited unexpectedly/);
    assert.doesNotMatch(result.errors.join("\n"), /signal-secret|Bearer/);
  });

  await t.test("unsupported status", () => {
    const result = captureAudit({
      spawn: () => ({
        signal: null,
        status: 2,
        stderr: "request=https://registry.invalid/?token=status-secret",
        stdout: validReport,
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join("\n"), /exited unexpectedly/);
    assert.doesNotMatch(result.errors.join("\n"), /status-secret|https?:\/\//);
  });
});

test("fails closed on malformed JSON without printing raw registry output", () => {
  const secret = "npm_secret_value";
  const result = captureAudit({
    spawn: () => ({
      status: 1,
      stderr: `fetch failed at https://registry.example.invalid/path?token=${secret}`,
      stdout: `not-json authorization=Bearer ${secret}`,
    }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /valid JSON/);
  assert.match(result.errors.join("\n"), /Registry connectivity failed/);
  assert.doesNotMatch(result.errors.join("\n"), /npm_secret_value|https?:\/\/|Bearer/);
});

test("classifies a report transport error without leaking its raw details", () => {
  const secret = "registry-token-value";
  const result = captureAudit({
    spawn: () => ({
      status: 1,
      stderr: `request=https://registry.example.invalid/?token=${secret}`,
      stdout: JSON.stringify({
        error: {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          detail: `authorization=Bearer ${secret}`,
        },
      }),
    }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /could not obtain an advisory report/);
  assert.match(result.errors.join("\n"), /NODE_EXTRA_CA_CERTS/);
  assert.doesNotMatch(result.errors.join("\n"), /registry-token-value|https?:\/\/|Bearer/);
});

test("fails closed with bounded diagnostics on timeout and launch failure", async (t) => {
  await t.test("timeout", () => {
    const error = Object.assign(new Error("secret timeout URL https://registry.invalid"), {
      code: "ETIMEDOUT",
    });
    const result = captureAudit({ spawn: () => ({ error }) });

    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join("\n"), /timed out after 120 seconds/);
    assert.doesNotMatch(result.errors.join("\n"), /secret|https?:\/\//);
  });

  await t.test("launch failure", () => {
    const error = Object.assign(new Error("secret path /private/credential"), { code: "ENOENT" });
    const result = captureAudit({ spawn: () => ({ error }) });

    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join("\n"), /could not launch pnpm/);
    assert.doesNotMatch(result.errors.join("\n"), /secret|private\/credential/);
  });

  await t.test("thrown launch failure", () => {
    const result = captureAudit({
      spawn: () => {
        throw new Error("secret URL https://registry.invalid");
      },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.errors.join("\n"), /process failed/);
    assert.doesNotMatch(result.errors.join("\n"), /secret|https?:\/\//);
  });
});

test("reports policy violations and returns failure", () => {
  const result = captureAudit({
    spawn: () => ({
      status: 1,
      stderr: "",
      stdout: JSON.stringify({
        advisories: {
          unreviewed: {
            findings: [{ paths: ["apps__api>unsafe-package"], version: "1.0.0" }],
            github_advisory_id: "GHSA-unreviewed",
            module_name: "unsafe-package",
            severity: "high",
          },
        },
      }),
    }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /Production dependency audit failed/);
  assert.match(result.errors.join("\n"), /GHSA-unreviewed unsafe-package/);
});

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
