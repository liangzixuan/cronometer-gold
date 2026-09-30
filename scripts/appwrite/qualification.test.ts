import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalEvidence,
  evidenceSha256,
  loadReviewerTrustStore,
  parseQualificationBundle,
  readQualificationBundle,
  validateBackendAdmission,
  validateCaptureReview,
  validateManagedActivation,
  validateManagedDeployment,
  validateStagingIsolation,
} from "../deployment/managed-evidence.mjs";
import {
  createQualificationVerifier,
  probeBackendReadiness,
  READINESS_LIMITS,
} from "./qualification.ts";
import { fixture, NOW, REVISION, SHA } from "./qualification-fixture.mjs";
import type { DeploymentRecord, ReleaseReceipt, SiteRecord } from "./site-release.ts";

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "required test fixture");
  return value;
}
const token = "e".repeat(64);

const ok = () =>
  new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } });
function verifier(f: ReturnType<typeof fixture>, request: typeof fetch = async () => ok()) {
  return createQualificationVerifier(
    { qualificationPath: "/not-read-fixture", readinessToken: token },
    {
      trustStore: f.trust,
      policy: f.policy,
      now: () => NOW,
      readBundle: () => f.bundle,
      fetch: request,
    },
  );
}
test("independently signed six-image backend and v8 candidate validate with ephemeral test trust", () => {
  const f = fixture();
  assert.equal(validateBackendAdmission(f.bundle, f.expected, f.trust).sourceRevision, REVISION);
  assert.equal(
    validateManagedDeployment(f.bundle, f.expected, f.trust).web.deploymentId,
    "fixture-deployment",
  );
});
test("real empty checked-in reviewer trust rejects a well-shaped signed fixture", () => {
  const f = fixture();
  assert.throws(
    () => validateBackendAdmission(f.bundle, f.expected, loadReviewerTrustStore()),
    /reviewer_key_not_trusted/,
  );
});
test("forged signature and self-selected reviewer never admit a backend", () => {
  const f = fixture();
  f.bundle.backend.reviewedBy = "attacker-reviewer";
  assert.throws(
    () => validateBackendAdmission(f.bundle, f.expected, f.trust),
    /reviewer_key_not_trusted/,
  );
  f.bundle.backend.reviewedBy = "fixture-reviewer";
  f.bundle.backend.images.api = f.bundle.backend.images.api?.replace(SHA, "2".repeat(64)) ?? "";
  assert.throws(
    () => validateBackendAdmission(f.bundle, f.expected, f.trust),
    /reviewer_signature_invalid/,
  );
});
test("reviewer must differ from operator and the enrolled key must be active", () => {
  const f = fixture();
  f.bundle.backend.deployedBy = "FIXTURE-REVIEWER";
  assert.throws(
    () => validateBackendAdmission(f.bundle, f.expected, f.trust),
    /independent_reviewer_required/,
  );
  const g = fixture();
  required(g.trust.reviewers[0]).validUntil = "2026-09-29T18:00:00.000Z";
  assert.throws(
    () => validateBackendAdmission(g.bundle, g.expected, g.trust),
    /reviewer_key_not_trusted/,
  );
});
test("signed evidence still fails source, target, API and configuration substitution", () => {
  const f = fixture();
  for (const replacement of [
    { sourceRevision: "2".repeat(40) },
    { target: "production" as const },
    { apiOrigin: "https://other.nourishing.app" },
    { configurationSha256: "2".repeat(64) },
  ])
    assert.throws(
      () => validateBackendAdmission(f.bundle, { ...f.expected, ...replacement }, f.trust),
      /context_mismatch/,
    );
});
test("signed review expires after 24 hours and observations expire after one hour", () => {
  const f = fixture();
  assert.throws(
    () => validateBackendAdmission(f.bundle, { ...f.expected, now: NOW + 24 * 3600000 }, f.trust),
    /review_stale/,
  );
  assert.throws(
    () => validateBackendAdmission(f.bundle, { ...f.expected, now: NOW + 3600000 }, f.trust),
    /observation_stale/,
  );
});
test("extra web image and missing backend report do not pass signed backend admission", () => {
  const f = fixture();
  const {
    reviewerAttestation: _attestation,
    deployedBy: _operator,
    reviewedBy: _reviewer,
    reviewedAt: _time,
    ...base
  } = f.backend;
  f.bundle.backend = f.signRecord({
    ...base,
    images: { ...base.images, web: `ghcr.io/liangzixuan/cronometer-gold-web@sha256:${SHA}` },
  });
  assert.throws(
    () => validateBackendAdmission(f.bundle, f.expected, f.trust),
    /backend_images_invalid/,
  );
  const g = fixture();
  delete g.bundle.backendReports.restore;
  assert.throws(() => validateBackendAdmission(g.bundle, g.expected, g.trust), /reports_invalid/);
});
test("actual report bytes must match the reviewer's signed digests", () => {
  const f = fixture();
  required(f.bundle.backendReports.host).details = { host: "fabricated" };
  assert.throws(() => validateBackendAdmission(f.bundle, f.expected, f.trust), /report_mismatch/);
});
test("final signature cannot authorize a different output, deployment, origin or Site", () => {
  const f = fixture();
  for (const replacement of [
    { deploymentId: "other-deployment" },
    { siteId: "other-site" },
    { webOrigin: "https://other.nourishing.app" },
    { output: { ...f.expected.output, outputTreeSha256: "2".repeat(64) } },
  ])
    assert.throws(
      () => validateManagedDeployment(f.bundle, { ...f.expected, ...replacement }, f.trust),
      /mismatch/,
    );
});
test("backend-only preparation cannot activate without final reviewed output", async () => {
  const f = fixture();
  f.bundle.deployment = null;
  const gate = verifier(f);
  await gate.beforeUpload(f.context);
  await assert.rejects(gate.beforeActivation(f.context), /signed_evidence_shape_invalid/);
});
test("completed capture review binds exact summary, session and run", () => {
  const f = fixture();
  const expected = {
    sourceRevision: REVISION,
    summarySha256: SHA,
    sessionId: "fixture-session",
    runId: 123,
    attempt: 1,
    now: NOW,
  };
  validateCaptureReview(f.captureReview, expected, f.trust);
  for (const replacement of [
    { summarySha256: "2".repeat(64) },
    { sessionId: "different" },
    { runId: 124 },
    { attempt: 2 },
  ])
    assert.throws(
      () => validateCaptureReview(f.captureReview, { ...expected, ...replacement }, f.trust),
      /context_mismatch/,
    );
});
test("missing or unresolved capture prevents even the live readiness probe", async () => {
  const f = fixture();
  let requests = 0;
  f.bundle.captureReview = {};
  await assert.rejects(
    verifier(f, async () => {
      requests++;
      return ok();
    }).beforeUpload(f.context),
    /signed_evidence_shape_invalid/,
  );
  assert.equal(requests, 0);
});
test("actual preparation and activation independently perform bounded live readiness", async () => {
  const f = fixture();
  let requests = 0;
  const gate = verifier(f, async (url, init) => {
    requests++;
    assert.equal(url, `${f.config.apiOrigin}/ready`);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.ok(init?.signal);
    return ok();
  });
  await gate.beforeUpload(f.context);
  await gate.beforeActivation(f.context);
  assert.equal(requests, 2);
  assert.equal(gate.readinessObservations().length, 2);
  assert.ok(!JSON.stringify(gate.readinessObservations()).includes(token));
  assert.equal(gate.readinessObservations()[0]?.meaning, "live-database-readiness-only");
});
test("HTTPS readiness never accepts redirects, HTTP errors, extra body keys or wrong content types", async () => {
  for (const response of [
    new Response("", { status: 302, headers: { location: "https://attacker.example" } }),
    new Response('{"status":"ok"}', {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
    new Response('{"status":"ok","identity":"fake"}', {
      headers: { "content-type": "application/json" },
    }),
    new Response('{"status":"ok"}', { headers: { "content-type": "text/plain" } }),
  ])
    await assert.rejects(
      probeBackendReadiness(
        "https://staging-api.nourishing.app",
        token,
        async () => response,
        () => NOW,
      ),
      /backend_live_readiness/,
    );
});
test("streamed and declared oversized readiness responses stop at the byte bound", async () => {
  for (const response of [
    new Response("a".repeat(READINESS_LIMITS.bytes + 1), {
      headers: { "content-type": "application/json" },
    }),
    new Response('{"status":"ok"}', {
      headers: { "content-type": "application/json", "content-length": "2000" },
    }),
  ])
    await assert.rejects(
      probeBackendReadiness("https://staging-api.nourishing.app", token, async () => response),
      /too_large/,
    );
});
test("transport exceptions are redacted and malformed readiness credentials never reach transport", async () => {
  await assert.rejects(
    probeBackendReadiness("https://staging-api.nourishing.app", token, async () => {
      throw new Error(`secret=${token}`);
    }),
    /^ReleaseError: backend_live_readiness_failed$/,
  );
  let calls = 0;
  await assert.rejects(
    probeBackendReadiness("https://staging-api.nourishing.app", "invalid", async () => {
      calls++;
      return ok();
    }),
    /readiness_credential_invalid/,
  );
  assert.equal(calls, 0);
});
test("staging cannot share database, search namespace, storage principal or API origin", () => {
  const staging = fixture().backend;
  const production = fixture("production").backend;
  validateStagingIsolation(production, staging);
  for (const key of [
    "databaseSha256",
    "searchNamespaceSha256",
    "storagePrincipalSha256",
  ] as const) {
    const changed = {
      ...production,
      isolation: { ...production.isolation, [key]: staging.isolation[key] },
    };
    assert.throws(() => validateStagingIsolation(changed, staging), /staging_isolation_invalid/);
  }
  assert.throws(
    () => validateStagingIsolation({ ...production, apiOrigin: staging.apiOrigin }, staging),
    /staging_isolation_invalid/,
  );
});
test("canonical input rejects duplicate keys and recursively embedded staging evidence", () => {
  const f = fixture();
  const text = canonicalEvidence(f.bundle);
  assert.equal(parseQualificationBundle(text).backend.target, "staging");
  assert.throws(
    () => parseQualificationBundle('{"schemaVersion":"wrong","schemaVersion":"wrong"}'),
    /not_canonical/,
  );
  assert.throws(() => parseQualificationBundle(JSON.stringify(f.bundle, null, 2)), /not_canonical/);
  f.bundle.staging = { ...f.bundle, staging: { ...f.bundle } };
  assert.throws(
    () => parseQualificationBundle(canonicalEvidence(f.bundle)),
    /staging_bundle_invalid/,
  );
});
test("qualification files require private owner mode and refuse symbolic links", () => {
  const directory = mkdtempSync(join(tmpdir(), "qualification-fixture-"));
  try {
    const f = fixture();
    const path = join(directory, "evidence.json");
    writeFileSync(path, canonicalEvidence(f.bundle), { mode: 0o600 });
    assert.equal(readQualificationBundle(path).backend.target, "staging");
    chmodSync(path, 0o644);
    assert.throws(() => readQualificationBundle(path), /qualification_file_invalid/);
    chmodSync(path, 0o600);
    symlinkSync(path, join(directory, "link.json"));
    assert.throws(
      () => readQualificationBundle(join(directory, "link.json")),
      /qualification_file_unreadable/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signed high/critical findings or nonempty scanner ignores still block", () => {
  for (const change of ["finding", "ignore"]) {
    const f = fixture();
    const details = required(f.bundle.backendReports.security).details as {
      imageChecks: { scan: { vulnerabilities: unknown[]; ignores: string[] } }[];
    };
    if (change === "finding")
      required(details.imageChecks[0]).scan.vulnerabilities.push({
        id: "CVE-2099-1234",
        severity: "HIGH",
        package: "fixture-package",
        version: "1.0.0",
      });
    else required(details.imageChecks[0]).scan.ignores.push("CVE-2099-1234");
    f.bundle.backend.reports.security = evidenceSha256(f.bundle.backendReports.security);
    f.bundle.backend = f.signRecord(f.bundle.backend);
    assert.throws(
      () => validateBackendAdmission(f.bundle, f.expected, f.trust),
      /image_(vulnerability_blocked|scan_invalid)/,
    );
  }
});
test("a correctly signed failed worker or mismatched running-container identity cannot pass", () => {
  const f = fixture();
  const readiness = required(f.bundle.backendReports.readiness).details as {
    worker: { queueConnected: boolean };
  };
  readiness.worker.queueConnected = false;
  f.bundle.backend.reports.readiness = evidenceSha256(f.bundle.backendReports.readiness);
  f.bundle.backend = f.signRecord(f.bundle.backend);
  assert.throws(
    () => validateBackendAdmission(f.bundle, f.expected, f.trust),
    /worker_readiness_invalid/,
  );
  const g = fixture();
  const host = required(g.bundle.backendReports.host).details as {
    containers: { sourceRevision: string }[];
  };
  required(host.containers[0]).sourceRevision = "2".repeat(40);
  g.bundle.backend.reports.host = evidenceSha256(g.bundle.backendReports.host);
  g.bundle.backend = g.signRecord(g.bundle.backend);
  assert.throws(
    () => validateBackendAdmission(g.bundle, g.expected, g.trust),
    /host_container_identity_mismatch/,
  );
});
test("observed managed runtime must include the reviewed patch and actual native inventory", () => {
  const f = fixture();
  const ssr = required(required(f.bundle.runtimeReports).ssr).details as {
    opensslFixCommit: string;
  };
  ssr.opensslFixCommit = "unknown";
  const deployment = required(f.bundle.deployment);
  (deployment.reports as Record<string, string>).ssr = evidenceSha256(
    required(f.bundle.runtimeReports).ssr,
  );
  f.bundle.deployment = f.signRecord(deployment);
  assert.throws(
    () => validateManagedDeployment(f.bundle, f.expected, f.trust),
    /managed_runtime_not_qualified/,
  );
});
test("missing Playwright log objects are not an accepted signed capture policy", async () => {
  const f = fixture();
  f.bundle.captureReview = f.signRecord({
    ...f.captureReview,
    observations: {
      video: "disabled",
      network: "disabled",
      console: "disabled",
      playwright: "missing-object",
      screenshots: "absent-in-complete-timeline",
      credentialMasking: "observed-redacted",
    },
  });
  await assert.rejects(verifier(f).beforeUpload(f.context), /capture_policy_unresolved/);
});
test("source archive substitution cannot activate the reviewed output", () => {
  const f = fixture();
  assert.throws(
    () =>
      validateManagedDeployment(
        f.bundle,
        {
          ...f.expected,
          sourceArchiveSha256: "f".repeat(64),
        },
        f.trust,
      ),
    /managed_source_archive_mismatch/,
  );
});
test("post-activation signature proves the actual selected Site separately from candidate review", () => {
  const f = fixture("production");
  const expected = {
    deploymentSha256: evidenceSha256(f.bundle.deployment),
    sourceRevision: REVISION,
    apiOrigin: f.config.apiOrigin,
    siteId: f.config.siteId,
    deploymentId: "fixture-deployment",
    now: NOW,
  };
  validateManagedActivation(f.activation, expected, f.trust);
  assert.throws(
    () => validateManagedActivation(f.bundle.deployment, expected, f.trust),
    /signed_evidence_shape_invalid/,
  );
  assert.throws(
    () =>
      validateManagedActivation(f.activation, { ...expected, deploymentId: "different" }, f.trust),
    /activation_not_confirmed/,
  );
  assert.throws(
    () =>
      validateManagedActivation(
        f.activation,
        { ...expected, deploymentSha256: "2".repeat(64) },
        f.trust,
      ),
    /activation_context_mismatch/,
  );
  assert.throws(
    () => validateManagedActivation(f.activation, { ...expected, now: NOW + 3600000 }, f.trust),
    /activation_observation_stale/,
  );
});

test("staging revalidation binds live provider identity and uses its distinct readiness token", async () => {
  const production = fixture("production");
  const staging = fixture("staging");
  staging.bundle.backend = production.signRecord(staging.bundle.backend);
  staging.bundle.captureReview = production.signRecord(staging.bundle.captureReview);
  staging.bundle.deployment = production.signRecord({
    ...required(staging.bundle.deployment),
    backendAdmissionSha256: evidenceSha256(staging.bundle.backend),
    captureReviewSha256: evidenceSha256(staging.bundle.captureReview),
  });
  production.bundle.staging = staging.bundle;
  const stageToken = "f".repeat(64);
  let requests = 0;
  const gate = createQualificationVerifier(
    {
      qualificationPath: "/fixture-not-read",
      readinessToken: token,
      stagingReadinessToken: stageToken,
    },
    {
      now: () => NOW,
      trustStore: production.trust,
      readBundle: () => production.bundle,
      fetch: async (url, init) => {
        requests++;
        assert.equal(url, `${staging.config.apiOrigin}/ready`);
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${stageToken}`);
        return ok();
      },
    },
  );
  const context = {
    ...production.context,
    staging: {
      config: staging.config,
      site: { deploymentId: "fixture-deployment" } as SiteRecord,
      deployment: {
        $id: "fixture-deployment",
        resourceId: staging.config.siteId,
        resourceType: "sites",
        status: "ready",
      } as DeploymentRecord,
      output: staging.expected.output,
    },
  };
  const receipt = { activeDeploymentId: "fixture-deployment" } as ReleaseReceipt;
  await gate.verifyStaging(receipt, context);
  assert.equal(requests, 1);
  await assert.rejects(
    gate.verifyStaging(receipt, {
      ...context,
      staging: { ...context.staging, site: { ...context.staging.site, deploymentId: "drifted" } },
    }),
    /staging_provider_identity_mismatch/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    gate.verifyStaging(receipt, {
      ...context,
      staging: {
        ...context.staging,
        output: { ...context.staging.output, outputArchiveSha256: "2".repeat(64) },
      },
    }),
    /managed_output_mismatch/,
  );
});
