import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, NOW, REVISION } from "../../../scripts/appwrite/qualification-fixture.mjs";
import { canonicalEvidence } from "../../../scripts/deployment/managed-evidence.mjs";
import policy from "../config/release-deployment.json";
import {
  ExpectedReleaseBlockError,
  MOBILE_RELEASE_BUNDLE_SCHEMA,
  RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
  RELEASE_EXPECTED_BLOCK_EXIT_CODE,
  validateReleaseApiUrl,
  validateReleaseDeployment,
  validateReleaseDeploymentPolicy,
} from "./check-release-env.mjs";

const runtime = { gitHead: () => REVISION, gitStatus: () => "", now: () => new Date(NOW) };
function setup(target = "production") {
  const f = fixture(target);
  const evidence = {
    schemaVersion: MOBILE_RELEASE_BUNDLE_SCHEMA,
    qualification: f.bundle,
    activation: f.activation,
  };
  const env = () => ({
    EXPO_PUBLIC_API_URL: "https://api.nourishing.app",
    NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: canonicalEvidence(evidence),
  });
  return {
    f,
    evidence,
    env,
    check: (changes = {}, time = runtime, trust = f.trust) =>
      validateReleaseDeployment({ ...env(), ...changes }, policy, time, trust),
  };
}
describe("mobile release API preflight", () => {
  it("requires an explicit credential-free HTTPS origin", () => {
    expect(() => validateReleaseApiUrl(undefined)).toThrow(/required/u);
    expect(() => validateReleaseApiUrl("http://api.example.test")).toThrow(/HTTPS/u);
    expect(() => validateReleaseApiUrl("https://user:secret@api.example.test")).toThrow(
      /credential-free/u,
    );
    expect(() => validateReleaseApiUrl("https://api.github.com/v1")).toThrow(/credential-free/u);
  });

  it.each([
    "https://localhost",
    "https://api.localhost",
    "https://127.0.0.1",
    "https://127.10.20.30",
    "https://0.0.0.0",
    "https://10.0.2.2",
    "https://[::]",
    "https://[::1]",
    "https://[::127.0.0.1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:0:127.0.0.1]",
  ])("rejects known local release target %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/non-loopback/u);
  });

  it.each([
    "https://api.example.invalid",
    "https://api.example.test",
    "https://api.example",
    "https://example.com",
    "https://api.example.com",
    "https://example.net",
    "https://example.org",
    "https://192.0.2.1",
    "https://198.51.100.8",
    "https://203.0.113.9",
    "https://[2001:db8::1]",
    "https://[::ffff:192.0.2.1]",
  ])("rejects reserved documentation target %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/non-documentation/u);
  });

  it.each([
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://100.64.0.1",
    "https://169.254.169.254",
    "https://224.0.0.1",
    "https://240.0.0.1",
    "https://[fc00::1]",
    "https://[fd12:3456::1]",
    "https://[fe80::1]",
    "https://[ff02::1]",
    "https://[2606:4700:4700::1111]",
  ])("rejects numeric release target %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/public-DNS/u);
  });

  it.each([
    "https://foo",
    "https://api.local",
    "https://api.internal",
    "https://api.home.arpa",
    "https://api_name.example.co",
    "https://-api.example.co",
    "https://api-.example.co",
    "https://api.example.1a",
    "https://api.github.com.",
    `https://${"a".repeat(64)}.example.co`,
  ])("rejects a hostname outside the owned public-DNS shape %s", (value) => {
    expect(() => validateReleaseApiUrl(value)).toThrow(/public-DNS/u);
  });

  it("accepts only the owned canonical production API origin", () => {
    expect(validateReleaseApiUrl("https://api.nourishing.app").href).toBe(
      "https://api.nourishing.app/",
    );
    expect(() => validateReleaseApiUrl("https://api.github.com")).toThrow(
      /exactly match the owned origin https:\/\/api\.nourishing\.app/u,
    );
    expect(() => validateReleaseApiUrl("https://api.nourishing.app:444")).toThrow(/exactly match/u);
  });
});

describe("shared managed mobile release admission", () => {
  it("retains the exact machine-readable missing-evidence blocker", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/check-release-env.mjs", "--machine-readable"],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { PATH: process.env.PATH },
        timeout: 10000,
      },
    );
    expect(result.status).toBe(RELEASE_EXPECTED_BLOCK_EXIT_CODE);
    expect(result.stdout).toBe(`${RELEASE_DEPLOYMENT_UNCONFIRMED_CODE}\n`);
    expect(result.stderr).toBe("");
    expect(() => validateReleaseDeployment({}, policy)).toThrow(ExpectedReleaseBlockError);
  });
  it("accepts independently signed production and actual active-deployment observations", () => {
    expect(setup().check().origin).toBe("https://api.nourishing.app");
  });
  it("keeps checked-in policy unconfirmed and rejects older schemas", () => {
    expect(validateReleaseDeploymentPolicy(policy)).toEqual(policy);
    for (const change of [
      { deploymentConfirmed: true },
      { apiOrigin: "https://api.nourishing.app" },
      { schemaVersion: "nutrition-tracker-release-deployment-v7" },
      { extra: true },
    ])
      expect(() => validateReleaseDeploymentPolicy({ ...policy, ...change })).toThrow(
        /unconfirmed v8/u,
      );
    const s = setup();
    s.evidence.schemaVersion = "nutrition-tracker-release-deployment-v7";
    expect(() => s.check()).toThrow(/older deployment schemas/u);
  });
  it("rejects a prepared candidate without signed activation", () => {
    const s = setup();
    s.evidence.activation = null;
    expect(() => s.check()).toThrow();
  });
  it("rejects activation substitution, stale observations and unsigned edits", () => {
    for (const field of ["deploymentSha256", "sourceRevision", "apiOrigin"]) {
      const s = setup();
      s.evidence.activation[field] = "wrong";
      expect(() => s.check()).toThrow();
    }
    const s = setup();
    s.evidence.activation = s.f.signRecord({
      ...s.f.activation,
      observedAt: new Date(NOW - 7200000).toISOString(),
    });
    expect(() => s.check()).toThrow();
  });
  it("rejects staging evidence for personal mobile release", () => {
    expect(() => setup("staging").check()).toThrow(/production managed/u);
  });
  it("requires current source, clean local state and actual EAS commit", () => {
    const s = setup();
    expect(() => s.check({}, { ...runtime, gitHead: () => "f".repeat(40) })).toThrow();
    expect(() => s.check({}, { ...runtime, gitStatus: () => " M app.ts" })).toThrow(/clean Git/u);
    expect(() => s.check({ EAS_BUILD: "true" })).toThrow(/EAS_BUILD_GIT_COMMIT_HASH/u);
    expect(() =>
      s.check({ EAS_BUILD: "true", EAS_BUILD_GIT_COMMIT_HASH: "f".repeat(40) }),
    ).toThrow();
    expect(s.check({ EAS_BUILD: "true", EAS_BUILD_GIT_COMMIT_HASH: REVISION }).origin).toBe(
      "https://api.nourishing.app",
    );
  });
  it("never trusts a caller's unsigned report or the empty checked-in trust store", () => {
    const s = setup();
    expect(() => validateReleaseDeployment(s.env(), policy, runtime)).toThrow();
    s.evidence.qualification.runtimeReports.ssr.details.node = "0.0.0";
    expect(() => s.check()).toThrow();
  });
  it("requires actual capture/masking review and bounded current observations", () => {
    const s = setup();
    s.evidence.qualification.captureReview.observations.playwright = "unknown";
    expect(() => s.check()).toThrow();
    expect(() => setup().check({}, { ...runtime, now: () => new Date(NOW + 7200000) })).toThrow();
    expect(() => setup().check({}, { ...runtime, now: () => new Date(NaN) })).toThrow();
  });
  it("rejects noncanonical JSON, duplicate keys, oversized values and dual input channels", () => {
    const s = setup();
    for (const raw of [
      JSON.stringify(s.evidence, null, 2),
      '{"schemaVersion":1,"schemaVersion":2}',
      "x".repeat(600000),
    ])
      expect(() => s.check({ NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: raw })).toThrow();
    expect(() =>
      s.check({ NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH: "/tmp/evidence.json" }),
    ).toThrow(/exactly one/u);
  });
  it("reads only a bounded owner-only regular file and rejects symlink/FIFO before blocking", () => {
    const s = setup();
    const dir = mkdtempSync(join(tmpdir(), "mobile-managed-"));
    const path = join(dir, "evidence.json");
    try {
      writeFileSync(path, canonicalEvidence(s.evidence), { mode: 0o600 });
      const env = {
        NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: undefined,
        NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH: path,
      };
      expect(s.check(env).origin).toBe("https://api.nourishing.app");
      chmodSync(path, 0o644);
      expect(() => s.check(env)).toThrow(/owner-only/u);
      chmodSync(path, 0o600);
      const link = join(dir, "link.json");
      symlinkSync(path, link);
      expect(() => s.check({ ...env, NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH: link })).toThrow();
      const fifo = join(dir, "fifo.json");
      const made = spawnSync("mkfifo", [fifo]);
      expect(made.status).toBe(0);
      expect(() => s.check({ ...env, NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH: fifo })).toThrow(
        /regular file/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
