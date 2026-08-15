const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export function evaluateAuditPolicy(policy, report, now = Date.now()) {
  const minimumRank = severityRank[policy.minimumSeverity];
  if (minimumRank === undefined) throw new Error("Audit policy has an invalid minimum severity.");
  if (!report?.advisories || typeof report.advisories !== "object") {
    throw new Error("Production audit did not provide advisories.");
  }

  const reviewedExceptions = new Map();
  for (const exception of policy.reviewedExceptions) {
    if (
      !exception.advisoryId ||
      exception.expectedSeverity !== "high" ||
      !exception.moduleName ||
      !exception.owner ||
      !exception.reason ||
      !exception.requiredPathPrefix ||
      !exception.requiredPathSuffix ||
      !Array.isArray(exception.versions) ||
      exception.versions.length === 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)
    ) {
      throw new Error(
        "Every audit exception requires a high severity, advisory, package, owner, reason, nonempty path constraints, versions, and ISO expiry.",
      );
    }
    if (reviewedExceptions.has(exception.advisoryId)) {
      throw new Error(`Duplicate audit exception: ${exception.advisoryId}`);
    }
    const expiresAt = Date.parse(`${exception.expires}T23:59:59.999Z`);
    if (!Number.isFinite(expiresAt) || expiresAt < now) {
      throw new Error(`Audit exception ${exception.advisoryId} expired on ${exception.expires}.`);
    }
    reviewedExceptions.set(exception.advisoryId, exception);
  }

  const violations = [];
  const usedExceptions = new Set();
  const advisories = Object.values(report.advisories);

  for (const advisory of advisories) {
    const rank = severityRank[advisory.severity] ?? Number.POSITIVE_INFINITY;
    if (rank < minimumRank) continue;

    if (rank >= severityRank.critical) {
      violations.push(
        `${advisory.github_advisory_id} ${advisory.module_name}: critical advisories cannot be excepted`,
      );
      continue;
    }

    const exception = reviewedExceptions.get(advisory.github_advisory_id);
    if (!exception) {
      violations.push(
        `${advisory.github_advisory_id} ${advisory.module_name}: no reviewed exception`,
      );
      continue;
    }

    const hasFindings = Array.isArray(advisory.findings) && advisory.findings.length > 0;
    const findingMatches =
      hasFindings &&
      advisory.findings.every(
        (finding) =>
          exception.versions.includes(finding.version) &&
          Array.isArray(finding.paths) &&
          finding.paths.length > 0 &&
          finding.paths.every(
            (path) =>
              path.startsWith(exception.requiredPathPrefix) &&
              path.endsWith(exception.requiredPathSuffix),
          ),
      );
    if (
      advisory.severity !== exception.expectedSeverity ||
      advisory.module_name !== exception.moduleName ||
      !findingMatches
    ) {
      violations.push(
        `${advisory.github_advisory_id} changed severity, package, version, findings, or dependency path; review again`,
      );
      continue;
    }

    usedExceptions.add(advisory.github_advisory_id);
  }

  for (const advisoryId of reviewedExceptions.keys()) {
    if (!usedExceptions.has(advisoryId)) {
      violations.push(`${advisoryId}: exception is unused and must be removed or re-reviewed`);
    }
  }

  const belowThreshold = advisories.filter(
    (advisory) => (severityRank[advisory.severity] ?? Number.POSITIVE_INFINITY) < minimumRank,
  ).length;
  return { belowThreshold, usedExceptions: usedExceptions.size, violations };
}
