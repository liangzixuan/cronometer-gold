import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { workflowJob, workflowStep } from "./workflow-contract-helpers.mjs";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const terraformActionIdentity = "hashicorp/setup-terraform";
const terraformAction = "hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e";
const terraformUseLine = `        uses: ${terraformAction} # v4.0.1`;
const terraformStep = [
  "      - name: Set up Terraform",
  terraformUseLine,
  "        with:",
  "          terraform_version: 1.5.7",
  "",
].join("\n");

function assertReviewedTerraformSetup(source) {
  const quality = workflowJob(source, "quality");
  const setup = workflowStep(quality, "Set up Terraform");

  assert.equal(
    setup,
    terraformStep,
    "Terraform setup must remain the exact reviewed full-SHA action with only version 1.5.7",
  );
  assert.deepEqual(
    source.split("\n").filter((line) => line.toLowerCase().includes(terraformActionIdentity)),
    [terraformUseLine],
    "the workflow must contain exactly one canonical setup-terraform reference, including comments",
  );
}

test("pins the CI Terraform setup to the reviewed Node 24 action", () => {
  assertReviewedTerraformSetup(ciWorkflow);
});

test("rejects alternate Terraform action identities and hidden references", () => {
  const alternateReferences = [
    [
      "the former v3 commit",
      terraformUseLine.replace(
        terraformAction,
        "hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd",
      ),
    ],
    ["the floating v4 tag", "        uses: hashicorp/setup-terraform@v4"],
    ["the version tag", "        uses: hashicorp/setup-terraform@v4.0.1"],
    ["the main branch", "        uses: hashicorp/setup-terraform@main"],
    ["a quoted uses key", terraformUseLine.replace("uses:", '"uses":')],
    ["a comment-hidden use", terraformUseLine.replace("uses:", "# uses:")],
  ];

  for (const [label, replacement] of alternateReferences) {
    const mutated = ciWorkflow.replace(terraformUseLine, replacement);
    assert.throws(
      () => assertReviewedTerraformSetup(mutated),
      { name: "AssertionError" },
      `must reject ${label}`,
    );
  }

  const duplicatedUse = ciWorkflow.replace(
    terraformUseLine,
    `${terraformUseLine}\n${terraformUseLine}`,
  );
  assert.throws(
    () => assertReviewedTerraformSetup(duplicatedUse),
    { name: "AssertionError" },
    "must reject a duplicate setup-terraform use",
  );

  const commentedDuplicate = ciWorkflow.replace(
    terraformUseLine,
    `${terraformUseLine}\n        # ${terraformUseLine.trim()}`,
  );
  assert.throws(
    () => assertReviewedTerraformSetup(commentedDuplicate),
    { name: "AssertionError" },
    "must reject a comment-hidden duplicate setup-terraform use",
  );

  const mixedCaseAlternate = ciWorkflow.replace(
    terraformStep,
    `${terraformStep}      - name: Alternate mixed-case Terraform setup
        uses: HashiCorp/setup-terraform@main

`,
  );
  assert.throws(
    () => assertReviewedTerraformSetup(mixedCaseAlternate),
    { name: "AssertionError" },
    "must reject a mixed-case alternate setup-terraform use while preserving the canonical step",
  );
});

test("rejects duplicate steps, version drift, and extra Terraform inputs", () => {
  const mutations = [
    [
      "a duplicate setup step",
      ciWorkflow.replace(terraformStep, `${terraformStep}${terraformStep}`),
    ],
    [
      "a different Terraform version",
      ciWorkflow.replace(
        "          terraform_version: 1.5.7",
        "          terraform_version: 1.6.0",
      ),
    ],
    [
      "a credential input",
      ciWorkflow.replace(
        "          terraform_version: 1.5.7",
        "          terraform_version: 1.5.7\n          cli_config_credentials_token: injected",
      ),
    ],
    [
      "a wrapper override",
      ciWorkflow.replace(
        "          terraform_version: 1.5.7",
        "          terraform_version: 1.5.7\n          terraform_wrapper: false",
      ),
    ],
  ];

  for (const [label, mutated] of mutations) {
    assert.throws(
      () => assertReviewedTerraformSetup(mutated),
      { name: "AssertionError" },
      `must reject ${label}`,
    );
  }
});
