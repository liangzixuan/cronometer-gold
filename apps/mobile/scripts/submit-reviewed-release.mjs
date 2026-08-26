import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EAS_BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BUILD_ID_ENVIRONMENT = {
  ios: "NUTRITION_IOS_PRODUCTION_BUILD_ID",
  android: "NUTRITION_ANDROID_PRODUCTION_BUILD_ID",
};

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function resolveReviewedSubmissionPlan(arguments_, environment) {
  assert(Array.isArray(arguments_), "Reviewed submission arguments must be an array.");
  let platform;
  let buildId;
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    assert(typeof value === "string", `Reviewed submission flag ${String(flag)} needs a value.`);
    if (flag === "--platform") {
      assert(platform === undefined, "Reviewed submission platform may be supplied only once.");
      platform = value;
    } else if (flag === "--id") {
      assert(buildId === undefined, "Reviewed submission build ID may be supplied only once.");
      buildId = value;
    } else {
      throw new TypeError(`Unsupported reviewed submission flag ${JSON.stringify(flag)}.`);
    }
  }
  assert(platform === "ios" || platform === "android", "Use --platform ios or --platform android.");
  assert(
    typeof buildId === "string" && EAS_BUILD_ID.test(buildId),
    "--id must be an exact lowercase EAS build ID.",
  );
  const buildIdEnvironment = BUILD_ID_ENVIRONMENT[platform];
  assert(
    environment?.[buildIdEnvironment] === buildId,
    `${buildIdEnvironment} must pin the exact production build selected for submission.`,
  );
  return {
    buildId,
    buildIdEnvironment,
    command: "eas",
    commandArguments: ["submit", "--platform", platform, "--id", buildId],
    platform,
  };
}

function runPnpmScript(script, environment) {
  const result = spawnSync("pnpm", [script], { env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new TypeError(`Reviewed submission gate pnpm ${script} failed.`);
}

function runEasSubmit(plan, environment) {
  const submitEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("NUTRITION_")),
  );
  const result = spawnSync(plan.command, plan.commandArguments, {
    env: submitEnvironment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new TypeError("Reviewed EAS submission failed.");
}

export function runReviewedSubmission(
  arguments_,
  environment,
  {
    runGate = (script) => runPnpmScript(script, environment),
    submit = (plan) => runEasSubmit(plan, environment),
  } = {},
) {
  const plan = resolveReviewedSubmissionPlan(arguments_, environment);
  runGate("release:check");
  runGate("release:health-evidence");
  submit(plan);
  return plan;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const plan = runReviewedSubmission(process.argv.slice(2), process.env);
    process.stdout.write(
      `Reviewed ${plan.platform} production build ${plan.buildId} was submitted.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Reviewed release submission failed."}\n`,
    );
    process.exitCode = 1;
  }
}
