import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BRANCH,
  collectGitHubEvidence,
  parseBrowserSummary,
  REPOSITORY,
  selectLatestRun,
  validateBrowserSummary,
  validateGitHubEvidence,
  validateJobs,
  validateProductionReview,
  WORKFLOW_POLICIES,
} from "./github-checks.ts";

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const context = { revision: SHA, target: "staging" as const, releaseRunId: 900, releaseAttempt: 1 };
const clone = <T>(value: T): T => structuredClone(value);
function first<T>(value: T[]): T {
  const item = value[0];
  assert.ok(item);
  return item;
}
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
  const policies = WORKFLOW_POLICIES[workflow];
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
      tree: "c".repeat(40),
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
    tree: "c".repeat(40),
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
      summarySha256: createHash("sha256").update(JSON.stringify(browser())).digest("hex"),
      summary: browser(),
    },
    productionReview: null,
  };
}

test("selects newest actual run and latest attempt; a newer failed or pending run blocks", () => {
  const newest = { ...run("ci.yml", 31, 2), conclusion: "failure" };
  assert.equal(selectLatestRun([run("ci.yml"), newest], "ci.yml", SHA).id, 31);
  const data = evidence();
  first(data.requiredRuns).run = newest;
  assert.throws(() => validateGitHubEvidence(data, context));
});
for (const [field, value] of [
  ["head_sha", "f".repeat(40)],
  ["head_branch", "untrusted"],
  ["path", ".github/workflows/other.yml"],
  ["event", "pull_request"],
] as const) {
  test(`rejects wrong run ${field}`, () => {
    assert.throws(() => selectLatestRun([{ ...run("ci.yml"), [field]: value }], "ci.yml", SHA));
  });
}
test("requires all five CI, ten container and three browser workflow jobs", () => {
  assert.equal(jobs("ci.yml").length, 5);
  assert.equal(jobs("container-supply-chain.yml").length, 10);
  assert.equal(jobs("browserstack-web.yml").length, 3);
  assert.doesNotThrow(() => validateGitHubEvidence(evidence(), context));
  for (const workflow of Object.keys(WORKFLOW_POLICIES) as (keyof typeof WORKFLOW_POLICIES)[]) {
    const missing = jobs(workflow);
    missing.pop();
    assert.throws(() => validateJobs(missing, run(workflow), workflow, SHA));
    const duplicate = jobs(workflow);
    duplicate.push(clone(first(duplicate)));
    assert.throws(() => validateJobs(duplicate, run(workflow), workflow, SHA));
  }
});
test("browser release evidence still requires both complete successful fixture scans", () => {
  assert.deepEqual(
    Object.keys(WORKFLOW_POLICIES["browserstack-web.yml"] ?? {}).sort(),
    [
      "synthetic-browser",
      "postgres-fixture-vulnerabilities",
      "meilisearch-fixture-vulnerabilities",
    ].sort(),
  );
  for (const name of ["postgres-fixture-vulnerabilities", "meilisearch-fixture-vulnerabilities"]) {
    for (const mutation of [
      "missing-job",
      "failed-job",
      "skipped-job",
      "missing-scan",
      "failed-scan",
      "skipped-scan",
    ]) {
      const data = evidence();
      const record = data.requiredRuns.find((r) => r.workflow === "browserstack-web.yml");
      assert.ok(record);
      const scanner = record.jobs.find((j) => j.name === name);
      assert.ok(scanner);
      if (mutation === "missing-job") record.jobs = record.jobs.filter((j) => j !== scanner);
      if (mutation === "failed-job") scanner.conclusion = "failure";
      if (mutation === "skipped-job") scanner.conclusion = "skipped";
      if (mutation.endsWith("-scan")) {
        const step = scanner.steps.find((s) => s.name.startsWith("Reject high or critical "));
        assert.ok(step);
        if (mutation === "missing-scan") scanner.steps = scanner.steps.filter((s) => s !== step);
        if (mutation === "failed-scan") step.conclusion = "failure";
        if (mutation === "skipped-scan") step.conclusion = "skipped";
      }
      assert.throws(() => validateGitHubEvidence(data, context), `${name}: ${mutation}`);
    }
  }
});
for (const mutation of [
  "job-skipped",
  "step-skipped",
  "step-missing",
  "step-failed",
  "step-order",
  "wrong-attempt",
  "wrong-job-sha",
] as const) {
  test(`rejects ${mutation} without relying on workflow conclusion`, () => {
    const rows = jobs("ci.yml");
    const job = first(rows);
    if (mutation === "job-skipped") job.conclusion = "skipped";
    if (mutation === "step-skipped") first(job.steps).conclusion = "skipped";
    if (mutation === "step-missing") job.steps.shift();
    if (mutation === "step-failed") first(job.steps).conclusion = "failure";
    if (mutation === "step-order") job.steps.reverse();
    if (mutation === "wrong-attempt") job.run_attempt = 2;
    if (mutation === "wrong-job-sha") job.head_sha = "f".repeat(40);
    assert.throws(() => validateJobs(rows, run("ci.yml"), "ci.yml", SHA));
  });
}
test("permits only explicit conditional container skips; security verification cannot skip", () => {
  const rows = jobs("container-supply-chain.yml");
  assert.doesNotThrow(() =>
    validateJobs(rows, run("container-supply-chain.yml"), "container-supply-chain.yml", SHA),
  );
  const node = rows.find((r) => r.name.endsWith("(node-runtime)"));
  assert.ok(node);
  const provenance = node.steps.find((s) => s.name === "Verify GitHub build provenance");
  assert.ok(provenance);
  provenance.conclusion = "skipped";
  assert.throws(() =>
    validateJobs(rows, run("container-supply-chain.yml"), "container-supply-chain.yml", SHA),
  );
});
for (const bad of ["source", "session", "cleanup", "command", "capture", "checks"] as const) {
  test(`rejects incomplete BrowserStack ${bad} receipt`, () => {
    const row = browser();
    if (bad === "source") row.build.sha = "f".repeat(40);
    if (bad === "session") row.terminal.browserstackStatus = "running";
    if (bad === "cleanup") row.cleanup.failures = ["unsafe"] as never[];
    if (bad === "command") row.build.command = "pnpm build";
    if (bad === "capture") row.capture.requested.video = true;
    if (bad === "checks") row.browser.checks.pop();
    assert.throws(() => validateBrowserSummary(row, SHA, 32, 1));
  });
}
test("parses only one bounded JSON summary and never executes log strings", () => {
  const line = JSON.stringify(browser());
  assert.deepEqual(parseBrowserSummary(`2026-09-29T01:00:00.000Z ${line}\n`), browser());
  for (const invalid of [
    "",
    `${line}\n${line}`,
    JSON.stringify({ kind: "synthetic-browser-ci", accepted: false }),
    "x".repeat(8 * 1024 * 1024 + 1),
  ]) {
    assert.throws(() => validateBrowserSummary(parseBrowserSummary(invalid), SHA, 32, 1));
  }
});
function protection() {
  return {
    environment: {
      id: 22989561316,
      name: "appwrite-production",
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [{ type: "User", reviewer: { id: 8, login: "reviewer" } }],
        },
      ],
    },
    branches: { total_count: 1, branch_policies: [{ name: BRANCH, type: "branch" }] },
    approvals: [
      {
        state: "approved",
        user: { id: 8, login: "reviewer" },
        environments: [{ id: 22989561316, name: "appwrite-production" }],
      },
    ],
    releaseRun: {
      id: 900,
      run_attempt: 1,
      head_sha: SHA,
      head_branch: BRANCH,
      event: "workflow_dispatch",
      path: ".github/workflows/appwrite-site-release.yml",
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      actor: { id: 9, login: "initiator" },
      triggering_actor: { id: 9, login: "initiator" },
    },
  };
}
test("production requires actual configured reviewer, exact branch rule and approved current run", () => {
  assert.doesNotThrow(() => validateProductionReview(protection(), context));
  for (const mutate of [
    (x: ReturnType<typeof protection>) => {
      x.environment.protection_rules = [];
    },
    (x: ReturnType<typeof protection>) => {
      first(x.branches.branch_policies).name = "*";
    },
    (x: ReturnType<typeof protection>) => {
      x.approvals = [];
    },
    (x: ReturnType<typeof protection>) => {
      first(x.approvals).state = "rejected";
    },
    (x: ReturnType<typeof protection>) => {
      first(x.approvals).user.id = 9;
    },
    (x: ReturnType<typeof protection>) => {
      x.releaseRun.run_attempt = 2;
    },
  ]) {
    const x = protection();
    mutate(x);
    assert.throws(() => validateProductionReview(x, context));
  }
});
test("GitHub collection refuses HTTP errors, redirects and oversized responses without leaking credentials", async () => {
  for (const response of [
    new Response("private-token", { status: 403 }),
    new Response("", { status: 302, headers: { location: "http://evil.test" } }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(
      collectGitHubEvidence({ ...context, token: "private-token", fetch: async () => response }),
      (error) => {
        assert.doesNotMatch(String(error), /private-token|evil/);
        return true;
      },
    );
  }
});
test("required named step policies follow the actual repository workflow definitions", () => {
  for (const [workflow, jobPolicies] of Object.entries(WORKFLOW_POLICIES)) {
    const text = readFileSync(
      new URL(`../../.github/workflows/${workflow}`, import.meta.url),
      "utf8",
    );
    for (const policy of Object.values(jobPolicies))
      for (const name of policy.required) {
        assert.ok(text.includes(`- name: ${name}`), `Missing actual workflow step: ${name}`);
      }
  }
});

function apiFixture(
  change?:
    | "rerun"
    | "shuffled-browser-jobs"
    | "missing-page"
    | "wrong-tree"
    | "missing-cleanup"
    | "branch-advanced"
    | "default-branch"
    | "final-branch-drift"
    | "dependency-failure",
) {
  const calls: { url: string; authorization: string | null }[] = [];
  const lookups = new Map<string, number>();
  const lockBytes = Buffer.from("lockfileVersion: '9.0'\n");
  const lockHash = createHash("sha256").update(lockBytes).digest("hex");
  const summary = browser();
  summary.build.lockSha256 = lockHash;
  const workflows = Object.keys(WORKFLOW_POLICIES);
  function fixtureRun(workflow: string, id: number, attempt = 1) {
    const result = run(workflow, id, attempt);
    if (change === "dependency-failure" && workflow === "ci.yml") result.conclusion = "failure";
    return result;
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, authorization: new Headers(init?.headers).get("authorization") });
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (url.hostname === "results.blob.core.windows.net")
      return new Response(`${JSON.stringify(summary)}\n`);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, "GET");
    const path = url.pathname.replace(`/repos/${REPOSITORY}`, "");
    if (path === "")
      return json({
        full_name: REPOSITORY,
        default_branch: change === "default-branch" ? "other" : BRANCH,
      });
    if (path === `/git/ref/heads/${BRANCH}`) {
      const count = (lookups.get("branch") ?? 0) + 1;
      lookups.set("branch", count);
      return json({
        ref: `refs/heads/${BRANCH}`,
        object: {
          type: "commit",
          sha:
            change === "branch-advanced" || (change === "final-branch-drift" && count > 1)
              ? "f".repeat(40)
              : SHA,
        },
      });
    }
    if (path === `/git/commits/${SHA}`)
      return json({
        sha: SHA,
        tree: { sha: change === "wrong-tree" ? "d".repeat(40) : "c".repeat(40) },
      });
    if (path === "/contents/pnpm-lock.yaml")
      return json({
        type: "file",
        encoding: "base64",
        size: lockBytes.length,
        content: lockBytes.toString("base64"),
      });
    const workflow = /\/actions\/workflows\/(.+)\/runs/.exec(path)?.[1];
    if (workflow) {
      const count = (lookups.get(workflow) ?? 0) + 1;
      lookups.set(workflow, count);
      return json({
        total_count: change === "missing-page" ? 2 : 1,
        workflow_runs: [
          fixtureRun(
            workflow,
            30 + workflows.indexOf(workflow),
            change === "rerun" && count > 1 ? 2 : 1,
          ),
        ],
      });
    }
    const jobMatch = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs/.exec(path);
    if (jobMatch) {
      const id = Number(jobMatch[1]);
      const name = workflows[id - 30];
      assert.ok(name);
      const result = jobs(name, id);
      if (change === "dependency-failure" && name === "ci.yml") {
        const scanner = result.find((job) => job.name === "production dependency advisories");
        assert.ok(scanner);
        scanner.conclusion = "failure";
        const scan = scanner.steps.find(
          (step) => step.name === "Reject high-severity production dependency advisories",
        );
        assert.ok(scan);
        scan.conclusion = "failure";
      }
      if (change === "shuffled-browser-jobs" && name === "browserstack-web.yml") result.reverse();
      if (change === "missing-cleanup" && name === "browserstack-web.yml")
        first(result).steps = first(result).steps.filter(
          (s) => s.name !== "Stop owned tunnel, applications and containers",
        );
      return json({ total_count: result.length, jobs: result });
    }
    const runId = /\/actions\/runs\/(\d+)$/.exec(path)?.[1];
    if (runId) {
      const name = workflows[Number(runId) - 30];
      assert.ok(name);
      return json(fixtureRun(name, Number(runId)));
    }
    if (path === "/actions/jobs/100/logs")
      return new Response("", {
        status: 302,
        headers: { location: "https://results.blob.core.windows.net/job/log?signature=private" },
      });
    assert.fail(`Unexpected fixture API path ${path}`);
  };
  return { fetcher, calls, lockHash };
}
test("collects the exact synthetic browser log when security jobs precede it", async () => {
  const fixture = apiFixture("shuffled-browser-jobs");
  const result = await collectGitHubEvidence({
    ...context,
    token: "private-token",
    fetch: fixture.fetcher,
  });
  assert.equal(result.browser.summary.accepted, true);
  assert.deepEqual(
    fixture.calls.filter((c) => c.url.includes("/logs")).map((c) => c.url),
    [`https://api.github.com/repos/${REPOSITORY}/actions/jobs/100/logs`],
  );
});
test("collects actual latest attempts, complete jobs, source tree/lock bytes and parsed browser evidence", async () => {
  const fixture = apiFixture();
  const result = await collectGitHubEvidence({
    ...context,
    token: "private-token",
    fetch: fixture.fetcher,
  });
  assert.equal(result.tree, "c".repeat(40));
  assert.equal(result.lockfileSha256, fixture.lockHash);
  assert.equal(result.requiredRuns.length, 3);
  assert.equal(fixture.calls.filter((c) => c.url.includes("/workflows/")).length, 6);
  assert.equal(
    fixture.calls.find((c) => c.url.startsWith("https://results.blob.core.windows.net"))
      ?.authorization,
    null,
  );
  assert.ok(
    fixture.calls
      .filter((c) => c.url.startsWith("https://api.github.com"))
      .every((c) => c.authorization === "Bearer private-token"),
  );
  assert.doesNotMatch(JSON.stringify(result), /private-token|signature=private/);
  assert.throws(() => validateGitHubEvidence(result, { ...context, tree: "d".repeat(40) }));
  assert.throws(() =>
    validateGitHubEvidence(result, { ...context, lockfileSha256: "f".repeat(64) }),
  );
});
for (const change of [
  "rerun",
  "missing-page",
  "wrong-tree",
  "missing-cleanup",
  "branch-advanced",
  "default-branch",
  "final-branch-drift",
] as const) {
  test(`assembled collection rejects ${change}`, async () => {
    await assert.rejects(
      collectGitHubEvidence({
        ...context,
        token: "private-token",
        fetch: apiFixture(change).fetcher,
      }),
    );
  });
}

test("the actual ESM CLI rejects a malformed selector before any network or output file", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./github-checks.ts", import.meta.url)),
      "--target",
      "untrusted",
    ],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { NODE_DISABLE_COMPILE_CACHE: "1" },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4096,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "GitHub release prerequisites failed; no deployment was authorized\n",
  );
});

test("manual prepare and activate require the exact trusted source and private reviewed inputs", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/appwrite-site-release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /on:\n {2}workflow_dispatch:/);
  assert.doesNotMatch(workflow, /(?:push|pull_request|workflow_run|schedule):/);
  assert.match(workflow, /options: \[prepare, activate\]/);
  assert.match(workflow, /options: \[staging, production\]/);
  assert.match(workflow, /review_artifact_id:/);
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}actions: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.ok(
    workflow.includes(
      "github.repository == 'liangzixuan/cronometer-gold' && github.ref == 'refs/heads/codex/retention-features' && github.event_name == 'workflow_dispatch'",
    ),
  );
  assert.ok(workflow.includes("inputs.target == 'staging' || inputs.promote"));
  assert.match(workflow, /environment: appwrite-\$\{\{ inputs.target \}\}/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}\n +persist-credentials: false/);
  assert.doesNotMatch(workflow, /continue-on-error:|secrets: inherit/);
  assert.match(workflow, /review-artifact.py/);
  assert.match(workflow, /--revision "\$GITHUB_SHA"/);
  assert.match(workflow, /--qualification "\$RUNNER_TEMP\/appwrite-review\/qualification.json"/);
  assert.match(
    workflow,
    /--candidate-receipt "\$RUNNER_TEMP\/appwrite-review\/candidate-receipt.json"/,
  );
  assert.match(workflow, /--staging-config "\$RUNNER_TEMP\/appwrite-review\/staging-config.json"/);
  assert.match(
    workflow,
    /--staging-receipt "\$RUNNER_TEMP\/appwrite-review\/staging-receipt.json"/,
  );
  assert.match(workflow, /APPWRITE_DEPLOY_KEY: \$\{\{ secrets.APPWRITE_DEPLOY_KEY \}\}/);
  assert.match(workflow, /APPWRITE_BACKEND_READINESS_TOKEN:/);
  assert.match(workflow, /APPWRITE_STAGING_READINESS_TOKEN:/);
  const uploads = workflow
    .split(/^ {6}- /m)
    .filter((step) => step.includes("actions/upload-artifact@"));
  assert.equal(uploads.length, 1);
  const upload = first(uploads);
  assert.match(upload, /if: always\(\)/);
  assert.match(upload, /path: \$\{\{ runner.temp \}\}\/release-receipt.json/);
  assert.match(upload, /retention-days: 1/);
  assert.doesNotMatch(upload, /secrets\.|github-evidence|\.log|qualification/);
});

for (const securityJob of ["production dependency advisories", "object-store vulnerabilities"]) {
  for (const failure of ["job-failed", "job-missing", "step-skipped", "step-failed"]) {
    test(`release acceptance rejects ${securityJob}: ${failure}`, () => {
      const data = evidence();
      const ci = data.requiredRuns.find((entry) => entry.workflow === "ci.yml");
      assert.ok(ci);
      const job = ci.jobs.find((entry) => entry.name === securityJob);
      assert.ok(job);
      if (failure === "job-failed") job.conclusion = "failure";
      if (failure === "job-missing") ci.jobs = ci.jobs.filter((entry) => entry !== job);
      const scan = job.steps.at(-1);
      assert.ok(scan);
      if (failure === "step-skipped") scan.conclusion = "skipped";
      if (failure === "step-failed") scan.conclusion = "failure";
      assert.throws(() => validateGitHubEvidence(data, context));
    });
  }
}

const STAGING_POLICY_START = Date.parse("2026-10-22T00:37:43Z");
const STAGING_POLICY_NOW = Date.parse("2026-10-22T12:00:00Z");
const STAGING_POLICY_END = Date.parse("2026-10-23T18:37:37Z");
const STAGING_FAILURE_CASES = [
  [
    "ci.yml",
    "production dependency advisories",
    "Reject high-severity production dependency advisories",
  ],
  [
    "ci.yml",
    "object-store vulnerabilities",
    "Reject high or critical object-store vulnerabilities",
  ],
  [
    "browserstack-web.yml",
    "postgres-fixture-vulnerabilities",
    "Reject high or critical PostgreSQL fixture vulnerabilities",
  ],
  [
    "browserstack-web.yml",
    "meilisearch-fixture-vulnerabilities",
    "Reject high or critical Meilisearch fixture vulnerabilities",
  ],
] as const;
function failedDependency(
  data: ReturnType<typeof evidence>,
  entry: (typeof STAGING_FAILURE_CASES)[number],
) {
  const [workflow, name, stepName] = entry;
  const record = data.requiredRuns.find((item) => item.workflow === workflow);
  assert.ok(record);
  const job = record.jobs.find((item) => item.name === name);
  assert.ok(job);
  const step = job.steps.find((item) => item.name === stepName);
  assert.ok(step);
  record.run.conclusion = "failure";
  job.conclusion = "failure";
  step.conclusion = "failure";
  return { record, job, step };
}
for (const entry of STAGING_FAILURE_CASES) {
  test(`approved staging retains actual failed dependency results: ${entry[1]}`, () => {
    const data = evidence();
    const { record } = failedDependency(data, entry);
    const before = clone(data);
    for (const now of [STAGING_POLICY_START, STAGING_POLICY_NOW, STAGING_POLICY_END - 1])
      assert.doesNotThrow(() => validateGitHubEvidence(data, context, now));
    assert.deepEqual(data, before);
    assert.throws(() => validateJobs(record.jobs, record.run, entry[0], SHA));
    assert.throws(() =>
      validateJobs(record.jobs, record.run, entry[0], SHA, "production", STAGING_POLICY_NOW),
    );
    for (const now of [
      STAGING_POLICY_START - 1,
      STAGING_POLICY_END,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      assert.throws(() => validateGitHubEvidence(data, context, now));
  });
}

test("the approved staging exception accepts all four scans together without rewriting failure evidence", () => {
  const data = evidence();
  for (const entry of STAGING_FAILURE_CASES) failedDependency(data, entry);
  const before = clone(data);
  assert.doesNotThrow(() => validateGitHubEvidence(data, context, STAGING_POLICY_NOW));
  assert.deepEqual(data, before);
});

for (const mutation of [
  "missing-job",
  "missing-scan",
  "skipped-scan",
  "pending-scan",
  "successful-job",
  "successful-run",
  "failed-setup",
  "failed-functional",
  "unnamed-functional-failure",
] as const) {
  test(`staging dependency approval still rejects ${mutation}`, () => {
    const data = evidence();
    const { record, job, step } = failedDependency(data, STAGING_FAILURE_CASES[0]);
    if (mutation === "missing-job") record.jobs = record.jobs.filter((item) => item !== job);
    if (mutation === "missing-scan") job.steps = job.steps.filter((item) => item !== step);
    if (mutation === "skipped-scan") step.conclusion = "skipped";
    if (mutation === "pending-scan") step.status = "in_progress";
    if (mutation === "successful-job") job.conclusion = "success";
    if (mutation === "successful-run") record.run.conclusion = "success";
    if (mutation === "failed-setup") first(job.steps).conclusion = "failure";
    if (mutation === "failed-functional" || mutation === "unnamed-functional-failure") {
      const quality = record.jobs.find((item) => item.name === "quality");
      assert.ok(quality);
      quality.conclusion = "failure";
      first(quality.steps).conclusion = "failure";
      if (mutation === "unnamed-functional-failure")
        Object.assign(first(quality.steps), { name: undefined });
    }
    assert.throws(() => validateGitHubEvidence(data, context, STAGING_POLICY_NOW));
  });
}

test("the collector preserves a failed scan and run through its final fresh read", async () => {
  const fixture = apiFixture("dependency-failure");
  const result = await collectGitHubEvidence({
    ...context,
    token: "private-token",
    fetch: fixture.fetcher,
    now: () => STAGING_POLICY_NOW,
  });
  const ci = result.requiredRuns.find((record) => record.workflow === "ci.yml");
  assert.ok(ci);
  assert.equal(ci.run.conclusion, "failure");
  const job = ci.jobs.find((entry) => entry.name === "production dependency advisories");
  assert.ok(job);
  assert.equal(job.conclusion, "failure");
  assert.equal(
    (job.steps as { name: string; conclusion: string }[]).find(
      (step) => step.name === STAGING_FAILURE_CASES[0][2],
    )?.conclusion,
    "failure",
  );
  assert.doesNotThrow(() => validateGitHubEvidence(result, context, STAGING_POLICY_NOW));
});

test("the collector rejects approval expiry during collection using its final clock", async () => {
  const fixture = apiFixture("dependency-failure");
  let reads = 0;
  await assert.rejects(
    collectGitHubEvidence({
      ...context,
      token: "private-token",
      fetch: fixture.fetcher,
      now: () => (++reads === 1 ? STAGING_POLICY_NOW : STAGING_POLICY_END),
    }),
  );
  assert.ok(reads > 1);
  assert.equal(
    fixture.calls.filter((call) => call.url.includes(`/git/ref/heads/${BRANCH}`)).length,
    2,
  );
});
