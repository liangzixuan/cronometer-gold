import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { MockAgent } from "undici";
import {
  APPWRITE_TARGET,
  activateSite,
  createSitesPort,
  exactHttpsOrigin,
  prepareSite,
  type QualificationVerifier,
  qualificationOptionsFromEnvironment,
  RELEASE_LIMITS,
  ReleaseError,
  type ReleaseOptions,
  type ReleaseReceipt,
  SITE_COMMANDS,
  type SiteRecord,
  type SitesPort,
  type TargetConfig,
  validateStaging,
  validateTarget,
  verifyOutputArchive,
} from "./site-release.ts";
import {
  canonical,
  gitTreeIdentity,
  META_PATH,
  makeTar,
  readTarGzip,
  type SourceArtifact,
  type SourceFile,
  sha256,
  type TarEntry,
} from "./source-artifact.ts";

function fixture() {
  const revision = "1".repeat(40);
  const sourceEntries: [TarEntry, TarEntry, TarEntry] = [
    { path: "apps/web/public/icon.svg", mode: 0o644, type: "file", data: Buffer.from("<svg/>") },
    {
      path: "pnpm-lock.yaml",
      mode: 0o644,
      type: "file",
      data: Buffer.from("lockfileVersion: '9.0'\n"),
    },
    {
      path: "scripts/appwrite/start-site.cjs",
      mode: 0o644,
      type: "file",
      data: Buffer.from("fixture launcher\n"),
    },
  ];
  const files: SourceFile[] = sourceEntries.map((entry) => ({
    path: entry.path,
    mode: "100644",
    size: entry.data.length,
    sha256: sha256(entry.data),
  }));
  const tree = gitTreeIdentity(files, new Map(sourceEntries.map((entry) => [entry.path, entry])));
  const manifest = { schemaVersion: 1, revision, tree, files };
  const embedded = canonical(manifest);
  const archive = gzipSync(
    makeTar([{ path: META_PATH, mode: 0o644, type: "file", data: embedded }, ...sourceEntries]),
  );
  const source: SourceArtifact = {
    ...manifest,
    schemaVersion: 1,
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    manifestSha256: sha256(embedded),
  };
  const outputEntries: TarEntry[] = [
    {
      path: "payload/apps/web/.next/BUILD_ID",
      mode: 0o644,
      type: "file",
      data: Buffer.from("fixtureBuild\n"),
    },
    {
      path: "payload/apps/web/.next/static/chunk.js",
      mode: 0o644,
      type: "file",
      data: Buffer.from("fixture asset\n"),
    },
    {
      path: "payload/apps/web/public/icon.svg",
      mode: 0o644,
      type: "file",
      data: sourceEntries[0].data,
    },
    {
      path: "payload/apps/web/server.js",
      mode: 0o644,
      type: "file",
      data: Buffer.from("fixture server\n"),
    },
    { path: "start-site.cjs", mode: 0o644, type: "file", data: sourceEntries[2].data },
  ];
  const output = outputArchive(source, outputEntries);
  const config: TargetConfig = {
    target: "staging",
    siteId: "staging-site",
    otherSiteId: "production-site",
    webOrigin: "https://staging.nourishing.example.com",
    apiOrigin: "https://api-staging.nourishing.example.com",
    buildSpecification: "s-2vcpu-2gb",
    runtimeSpecification: "s-1vcpu-1gb",
  };
  const site: SiteRecord = {
    $id: config.siteId,
    enabled: true,
    framework: "nextjs",
    adapter: "ssr",
    buildRuntime: "node-22",
    deploymentId: "previous-deploy",
    deploymentRetention: 0,
    scopes: [],
    ...SITE_COMMANDS,
    installationId: "",
    providerRepositoryId: "",
    buildSpecification: config.buildSpecification,
    runtimeSpecification: config.runtimeSpecification,
    vars: [
      { key: "WEB_PUBLIC_ORIGIN", value: config.webOrigin },
      { key: "API_INTERNAL_URL", value: config.apiOrigin },
      { key: "NODE_ENV", value: "production" },
    ],
  };
  return { source, archive, output, config, site, outputEntries };
}
function outputArchive(
  source: SourceArtifact,
  entries: TarEntry[],
  override: Record<string, unknown> = {},
) {
  const files = entries
    .filter((entry) => entry.type !== "directory")
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.type === "symlink" ? "120000" : entry.mode === 0o755 ? "100755" : "100644",
      size:
        entry.type === "symlink" ? Buffer.byteLength(entry.target as string) : entry.data.length,
      sha256: sha256(entry.type === "symlink" ? (entry.target as string) : entry.data),
      ...(entry.type === "symlink" ? { target: entry.target } : {}),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    schemaVersion: 1,
    revision: source.revision,
    tree: source.tree,
    sourceManifestSha256: source.manifestSha256,
    buildId: "fixtureBuild",
    entrypoint: "start-site.cjs",
    payloadEntrypoint: "payload/apps/web/server.js",
    files,
    outputTreeSha256: sha256(JSON.stringify(files)),
    ...override,
  };
  return gzipSync(
    makeTar([
      ...entries,
      { path: "output-manifest.json", type: "file", mode: 0o644, data: canonical(manifest) },
    ]),
  );
}
function harness() {
  const f = fixture();
  const calls: string[] = [];
  const receipts: ReleaseReceipt[] = [];
  let active = f.site.deploymentId;
  const current = () => ({ ...f.site, deploymentId: active });
  const deployment = {
    $id: "new-deploy",
    resourceId: f.config.siteId,
    resourceType: "sites",
    status: "ready",
    activate: false,
    sourceSize: f.archive.length,
  };
  const port: SitesPort = {
    async getSite() {
      calls.push("get-site");
      return current();
    },
    async createDeployment(siteId, archive, progress) {
      calls.push("upload-inactive");
      assert.equal(siteId, f.config.siteId);
      assert.deepEqual(archive, f.archive);
      progress("new-deploy");
      return { ...deployment };
    },
    async getDeployment(_siteId, id) {
      calls.push(`get-deployment:${id}`);
      return { ...deployment, $id: id };
    },
    async download(_siteId, _id, type) {
      calls.push(`download:${type}`);
      return type === "source" ? f.archive : f.output;
    },
    async activate(_siteId, id) {
      calls.push("activate");
      active = id;
      return current();
    },
    async close() {
      calls.push("close");
    },
  };
  const options: ReleaseOptions = {
    ...f,
    githubEvidence: {
      fixture: "GitHub verification is injected only for offline controller tests",
    },
    qualification: {
      async beforeUpload() {
        calls.push("qualification-before-upload");
      },
      async beforeActivation() {
        calls.push("qualification-before-activation");
      },
      async verifyStaging() {
        calls.push("verify-staging");
      },
    } as QualificationVerifier,
    verifyGitHub: (
      _value: unknown,
      expected: { revision: string; tree: string; lockfileSha256: string; target: string },
    ) => {
      calls.push("verify-github");
      assert.equal(expected.revision, f.source.revision);
      assert.equal(expected.tree, f.source.tree);
      assert.equal(expected.lockfileSha256, f.source.files[1]?.sha256);
      return { verified: true };
    },
    createPort: () => {
      calls.push("create-port");
      return port;
    },
    saveReceipt: (receipt: ReleaseReceipt) => {
      receipts.push(structuredClone(receipt));
    },
    sleep: async () => {
      calls.push("sleep");
    },
    now: () => Date.parse("2026-09-29T07:00:00Z"),
  };
  return {
    ...f,
    calls,
    receipts,
    port,
    options,
    deployment,
    setActive: (id: string) => {
      active = id;
    },
  };
}
async function prepared(h: ReturnType<typeof harness>) {
  const candidateReceipt = await prepareSite(h.options);
  assert.equal(candidateReceipt.status, "candidate-prepared", candidateReceipt.failure ?? "");
  h.calls.length = 0;
  h.receipts.length = 0;
  return { ...h.options, candidateReceipt };
}
test("preparation uploads once and verifies exact source/output without activation or final qualification", async () => {
  const h = harness();
  const receipt = await prepareSite(h.options);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.status, "candidate-prepared");
  assert.equal(receipt.operation, "prepare");
  assert.equal(receipt.activationOutcome, "not-attempted");
  assert.equal(receipt.previousDeploymentId, "previous-deploy");
  assert.equal(receipt.uploadedDeploymentId, "new-deploy");
  assert.equal(receipt.activeDeploymentId, "previous-deploy");
  assert.equal(receipt.output?.outputArchiveSha256, sha256(h.output));
  assert.deepEqual(h.calls, [
    "verify-github",
    "qualification-before-upload",
    "create-port",
    "get-site",
    "get-deployment:previous-deploy",
    "upload-inactive",
    "download:source",
    "download:output",
    "get-site",
    "close",
  ]);
  assert.equal(h.receipts.length, 1);
});
test("activation rereads the candidate and current authority before a single confirmed mutation", async () => {
  const h = harness();
  const options = await prepared(h);
  h.options.qualification.beforeActivation = async (context) => {
    h.calls.push("qualification-before-activation");
    assert.deepEqual(context.githubEvidence, { verified: true });
    assert.equal(context.deployment?.$id, "new-deploy");
    assert.equal(context.site?.$id, h.config.siteId);
    assert.equal(context.output?.outputArchiveSha256, sha256(h.output));
  };
  const receipt = await activateSite(options);
  assert.equal(receipt.status, "activated");
  assert.equal(receipt.operation, "activate");
  assert.equal(receipt.activationOutcome, "confirmed-candidate");
  assert.equal(receipt.activeDeploymentId, "new-deploy");
  assert.deepEqual(h.calls, [
    "verify-github",
    "qualification-before-upload",
    "create-port",
    "get-site",
    "get-deployment:previous-deploy",
    "get-deployment:new-deploy",
    "download:source",
    "download:output",
    "verify-github",
    "qualification-before-upload",
    "qualification-before-activation",
    "get-site",
    "get-deployment:previous-deploy",
    "activate",
    "get-site",
    "close",
  ]);
  assert.equal(h.receipts.length, 1);
});
test("activation rejects absent, failed, cross-target, substituted and already active candidate receipts before provider access", async () => {
  const h = harness();
  const { candidateReceipt } = await prepared(h);
  for (const candidate of [
    undefined,
    { ...candidateReceipt, status: "failed" },
    { ...candidateReceipt, operation: "activate" },
    { ...candidateReceipt, configSha256: "0".repeat(64) },
    { ...candidateReceipt, sourceArchiveSha256: "0".repeat(64) },
    { ...candidateReceipt, siteId: "other-site" },
    { ...candidateReceipt, cleanupFailure: "transport_cleanup_failed" },
    { ...candidateReceipt, uploadedDeploymentId: "previous-deploy" },
  ]) {
    h.calls.length = 0;
    const result = await activateSite({
      ...h.options,
      candidateReceipt: candidate as ReleaseReceipt | undefined,
    });
    assert.equal(result.failure, "candidate_receipt_mismatch");
    assert.equal(h.calls.includes("create-port"), false);
  }
});
test("bad GitHub evidence and backend qualification stop before provider mutation", async () => {
  const h = harness();
  h.options.verifyGitHub = () => {
    throw new Error("untrusted input and secret value");
  };
  assert.equal((await prepareSite(h.options)).failure, "release_step_failed");
  assert.equal(h.calls.includes("create-port"), false);
  const other = harness();
  other.options.qualification.beforeUpload = async () => {
    throw new ReleaseError("backend_qualification_unavailable");
  };
  assert.equal((await prepareSite(other.options)).failure, "backend_qualification_unavailable");
  assert.equal(other.calls.includes("create-port"), false);
});
for (const origin of [
  "http://example.com",
  "https://example.com/",
  "https://example.com/path",
  "https://example.com:444",
  "https://user:password@example.com",
  "https://example.com?x=1",
  "https://127.0.0.1",
  "https://localhost",
  "https://api.local",
  "https://[::1]",
]) {
  test(`reject untrusted origin ${origin}`, () =>
    assert.throws(() => exactHttpsOrigin(origin), /invalid_target_origin/));
}
test("targets must be distinct Sites and origins", () => {
  const { config } = fixture();
  validateTarget(config);
  assert.throws(
    () => validateTarget({ ...config, otherSiteId: config.siteId }),
    /invalid_target_configuration/,
  );
  assert.throws(
    () => validateTarget({ ...config, apiOrigin: config.webOrigin }),
    /backend_origin_must_be_distinct/,
  );
  assert.throws(
    () => validateTarget({ ...config, siteId: "../other" }),
    /invalid_target_configuration/,
  );
});
for (const update of [
  { $id: "other-site" },
  { framework: "react" },
  { adapter: "static" },
  { buildRuntime: "node-24" },
  { installationId: "git-auto-deploy" },
  { providerRepositoryId: "competing-repo" },
  { scopes: ["databases.write"] },
  { deploymentRetention: 1 },
  { buildSpecification: "unapproved" },
  { startCommand: "node other.js" },
  { enabled: false },
  { vars: [] },
]) {
  test(`reject changed Site configuration ${Object.keys(update)[0]}`, async () => {
    const h = harness();
    h.port.getSite = async () => ({ ...h.site, ...update });
    const result = await prepareSite(h.options);
    assert.equal(result.status, "failed");
    assert.equal(h.calls.includes("upload-inactive"), false);
  });
}
test("retained previous deployment must be ready and belong to the target", async () => {
  const h = harness();
  h.port.getDeployment = async () => ({ ...h.deployment, resourceId: "other-site" });
  assert.equal((await prepareSite(h.options)).failure, "rollback_deployment_unavailable");
  assert.equal(h.calls.includes("upload-inactive"), false);
});
test("uncertain partial upload preserves the known ID, redacts errors and never retries", async () => {
  const h = harness();
  let uploads = 0;
  h.port.createDeployment = async (_site, _archive, progress) => {
    uploads++;
    progress("partial-deploy");
    throw new Error("APPWRITE_DEPLOY_KEY=fixture-secret provider body");
  };
  const receipt = await prepareSite(h.options);
  assert.equal(uploads, 1);
  assert.equal(receipt.uploadedDeploymentId, "partial-deploy");
  assert.equal(receipt.phase, "upload");
  assert.equal(receipt.failure, "release_step_failed");
  assert.equal(JSON.stringify(receipt).includes("fixture-secret"), false);
  assert.equal(h.calls.at(-1), "close");
});
test("autoactivation or wrong upload identity is rejected", async () => {
  for (const update of [
    { activate: true },
    { resourceId: "wrong" },
    { $id: "another-id" },
    { sourceSize: 1 },
  ]) {
    const h = harness();
    h.port.createDeployment = async (_site, _bytes, progress) => {
      progress("new-deploy");
      return { ...h.deployment, ...update };
    };
    assert.equal((await prepareSite(h.options)).status, "failed");
    assert.equal(h.calls.includes("activate"), false);
  }
});
test("readiness polling has a fixed bound with no new uploads", async () => {
  const h = harness();
  let reads = 0;
  h.port.createDeployment = async () => ({ ...h.deployment, status: "building" });
  h.port.getDeployment = async (_site, id) => {
    if (id === "previous-deploy") return { ...h.deployment, $id: id };
    reads++;
    return { ...h.deployment, status: "building" };
  };
  assert.equal((await prepareSite(h.options)).failure, "deployment_readiness_timeout");
  assert.equal(reads, RELEASE_LIMITS.polls);
  assert.equal(h.calls.includes("activate"), false);
});
test("failed and canceled deployments are retained without activation or retry", async () => {
  for (const status of ["failed", "canceled"]) {
    const h = harness();
    h.port.createDeployment = async () => ({ ...h.deployment, status });
    assert.equal((await prepareSite(h.options)).failure, "deployment_build_failed");
    assert.equal(h.calls.includes("activate"), false);
  }
});
test("downloaded source bytes must exactly match the reviewed archive", async () => {
  const h = harness();
  h.port.download = async () => Buffer.from("different source");
  assert.equal((await prepareSite(h.options)).failure, "uploaded_source_identity_mismatch");
  assert.equal(h.calls.includes("activate"), false);
});
test("hosted runtime/backend verifier failure prevents activation and preserves inactive candidate", async () => {
  const h = harness();
  const options = await prepared(h);
  options.qualification.beforeActivation = async () => {
    throw new ReleaseError("backend_restore_evidence_mismatch");
  };
  assert.equal((await activateSite(options)).failure, "backend_restore_evidence_mismatch");
  assert.equal(h.calls.includes("activate"), false);
  assert.equal(h.calls.includes("upload-inactive"), false);
});
test("activation rechecks current GitHub evidence and passes only the newly verified response to final qualification", async () => {
  const h = harness();
  const options = await prepared(h);
  let calls = 0;
  options.verifyGitHub = async () => ({ phase: ++calls });
  options.qualification.beforeActivation = async (context) =>
    assert.deepEqual(context.githubEvidence, { phase: 2 });
  assert.equal((await activateSite(options)).status, "activated");
  assert.equal(calls, 2);
  const changed = harness();
  const changedOptions = await prepared(changed);
  let reads = 0;
  changedOptions.verifyGitHub = async () => {
    if (++reads === 2) throw new ReleaseError("github_state_changed");
    return {};
  };
  assert.equal((await activateSite(changedOptions)).failure, "github_state_changed");
  assert.equal(changed.calls.includes("activate"), false);
});
test("actual candidate must still be inactive, ready, source-identical and output-identical", async () => {
  for (const mode of ["active", "building", "source", "output"] as const) {
    const h = harness();
    const options = await prepared(h);
    if (mode === "active") h.setActive("new-deploy");
    if (mode === "building") {
      const original = h.port.getDeployment;
      h.port.getDeployment = async (site, id) => ({
        ...(await original(site, id)),
        ...(id === "new-deploy" ? { status: "building" } : {}),
      });
    }
    if (mode === "source") h.port.download = async () => Buffer.from("substituted");
    if (mode === "output") {
      const output = outputArchive(
        h.source,
        h.outputEntries.map((entry) =>
          entry.path.endsWith("chunk.js")
            ? { ...entry, data: Buffer.from("different build") }
            : entry,
        ),
      );
      h.port.download = async (_site, _id, type) => (type === "source" ? h.archive : output);
    }
    const receipt = await activateSite(options);
    assert.equal(receipt.status, "failed");
    assert.equal(h.calls.includes("activate"), false);
  }
});
test("active deployment change after qualification stops promotion", async () => {
  const h = harness();
  const options = await prepared(h);
  options.qualification.beforeActivation = async () => h.setActive("concurrent-deploy");
  assert.equal((await activateSite(options)).failure, "active_deployment_changed");
  assert.equal(h.calls.includes("activate"), false);
});
for (const outcome of [
  "confirmed-candidate",
  "confirmed-previous",
  "confirmed-other",
  "unknown",
] as const) {
  test(`ambiguous activation reconciles ${outcome} with one read and never retries or rolls back`, async () => {
    const h = harness();
    const options = await prepared(h);
    let attempts = 0;
    let reconciliationReads = 0;
    const getSite = h.port.getSite;
    h.port.getSite = async (site) => {
      if (attempts) {
        reconciliationReads++;
        if (outcome === "unknown") throw new Error("private transport details");
      }
      return getSite(site);
    };
    h.port.activate = async () => {
      attempts++;
      if (outcome === "confirmed-candidate") h.setActive("new-deploy");
      if (outcome === "confirmed-other") h.setActive("other-deploy");
      throw new Error("uncertain secret provider response");
    };
    const receipt = await activateSite(options);
    assert.equal(attempts, 1);
    assert.equal(reconciliationReads, 1);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.activationOutcome, outcome);
    assert.equal(receipt.previousDeploymentId, "previous-deploy");
    assert.equal(JSON.stringify(receipt).includes("secret"), false);
  });
}
test("activation response and readback mismatches fail even when reconciliation finds the candidate", async () => {
  const h = harness();
  const options = await prepared(h);
  h.port.activate = async () => h.site;
  assert.equal((await activateSite(options)).failure, "activation_response_mismatch");
  const other = harness();
  const otherOptions = await prepared(other);
  let reads = 0;
  other.port.getSite = async () => ({
    ...other.site,
    deploymentId: ++reads === 3 ? "concurrent" : "previous-deploy",
  });
  assert.equal((await activateSite(otherOptions)).failure, "activation_confirmation_mismatch");
});
async function productionHarness() {
  const staging = harness();
  const staged = await activateSite(await prepared(staging));
  assert.equal(staged.status, "activated");
  const h = harness();
  const config: TargetConfig = {
    ...h.config,
    target: "production",
    siteId: "production-site",
    otherSiteId: "staging-site",
    webOrigin: "https://nourishing.example.com",
    apiOrigin: "https://api.nourishing.example.com",
  };
  const site = {
    ...h.site,
    $id: config.siteId,
    vars: [
      { key: "WEB_PUBLIC_ORIGIN", value: config.webOrigin },
      { key: "API_INTERNAL_URL", value: config.apiOrigin },
      { key: "NODE_ENV", value: "production" },
    ],
  };
  let active = "previous-deploy";
  h.port.getSite = async () => ({ ...site, deploymentId: active });
  h.port.getDeployment = async (_site, id) => ({
    ...h.deployment,
    $id: id,
    resourceId: config.siteId,
  });
  h.port.createDeployment = async (_site, _archive, progress) => {
    h.calls.push("upload-inactive");
    progress("new-deploy");
    return { ...h.deployment, resourceId: config.siteId };
  };
  h.port.activate = async (_site, id) => {
    h.calls.push("activate");
    active = id;
    return { ...site, deploymentId: active };
  };
  const options: ReleaseOptions = {
    ...h.options,
    config,
    stagingConfig: staging.config,
    stagingReceipt: staged,
    createStagingPort: () => {
      h.calls.push("create-staging-port");
      return staging.port;
    },
  };
  return { ...h, options, staging, staged };
}
test("production requires actual staging Site, deployment, source and output observations before upload", async () => {
  const h = await productionHarness();
  h.staging.calls.length = 0;
  h.options.qualification.verifyStaging = async (receipt, context) => {
    h.calls.push("verify-staging");
    assert.equal(receipt.status, "activated");
    assert.equal(context.staging?.site.deploymentId, receipt.activeDeploymentId);
    assert.equal(context.staging?.deployment.$id, receipt.activeDeploymentId);
    assert.deepEqual(context.staging?.output, receipt.output);
  };
  assert.equal((await prepareSite(h.options)).status, "candidate-prepared");
  assert.ok(h.calls.indexOf("verify-staging") < h.calls.indexOf("upload-inactive"));
  assert.deepEqual(h.staging.calls, [
    "get-site",
    "get-deployment:new-deploy",
    "download:source",
    "download:output",
    "get-site",
    "close",
  ]);
});
test("production activation freshly rechecks staging rather than trusting earlier preparation", async () => {
  const h = await productionHarness();
  const candidateReceipt = await prepareSite(h.options);
  h.calls.length = 0;
  h.staging.setActive("staging-drift");
  const result = await activateSite({ ...h.options, candidateReceipt });
  assert.equal(result.failure, "staging_active_deployment_changed");
  assert.equal(h.calls.includes("activate"), false);
});
for (const mode of [
  "receipt",
  "config",
  "deployment",
  "source",
  "output",
  "signature",
  "concurrent",
] as const) {
  test(`production rejects staging ${mode} drift before upload`, async () => {
    const h = await productionHarness();
    assert.ok(h.staged.output);
    if (mode === "receipt")
      h.options.stagingReceipt = { ...h.staged, status: "candidate-prepared" };
    if (mode === "config")
      h.options.stagingConfig = { ...h.staging.config, apiOrigin: h.options.config.apiOrigin };
    if (mode === "deployment")
      h.staging.port.getDeployment = async () => ({ ...h.deployment, resourceId: "another-site" });
    if (mode === "source") h.staging.port.download = async () => Buffer.from("swapped source");
    if (mode === "output")
      h.options.stagingReceipt = {
        ...h.staged,
        output: { ...h.staged.output, outputArchiveSha256: "0".repeat(64) },
      };
    if (mode === "signature")
      h.options.qualification.verifyStaging = async () => {
        throw new ReleaseError("staging_signature_invalid");
      };
    if (mode === "concurrent")
      h.options.qualification.verifyStaging = async () => h.staging.setActive("concurrent-staging");
    assert.equal((await prepareSite(h.options)).status, "failed");
    assert.equal(h.calls.includes("upload-inactive"), false);
    assert.equal(h.calls.includes("activate"), false);
  });
}
test("saved staging acceptance must name the exact source and successful reviewed activation", async () => {
  const h = await productionHarness();
  assert.doesNotThrow(() => validateStaging(h.staged, h.source, h.options.config));
  for (const receipt of [
    { ...h.staged, status: "failed" },
    { ...h.staged, sourceArchiveSha256: "0".repeat(64) },
  ])
    assert.throws(() => validateStaging(receipt as ReleaseReceipt, h.source, h.options.config));
});
test("deadline and transport cleanup failure never become accepted", async () => {
  const h = harness();
  let now = 0;
  h.options.now = () => now;
  h.options.qualification.beforeUpload = async () => {
    now = RELEASE_LIMITS.totalMs;
  };
  assert.equal((await prepareSite(h.options)).failure, "release_deadline");
  const other = harness();
  other.port.close = async () => {
    throw new Error("private error");
  };
  assert.equal((await prepareSite(other.options)).failure, "transport_cleanup_failed");
});
test("output archive validates complete entries and source identities independently", () => {
  const { output, source } = fixture();
  const value = verifyOutputArchive(output, source);
  assert.equal(value.outputArchiveSha256, sha256(output));
  assert.notEqual(value.outputArchiveSha256, source.archiveSha256);
});
test("output rejects source swaps, missing server/static/public and altered launcher", () => {
  const f = fixture();
  assert.throws(
    () =>
      verifyOutputArchive(
        outputArchive(f.source, f.outputEntries, { revision: "2".repeat(40) }),
        f.source,
      ),
    /output_identity_mismatch/,
  );
  for (const path of [
    "payload/apps/web/server.js",
    "payload/apps/web/.next/static/chunk.js",
    "payload/apps/web/public/icon.svg",
    "start-site.cjs",
  ]) {
    assert.throws(() =>
      verifyOutputArchive(
        outputArchive(
          f.source,
          f.outputEntries.filter((item) => item.path !== path),
        ),
        f.source,
      ),
    );
  }
  assert.throws(
    () =>
      verifyOutputArchive(
        outputArchive(
          f.source,
          f.outputEntries.map((entry) =>
            entry.path === "start-site.cjs" ? { ...entry, data: Buffer.from("changed") } : entry,
          ),
        ),
        f.source,
      ),
    /output_required_file_mismatch/,
  );
});
test("output permits contained pnpm links but rejects escapes, cycles and dangling links", () => {
  const f = fixture();
  const link = (target: string): TarEntry => ({
    path: "payload/server-link",
    mode: 0o777,
    type: "symlink",
    target,
    data: Buffer.alloc(0),
  });
  assert.doesNotThrow(() =>
    verifyOutputArchive(
      outputArchive(f.source, [...f.outputEntries, link("apps/web/server.js")]),
      f.source,
    ),
  );
  for (const target of ["../../outside", "/etc/passwd", "missing", "server-link"])
    assert.throws(() =>
      verifyOutputArchive(outputArchive(f.source, [...f.outputEntries, link(target)]), f.source),
    );
});
test("official SDK rejects an alternate Site before any network request", async () => {
  const { config } = fixture();
  const port = createSitesPort(config, "synthetic-offline-key");
  try {
    await assert.rejects(port.getSite("other-site"), /provider_target_rejected/);
  } finally {
    await port.close();
  }
  assert.equal(APPWRITE_TARGET.endpoint, "https://nyc.cloud.appwrite.io/v1");
});

test("CLI rejects the removed deploy operation and requires explicit qualification before opening transport", () => {
  for (const args of [
    ["deploy"],
    [
      "prepare",
      "--target",
      "staging",
      "--artifact",
      "/unused",
      "--github-evidence",
      "/unused",
      "--receipt",
      "/unused",
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./site-release.ts", import.meta.url)), ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, APPWRITE_DEPLOY_KEY: "synthetic-offline-key" },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Appwrite release admission failed/);
    assert.equal((result.stdout + result.stderr).includes("synthetic-offline-key"), false);
  }
});
test("read-only staging SDK port rejects both upload and activation before any request", async () => {
  const h = harness();
  const mock = new MockAgent();
  mock.disableNetConnect();
  const port = createSitesPort(h.config, "synthetic-offline-key", mock, { readOnly: true });
  try {
    await assert.rejects(port.activate(h.config.siteId, "new-deploy"), /provider_target_rejected/);
    await assert.rejects(
      port.createDeployment(h.config.siteId, h.archive, () => {}),
      /provider_target_rejected/,
    );
  } finally {
    await port.close();
  }
});
test("provider request budget is shared across target and staging transports", async () => {
  const h = harness();
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock
    .get("https://nyc.cloud.appwrite.io")
    .intercept({ path: `/v1/sites/${h.config.siteId}`, method: "GET" })
    .reply(200, JSON.stringify(h.site), { headers: { "content-type": "application/json" } });
  const budget = { requests: RELEASE_LIMITS.requests - 1, deadlineAt: Date.now() + 30000 };
  const first = createSitesPort(h.config, "synthetic-offline-key", mock, { budget });
  const secondMock = new MockAgent();
  secondMock.disableNetConnect();
  const second = createSitesPort(h.config, "synthetic-offline-key", secondMock, {
    readOnly: true,
    budget,
  });
  try {
    await first.getSite(h.config.siteId);
    await assert.rejects(second.getSite(h.config.siteId), /provider_request/);
    assert.equal(budget.requests, RELEASE_LIMITS.requests + 1);
    mock.assertNoPendingInterceptors();
  } finally {
    await first.close();
    await second.close();
  }
});
test("official SDK transport bounds and redacts provider responses without network access", async () => {
  for (const mode of ["provider-error", "encoded", "oversize", "redirect", "retry-421"]) {
    const f = fixture();
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get("https://nyc.cloud.appwrite.io");
    const status =
      mode === "redirect"
        ? 302
        : mode === "retry-421"
          ? 421
          : mode === "provider-error"
            ? 500
            : 200;
    const headers = {
      "content-type": "application/json",
      ...(mode === "encoded" ? { "content-encoding": "gzip" } : {}),
      ...(mode === "oversize" ? { "content-length": String(1024 * 1024 + 1) } : {}),
      ...(mode === "redirect" ? { location: "https://elsewhere.example.com" } : {}),
    };
    pool
      .intercept({ path: `/v1/sites/${f.config.siteId}`, method: "GET" })
      .reply(status, JSON.stringify({ message: "provider-secret-body", code: status }), {
        headers,
      });
    const port = createSitesPort(f.config, "synthetic-offline-key", mock);
    try {
      await assert.rejects(
        port.getSite(f.config.siteId),
        (error: unknown) =>
          error instanceof ReleaseError && error.message === "provider_request_failed",
      );
      mock.assertNoPendingInterceptors();
    } finally {
      await port.close();
    }
  }
});
test("official SDK transport enforces the total request count", async () => {
  const f = fixture();
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock
    .get("https://nyc.cloud.appwrite.io")
    .intercept({ path: `/v1/sites/${f.config.siteId}`, method: "GET" })
    .reply(200, JSON.stringify(f.site), { headers: { "content-type": "application/json" } })
    .times(RELEASE_LIMITS.requests);
  const port = createSitesPort(f.config, "synthetic-offline-key", mock);
  try {
    for (let i = 0; i < RELEASE_LIMITS.requests; i++) await port.getSite(f.config.siteId);
    await assert.rejects(port.getSite(f.config.siteId), /provider_request/);
    mock.assertNoPendingInterceptors();
  } finally {
    await port.close();
  }
});

test("invalid admission identities never enter a retained receipt", async () => {
  const marker = "synthetic-private-marker".repeat(1000);
  for (const section of ["source", "config"] as const) {
    const h = harness();
    const options: ReleaseOptions = {
      ...h.options,
      [section]:
        section === "source"
          ? {
              ...h.options.source,
              revision: marker,
              tree: marker,
              archiveSha256: marker,
              manifestSha256: marker,
            }
          : { ...h.options.config, siteId: marker },
    };
    const receipt = await prepareSite(options);
    assert.equal(receipt.status, "failed");
    assert.equal(JSON.stringify(receipt).includes("synthetic-private-marker"), false);
    assert.equal(JSON.stringify(receipt).length < 2048, true);
    assert.equal(receipt.revision, "");
    assert.equal(receipt.siteId, "");
    assert.equal(h.calls.includes("create-port"), false);
  }
});

test("transport cleanup failure preserves the primary upload failure", async () => {
  const h = harness();
  h.port.createDeployment = async () => {
    throw new ReleaseError("provider_request_failed");
  };
  h.port.close = async () => {
    throw new Error("synthetic provider cleanup detail");
  };
  const receipt = await prepareSite(h.options);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.failure, "provider_request_failed");
  assert.equal(receipt.cleanupFailure, "transport_cleanup_failed");
  assert.equal(JSON.stringify(receipt).includes("synthetic provider cleanup detail"), false);
});

test("provider metadata exception accepts only a bounded regular file with safe mode", () => {
  const f = fixture();
  const entries = readTarGzip(f.output);
  const regular: TarEntry = {
    path: ".open-runtimes",
    type: "file",
    mode: 0o644,
    data: Buffer.from("OPEN_RUNTIMES_COMPRESSION=gzip"),
  };
  assert.equal(
    verifyOutputArchive(gzipSync(makeTar([...entries, regular])), f.source).revision,
    f.source.revision,
  );
  for (const extra of [
    { ...regular, type: "symlink" as const, data: Buffer.alloc(0), target: "../outside" },
    { ...regular, mode: 0o666 },
    { ...regular, data: Buffer.alloc(4097) },
  ]) {
    assert.throws(
      () => verifyOutputArchive(gzipSync(makeTar([...entries, extra])), f.source),
      /output_unexpected_file/,
    );
  }
});

test("CLI optional readiness secrets treat GitHub empty values as absent without sharing target credentials", () => {
  assert.deepEqual(qualificationOptionsFromEnvironment("/review.json", {}), {
    qualificationPath: "/review.json",
  });
  assert.deepEqual(
    qualificationOptionsFromEnvironment("/review.json", {
      APPWRITE_BACKEND_READINESS_TOKEN: "",
      APPWRITE_STAGING_READINESS_TOKEN: "",
    }),
    { qualificationPath: "/review.json" },
  );
  const target = "a".repeat(64),
    staging = "b".repeat(64);
  assert.deepEqual(
    qualificationOptionsFromEnvironment("/review.json", {
      APPWRITE_BACKEND_READINESS_TOKEN: target,
      APPWRITE_STAGING_READINESS_TOKEN: staging,
    }),
    { qualificationPath: "/review.json", readinessToken: target, stagingReadinessToken: staging },
  );
  assert.deepEqual(
    qualificationOptionsFromEnvironment("/review.json", {
      APPWRITE_BACKEND_READINESS_TOKEN: target,
      APPWRITE_STAGING_READINESS_TOKEN: "",
    }),
    { qualificationPath: "/review.json", readinessToken: target },
  );
});
test("CLI preserves nonempty malformed readiness credentials for fail-closed qualification", () => {
  for (const token of [" ", "a".repeat(63), "A".repeat(64), "a".repeat(64).concat("\n")])
    assert.deepEqual(
      qualificationOptionsFromEnvironment("/review.json", {
        APPWRITE_BACKEND_READINESS_TOKEN: token,
        APPWRITE_STAGING_READINESS_TOKEN: token,
      }),
      { qualificationPath: "/review.json", readinessToken: token, stagingReadinessToken: token },
    );
});
