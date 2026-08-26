export const EAS_PROJECT_ID = "14022636-ab56-468c-94f6-d6106addde42";

const EAS_BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const BUILD_PROFILES = new Set(["physical-device", "production"]);
const BUILD_PLATFORMS = new Set(["android", "ios"]);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function validateEasCloudBuildContext(environment) {
  assert(environment?.CI === "1", "CI must equal 1 in the EAS cloud-build context.");
  assert(environment?.EAS_BUILD === "true", "EAS_BUILD must equal true in an EAS build.");
  assert(
    environment?.EAS_BUILD_RUNNER === "eas-build",
    "EAS_BUILD_RUNNER must identify the EAS cloud builder; local builds cannot clear release gates.",
  );
  assert(
    environment?.EAS_BUILD_PROJECT_ID === EAS_PROJECT_ID,
    "EAS_BUILD_PROJECT_ID does not match the pinned Nutrition Tracker project.",
  );
  assert(
    typeof environment?.EAS_BUILD_ID === "string" && EAS_BUILD_ID.test(environment.EAS_BUILD_ID),
    "EAS_BUILD_ID must be one canonical lowercase UUID.",
  );
  assert(
    typeof environment?.EAS_BUILD_PLATFORM === "string" &&
      BUILD_PLATFORMS.has(environment.EAS_BUILD_PLATFORM),
    "EAS_BUILD_PLATFORM must be exactly ios or android.",
  );
  assert(
    typeof environment?.EAS_BUILD_PROFILE === "string" &&
      BUILD_PROFILES.has(environment.EAS_BUILD_PROFILE),
    "EAS_BUILD_PROFILE must be exactly production or physical-device.",
  );
  assert(
    typeof environment?.EAS_BUILD_GIT_COMMIT_HASH === "string" &&
      GIT_COMMIT.test(environment.EAS_BUILD_GIT_COMMIT_HASH),
    "EAS_BUILD_GIT_COMMIT_HASH must be one full lowercase Git commit.",
  );
  return {
    buildId: environment.EAS_BUILD_ID,
    gitCommit: environment.EAS_BUILD_GIT_COMMIT_HASH,
    platform: environment.EAS_BUILD_PLATFORM,
    profile: environment.EAS_BUILD_PROFILE,
    projectId: environment.EAS_BUILD_PROJECT_ID,
  };
}
