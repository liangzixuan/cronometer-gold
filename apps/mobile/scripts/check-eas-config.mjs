import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ExpectedReleaseBlockError,
  RELEASE_EXPECTED_BLOCK_EXIT_CODE,
  RELEASE_NUMBERING_UNCONFIRMED_CODE,
  validateReleaseDeploymentPolicy,
} from "./check-release-env.mjs";

const EAS_PROJECT_ID = "14022636-ab56-468c-94f6-d6106addde42";
const RELEASE_NUMBERING_SCHEMA = "nutrition-tracker-release-numbering-v1";
const IOS_BUILD_NUMBER = /^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/u;
const CONTRACTS_BUILD = "pnpm --filter @nutrition-tracker/contracts build";

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function validateEasReleaseConfig(
  { appConfig, easConfig, packageConfig, releaseDeployment, releaseNumbering },
  { requireConfirmedNumbering = false } = {},
) {
  const expo = appConfig?.expo;
  const physicalDevice = easConfig?.build?.["physical-device"];
  const production = easConfig?.build?.production;

  assert(expo?.owner === "zixuanliang", "Expo owner must remain pinned to zixuanliang.");
  assert(
    expo?.extra?.eas?.projectId === EAS_PROJECT_ID,
    `Expo project ID must remain pinned to ${EAS_PROJECT_ID}.`,
  );
  assert(
    JSON.stringify(expo?.extra?.nativeHealth?.androidReadRecordTypes) ===
      JSON.stringify(["Weight"]),
    "Linking EAS must preserve the reviewed weight-only native-health configuration.",
  );
  assert(easConfig?.cli?.version === "22.0.0", "EAS CLI must remain exactly pinned to 22.0.0.");
  assert(
    easConfig?.cli?.appVersionSource === "local",
    "EAS app versions must remain source-controlled locally.",
  );
  assert(
    easConfig?.cli?.requireCommit === true,
    "Every EAS build must require a committed Git tree.",
  );
  assert(
    easConfig?.cli?.promptToConfigurePushNotifications === false,
    "Local-only reminders must not trigger push-credential configuration.",
  );
  assert(production?.distribution === "store", "Production must use store distribution.");
  assert(
    production?.credentialsSource === "remote",
    "Production signing credentials must be selected from the EAS credential store.",
  );
  assert(
    production?.environment === "production",
    "Production builds must load the EAS production environment.",
  );
  assert(
    !Object.hasOwn(production ?? {}, "env"),
    "Do not commit a release API origin in eas.json; use the EAS production environment.",
  );
  assert(production?.node === "22.13.0", "EAS Node must remain exactly pinned to 22.13.0.");
  assert(production?.corepack === true, "EAS must enable Corepack before dependency installation.");
  assert(production?.pnpm === "11.19.0", "EAS pnpm must remain exactly pinned to 11.19.0.");
  assert(
    production?.autoIncrement === false,
    "EAS must not mutate locally controlled app versions.",
  );
  assert(
    production?.android?.buildType === "app-bundle",
    "Production Android output must be an AAB.",
  );
  assert(production?.ios?.simulator === false, "Production iOS output must be a device IPA.");
  assert(
    physicalDevice?.extends === "production",
    "The physical-device profile must inherit the reviewed production toolchain.",
  );
  assert(
    physicalDevice?.distribution === "internal",
    "The physical-device profile must use signed internal distribution.",
  );
  assert(
    physicalDevice?.developmentClient === false,
    "The physical-device profile must remain a standalone signed app, not a development client.",
  );
  assert(
    physicalDevice?.environment === "preview",
    "The physical-device profile must load the isolated EAS preview environment.",
  );
  assert(
    !Object.hasOwn(physicalDevice ?? {}, "env"),
    "Do not commit a physical-device API origin in eas.json; use the EAS preview environment.",
  );
  assert(
    (physicalDevice?.credentialsSource ?? production?.credentialsSource) === "remote",
    "Physical-device signing credentials must come from the EAS credential store.",
  );
  assert(
    (physicalDevice?.node ?? production?.node) === "22.13.0" &&
      (physicalDevice?.corepack ?? production?.corepack) === true &&
      (physicalDevice?.pnpm ?? production?.pnpm) === "11.19.0",
    "The physical-device profile must preserve the pinned production Node, Corepack, and pnpm toolchain.",
  );
  assert(
    (physicalDevice?.autoIncrement ?? production?.autoIncrement) === false,
    "The physical-device profile must not mutate locally controlled app versions.",
  );
  assert(
    physicalDevice?.android?.buildType === "apk",
    "Physical-device Android output must be a directly installable APK.",
  );
  assert(
    physicalDevice?.android?.withoutCredentials !== true,
    "Physical-device Android output must retain signing credentials.",
  );
  assert(
    physicalDevice?.ios?.simulator === false,
    "Physical-device iOS output must be a signed device IPA.",
  );
  assert(
    physicalDevice?.ios?.withoutCredentials !== true,
    "Physical-device iOS output must retain signing credentials.",
  );
  assert(
    packageConfig?.scripts?.["eas-build-post-install"] ===
      `${CONTRACTS_BUILD} && node scripts/check-eas-build-post-install.mjs`,
    "EAS must run the fail-closed profile-aware checks before compilation.",
  );
  assert(
    packageConfig?.scripts?.["ci:release-state"] ===
      `${CONTRACTS_BUILD} && node scripts/check-ci-release-state.mjs`,
    "CI release-state checks must build their workspace contract dependency first.",
  );
  assert(
    packageConfig?.scripts?.["config:check"] ===
      `${CONTRACTS_BUILD} && node scripts/check-native-config.mjs && node scripts/check-eas-config.mjs`,
    "Mobile configuration checks must build their workspace contract dependency first.",
  );
  assert(
    packageConfig?.scripts?.["eas:check"] ===
      `${CONTRACTS_BUILD} && node scripts/check-eas-config.mjs`,
    "Standalone EAS checks must build their workspace contract dependency first.",
  );
  assert(
    packageConfig?.scripts?.["release:check"] ===
      `${CONTRACTS_BUILD} && node scripts/check-eas-config.mjs --release && node scripts/check-release-env.mjs && node scripts/check-native-config.mjs`,
    "The reviewed release preflight must not be replaced or weakened.",
  );
  assert(
    packageConfig?.scripts?.["release:health-evidence"] ===
      `${CONTRACTS_BUILD} && node scripts/check-health-release.mjs`,
    "The reviewer-signed four-artifact evidence verifier must not be replaced or weakened.",
  );
  assert(
    packageConfig?.scripts?.["release:submit"] ===
      `${CONTRACTS_BUILD} && node scripts/submit-reviewed-release.mjs`,
    "Production submission must remain behind the reviewed four-artifact evidence wrapper.",
  );
  validateReleaseDeploymentPolicy(releaseDeployment);

  assert(
    releaseNumbering?.schemaVersion === RELEASE_NUMBERING_SCHEMA,
    `Release numbering must use ${RELEASE_NUMBERING_SCHEMA}.`,
  );
  assert(
    typeof releaseNumbering?.identifierHistoryConfirmed === "boolean",
    "Release numbering must explicitly record whether package-identifier history is confirmed.",
  );
  if (releaseNumbering.identifierHistoryConfirmed) {
    assert(
      typeof releaseNumbering.iosBuildNumber === "string" &&
        IOS_BUILD_NUMBER.test(releaseNumbering.iosBuildNumber),
      "Confirmed iOS release numbering requires a bounded explicit build number.",
    );
    assert(
      Number.isInteger(releaseNumbering.androidVersionCode) &&
        releaseNumbering.androidVersionCode >= 1 &&
        releaseNumbering.androidVersionCode <= 2_100_000_000,
      "Confirmed Android release numbering requires an explicit valid version code.",
    );
    assert(
      expo?.ios?.buildNumber === releaseNumbering.iosBuildNumber,
      "The iOS build number must match the confirmed release-numbering record.",
    );
    assert(
      expo?.android?.versionCode === releaseNumbering.androidVersionCode,
      "The Android version code must match the confirmed release-numbering record.",
    );
  } else {
    assert(
      releaseNumbering.iosBuildNumber === null && releaseNumbering.androidVersionCode === null,
      "Unconfirmed identifier history must not guess native build numbers.",
    );
    assert(
      expo?.ios?.buildNumber === undefined && expo?.android?.versionCode === undefined,
      "Native build numbers must remain absent until identifier history is confirmed.",
    );
  }
  if (requireConfirmedNumbering) {
    if (!releaseNumbering.identifierHistoryConfirmed) {
      throw new ExpectedReleaseBlockError(
        RELEASE_NUMBERING_UNCONFIRMED_CODE,
        "Package-identifier history and explicit native build numbers must be confirmed before release.",
      );
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const arguments_ = process.argv.slice(2);
  const machineReadable = arguments_.includes("--machine-readable");
  try {
    const [
      { default: appConfig },
      { default: easConfig },
      { default: packageConfig },
      { default: releaseDeployment },
      { default: releaseNumbering },
    ] = await Promise.all([
      import("../app.json", { with: { type: "json" } }),
      import("../eas.json", { with: { type: "json" } }),
      import("../package.json", { with: { type: "json" } }),
      import("../config/release-deployment.json", { with: { type: "json" } }),
      import("../config/release-numbering.json", { with: { type: "json" } }),
    ]);
    validateEasReleaseConfig(
      { appConfig, easConfig, packageConfig, releaseDeployment, releaseNumbering },
      { requireConfirmedNumbering: arguments_.includes("--release") },
    );
    process.stdout.write("EAS release configuration is valid.\n");
  } catch (error) {
    if (machineReadable && error instanceof ExpectedReleaseBlockError) {
      process.stdout.write(`${error.code}\n`);
      process.exitCode = RELEASE_EXPECTED_BLOCK_EXIT_CODE;
    } else {
      const message = error instanceof Error ? error.message : "EAS release configuration failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
