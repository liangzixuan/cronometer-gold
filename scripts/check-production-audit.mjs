import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { evaluateAuditPolicy } from "./audit-policy.mjs";

const policy = JSON.parse(
  readFileSync(new URL("../config/audit-policy.json", import.meta.url), "utf8"),
);

export const PRODUCTION_AUDIT_TIMEOUT_MS = 120_000;

const transportPatterns = [
  {
    message:
      "Registry TLS verification failed. Configure a reviewed CA with NODE_EXTRA_CA_CERTS or retry on an approved network; TLS verification remains required.",
    pattern:
      /certificate|cert[_ -]has[_ -]expired|self[_ -]signed|unable[_ -]to[_ -]verify|unable to verify|unknown ca/i,
  },
  {
    message: "Registry DNS resolution failed. Check approved network and DNS access, then retry.",
    pattern: /eai_again|enotfound|getaddrinfo|name or service not known/i,
  },
  {
    message:
      "Registry advisory access was rejected. Verify approved registry access without printing or weakening credentials.",
    pattern: /\be401\b|\be403\b|unauthorized|forbidden|authentication required/i,
  },
  {
    message:
      "Registry connectivity failed. Check approved network access and HTTPS inspection CA trust, then retry.",
    pattern: /econnrefused|econnreset|enetunreach|fetch failed|network error|socket hang up/i,
  },
];

function writeTransportDiagnostic(output, writeError) {
  const boundedOutput = typeof output === "string" ? output.slice(0, 100_000) : "";
  const match = transportPatterns.find(({ pattern }) => pattern.test(boundedOutput));
  writeError(
    match?.message ??
      "The registry response was suppressed because it was not a valid advisory report; inspect connectivity in a trusted environment.",
  );
}

function writeSpawnFailure(error, writeError) {
  if (error?.code === "ETIMEDOUT") {
    writeError(
      `Production audit timed out after ${PRODUCTION_AUDIT_TIMEOUT_MS / 1_000} seconds. Check approved network access and HTTPS inspection CA trust, then retry.`,
    );
    return;
  }
  if (error?.code === "ENOENT") {
    writeError(
      "Production audit could not launch pnpm. Install the repository-pinned package manager.",
    );
    return;
  }
  if (error?.code === "ENOBUFS") {
    writeError("Production audit output exceeded the bounded capture limit.");
    return;
  }
  writeError("Production audit process failed before returning an advisory report.");
}

function buildAuditEnvironment(environment) {
  const childEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    const compactKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (
      compactKey === "nodetlsrejectunauthorized" ||
      compactKey === "npmconfigstrictssl" ||
      compactKey === "pnpmconfigstrictssl"
    ) {
      continue;
    }
    childEnvironment[key] = value;
  }
  childEnvironment.npm_config_strict_ssl = "true";
  return childEnvironment;
}

export function runProductionAudit({
  auditPolicy = policy,
  environment = process.env,
  now = Date.now(),
  spawn = spawnSync,
  writeError = console.error,
  writeOutput = console.log,
} = {}) {
  let audit;
  try {
    audit = spawn("pnpm", ["audit", "--prod", "--json"], {
      encoding: "utf8",
      env: buildAuditEnvironment(environment),
      killSignal: "SIGKILL",
      maxBuffer: 30_000_000,
      timeout: PRODUCTION_AUDIT_TIMEOUT_MS,
    });
  } catch {
    writeError("Production audit process failed before returning an advisory report.");
    return 1;
  }

  if (audit?.error) {
    writeSpawnFailure(audit.error, writeError);
    return 1;
  }

  if (audit?.signal || (audit?.status !== 0 && audit?.status !== 1)) {
    writeError("Production audit process exited unexpectedly without a trustworthy report.");
    writeTransportDiagnostic(audit?.stderr, writeError);
    return 1;
  }

  const auditStdout = typeof audit?.stdout === "string" ? audit.stdout : "";
  const auditStderr = typeof audit?.stderr === "string" ? audit.stderr : "";

  let report;
  try {
    report = JSON.parse(auditStdout);
  } catch {
    writeError("Production audit did not return a valid JSON report.");
    writeTransportDiagnostic(`${auditStdout}\n${auditStderr}`, writeError);
    return 1;
  }

  if (report?.error) {
    writeError("Production audit could not obtain an advisory report.");
    writeTransportDiagnostic(`${JSON.stringify(report.error)}\n${auditStderr}`, writeError);
    return 1;
  }

  let result;
  try {
    result = evaluateAuditPolicy(auditPolicy, report, now);
  } catch {
    writeError("Production audit report or policy was invalid.");
    return 1;
  }

  if (result.violations.length > 0) {
    writeError("Production dependency audit failed:");
    for (const violation of result.violations) writeError(`- ${violation}`);
    return 1;
  }

  writeOutput(
    `Production audit accepted ${result.usedExceptions} reviewed advisories; ${result.belowThreshold} lower-severity advisory remains visible.`,
  );
  return 0;
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryUrl === import.meta.url) process.exitCode = runProductionAudit();
