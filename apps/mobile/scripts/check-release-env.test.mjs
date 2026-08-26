import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "@nutrition-tracker/contracts";
import { describe, expect, it } from "vitest";

import {
  ExpectedReleaseBlockError,
  RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
  RELEASE_DEPLOYMENT_SCHEMA,
  RELEASE_DEPLOYMENT_UNCONFIRMED_CODE,
  RELEASE_EXPECTED_BLOCK_EXIT_CODE,
  validateReleaseApiUrl,
  validateReleaseDeployment,
  validateReleaseDeploymentPolicy,
  validateReleaseDeploymentRecord,
} from "./check-release-env.mjs";

const SERVICE_COMMIT = "a".repeat(40);
const REVIEWED_AT = "2026-08-25T18:00:00.000Z";
const reviewerKeys = generateKeyPairSync("ed25519");
const wrongReviewerKeys = generateKeyPairSync("ed25519");
const reviewerPrincipal = "independent.deployment.reviewer@example.test";
const deploymentOperatorPrincipal = "deployment.operator@example.test";
const reviewerKeyId = "deployment-reviewer-2026-01";
const externalHttpsReport = Buffer.from(
  '{"schemaVersion":"external-https-report-v1","result":"passed"}\n',
  "utf8",
);
const reviewerAccessReport = Buffer.from(
  '{"schemaVersion":"reviewer-access-report-v1","result":"passed"}\n',
  "utf8",
);
const reportDigests = {
  externalHttpsEvidenceSha256: createHash("sha256").update(externalHttpsReport).digest("hex"),
  reviewerAccessEvidenceSha256: createHash("sha256").update(reviewerAccessReport).digest("hex"),
};
const reviewerTrustStore = {
  schemaVersion: RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
  reviewers: [
    {
      keyId: reviewerKeyId,
      principal: reviewerPrincipal,
      algorithm: "Ed25519",
      publicKeySpkiDerBase64: reviewerKeys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    },
  ],
};
const checkedInReviewerTrustStore = JSON.parse(
  readFileSync(new URL("../config/release-deployment-reviewers.json", import.meta.url), "utf8"),
);

function serviceImages() {
  return Object.fromEntries(
    ["api", "web", "worker", "migrator", "caddy", "postgres"].map((component, index) => [
      component,
      `ghcr.io/liangzixuan/cronometer-gold-${component}@sha256:${String(index + 1).repeat(64)}`,
    ]),
  );
}

function releaseRuntime(overrides = {}) {
  return {
    gitHead: () => SERVICE_COMMIT,
    gitStatus: () => "",
    now: () => new Date("2026-08-25T18:30:00.000Z"),
    readEvidence: () => "",
    readReport: () => Buffer.alloc(0),
    statEvidence: () => ({ isFile: () => true, size: 1 }),
    statReport: () => ({ isFile: () => true, size: 1 }),
    ...overrides,
  };
}

function canonicalEvidence(deployment) {
  return JSON.stringify({
    schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
    deploymentPlatform: deployment.deploymentPlatform,
    deploymentConfirmed: true,
    apiOrigin: deployment.apiOrigin,
    serviceGitCommit: deployment.serviceGitCommit,
    serviceImages: Object.fromEntries(
      ["api", "web", "worker", "migrator", "caddy", "postgres"].map((component) => [
        component,
        deployment.serviceImages[component],
      ]),
    ),
    deployedBy: deployment.deployedBy,
    externalHttpsEvidenceSha256: deployment.externalHttpsEvidenceSha256,
    reviewerAccessEvidenceSha256: deployment.reviewerAccessEvidenceSha256,
    reviewedBy: deployment.reviewedBy,
    reviewedAt: deployment.reviewedAt,
    reviewerAttestation: {
      keyId: deployment.reviewerAttestation.keyId,
      algorithm: deployment.reviewerAttestation.algorithm,
      signatureBase64: deployment.reviewerAttestation.signatureBase64,
    },
  });
}

function deploymentEnvironment(deployment, overrides = {}) {
  return {
    EXPO_PUBLIC_API_URL: deployment.apiOrigin,
    NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: canonicalEvidence(deployment),
    NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64: externalHttpsReport.toString("base64"),
    NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64: reviewerAccessReport.toString("base64"),
    ...overrides,
  };
}

function signedDeployment(overrides = {}, privateKey = reviewerKeys.privateKey) {
  const unsigned = {
    schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
    deploymentPlatform: "azure",
    deploymentConfirmed: true,
    apiOrigin: "https://api.nourishing.app",
    serviceGitCommit: SERVICE_COMMIT,
    serviceImages: serviceImages(),
    deployedBy: deploymentOperatorPrincipal,
    ...reportDigests,
    reviewedBy: reviewerPrincipal,
    reviewedAt: REVIEWED_AT,
    ...overrides,
    reviewerAttestation: {
      keyId: reviewerKeyId,
      algorithm: "Ed25519",
    },
  };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey);
  return {
    ...unsigned,
    reviewerAttestation: {
      ...unsigned.reviewerAttestation,
      signatureBase64: signature.toString("base64"),
    },
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

describe("confirmed release platform and origin", () => {
  const unconfirmed = {
    schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
    deploymentPlatform: "azure",
    deploymentConfirmed: false,
    apiOrigin: null,
    deployedBy: null,
    serviceGitCommit: null,
    serviceImages: null,
    externalHttpsEvidenceSha256: null,
    reviewerAccessEvidenceSha256: null,
    reviewedBy: null,
    reviewerAttestation: null,
    reviewedAt: null,
  };
  const confirmed = signedDeployment();

  it("emits only the exact structured blocker in machine-readable CLI mode", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/check-release-env.mjs", "--machine-readable"],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    expect(result.status).toBe(RELEASE_EXPECTED_BLOCK_EXIT_CODE);
    expect(result.stdout).toBe(`${RELEASE_DEPLOYMENT_UNCONFIRMED_CODE}\n`);
    expect(result.stderr).toBe("");
  });

  it("keeps an unconfirmed deployment null and blocks release", () => {
    expect(validateReleaseDeploymentRecord(unconfirmed)).toEqual({
      apiOrigin: null,
      deployedBy: null,
      deploymentConfirmed: false,
      deploymentPlatform: "azure",
      externalHttpsEvidenceSha256: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewerAttestation: null,
      reviewerAccessEvidenceSha256: null,
      serviceGitCommit: null,
      serviceImages: null,
    });
    expect(() => validateReleaseDeployment({}, unconfirmed)).toThrow(/must be confirmed/u);
    try {
      validateReleaseDeployment({}, unconfirmed);
      throw new Error("Expected deployment blocker was not raised.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExpectedReleaseBlockError);
      expect(error).toMatchObject({ code: RELEASE_DEPLOYMENT_UNCONFIRMED_CODE });
    }
  });

  it("requires the environment to exactly equal the checked-in origin", () => {
    expect(
      validateReleaseDeployment(
        deploymentEnvironment(confirmed),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ).origin,
    ).toBe(confirmed.apiOrigin);
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, { EXPO_PUBLIC_API_URL: "https://api.github.com" }),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/exactly match/u);
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          EXPO_PUBLIC_API_URL: `${confirmed.apiOrigin}/`,
        }),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/exactly match/u);
  });

  it("rejects noncanonical or unreviewed deployment records", () => {
    expect(() =>
      validateReleaseDeploymentRecord({
        apiOrigin: confirmed.apiOrigin,
        deploymentConfirmed: true,
        deploymentPlatform: "azure",
        schemaVersion: RELEASE_DEPLOYMENT_SCHEMA,
      }),
    ).toThrow(/must contain exactly/u);
    expect(() =>
      validateReleaseDeploymentRecord({ ...confirmed, apiOrigin: `${confirmed.apiOrigin}/` }),
    ).toThrow(/canonical/u);
    expect(() =>
      validateReleaseDeploymentRecord({ ...unconfirmed, apiOrigin: confirmed.apiOrigin }),
    ).toThrow(/must not claim/u);
    expect(() =>
      validateReleaseDeploymentRecord({ ...unconfirmed, deploymentPlatform: "unknown" }),
    ).toThrow(/platform/u);
    expect(() =>
      validateReleaseDeploymentRecord({
        ...confirmed,
        schemaVersion: "nutrition-tracker-release-deployment-v2",
      }),
    ).toThrow(/v4/u);
  });

  it("requires the exact six digest-qualified service image repositories", () => {
    const missing = serviceImages();
    delete missing.worker;
    expect(() => validateReleaseDeploymentRecord({ ...confirmed, serviceImages: missing })).toThrow(
      /exactly/u,
    );

    expect(() =>
      validateReleaseDeploymentRecord({
        ...confirmed,
        serviceImages: { ...serviceImages(), extra: serviceImages().api },
      }),
    ).toThrow(/exactly/u);

    expect(() =>
      validateReleaseDeploymentRecord({
        ...confirmed,
        serviceImages: {
          ...serviceImages(),
          api: `ghcr.io/attacker/cronometer-gold-api@sha256:${"1".repeat(64)}`,
        },
      }),
    ).toThrow(/exact GHCR repository/u);

    expect(() =>
      validateReleaseDeploymentRecord({
        ...confirmed,
        serviceImages: {
          ...serviceImages(),
          api: "ghcr.io/liangzixuan/cronometer-gold-api:latest",
        },
      }),
    ).toThrow(/sha256 digest/u);
  });

  it("requires distinct evidence digests and a canonical review timestamp", () => {
    expect(() =>
      validateReleaseDeploymentRecord({
        ...confirmed,
        externalHttpsEvidenceSha256: "not-a-digest",
      }),
    ).toThrow(/SHA-256/u);
    expect(() =>
      validateReleaseDeploymentRecord({
        ...confirmed,
        reviewerAccessEvidenceSha256: confirmed.externalHttpsEvidenceSha256,
      }),
    ).toThrow(/distinct reports/u);
    expect(() =>
      validateReleaseDeploymentRecord({ ...confirmed, reviewedAt: "2026-08-25T18:00:00Z" }),
    ).toThrow(/canonical/u);
  });

  it("requires a trusted independent deployment-reviewer signature", () => {
    expect(checkedInReviewerTrustStore).toEqual({
      schemaVersion: RELEASE_DEPLOYMENT_REVIEWER_TRUST_SCHEMA,
      reviewers: [],
    });
    expect(() =>
      validateReleaseDeployment(deploymentEnvironment(confirmed), unconfirmed, releaseRuntime()),
    ).toThrow(/active checked-in trusted key/u);

    const wrongSignature = signedDeployment({}, wrongReviewerKeys.privateKey);
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(wrongSignature),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/signature verification/u);

    const wrongPrincipal = signedDeployment({ reviewedBy: "different.reviewer@example.test" });
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(wrongPrincipal),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/active checked-in trusted key/u);

    const alternateKeyId = "deployment-reviewer-2026-02";
    const keyIdTampered = {
      ...confirmed,
      reviewerAttestation: {
        ...confirmed.reviewerAttestation,
        keyId: alternateKeyId,
      },
    };
    const sameKeyAlternateIdTrustStore = {
      ...reviewerTrustStore,
      reviewers: [
        ...reviewerTrustStore.reviewers,
        { ...reviewerTrustStore.reviewers[0], keyId: alternateKeyId },
      ],
    };
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(keyIdTampered),
        unconfirmed,
        releaseRuntime(),
        sameKeyAlternateIdTrustStore,
      ),
    ).toThrow(/signature verification/u);
  });

  it("rejects deployment self-review even when casing differs", () => {
    for (const deployedBy of [reviewerPrincipal, reviewerPrincipal.toUpperCase()]) {
      const selfReviewed = signedDeployment({ deployedBy });
      expect(() =>
        validateReleaseDeployment(
          deploymentEnvironment(selfReviewed),
          unconfirmed,
          releaseRuntime(),
          reviewerTrustStore,
        ),
      ).toThrow(/independent reviewer/u);
    }
  });

  it("rejects a signed record after any deployment claim is changed", () => {
    const tampered = { ...confirmed, apiOrigin: "https://api.github.com" };
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(tampered),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/signature verification|must equal https:\/\/api\.nourishing\.app/u);
  });

  it("hashes both exact bounded report byte strings", () => {
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64: Buffer.from(
            "tampered report",
            "utf8",
          ).toString("base64"),
        }),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/external HTTPS report SHA-256/u);

    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64: "not canonical base64",
        }),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/canonical padded standard base64/u);

    const missing = deploymentEnvironment(confirmed);
    delete missing.NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64;
    expect(() =>
      validateReleaseDeployment(missing, unconfirmed, releaseRuntime(), reviewerTrustStore),
    ).toThrow(/exactly one bounded base64 value or absolute report path/u);

    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64: Buffer.alloc(65_537, 1).toString(
            "base64",
          ),
        }),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/exceeded its byte bound/u);
  });

  it("accepts distinct exact report files and rejects aliases or changed files", () => {
    const httpsPath = "/private/tmp/reviewed-external-https.json";
    const accessPath = "/private/tmp/reviewed-access.json";
    const fileEnvironment = deploymentEnvironment(confirmed, {
      NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64: undefined,
      NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_PATH: httpsPath,
      NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64: undefined,
      NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_PATH: accessPath,
    });
    const runtime = releaseRuntime({
      readReport: (path) => (path === httpsPath ? externalHttpsReport : reviewerAccessReport),
      statReport: (path) => ({
        isFile: () => true,
        size: path === httpsPath ? externalHttpsReport.length : reviewerAccessReport.length,
      }),
    });
    expect(
      validateReleaseDeployment(fileEnvironment, unconfirmed, runtime, reviewerTrustStore).origin,
    ).toBe(confirmed.apiOrigin);

    expect(() =>
      validateReleaseDeployment(
        {
          ...fileEnvironment,
          NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_PATH: httpsPath,
        },
        unconfirmed,
        runtime,
        reviewerTrustStore,
      ),
    ).toThrow(/distinct report files/u);

    expect(() =>
      validateReleaseDeployment(
        fileEnvironment,
        unconfirmed,
        releaseRuntime({
          readReport: runtime.readReport,
          statReport: () => ({ isFile: () => true, size: externalHttpsReport.length + 1 }),
        }),
        reviewerTrustStore,
      ),
    ).toThrow(/changed while it was being reviewed/u);

    expect(() =>
      validateReleaseDeployment(
        fileEnvironment,
        unconfirmed,
        releaseRuntime({
          readReport: runtime.readReport,
          statReport: () => ({ isFile: () => false, size: externalHttpsReport.length }),
        }),
        reviewerTrustStore,
      ),
    ).toThrow(/bounded regular report file/u);
  });

  it("binds a fresh review to the actual clean release Git HEAD", () => {
    const environment = deploymentEnvironment(confirmed);
    expect(() =>
      validateReleaseDeployment(
        environment,
        unconfirmed,
        releaseRuntime({ gitHead: () => "d".repeat(40) }),
        reviewerTrustStore,
      ),
    ).toThrow(/match.*Git HEAD/u);
    expect(() =>
      validateReleaseDeployment(
        environment,
        unconfirmed,
        releaseRuntime({ gitStatus: () => " M app.json" }),
        reviewerTrustStore,
      ),
    ).toThrow(/clean Git tree/u);
    expect(() =>
      validateReleaseDeployment(
        environment,
        unconfirmed,
        releaseRuntime({ now: () => new Date("2026-08-26T18:00:00.001Z") }),
        reviewerTrustStore,
      ),
    ).toThrow(/older than 24 hours/u);
    expect(() =>
      validateReleaseDeployment(
        environment,
        unconfirmed,
        releaseRuntime({ now: () => new Date("2026-08-25T17:54:59.999Z") }),
        reviewerTrustStore,
      ),
    ).toThrow(/future/u);
  });

  it("uses the canonical EAS source commit without invoking unavailable Git metadata", () => {
    const gitHead = () => {
      throw new Error("EAS Build must not invoke git rev-parse");
    };
    const gitStatus = () => {
      throw new Error("EAS Build must not invoke git status");
    };
    expect(
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          EAS_BUILD: "true",
          EAS_BUILD_GIT_COMMIT_HASH: SERVICE_COMMIT,
        }),
        unconfirmed,
        releaseRuntime({ gitHead, gitStatus }),
        reviewerTrustStore,
      ).origin,
    ).toBe(confirmed.apiOrigin);
  });

  it.each([
    [undefined, /EAS_BUILD_GIT_COMMIT_HASH/u],
    ["", /EAS_BUILD_GIT_COMMIT_HASH/u],
    ["a".repeat(39), /EAS_BUILD_GIT_COMMIT_HASH/u],
    ["A".repeat(40), /EAS_BUILD_GIT_COMMIT_HASH/u],
    [`${SERVICE_COMMIT}\n`, /EAS_BUILD_GIT_COMMIT_HASH/u],
  ])("fails closed for an invalid EAS source commit (%j)", (easCommit, message) => {
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          EAS_BUILD: "true",
          EAS_BUILD_GIT_COMMIT_HASH: easCommit,
        }),
        unconfirmed,
        releaseRuntime({
          gitHead: () => {
            throw new Error("must not fall back to local Git on EAS Build");
          },
          gitStatus: () => {
            throw new Error("must not fall back to local Git on EAS Build");
          },
        }),
        reviewerTrustStore,
      ),
    ).toThrow(message);
  });

  it("rejects an EAS source commit that differs from the deployed service commit", () => {
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          EAS_BUILD: "true",
          EAS_BUILD_GIT_COMMIT_HASH: "d".repeat(40),
        }),
        unconfirmed,
        releaseRuntime({
          gitHead: () => {
            throw new Error("must not invoke local Git on EAS Build");
          },
          gitStatus: () => {
            throw new Error("must not invoke local Git on EAS Build");
          },
        }),
        reviewerTrustStore,
      ),
    ).toThrow(/match.*Git HEAD/u);
  });

  it("keeps the checked-in policy unconfirmed and requires one canonical external record", () => {
    expect(() =>
      validateReleaseDeployment(
        { EXPO_PUBLIC_API_URL: confirmed.apiOrigin },
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/must be confirmed/u);
    expect(() => validateReleaseDeploymentPolicy(confirmed)).toThrow(/checked-in.*unconfirmed/u);
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON: JSON.stringify(confirmed, null, 2),
        }),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/canonical field order/u);
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(confirmed, {
          NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH: "/private/tmp/deployment.json",
        }),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/exactly one/u);
  });

  it("accepts one ignored external JSON file and rejects a platform mismatch", () => {
    const evidence = canonicalEvidence(confirmed);
    expect(
      validateReleaseDeployment(
        {
          EXPO_PUBLIC_API_URL: confirmed.apiOrigin,
          NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH:
            "/private/tmp/release-deployment-evidence.json",
          NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_BASE64: externalHttpsReport.toString("base64"),
          NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_BASE64: reviewerAccessReport.toString("base64"),
        },
        unconfirmed,
        releaseRuntime({
          readEvidence: () => `${evidence}\n`,
          statEvidence: () => ({ isFile: () => true, size: evidence.length + 1 }),
        }),
        reviewerTrustStore,
      ).origin,
    ).toBe(confirmed.apiOrigin);

    const mismatched = signedDeployment({ deploymentPlatform: "oci" });
    expect(() =>
      validateReleaseDeployment(
        deploymentEnvironment(mismatched),
        unconfirmed,
        releaseRuntime(),
        reviewerTrustStore,
      ),
    ).toThrow(/platform must match/u);
  });
});
