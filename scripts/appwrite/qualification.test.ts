import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalEvidence,
  evidenceSha256,
  parseQualificationBundle,
  readQualificationBundle,
  validateBackendAdmission,
  validateCaptureObservation,
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
      policy: f.policy,
      now: () => NOW,
      readBundle: () => f.bundle,
      fetch: request,
    },
  );
}
test("one operator validates measured backend and candidate without reviewer keys or signatures", () => {
  const f = fixture();
  assert.equal(validateBackendAdmission(f.bundle, f.expected).sourceRevision, REVISION);
  assert.equal(
    validateManagedDeployment(f.bundle, f.expected).web.deploymentId,
    "fixture-deployment",
  );
  assert.equal(Object.hasOwn(f.bundle.backend, "reviewerAttestation"), false);
  assert.equal(Object.hasOwn(f.bundle.backend, "reviewedBy"), false);
});

test("backend admission rejects legacy and unknown provenance after report binding", () => {
  for (const predicateType of [
    "https://slsa.dev/provenance/v0.2",
    "https://slsa.dev/provenance/v2",
  ]) {
    const f = fixture();
    const security = required(f.bundle.backendReports.security);
    const details = security.details as {
      imageChecks: { provenance: { predicateType: string } }[];
    };
    required(details.imageChecks[0]).provenance.predicateType = predicateType;
    f.bundle.backend.reports.security = evidenceSha256(security);
    f.bundle.backend = f.recordEvidence(f.bundle.backend);
    assert.throws(
      () => validateBackendAdmission(f.bundle, f.expected),
      /image_provenance_mismatch/,
    );
  }
});
test("Azure storage readiness rejects legacy create and delete statuses after measurement", () => {
  for (const replacement of [{ putHttpStatus: 200 }, { deleteHttpStatus: 204 }]) {
    const f = fixture();
    const readiness = required(f.bundle.backendReports.readiness);
    const details = readiness.details as {
      storage: { putHttpStatus: number; deleteHttpStatus: number };
    };
    Object.assign(details.storage, replacement);
    f.bundle.backend.reports.readiness = evidenceSha256(readiness);
    f.bundle.backend = f.recordEvidence(f.bundle.backend);
    assert.throws(
      () => validateBackendAdmission(f.bundle, f.expected),
      /storage_readiness_invalid/,
    );
  }
});
test("measured evidence still fails source, target, API and configuration substitution", () => {
  const f = fixture();
  for (const replacement of [
    { sourceRevision: "2".repeat(40) },
    { target: "production" as const },
    { apiOrigin: "https://other.nourishing.app" },
    { configurationSha256: "2".repeat(64) },
  ])
    assert.throws(
      () => validateBackendAdmission(f.bundle, { ...f.expected, ...replacement }),
      /context_mismatch/,
    );
});
test("measurement records and observations retain actual freshness bounds", () => {
  const f = fixture();
  assert.throws(
    () => validateBackendAdmission(f.bundle, { ...f.expected, now: NOW + 24 * 3600000 }),
    /record_stale/,
  );
  assert.throws(
    () => validateBackendAdmission(f.bundle, { ...f.expected, now: NOW + 3600000 }),
    /observation_stale/,
  );
});

test("extra web image and missing backend report do not pass measured backend admission", () => {
  const f = fixture();
  const { deployedBy: _operator, recordedAt: _time, ...base } = f.backend;
  f.bundle.backend = f.recordEvidence({
    ...base,
    images: { ...base.images, web: `ghcr.io/liangzixuan/cronometer-gold-web@sha256:${SHA}` },
  });
  assert.throws(() => validateBackendAdmission(f.bundle, f.expected), /backend_images_invalid/);
  const g = fixture();
  delete g.bundle.backendReports.restore;
  assert.throws(() => validateBackendAdmission(g.bundle, g.expected), /reports_invalid/);
});
test("actual report bytes must match the operator's recorded digests", () => {
  const f = fixture();
  required(f.bundle.backendReports.host).details = { host: "fabricated" };
  assert.throws(() => validateBackendAdmission(f.bundle, f.expected), /report_mismatch/);
});
test("final evidence cannot authorize a different output, deployment, origin or Site", () => {
  const f = fixture();
  for (const replacement of [
    { deploymentId: "other-deployment" },
    { siteId: "other-site" },
    { webOrigin: "https://other.nourishing.app" },
    { output: { ...f.expected.output, outputTreeSha256: "2".repeat(64) } },
  ])
    assert.throws(
      () => validateManagedDeployment(f.bundle, { ...f.expected, ...replacement }),
      /mismatch/,
    );
});
test("backend-only preparation cannot activate without final measured output", async () => {
  const f = fixture();
  f.bundle.deployment = null;
  const gate = verifier(f);
  await gate.beforeUpload(f.context);
  await assert.rejects(gate.beforeActivation(f.context), /evidence_record_shape_invalid/);
});
test("capture observation binds exact summary, session and run", () => {
  const f = fixture();
  const expected = {
    sourceRevision: REVISION,
    summarySha256: SHA,
    sessionId: "fixture-session",
    runId: 123,
    attempt: 1,
    now: NOW,
  };
  validateCaptureObservation(f.captureObservation, expected);
  for (const replacement of [
    { summarySha256: "2".repeat(64) },
    { sessionId: "different" },
    { runId: 124 },
    { attempt: 2 },
  ])
    assert.throws(
      () => validateCaptureObservation(f.captureObservation, { ...expected, ...replacement }),
      /context_mismatch/,
    );
});
test("missing or unresolved capture prevents even the live readiness probe", async () => {
  const f = fixture();
  let requests = 0;
  f.bundle.captureObservation = {};
  await assert.rejects(
    verifier(f, async () => {
      requests++;
      return ok();
    }).beforeUpload(f.context),
    /evidence_record_shape_invalid/,
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

test("recorded high/critical findings or nonempty scanner ignores still block", () => {
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
    f.bundle.backend = f.recordEvidence(f.bundle.backend);
    assert.throws(
      () => validateBackendAdmission(f.bundle, f.expected),
      /image_(vulnerability_blocked|scan_invalid)/,
    );
  }
});
test("a measured failed worker or mismatched running-container identity cannot pass", () => {
  const f = fixture();
  const readiness = required(f.bundle.backendReports.readiness).details as {
    worker: { queueConnected: boolean };
  };
  readiness.worker.queueConnected = false;
  f.bundle.backend.reports.readiness = evidenceSha256(f.bundle.backendReports.readiness);
  f.bundle.backend = f.recordEvidence(f.bundle.backend);
  assert.throws(() => validateBackendAdmission(f.bundle, f.expected), /worker_readiness_invalid/);
  const g = fixture();
  const host = required(g.bundle.backendReports.host).details as {
    containers: { sourceRevision: string }[];
  };
  required(host.containers[0]).sourceRevision = "2".repeat(40);
  g.bundle.backend.reports.host = evidenceSha256(g.bundle.backendReports.host);
  g.bundle.backend = g.recordEvidence(g.bundle.backend);
  assert.throws(
    () => validateBackendAdmission(g.bundle, g.expected),
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
  f.bundle.deployment = f.recordEvidence(deployment);
  assert.throws(
    () => validateManagedDeployment(f.bundle, f.expected),
    /managed_runtime_not_qualified/,
  );
});
test("missing Playwright log objects are not an accepted measured capture policy", async () => {
  const f = fixture();
  f.bundle.captureObservation = f.recordEvidence({
    ...f.captureObservation,
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
test("source archive substitution cannot activate the measured output", () => {
  const f = fixture();
  assert.throws(
    () =>
      validateManagedDeployment(f.bundle, {
        ...f.expected,
        sourceArchiveSha256: "f".repeat(64),
      }),
    /managed_source_archive_mismatch/,
  );
});
test("post-activation observation proves the actual selected Site separately from candidate measurement", () => {
  const f = fixture("production");
  const expected = {
    deploymentSha256: evidenceSha256(f.bundle.deployment),
    sourceRevision: REVISION,
    apiOrigin: f.config.apiOrigin,
    siteId: f.config.siteId,
    deploymentId: "fixture-deployment",
    now: NOW,
  };
  validateManagedActivation(f.activation, expected);
  assert.throws(
    () => validateManagedActivation(f.bundle.deployment, expected),
    /evidence_record_shape_invalid/,
  );
  assert.throws(
    () => validateManagedActivation(f.activation, { ...expected, deploymentId: "different" }),
    /activation_not_confirmed/,
  );
  assert.throws(
    () =>
      validateManagedActivation(f.activation, { ...expected, deploymentSha256: "2".repeat(64) }),
    /activation_context_mismatch/,
  );
  assert.throws(
    () => validateManagedActivation(f.activation, { ...expected, now: NOW + 3600000 }),
    /activation_observation_stale/,
  );
});

test("staging revalidation binds live provider identity and uses its distinct readiness token", async () => {
  const production = fixture("production");
  const staging = fixture("staging");
  staging.bundle.backend = production.recordEvidence(staging.bundle.backend);
  staging.bundle.captureObservation = production.recordEvidence(staging.bundle.captureObservation);
  staging.bundle.deployment = production.recordEvidence({
    ...required(staging.bundle.deployment),
    backendAdmissionSha256: evidenceSha256(staging.bundle.backend),
    captureObservationSha256: evidenceSha256(staging.bundle.captureObservation),
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
