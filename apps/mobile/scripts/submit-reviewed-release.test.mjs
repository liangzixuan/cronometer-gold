import { describe, expect, it, vi } from "vitest";

import {
  resolveReviewedSubmissionPlan,
  runReviewedSubmission,
} from "./submit-reviewed-release.mjs";

const iosBuildId = "33333333-3333-4333-8333-333333333333";
const androidBuildId = "44444444-4444-4444-8444-444444444444";
const environment = {
  NUTRITION_IOS_PRODUCTION_BUILD_ID: iosBuildId,
  NUTRITION_ANDROID_PRODUCTION_BUILD_ID: androidBuildId,
};

describe("reviewed EAS submission", () => {
  it.each([
    ["ios", iosBuildId, "NUTRITION_IOS_PRODUCTION_BUILD_ID"],
    ["android", androidBuildId, "NUTRITION_ANDROID_PRODUCTION_BUILD_ID"],
  ])("pins the exact reviewed %s production build", (platform, buildId, buildIdEnvironment) => {
    expect(
      resolveReviewedSubmissionPlan(["--platform", platform, "--id", buildId], environment),
    ).toEqual({
      buildId,
      buildIdEnvironment,
      command: "eas",
      commandArguments: ["submit", "--platform", platform, "--id", buildId],
      platform,
    });
  });

  it.each([
    [[], /--platform/u],
    [["--platform", "web", "--id", iosBuildId], /--platform ios or --platform android/u],
    [["--platform", "ios", "--id", "latest"], /exact lowercase EAS build ID/u],
    [["--platform", "ios", "--id", androidBuildId], /must pin the exact production build/u],
    [["--profile", "production", "--id", iosBuildId], /Unsupported reviewed submission flag/u],
  ])("rejects an unpinned or ambiguous submission (%j)", (arguments_, message) => {
    expect(() => resolveReviewedSubmissionPlan(arguments_, environment)).toThrow(message);
  });

  it("runs the release and external-evidence gates before EAS submission", () => {
    const events = [];
    const runGate = vi.fn((script) => events.push(`gate:${script}`));
    const submit = vi.fn((plan) => events.push(`submit:${plan.platform}:${plan.buildId}`));
    expect(
      runReviewedSubmission(["--platform", "ios", "--id", iosBuildId], environment, {
        runGate,
        submit,
      }),
    ).toMatchObject({ buildId: iosBuildId, platform: "ios" });
    expect(events).toEqual([
      "gate:release:check",
      "gate:release:health-evidence",
      `submit:ios:${iosBuildId}`,
    ]);
  });

  it("never submits when the release preflight fails", () => {
    const runGate = vi.fn(() => {
      throw new TypeError("release blocked");
    });
    const submit = vi.fn();
    expect(() =>
      runReviewedSubmission(["--platform", "ios", "--id", iosBuildId], environment, {
        runGate,
        submit,
      }),
    ).toThrow(/release blocked/u);
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("never submits when reviewed four-artifact evidence fails", () => {
    const runGate = vi.fn((script) => {
      if (script === "release:health-evidence") throw new TypeError("evidence blocked");
    });
    const submit = vi.fn();
    expect(() =>
      runReviewedSubmission(["--platform", "android", "--id", androidBuildId], environment, {
        runGate,
        submit,
      }),
    ).toThrow(/evidence blocked/u);
    expect(runGate.mock.calls).toEqual([["release:check"], ["release:health-evidence"]]);
    expect(submit).not.toHaveBeenCalled();
  });
});
