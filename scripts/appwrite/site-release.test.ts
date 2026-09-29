import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { MockAgent } from "undici";
import { BRANCH, REPOSITORY, WORKFLOW_POLICIES } from "./github-checks.ts";
import {
  APPWRITE_TARGET,
  createSitesPort,
  exactHttpsOrigin,
  MISSING_QUALIFICATIONS,
  type QualificationVerifier,
  RELEASE_LIMITS,
  ReleaseError,
  type ReleaseReceipt,
  releaseSite,
  SITE_COMMANDS,
  type SiteRecord,
  type SitesPort,
  type TargetConfig,
  unavailableQualification,
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
  const options = {
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
test("inactive upload, exact source/output verification, qualification and confirmed activation remain ordered", async () => {
  const h = harness();
  const receipt = await releaseSite(h.options);
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.previousDeploymentId, "previous-deploy");
  assert.equal(receipt.uploadedDeploymentId, "new-deploy");
  assert.equal(receipt.activeDeploymentId, "new-deploy");
  assert.equal(receipt.sourceArchiveSha256, h.source.archiveSha256);
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
    "qualification-before-activation",
    "get-site",
    "activate",
    "get-site",
    "close",
  ]);
  assert.equal(h.receipts.length, 1);
});
test("real CLI qualification rejects before creating any provider transport", async () => {
  const h = harness();
  h.options.qualification = unavailableQualification;
  const receipt = await releaseSite(h.options);
  assert.equal(receipt.failure, "managed_runtime_qualification_unavailable");
  assert.deepEqual(receipt.missingPrerequisites, MISSING_QUALIFICATIONS);
  assert.deepEqual(h.calls, ["verify-github"]);
});
test("bad GitHub evidence and backend qualification stop before provider mutation", async () => {
  const h = harness();
  h.options.verifyGitHub = () => {
    throw new Error("untrusted input and secret value");
  };
  assert.equal((await releaseSite(h.options)).failure, "release_step_failed");
  assert.equal(h.calls.includes("create-port"), false);
  const other = harness();
  other.options.qualification.beforeUpload = async () => {
    throw new ReleaseError("backend_qualification_unavailable");
  };
  assert.equal((await releaseSite(other.options)).failure, "backend_qualification_unavailable");
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
    const result = await releaseSite(h.options);
    assert.equal(result.status, "failed");
    assert.equal(h.calls.includes("upload-inactive"), false);
  });
}
test("retained previous deployment must be ready and belong to the target", async () => {
  const h = harness();
  h.port.getDeployment = async () => ({ ...h.deployment, resourceId: "other-site" });
  assert.equal((await releaseSite(h.options)).failure, "rollback_deployment_unavailable");
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
  const receipt = await releaseSite(h.options);
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
    assert.equal((await releaseSite(h.options)).status, "failed");
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
  assert.equal((await releaseSite(h.options)).failure, "deployment_readiness_timeout");
  assert.equal(reads, RELEASE_LIMITS.polls);
  assert.equal(h.calls.includes("activate"), false);
});
test("failed and canceled deployments are retained without activation or retry", async () => {
  for (const status of ["failed", "canceled"]) {
    const h = harness();
    h.port.createDeployment = async () => ({ ...h.deployment, status });
    assert.equal((await releaseSite(h.options)).failure, "deployment_build_failed");
    assert.equal(h.calls.includes("activate"), false);
  }
});
test("downloaded source bytes must exactly match the reviewed archive", async () => {
  const h = harness();
  h.port.download = async () => Buffer.from("different source");
  assert.equal((await releaseSite(h.options)).failure, "uploaded_source_identity_mismatch");
  assert.equal(h.calls.includes("activate"), false);
});
test("hosted runtime/backend verifier failure prevents activation", async () => {
  const h = harness();
  h.options.qualification.beforeActivation = async () => {
    throw new ReleaseError("backend_restore_evidence_mismatch");
  };
  assert.equal((await releaseSite(h.options)).failure, "backend_restore_evidence_mismatch");
  assert.equal(h.calls.includes("activate"), false);
});
test("active deployment change after qualification stops promotion", async () => {
  const h = harness();
  h.options.qualification.beforeActivation = async () => h.setActive("concurrent-deploy");
  assert.equal((await releaseSite(h.options)).failure, "active_deployment_changed");
  assert.equal(h.calls.includes("activate"), false);
});
test("uncertain activation is never retried and retains rollback identity", async () => {
  const h = harness();
  let attempts = 0;
  h.port.activate = async () => {
    attempts++;
    throw new Error("uncertain provider response");
  };
  const receipt = await releaseSite(h.options);
  assert.equal(attempts, 1);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.phase, "activation");
  assert.equal(receipt.previousDeploymentId, "previous-deploy");
  assert.equal(receipt.activeDeploymentId, null);
});
test("activation response and readback must name the uploaded deployment", async () => {
  const h = harness();
  h.port.activate = async () => h.site;
  assert.equal((await releaseSite(h.options)).failure, "activation_response_mismatch");
  const other = harness();
  let reads = 0;
  other.port.getSite = async () => {
    reads++;
    return { ...other.site, deploymentId: reads === 3 ? "concurrent" : "previous-deploy" };
  };
  assert.equal((await releaseSite(other.options)).failure, "activation_confirmation_mismatch");
});
test("production requires same source and actual verifier-backed staging acceptance", async () => {
  const h = harness();
  h.options.config = {
    ...h.config,
    target: "production",
    siteId: "production-site",
    otherSiteId: "staging-site",
  };
  assert.equal((await releaseSite(h.options)).failure, "staging_acceptance_missing_or_mismatched");
  assert.equal(h.calls.includes("create-port"), false);
  const staging = harness();
  const receipt = await releaseSite(staging.options);
  assert.doesNotThrow(() => validateStaging(receipt, h.source, h.options.config));
  assert.throws(() =>
    validateStaging({ ...receipt, status: "failed" }, h.source, h.options.config),
  );
  assert.throws(() =>
    validateStaging(
      { ...receipt, sourceArchiveSha256: "0".repeat(64) },
      h.source,
      h.options.config,
    ),
  );
  const next = harness();
  next.options.qualification.verifyStaging = async () => {
    throw new ReleaseError("staging_signature_invalid");
  };
  const result = await releaseSite({
    ...next.options,
    config: h.options.config,
    stagingReceipt: receipt,
  });
  assert.equal(result.failure, "staging_signature_invalid");
  assert.equal(next.calls.includes("create-port"), false);
});
test("deadline and transport cleanup failure never become accepted", async () => {
  const h = harness();
  let now = 0;
  h.options.now = () => now;
  h.options.qualification.beforeUpload = async () => {
    now = RELEASE_LIMITS.totalMs;
  };
  assert.equal((await releaseSite(h.options)).failure, "release_deadline");
  const other = harness();
  other.port.close = async () => {
    throw new Error("private error");
  };
  assert.equal((await releaseSite(other.options)).failure, "transport_cleanup_failed");
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

function cliEvidence(f: ReturnType<typeof fixture>) {
  const SHA = f.source.revision;
  const HASH = f.source.files[1]?.sha256 as string;
  function run(workflow: string, id = 30, attempt = 1) {
    return {
      id,
      run_number: id,
      run_attempt: attempt,
      head_sha: SHA,
      head_branch: BRANCH,
      path: `.github/workflows/${workflow}`,
      event: "push",
      status: "completed",
      conclusion: "success",
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
    };
  }
  function jobs(workflow: keyof typeof WORKFLOW_POLICIES, id = 30, attempt = 1) {
    const policies = WORKFLOW_POLICIES[workflow] ?? {};
    assert.ok(policies);
    return Object.entries(policies).map(([name, policy], i) => ({
      id: 100 + i,
      name,
      run_id: id,
      run_attempt: attempt,
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-29T01:00:00Z",
      completed_at: "2026-09-29T01:01:00Z",
      steps: policy.required.map((step, number) => ({
        name: step,
        number: number + 1,
        status: "completed",
        conclusion: policy.skipped.includes(step) ? "skipped" : "success",
      })),
    }));
  }
  function browser() {
    return {
      kind: "synthetic-browser-ci",
      accepted: true,
      qualificationOrReleaseAcceptance: false,
      build: {
        sha: SHA,
        tree: f.source.tree,
        fileMapSha256: HASH,
        lockSha256: HASH,
        outputsSha256: HASH,
        trackedFiles: 1113,
        buildId: "build-id",
        command:
          "pnpm exec turbo run build --filter=@nutrition-tracker/web... --filter=@nutrition-tracker/api... --filter=@nutrition-tracker/worker... --force",
        nodeVersion: "v22.23.2",
        pnpmVersion: "11.19.0",
      },
      browser: {
        sourceSha: SHA,
        buildId: "build-id",
        status: "passed",
        sessionId: "session-1",
        browserVersion: "141.0",
        browserSessionsAttempted: 1,
        retries: 0,
        origin: "http://127.0.0.1:3287",
        checks: [
          "authenticated-session-persistence",
          "real-search-and-single-add",
          "saved-diary-entry-after-reload",
          "report-agrees-with-saved-day",
          "narrow-diary-remains-usable",
        ],
      },
      terminal: {
        sessionId: "session-1",
        status: "passed",
        browserstackStatus: "done",
        durationSeconds: 40,
        buildName: `nourishing-${SHA}-32-1`,
        projectName: "Nourishing",
        name: "synthetic-login-search-add-report",
      },
      capture: {
        requested: {
          video: false,
          screenshots: false,
          networkLogs: false,
          console: "disable",
          playwrightLogs: false,
          maskCommands: "sendType,sendPress,setHTTPCredentials,setStorageState,setGeolocation",
        },
        observedArtifacts: {
          video_url: "empty",
          har_logs_url: "missing",
          browser_console_logs_url: "null",
          playwright_logs_url: "empty",
        },
        dashboardVerification: "pending-first-run-review",
      },
      cookieAttributesIndependentlyInspected: false,
      cleanup: { failures: [], volumesRetainedUntilEphemeralRunnerTeardown: true },
    };
  }
  function evidence() {
    return {
      schemaVersion: 1,
      repository: REPOSITORY,
      branch: BRANCH,
      revision: SHA,
      tree: f.source.tree,
      lockfileSha256: HASH,
      release: { runId: 900, attempt: 1 },
      target: "staging",
      checkedAt: "2026-09-29T01:02:00Z",
      requiredRuns: Object.keys(WORKFLOW_POLICIES).map((workflow, i) => ({
        workflow,
        run: run(workflow, 30 + i),
        jobs: jobs(workflow as keyof typeof WORKFLOW_POLICIES, 30 + i),
      })),
      browser: {
        summarySha256: sha256(JSON.stringify(browser())),
        summary: browser(),
      },
      productionReview: null,
    };
  }

  return evidence();
}
test("actual deployment CLI reports missing managed runtime/backend qualification without a cloud request", () => {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "nourishing-appwrite-cli-test-"));
  try {
    writeFileSync(join(directory, "source.tar.gz"), f.archive);
    writeFileSync(join(directory, "source-artifact.json"), canonical(f.source));
    writeFileSync(join(directory, "github.json"), canonical(cliEvidence(f)));
    writeFileSync(
      join(directory, "pretend-qualification.json"),
      JSON.stringify({ accepted: true }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./site-release.ts", import.meta.url)),
        "deploy",
        "--target",
        "staging",
        "--artifact",
        directory,
        "--github-evidence",
        join(directory, "github.json"),
        "--qualification",
        join(directory, "pretend-qualification.json"),
        "--receipt",
        join(directory, "receipt.json"),
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          APPWRITE_DEPLOY_KEY: "synthetic-offline-key",
          APPWRITE_SITE_ID: f.config.siteId,
          APPWRITE_OTHER_SITE_ID: f.config.otherSiteId,
          WEB_PUBLIC_ORIGIN: f.config.webOrigin,
          API_INTERNAL_URL: f.config.apiOrigin,
          APPWRITE_BUILD_SPECIFICATION: f.config.buildSpecification,
          APPWRITE_RUNTIME_SPECIFICATION: f.config.runtimeSpecification,
          GITHUB_RUN_ID: "900",
          GITHUB_RUN_ATTEMPT: "1",
        },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
    assert.equal(receipt.failure, "managed_runtime_qualification_unavailable");
    assert.deepEqual(receipt.missingPrerequisites, MISSING_QUALIFICATIONS);
    assert.equal(receipt.uploadedDeploymentId, null);
    assert.equal(JSON.parse(result.stdout).failure, receipt.failure);
    assert.equal((result.stdout + result.stderr).includes("synthetic-offline-key"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
    const options = {
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
    const receipt = await releaseSite(options);
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
  const receipt = await releaseSite(h.options);
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
