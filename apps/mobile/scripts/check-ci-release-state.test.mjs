import { describe, expect, it, vi } from "vitest";

import { checkCiReleaseState } from "./check-ci-release-state.mjs";
import {
  RELEASE_DEPLOYMENT_SCHEMA,
  RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE,
} from "./check-release-env.mjs";

const blocker =
  "Package-identifier history and explicit native build numbers must be confirmed before release.";
const unconfirmedDeployment = {
  schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
  ociDeploymentConfirmed: false,
  apiOrigin: null,
};
const confirmedDeployment = {
  schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
  ociDeploymentConfirmed: true,
  apiOrigin: "https://api.nutritionledger.app",
};

describe("mobile CI release-state gate", () => {
  it("passes only after observing the exact unconfirmed-numbering blocker", () => {
    const runScript = vi.fn(() => ({ status: 1, stdout: "", stderr: blocker }));
    expect(
      checkCiReleaseState(
        { identifierHistoryConfirmed: false },
        unconfirmedDeployment,
        {},
        runScript,
      ),
    ).toEqual({ mode: "expected-block", output: "" });
    expect(runScript).toHaveBeenCalledWith("release:check");
  });

  it("rejects an unexpected success or an unrelated failure while unconfirmed", () => {
    expect(() =>
      checkCiReleaseState({ identifierHistoryConfirmed: false }, unconfirmedDeployment, {}, () => ({
        status: 0,
        stdout: "",
        stderr: "",
      })),
    ).toThrow(/must fail only/u);
    expect(() =>
      checkCiReleaseState({ identifierHistoryConfirmed: false }, unconfirmedDeployment, {}, () => ({
        status: 1,
        stdout: "",
        stderr: "dependency failure",
      })),
    ).toThrow(/must fail only/u);
  });

  it("recognizes the exact deployment blocker after numbering is confirmed", () => {
    const runScript = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: RELEASE_DEPLOYMENT_UNCONFIRMED_MESSAGE,
    }));
    expect(
      checkCiReleaseState(
        { identifierHistoryConfirmed: true },
        unconfirmedDeployment,
        {},
        runScript,
      ),
    ).toEqual({ mode: "expected-block", output: "" });
  });

  it("requires a real release origin before the confirmed full export", () => {
    const runScript = vi.fn();
    expect(() =>
      checkCiReleaseState({ identifierHistoryConfirmed: true }, confirmedDeployment, {}, runScript),
    ).toThrow(/required/u);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary safe HTTPS origin that differs from the OCI record", () => {
    const runScript = vi.fn();
    expect(() =>
      checkCiReleaseState(
        { identifierHistoryConfirmed: true },
        confirmedDeployment,
        { EXPO_PUBLIC_API_URL: "https://api.github.com" },
        runScript,
      ),
    ).toThrow(/exactly match/u);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("runs the full release build when numbering and the real origin are present", () => {
    const runScript = vi.fn(() => ({ status: 0, stdout: "release export", stderr: "" }));
    expect(
      checkCiReleaseState(
        { identifierHistoryConfirmed: true },
        confirmedDeployment,
        { EXPO_PUBLIC_API_URL: confirmedDeployment.apiOrigin },
        runScript,
      ),
    ).toEqual({ mode: "release", output: "release export" });
    expect(runScript).toHaveBeenCalledWith("build:release");
  });
});
