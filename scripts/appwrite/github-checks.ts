import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "liangzixuan/cronometer-gold";
export const BRANCH = "codex/retention-features";
const JSON_LIMIT = 2 * 1024 * 1024;
const LOG_LIMIT = 8 * 1024 * 1024;
const RELEASE_WORKFLOW = "appwrite-site-release.yml";
const sha40 = /^[a-f0-9]{40}$/;
const sha64 = /^[a-f0-9]{64}$/;
type Row = Record<string, unknown>;
export type Target = "staging" | "production";
export interface EvidenceContext {
  revision: string;
  target: Target;
  releaseRunId?: number;
  releaseAttempt?: number;
  tree?: string;
  lockfileSha256?: string;
}
export interface Run extends Row {
  id: number;
  run_number: number;
  run_attempt: number;
  head_sha: string;
}
export interface BrowserSummary extends Row {
  build: { sha: string; tree: string; lockSha256: string; [key: string]: unknown };
}
export interface GitHubEvidence {
  schemaVersion: 1;
  repository: string;
  branch: string;
  revision: string;
  tree: string;
  lockfileSha256: string;
  release: { runId: number; attempt: number };
  target: Target;
  checkedAt: string;
  requiredRuns: { workflow: string; run: Run; jobs: Row[] }[];
  browser: { summarySha256: string; summary: BrowserSummary };
  productionReview: Row | null;
}
function need(condition: unknown): asserts condition {
  if (!condition) throw new Error("GitHub release evidence is incomplete or inconsistent");
}
function row(value: unknown): Row {
  need(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Row;
}
function rows(value: unknown, maximum = 100): unknown[] {
  need(Array.isArray(value) && value.length <= maximum);
  return value;
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function text(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function verifyRun(value: unknown, workflow: string, revision: string): Run {
  const r = row(value);
  need(positive(r.id) && positive(r.run_number) && positive(r.run_attempt));
  need(r.head_sha === revision && r.head_branch === BRANCH);
  need(r.path === `.github/workflows/${workflow}`);
  need(r.event === "push" || r.event === "workflow_dispatch");
  need(
    row(r.repository).full_name === REPOSITORY && row(r.head_repository).full_name === REPOSITORY,
  );
  return r as Run;
}
export function selectLatestRun(value: unknown, workflow: string, revision: string): Run {
  need(sha40.test(revision) && Object.hasOwn(WORKFLOW_POLICIES, workflow));
  const candidates = rows(value).map((r) => verifyRun(r, workflow, revision));
  need(candidates.length > 0 && new Set(candidates.map((r) => r.id)).size === candidates.length);
  const latest = candidates.sort((a, b) => b.run_number - a.run_number || b.id - a.id)[0];
  need(latest);
  return latest;
}
export function validateJobs(value: unknown, run: Run, workflow: string, revision: string): Row[] {
  const policy = WORKFLOW_POLICIES[workflow];
  need(policy && run.status === "completed" && run.conclusion === "success");
  const jobs = rows(value).map(row);
  need(jobs.length === Object.keys(policy).length);
  need(new Set(jobs.map((j) => j.id)).size === jobs.length);
  need(new Set(jobs.map((j) => j.name)).size === jobs.length);
  for (const job of jobs) {
    need(typeof job.name === "string" && Object.hasOwn(policy, job.name));
    const jobPolicy = policy[job.name];
    need(jobPolicy);
    need(
      positive(job.id) &&
        job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.head_sha === revision,
    );
    need(job.status === "completed" && job.conclusion === "success");
    need(typeof job.started_at === "string" && typeof job.completed_at === "string");
    need(
      Number.isFinite(Date.parse(job.started_at)) &&
        Date.parse(job.completed_at) >= Date.parse(job.started_at),
    );
    const steps = rows(job.steps, 100).map(row);
    need(new Set(steps.map((s) => s.name)).size === steps.length);
    let previous = 0;
    for (const step of steps) {
      need(positive(step.number) && step.number > previous && step.status === "completed");
      previous = step.number;
      need(
        step.conclusion === "success" ||
          (step.conclusion === "skipped" &&
            typeof step.name === "string" &&
            jobPolicy.skipped.includes(step.name)),
      );
    }
    const required = jobPolicy.required;
    need(
      steps
        .filter((s) => required.includes(String(s.name)))
        .map((s) => s.name)
        .join("\n") === required.join("\n"),
    );
  }
  return jobs;
}
export function parseBrowserSummary(log: string): unknown {
  need(Buffer.byteLength(log) <= LOG_LIMIT);
  const matches: unknown[] = [];
  for (const line of log.split(/\r?\n/)) {
    const clean = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /, "");
    if (!clean.startsWith("{") || clean.length > 32768) continue;
    try {
      const value: unknown = JSON.parse(clean);
      if (row(value).kind === "synthetic-browser-ci") matches.push(value);
    } catch {
      /* Other job output is not evidence. */
    }
  }
  need(matches.length === 1);
  return matches[0];
}
export function validateBrowserSummary(
  value: unknown,
  revision: string,
  runId: number,
  attempt: number,
): BrowserSummary {
  const s = row(value);
  const b = row(s.build);
  const browser = row(s.browser);
  const terminal = row(s.terminal);
  need(
    s.kind === "synthetic-browser-ci" &&
      s.accepted === true &&
      s.qualificationOrReleaseAcceptance === false,
  );
  need(
    b.sha === revision &&
      text(b.tree, sha40) &&
      text(b.fileMapSha256, sha64) &&
      text(b.lockSha256, sha64) &&
      text(b.outputsSha256, sha64),
  );
  need(positive(b.trackedFiles) && text(b.buildId, /^[A-Za-z0-9_-]{1,100}$/));
  need(
    b.command ===
      "pnpm exec turbo run build --filter=@nutrition-tracker/web... --filter=@nutrition-tracker/api... --filter=@nutrition-tracker/worker... --force",
  );
  need(b.nodeVersion === "v22.23.2" && b.pnpmVersion === "11.19.0");
  need(
    browser.sourceSha === revision && browser.buildId === b.buildId && browser.status === "passed",
  );
  need(
    text(browser.sessionId, /^[A-Za-z0-9-]{1,100}$/) &&
      text(browser.browserVersion, /^[A-Za-z0-9._-]{1,100}$/),
  );
  need(
    browser.browserSessionsAttempted === 1 &&
      browser.retries === 0 &&
      browser.origin === "http://127.0.0.1:3287",
  );
  need(
    JSON.stringify(browser.checks) ===
      JSON.stringify([
        "authenticated-session-persistence",
        "real-search-and-single-add",
        "saved-diary-entry-after-reload",
        "report-agrees-with-saved-day",
        "narrow-diary-remains-usable",
      ]),
  );
  need(
    terminal.sessionId === browser.sessionId &&
      terminal.status === "passed" &&
      terminal.browserstackStatus === "done",
  );
  need(
    Number.isInteger(terminal.durationSeconds) &&
      (terminal.durationSeconds as number) >= 0 &&
      (terminal.durationSeconds as number) <= 240,
  );
  need(
    terminal.buildName === `nourishing-${revision}-${runId}-${attempt}` &&
      terminal.projectName === "Nourishing" &&
      terminal.name === "synthetic-login-search-add-report",
  );
  const capture = row(s.capture);
  const requested = row(capture.requested);
  need(
    requested.video === false &&
      requested.screenshots === false &&
      requested.networkLogs === false &&
      requested.console === "disable" &&
      requested.playwrightLogs === false,
  );
  need(
    requested.maskCommands ===
      "sendType,sendPress,setHTTPCredentials,setStorageState,setGeolocation",
  );
  const artifacts = row(capture.observedArtifacts);
  need(
    Object.keys(artifacts).sort().join() ===
      ["video_url", "har_logs_url", "browser_console_logs_url", "playwright_logs_url"]
        .sort()
        .join(),
  );
  need(
    Object.values(artifacts).every((v) =>
      ["missing", "null", "empty", "present"].includes(String(v)),
    ),
  );
  need(
    capture.dashboardVerification === "pending-first-run-review" &&
      s.cookieAttributesIndependentlyInspected === false,
  );
  need(
    rows(row(s.cleanup).failures).length === 0 &&
      row(s.cleanup).volumesRetainedUntilEphemeralRunnerTeardown === true,
  );
  return s as BrowserSummary;
}
export function validateProductionReview(value: unknown, expected: EvidenceContext): Row {
  const p = row(value);
  const e = row(p.environment);
  const release = row(p.releaseRun);
  need(e.id === 22989561316 && e.name === "appwrite-production");
  const branch = row(e.deployment_branch_policy);
  need(branch.custom_branch_policies === true && branch.protected_branches === false);
  const policies = row(p.branches);
  const rules = rows(policies.branch_policies).map(row);
  const branchRule = rules[0];
  need(
    policies.total_count === 1 &&
      rules.length === 1 &&
      branchRule?.name === BRANCH &&
      branchRule.type === "branch",
  );
  const reviewers = rows(e.protection_rules)
    .map(row)
    .filter((r) => r.type === "required_reviewers");
  const reviewerRule = reviewers[0];
  need(
    reviewers.length === 1 && reviewerRule && typeof reviewerRule.prevent_self_review === "boolean",
  );
  const configured = rows(reviewerRule.reviewers, 6).map(row);
  need(
    configured.length > 0 &&
      configured.every((r) => r.type === "User" && positive(row(r.reviewer).id)),
  );
  need(
    release.id === expected.releaseRunId &&
      release.run_attempt === expected.releaseAttempt &&
      release.head_sha === expected.revision,
  );
  need(
    release.head_branch === BRANCH &&
      release.event === "workflow_dispatch" &&
      release.path === `.github/workflows/${RELEASE_WORKFLOW}`,
  );
  need(
    row(release.repository).full_name === REPOSITORY &&
      row(release.head_repository).full_name === REPOSITORY,
  );
  // Approval history is run-scoped, so production promotion is deliberately limited to attempt one.
  need(release.run_attempt === 1);
  const approvals = rows(p.approvals)
    .map(row)
    .filter((a) => rows(a.environments).some((v) => row(v).id === e.id && row(v).name === e.name));
  need(approvals.length > 0 && approvals.every((a) => a.state === "approved"));
  need(
    approvals.some(
      (a) =>
        configured.some((r) => row(r.reviewer).id === row(a.user).id) &&
        (reviewerRule.prevent_self_review === false ||
          (row(a.user).id !== row(release.actor).id &&
            row(a.user).id !== row(release.triggering_actor).id)),
    ),
  );
  return p;
}
export function validateGitHubEvidence(value: unknown, expected: EvidenceContext): GitHubEvidence {
  const e = row(value);
  const release = row(e.release);
  need(
    e.schemaVersion === 1 &&
      e.repository === REPOSITORY &&
      e.branch === BRANCH &&
      e.revision === expected.revision &&
      sha40.test(expected.revision),
  );
  need(text(e.tree, sha40) && text(e.lockfileSha256, sha64));
  need(expected.tree === undefined || e.tree === expected.tree);
  need(expected.lockfileSha256 === undefined || e.lockfileSha256 === expected.lockfileSha256);
  need(e.target === expected.target && (e.target === "staging" || e.target === "production"));
  need(positive(release.runId) && positive(release.attempt));
  need(expected.releaseRunId === undefined || release.runId === expected.releaseRunId);
  need(expected.releaseAttempt === undefined || release.attempt === expected.releaseAttempt);
  need(typeof e.checkedAt === "string" && Number.isFinite(Date.parse(e.checkedAt)));
  const records = rows(e.requiredRuns, 3).map(row);
  need(records.length === 3 && new Set(records.map((r) => r.workflow)).size === 3);
  for (const r of records) {
    need(typeof r.workflow === "string" && Object.hasOwn(WORKFLOW_POLICIES, r.workflow));
    const run = verifyRun(r.run, r.workflow, expected.revision);
    validateJobs(r.jobs, run, r.workflow, expected.revision);
  }
  const browserRun = row(records.find((r) => r.workflow === "browserstack-web.yml")?.run);
  const browser = row(e.browser);
  const summary = validateBrowserSummary(
    browser.summary,
    expected.revision,
    browserRun.id as number,
    browserRun.run_attempt as number,
  );
  need(browser.summarySha256 === digest(JSON.stringify(summary)));
  need(summary.build.tree === e.tree && summary.build.lockSha256 === e.lockfileSha256);
  if (e.target === "production")
    validateProductionReview(e.productionReview, {
      ...expected,
      releaseRunId: release.runId,
      releaseAttempt: release.attempt,
    });
  else need(e.productionReview === null);
  return e as unknown as GitHubEvidence;
}

export async function collectGitHubEvidence(
  options: EvidenceContext & {
    releaseRunId: number;
    releaseAttempt: number;
    token: string;
    fetch?: typeof fetch;
  },
): Promise<GitHubEvidence> {
  need(
    sha40.test(options.revision) &&
      positive(options.releaseRunId) &&
      positive(options.releaseAttempt),
  );
  need(options.token.length > 0 && options.token.length <= 4096 && !/[\r\n]/.test(options.token));
  const request = options.fetch ?? fetch;
  async function bytes(
    url: string,
    maximum: number,
    authorize: boolean,
    logRedirect = false,
  ): Promise<Uint8Array> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const response = await request(url, {
        method: "GET",
        redirect: "manual",
        signal: abort.signal,
        headers: authorize
          ? {
              Authorization: `Bearer ${options.token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2026-03-10",
            }
          : {},
      });
      if (logRedirect && response.status === 302) {
        const location = new URL(response.headers.get("location") ?? "");
        need(
          location.protocol === "https:" &&
            !location.username &&
            !location.password &&
            !location.port,
        );
        need(
          location.hostname.endsWith(".blob.core.windows.net") ||
            location.hostname.endsWith(".actions.githubusercontent.com"),
        );
        return await bytes(location.href, maximum, false);
      }
      need(response.status === 200 && response.body);
      const declared = response.headers.get("content-length");
      if (declared !== null) need(/^\d+$/.test(declared) && Number(declared) <= maximum);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          need(size <= maximum);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks);
    } catch {
      throw new Error("GitHub evidence request failed");
    } finally {
      clearTimeout(timer);
    }
  }
  const prefix = `https://api.github.com/repos/${REPOSITORY}`;
  async function api(path: string): Promise<unknown> {
    try {
      return JSON.parse(
        Buffer.from(await bytes(`${prefix}${path}`, JSON_LIMIT, true)).toString("utf8"),
      );
    } catch {
      throw new Error("GitHub evidence response was unavailable or invalid");
    }
  }
  async function latest(workflow: string): Promise<Run> {
    const page = row(
      await api(
        `/actions/workflows/${workflow}/runs?head_sha=${options.revision}&branch=${encodeURIComponent(BRANCH)}&per_page=100`,
      ),
    );
    const values = rows(page.workflow_runs);
    need(page.total_count === values.length);
    return selectLatestRun(values, workflow, options.revision);
  }
  async function currentBranch() {
    const repository = row(await api(""));
    need(repository.full_name === REPOSITORY && repository.default_branch === BRANCH);
    const reference = row(await api(`/git/ref/heads/${BRANCH}`));
    need(reference.ref === `refs/heads/${BRANCH}`);
    const object = row(reference.object);
    need(object.type === "commit" && object.sha === options.revision);
  }
  await currentBranch();
  const commit = row(await api(`/git/commits/${options.revision}`));
  need(commit.sha === options.revision);
  const tree = row(commit.tree).sha;
  need(text(tree, sha40));
  const lock = row(await api(`/contents/pnpm-lock.yaml?ref=${options.revision}`));
  need(
    lock.type === "file" &&
      lock.encoding === "base64" &&
      typeof lock.content === "string" &&
      positive(lock.size) &&
      lock.size <= 1024 * 1024,
  );
  const lockBytes = Buffer.from(lock.content, "base64");
  need(lockBytes.length === lock.size);
  const lockfileSha256 = digest(lockBytes);
  const requiredRuns: GitHubEvidence["requiredRuns"] = [];
  for (const workflow of Object.keys(WORKFLOW_POLICIES)) {
    const selected = await latest(workflow);
    const run = verifyRun(await api(`/actions/runs/${selected.id}`), workflow, options.revision);
    need(
      run.id === selected.id &&
        run.run_number === selected.run_number &&
        run.run_attempt === selected.run_attempt,
    );
    const page = row(
      await api(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
    );
    const jobs = validateJobs(page.jobs, run, workflow, options.revision);
    need(page.total_count === jobs.length);
    requiredRuns.push({ workflow, run, jobs });
  }
  const browserRun = requiredRuns.find((r) => r.workflow === "browserstack-web.yml");
  need(browserRun);
  const browserJob = browserRun.jobs[0];
  need(browserJob);
  const log = Buffer.from(
    await bytes(`${prefix}/actions/jobs/${browserJob.id}/logs`, LOG_LIMIT, true, true),
  ).toString("utf8");
  const summary = validateBrowserSummary(
    parseBrowserSummary(log),
    options.revision,
    browserRun.run.id,
    browserRun.run.run_attempt,
  );
  const productionReview =
    options.target === "production"
      ? {
          environment: await api("/environments/appwrite-production"),
          branches: await api(
            "/environments/appwrite-production/deployment-branch-policies?per_page=100",
          ),
          approvals: await api(`/actions/runs/${options.releaseRunId}/approvals`),
          releaseRun: await api(`/actions/runs/${options.releaseRunId}`),
        }
      : null;
  for (const previous of requiredRuns) {
    const current = await latest(previous.workflow);
    need(
      current.id === previous.run.id &&
        current.run_attempt === previous.run.run_attempt &&
        current.status === "completed" &&
        current.conclusion === "success",
    );
  }
  await currentBranch();
  return validateGitHubEvidence(
    {
      schemaVersion: 1,
      repository: REPOSITORY,
      branch: BRANCH,
      revision: options.revision,
      tree,
      lockfileSha256,
      release: { runId: options.releaseRunId, attempt: options.releaseAttempt },
      target: options.target,
      checkedAt: new Date().toISOString(),
      requiredRuns,
      browser: { summarySha256: digest(JSON.stringify(summary)), summary },
      productionReview,
    },
    options,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  need(
    args.length === 6 && args[0] === "--target" && args[2] === "--revision" && args[4] === "--out",
  );
  const target = args[1];
  need(target === "staging" || target === "production");
  const revision = args[3];
  const output = args[5];
  need(typeof revision === "string" && typeof output === "string");
  // These names belong to the Actions runner and are never forwarded to application builds.
  const env = process.env;
  need(
    env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_REF === `refs/heads/${BRANCH}` &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch",
  );
  need(env.GITHUB_SHA === revision && env.GITHUB_WORKFLOW_SHA === revision);
  const result = await collectGitHubEvidence({
    target,
    revision,
    releaseRunId: Number(env.GITHUB_RUN_ID),
    releaseAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    token: env.GITHUB_TOKEN ?? "",
  });
  await writeFile(output, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write("GitHub release prerequisites passed\n");
}

export const WORKFLOW_POLICIES: Record<
  string,
  Record<string, { required: string[]; skipped: string[] }>
> = {
  "ci.yml": {
    quality: {
      required: [
        "Check out source",
        "Set up Terraform",
        "Validate the Azure infrastructure pivot",
        "Validate the OCI controlled-beta infrastructure",
        "Validate the opt-in LocalStack fixture",
        "Validate the physical-device private-tailnet policy renderer",
        "Validate the P0 client-smoke normalizer contracts",
        "Prove the synthetic Windows collector producer boundary",
        "Install pnpm",
        "Set up Node.js",
        "Install locked dependencies",
        "Check manifests, formatting, boundaries, types, and tests",
        "Build all applications and packages",
        "Exercise the mobile release readiness state",
        "Reject high-severity production dependency advisories",
        "Enforce production license allowlist",
      ],
      skipped: [],
    },
    secrets: {
      required: [
        "Check out source",
        "Install checksum-pinned Gitleaks CLI",
        "Scan committed history for secrets",
      ],
      skipped: [],
    },
    database: {
      required: [
        "Check out source",
        "Install pnpm",
        "Set up Node.js",
        "Install locked dependencies",
        "Build integration-test workspace packages",
        "Set up pinned Buildx metadata inspection",
        "Install pinned Cosign for the object-store fixture",
        "Verify the qualified patched object-store image",
        "Initialize an empty object-store vulnerability-ignore policy",
        "Reject high or critical object-store vulnerabilities before execution",
        "Prepare private object-store fixture credentials",
        "Validate local service topology",
        "Bootstrap least-privilege private object storage",
        "Exercise encrypted artifact storage with split credentials",
        "Apply and replay database migrations",
        "Exercise database integration invariants",
        "Exercise authenticated API persistence adapters",
        "Bootstrap scoped Meilisearch keys",
        "Drill retention export and erasure production wiring",
        "Rehearse a complete PostgreSQL backup and isolated restore",
        "Exercise live erasure-ledger replay and API/worker readiness",
        "Exercise PostgreSQL-to-Meilisearch worker boundary",
        "Exercise real search index rebuild and queries",
        "Remove scoped Meilisearch key file",
        "Stop and remove the owned CI object-store fixture",
      ],
      skipped: [],
    },
  },
  "container-supply-chain.yml": {
    "build, scan, publish (node-runtime)": {
      required: [
        "Check out source",
        "Check out the signed Node release tag",
        "Verify native ARM64 execution",
        "Verify the signed Node source and exact OpenSSL fix",
        "Set up pinned Buildx and BuildKit",
        "Install Cosign for Distroless verification",
        "Verify pinned builder and signed Distroless inputs",
        "Resolve lowercase GHCR image name",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push patched Node runtime by digest",
        "Select the patched runtime candidate digest",
        "Verify patched runtime identity, binary, and symbols",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on patched runtime high or critical vulnerabilities",
        "Inventory patched runtime packages with Trivy",
        "Assert patched runtime inventory",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the verified patched runtime",
        "Export the verified patched Node runtime",
      ],
      skipped: [
        "Build and push patched Node runtime by digest",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "build, scan, publish (api)": {
      required: [
        "Check out source",
        "Resolve lowercase GHCR image name",
        "Install ARM64 emulator",
        "Set up pinned Buildx and BuildKit",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push by digest with SBOM and provenance",
        "Select the candidate digest",
        "Verify ARM64 runtime identity",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on high or critical vulnerabilities",
        "Inventory exact application packages with Trivy",
        "Assert scanner visibility of exact application packages",
        "Exercise the distroless Node runtime contract",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the deployable digest",
      ],
      skipped: [
        "Build and push by digest with SBOM and provenance",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "build, scan, publish (worker)": {
      required: [
        "Check out source",
        "Resolve lowercase GHCR image name",
        "Install ARM64 emulator",
        "Set up pinned Buildx and BuildKit",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push by digest with SBOM and provenance",
        "Select the candidate digest",
        "Verify ARM64 runtime identity",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on high or critical vulnerabilities",
        "Inventory exact application packages with Trivy",
        "Assert scanner visibility of exact application packages",
        "Exercise the distroless Node runtime contract",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the deployable digest",
      ],
      skipped: [
        "Build and push by digest with SBOM and provenance",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "build, scan, publish (migrator)": {
      required: [
        "Check out source",
        "Resolve lowercase GHCR image name",
        "Install ARM64 emulator",
        "Set up pinned Buildx and BuildKit",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push by digest with SBOM and provenance",
        "Select the candidate digest",
        "Verify ARM64 runtime identity",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on high or critical vulnerabilities",
        "Inventory exact application packages with Trivy",
        "Assert scanner visibility of exact application packages",
        "Exercise the distroless Node runtime contract",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the deployable digest",
      ],
      skipped: [
        "Build and push by digest with SBOM and provenance",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "build, scan, publish (web)": {
      required: [
        "Check out source",
        "Resolve lowercase GHCR image name",
        "Install ARM64 emulator",
        "Set up pinned Buildx and BuildKit",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push by digest with SBOM and provenance",
        "Select the candidate digest",
        "Verify ARM64 runtime identity",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on high or critical vulnerabilities",
        "Inventory exact application packages with Trivy",
        "Assert scanner visibility of exact application packages",
        "Exercise the distroless Node runtime contract",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the deployable digest",
      ],
      skipped: [
        "Build and push by digest with SBOM and provenance",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "build, scan, publish (caddy)": {
      required: [
        "Check out source",
        "Check out the signed Caddy release tag",
        "Verify the exact Caddy tag signature and source commit",
        "Resolve lowercase GHCR image name",
        "Verify native ARM64 execution",
        "Set up pinned Buildx and BuildKit",
        "Install pinned Cosign for the Meilisearch upstream input",
        "Verify the locked Meilisearch build input before building",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push by digest with SBOM and provenance",
        "Select the candidate digest",
        "Verify ARM64 service identity",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on high or critical vulnerabilities",
        "Exercise the Caddy non-root, validation, and bind contract",
        "Exercise PostgreSQL init, TLS, health, and existing-cluster contracts",
        "Exercise the Meilisearch non-root and health contract",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the deployable digest",
      ],
      skipped: [
        "Install pinned Cosign for the Meilisearch upstream input",
        "Verify the locked Meilisearch build input before building",
        "Build and push by digest with SBOM and provenance",
        "Exercise PostgreSQL init, TLS, health, and existing-cluster contracts",
        "Exercise the Meilisearch non-root and health contract",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "build, scan, publish (postgres)": {
      required: [
        "Check out source",
        "Check out the signed Caddy release tag",
        "Verify the exact Caddy tag signature and source commit",
        "Resolve lowercase GHCR image name",
        "Verify native ARM64 execution",
        "Set up pinned Buildx and BuildKit",
        "Install pinned Cosign for the Meilisearch upstream input",
        "Verify the locked Meilisearch build input before building",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push by digest with SBOM and provenance",
        "Select the candidate digest",
        "Verify ARM64 service identity",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on high or critical vulnerabilities",
        "Exercise the Caddy non-root, validation, and bind contract",
        "Exercise PostgreSQL init, TLS, health, and existing-cluster contracts",
        "Exercise the Meilisearch non-root and health contract",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the deployable digest",
      ],
      skipped: [
        "Check out the signed Caddy release tag",
        "Verify the exact Caddy tag signature and source commit",
        "Install pinned Cosign for the Meilisearch upstream input",
        "Verify the locked Meilisearch build input before building",
        "Build and push by digest with SBOM and provenance",
        "Exercise the Caddy non-root, validation, and bind contract",
        "Exercise the Meilisearch non-root and health contract",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "build, scan, publish (meilisearch)": {
      required: [
        "Check out source",
        "Check out the signed Caddy release tag",
        "Verify the exact Caddy tag signature and source commit",
        "Resolve lowercase GHCR image name",
        "Verify native ARM64 execution",
        "Set up pinned Buildx and BuildKit",
        "Install pinned Cosign for the Meilisearch upstream input",
        "Verify the locked Meilisearch build input before building",
        "Log in to GHCR with the job token",
        "Resolve an existing immutable commit tag",
        "Build and push by digest with SBOM and provenance",
        "Select the candidate digest",
        "Verify ARM64 service identity",
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on high or critical vulnerabilities",
        "Exercise the Caddy non-root, validation, and bind contract",
        "Exercise PostgreSQL init, TLS, health, and existing-cluster contracts",
        "Exercise the Meilisearch non-root and health contract",
        "Record GitHub build provenance",
        "Verify GitHub build provenance",
        "Create the immutable commit tag",
        "Verify the immutable commit tag",
        "Summarize the deployable digest",
      ],
      skipped: [
        "Check out the signed Caddy release tag",
        "Verify the exact Caddy tag signature and source commit",
        "Build and push by digest with SBOM and provenance",
        "Exercise the Caddy non-root, validation, and bind contract",
        "Exercise PostgreSQL init, TLS, health, and existing-cluster contracts",
        "Record GitHub build provenance",
        "Create the immutable commit tag",
      ],
    },
    "validate upstream build input (MEILI_IMAGE)": {
      required: [
        "Check out source",
        "Validate and resolve the reviewed image lock",
        "Set up pinned Buildx and BuildKit",
        "Verify the locked index and ARM64 runtime identity",
        "Install pinned Cosign for signed upstream images",
        "Verify upstream provenance evidence",
        "Summarize the upstream build-input review",
        "Enforce locked upstream identity and provenance",
      ],
      skipped: [],
    },
    "build, scan, publish (object-store)": {
      required: [
        "Require the approved storage publication context",
        "Check out storage source",
        "Set up pinned storage Buildx and BuildKit",
        "Install pinned storage Cosign",
        "Verify the unchanged signed upstream storage base",
        "Log in for the project storage image",
        "Resolve the immutable storage commit tag",
        "Build the patched storage candidate by digest",
        "Export the exact storage build evidence",
        "Select the exact storage candidate",
        "Verify patched storage identity without running weed",
        "Initialize an empty patched-storage vulnerability-ignore policy",
        "Reject all high and critical patched-storage vulnerabilities",
        "Inventory the patched storage image",
        "Require the patched gRPC binary in the scan inventory",
        "Sign the scanned project storage digest",
        "Attest the scanned project storage digest",
        "Verify the signed same-source storage digest",
        "Publish the immutable verified storage tag",
        "Export the verified storage digest",
      ],
      skipped: [
        "Build the patched storage candidate by digest",
        "Sign the scanned project storage digest",
        "Attest the scanned project storage digest",
        "Publish the immutable verified storage tag",
      ],
    },
  },
  "browserstack-web.yml": {
    "synthetic-browser": {
      required: [
        "Install locked development dependencies",
        "Set up the repository-pinned image inspection tool",
        "Bind checkout and prepare pinned browser/image assets",
        "Verify exact original service image provenance",
        "Initialize empty fixture vulnerability-ignore policy",
        "Reject high or critical PostgreSQL fixture vulnerabilities",
        "Reject high or critical Meilisearch fixture vulnerabilities",
        "Build this checkout without task-cache reuse",
        "Start the bounded synthetic real app",
        "One BrowserStack Local browser session",
        "Stop owned tunnel, applications and containers",
        "Print the bounded source, browser and cleanup receipt",
      ],
      skipped: [],
    },
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("GitHub release prerequisites failed; no deployment was authorized\n");
    process.exitCode = 1;
  });
}
