import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { workflowJob } from "./workflow-contract-helpers.mjs";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const containerWorkflow = readFileSync(
  new URL("../.github/workflows/container-supply-chain.yml", import.meta.url),
  "utf8",
);
const guidance = readFileSync(
  new URL("../docs/quality/container-supply-chain.md", import.meta.url),
  "utf8",
);

test("keeps skipped container jobs out of pre-merge branch protection", () => {
  assert.match(ciWorkflow, /^on:\n {2}pull_request:\n {2}push:$/m);
  for (const name of ["quality", "secrets", "database"]) {
    const job = workflowJob(ciWorkflow, name);
    assert.doesNotMatch(job, /^ {4}if:/m, `${name} must run without a job-level condition`);
  }

  assert.match(containerWorkflow, /^on:\n {2}push:\n {2}workflow_dispatch:$/m);
  assert.doesNotMatch(containerWorkflow, /^ {2}pull_request:/m);
  for (const name of [
    "build-node-runtime",
    "build-scan-publish-apps",
    "build-scan-publish-services",
    "validate-external-images",
  ]) {
    assert.match(
      workflowJob(containerWorkflow, name),
      /^ {4}if: github\.ref_name == github\.event\.repository\.default_branch$/m,
      `${name} must remain explicitly default-branch-only`,
    );
  }

  assert.match(
    guidance,
    /Protect the default branch with the always-running `quality`, `secrets`, and\n {2}`database` checks/u,
  );
  assert.match(guidance, /could satisfy\n {2}that setting without executing the container gate/u);
  assert.match(guidance, /mandatory \*\*post-merge release evidence\*\*/u);
  assert.doesNotMatch(guidance, /require all seven repository-artifact checks/u);
});
