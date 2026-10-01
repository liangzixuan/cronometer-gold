// Shared policy evaluation; callers own their inventory and scoped exceptions.
export function evaluateLicensePolicy(policy, notices, report) {
  const allowedGroups = new Set(policy.allowedLicenseGroups);
  const violations = [];
  let reviewedExceptionCount = 0;
  let packageCount = 0;
  const usedExceptions = new Set();

  const reviewedExceptions = policy.reviewedExceptions.map((candidate) => {
    const hasExactName = typeof candidate.packageName === "string";
    const hasPattern = typeof candidate.packagePattern === "string";
    if (hasExactName === hasPattern) {
      throw new Error("Each reviewed license exception must have one exact name or one pattern.");
    }
    if (
      !candidate.owner ||
      !candidate.reason ||
      !candidate.noticeToken ||
      !Array.isArray(candidate.versions) ||
      candidate.versions.length === 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate.expires)
    ) {
      throw new Error(
        "Each reviewed license exception requires an owner, reason, notice, versions, and ISO expiry.",
      );
    }
    if (!notices.includes(candidate.noticeToken)) {
      throw new Error(`Third-party notices omit exception token: ${candidate.noticeToken}`);
    }

    const expiresAt = Date.parse(`${candidate.expires}T23:59:59.999Z`);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      throw new Error(
        `Reviewed license exception for ${candidate.packageName ?? candidate.packagePattern} is expired.`,
      );
    }

    if (
      hasPattern &&
      !(candidate.packagePattern.startsWith("^") && candidate.packagePattern.endsWith("$"))
    ) {
      throw new Error(`License exception pattern must be anchored: ${candidate.packagePattern}`);
    }

    return {
      ...candidate,
      matcher: hasExactName
        ? (packageName) => packageName === candidate.packageName
        : (packageName) => new RegExp(candidate.packagePattern, "u").test(packageName),
    };
  });

  for (const [license, packages] of Object.entries(report)) {
    for (const packageRecord of packages) {
      packageCount += 1;
      const deniedIdentifier = policy.alwaysDeniedIdentifiers.find((identifier) =>
        license.toLowerCase().includes(identifier.toLowerCase()),
      );

      // An exception can never override an identifier in the unconditional deny list.
      if (deniedIdentifier) {
        violations.push({
          license,
          name: packageRecord.name,
          reason: `contains denied identifier ${deniedIdentifier}`,
          versions: packageRecord.versions,
        });
        continue;
      }

      if (allowedGroups.has(license)) continue;

      const exception = reviewedExceptions.find(
        (candidate) =>
          candidate.license === license &&
          candidate.matcher(packageRecord.name) &&
          packageRecord.versions.every((version) => candidate.versions.includes(version)),
      );
      if (exception) {
        reviewedExceptionCount += 1;
        usedExceptions.add(exception.noticeToken);
        continue;
      }

      violations.push({
        license,
        name: packageRecord.name,
        reason: "license is not allowed and has no current package/version exception",
        versions: packageRecord.versions,
      });
    }
  }

  for (const exception of reviewedExceptions) {
    if (!usedExceptions.has(exception.noticeToken)) {
      violations.push({
        license: exception.license,
        name: exception.packageName ?? exception.packagePattern,
        reason: "reviewed exception is unused and must be removed or re-reviewed",
        versions: exception.versions,
      });
    }
  }

  return { violations, reviewedExceptionCount, packageCount };
}
