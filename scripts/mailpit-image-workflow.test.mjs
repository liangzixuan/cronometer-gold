import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MAILPIT_INPUTS } from "./verify-mailpit-build.mjs";
import {
  assertStepOrder,
  assertUnconditionalStep,
  workflowJob,
  workflowStep,
} from "./workflow-contract-helpers.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/mailpit-image.yml");
const docker = read("infra/docker/mailpit.Dockerfile");
const job = workflowJob(workflow, "mailpit-image");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("publisher is limited to exact branch, repository, push and native ARM64", () => {
  assert.match(workflow, /branches: \[codex\/retention-features\]/u);
  const guard = workflowStep(job, "Require the approved Mailpit publication context");
  for (const line of [
    'test "${EVENT_NAME}" = push',
    'test "${SOURCE_REF}" = refs/heads/codex/retention-features',
    'test "${SOURCE_REPOSITORY}" = liangzixuan/cronometer-gold',
    'test "${REVISION}" = "${WORKFLOW_REVISION}"',
    'test "${RUNNER_ARCH}" = ARM64',
    'test "$(uname -m)" = aarch64',
  ])
    assert.ok(guard.includes(line));
  assert.match(job, /runs-on: ubuntu-24\.04-arm/u);
  assert.match(job, /timeout-minutes: 60/u);
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch|pull_request|schedule:|cancel-in-progress: true/u,
  );
});
test("automatic rebuild paths are exact build, review and verifier inputs", () => {
  const paths = workflow
    .split("permissions:")[0]
    .split("\n")
    .filter((line) => line.startsWith("      - "))
    .map((line) => line.slice(8));
  for (const file of [
    ".dockerignore",
    ".github/workflows/mailpit-image.yml",
    "infra/docker/mailpit.Dockerfile",
    "infra/docker/mailpit-build-inputs.json",
    "infra/docker/mailpit-NOTICES.txt",
    "infra/docker/mailpit-go-licenses.go.mod",
    "infra/docker/mailpit-go-licenses.go.sum",
    "scripts/verify-mailpit-build.mjs",
    "scripts/verify-mailpit-image.mjs",
    "scripts/verify-oci-buildkit-attestations.mjs",
    "scripts/license-policy.mjs",
    "scripts/license-policy.test.mjs",
    "scripts/check-licenses.mjs",
    "scripts/workflow-contract-helpers.mjs",
    "scripts/mailpit-build.test.mjs",
    "scripts/verify-mailpit-image.test.mjs",
    "scripts/mailpit-image-workflow.test.mjs",
    "config/license-policy.json",
  ])
    assert.ok(paths.includes(file));
  assert.equal(paths.length, 18);
  assert.equal(
    paths.some(
      (path) => path.includes("*") || path.startsWith("infra/oci/") || path.startsWith("apps/"),
    ),
    false,
  );
});
test("all actions and BuildKit/scanner inputs are pinned", () => {
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/gu)].map((match) => match[1]);
  assert.ok(actions.length >= 8);
  assert.ok(actions.every((value) => /@[0-9a-f]{40}$/u.test(value)));
  assert.match(workflow, /version: v0\.36\.1/u);
  assert.match(workflow, /cosign-release: v3\.1\.3/u);
  assert.match(workflow, /moby\/buildkit@sha256:[0-9a-f]{64}/u);
  assert.match(workflow, /provenance: mode=max,version=v1/u);
  assert.match(workflow, /sbom: generator=.*@sha256:[0-9a-f]{64}/u);
  assert.doesNotMatch(workflow, /continue-on-error:|provenance: false|sbom: false/u);
});
test("immutable publication follows exact identity, current strict scan, complete inventory and signatures", () => {
  assertStepOrder(job, [
    "Build the Mailpit candidate by digest",
    "Export the exact Mailpit build evidence",
    "Select the exact Mailpit candidate",
    "Verify Mailpit identity without running mailpit",
    "Initialize an empty mailpit vulnerability-ignore policy",
    "Reject all high and critical mailpit vulnerabilities",
    "Inventory the Mailpit image",
    "Require complete Mailpit binary scan coverage",
    "Sign the scanned project Mailpit digest",
    "Attest the scanned project Mailpit digest",
    "Verify the signed same-source Mailpit digest",
    "Publish the immutable verified Mailpit tag",
    "Export the verified Mailpit digest",
  ]);
});
for (const name of [
  "Verify Mailpit identity without running mailpit",
  "Reject all high and critical mailpit vulnerabilities",
  "Inventory the Mailpit image",
  "Require complete Mailpit binary scan coverage",
  "Verify the signed same-source Mailpit digest",
])
  test(`${name} cannot be skipped for an existing tag`, () =>
    assertUnconditionalStep(workflowStep(job, name), name));
test("strict scan has no ignore entries, includes unfixed HIGH/CRITICAL and rejects findings", () => {
  const step = workflowStep(job, "Reject all high and critical mailpit vulnerabilities");
  for (const line of [
    "version: v0.74.0",
    "scan-type: image",
    "scanners: vuln",
    "vuln-type: os,library",
    "severity: HIGH,CRITICAL",
    "ignore-unfixed: false",
    'exit-code: "1"',
    "cache: false",
  ])
    assert.ok(step.includes(line));
  assert.ok(
    workflowStep(job, "Initialize an empty mailpit vulnerability-ignore policy").includes(
      'install -m 600 /dev/null "${RUNNER_TEMP}/mailpit.trivyignore"',
    ),
  );
  assert.ok(
    workflowStep(job, "Require complete Mailpit binary scan coverage").includes(
      'test ! -s "${RUNNER_TEMP}/mailpit.trivyignore"',
    ),
  );
  assert.doesNotMatch(workflow, /VEX|ignore-policy|ignorefile:|--ignore-unfixed=true/u);
});
test("binary extraction is compared with the actual build evidence before scan", () => {
  const step = workflowStep(job, "Verify Mailpit identity without running mailpit");
  assert.match(step, /verify-mailpit-image\.mjs identity/u);
  assert.match(step, /binarySha256/u);
  assert.match(step, /mailpit-build-evidence\/mailpit\.sha256/u);
  assert.match(step, /\/out\/mailpit/u);
});
test("source and builder inputs are exact reviewed archives and indexes", () => {
  for (const value of [
    MAILPIT_INPUTS.nodeImage,
    MAILPIT_INPUTS.goImage,
    MAILPIT_INPUTS.upstream.archive,
    MAILPIT_INPUTS.upstream.archiveSha256,
    MAILPIT_INPUTS.licenseTool.archive,
    MAILPIT_INPUTS.licenseTool.archiveSha256,
  ])
    assert.ok(docker.includes(value));
  assert.ok(docker.includes(sha(read("infra/docker/mailpit-build-inputs.json"))));
  assert.ok(docker.includes(MAILPIT_INPUTS.noticesSha256));
});
test("dependency installation suppresses lifecycles and verifies native binaries before frontend execution", () => {
  assert.ok(
    docker.includes(
      "npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund",
    ),
  );
  assert.ok(
    docker.indexOf("verify-mailpit-build.mjs npm") <
      docker.indexOf("MINIFY=true node esbuild.config.mjs"),
  );
  assert.ok(docker.includes("npm audit --audit-level=high --json"));
  assert.doesNotMatch(docker, /npm (?:install|update)|--force|--legacy-peer-deps|latest/u);
});
test("frozen Go graphs are admitted before the license tool or Mailpit executes", () => {
  assert.ok(docker.includes("GOTOOLCHAIN=local GOENV=off GOWORK=off"));
  assert.ok(docker.includes('GOFLAGS="-mod=readonly -p=2"'));
  assert.ok(docker.includes("COPY --from=graph-admission /evidence/graph-verification.json"));
  assert.ok(
    docker.indexOf("FROM go-inputs AS build") > docker.indexOf("verify-mailpit-build.mjs graph"),
  );
  const collector = docker.slice(
    docker.indexOf("sha256sum go.mod go.sum /license-tool/go.mod /license-tool/go.sum"),
    docker.indexOf("FROM frontend AS graph-admission"),
  );
  const commands = [
    "sha256sum go.mod go.sum /license-tool/go.mod /license-tool/go.sum > /out/manifests.sha256",
    "go list -mod=readonly -m -f '{{.Path}} {{.Version}}' all > /out/mailpit-modules.txt",
    "go list -mod=readonly -deps -f '{{.ImportPath}}' . > /out/mailpit-imports.txt",
    "go mod verify;",
    "cd /license-tool;",
    "go list -mod=readonly -m -f '{{.Path}} {{.Version}}' all > /out/tool-modules.txt",
    "go list -mod=readonly -deps -f '{{.ImportPath}}' . > /out/tool-imports.txt",
    "go mod verify;",
    "cd /src; sha256sum -c /out/manifests.sha256",
  ];
  let cursor = 0;
  for (const command of commands) {
    const offset = collector.indexOf(command, cursor);
    assert.ok(offset >= cursor, `missing or unordered frozen Go command: ${command}`);
    cursor = offset + command.length;
  }
  assert.doesNotMatch(collector, /go mod download/u);
  assert.ok(
    docker.includes("-ldflags='-s -w -X github.com/axllent/mailpit/config.Version=v1.31.3'"),
  );
  assert.doesNotMatch(docker, /go get|go mod tidy|GOSUMDB=off|GOTOOLCHAIN=auto/u);
});
test("final image requires notice admission, full MPL source, Go notices and nonroot scratch", () => {
  const runtime = docker.slice(docker.indexOf("FROM scratch AS runtime"));
  for (const value of [
    "COPY --from=evidence-admission",
    "ical.js-2.2.1.tgz",
    "browser-notices/",
    "go-notices.txt",
    "Go-LICENSE",
    "mailpit-NOTICES.txt",
    "USER 1000:1000",
    'ENTRYPOINT ["/usr/bin/mailpit"]',
  ])
    assert.ok(runtime.includes(value));
  assert.doesNotMatch(runtime, /MP_SMTP_RELAY|MP_WEBHOOK|captured-only|COPY.*node_modules|VOLUME/u);
});
