import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertStepOrder,
  assertUnconditionalStep,
  workflowJob,
  workflowStep,
} from "./workflow-contract-helpers.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/container-supply-chain.yml", import.meta.url),
  "utf8",
);

const BUILD_ACTION = "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a";
const BUILDX_ACTION = "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c";
const CHECKOUT_ACTION = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const BUILDKIT_IMAGE =
  "moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8";
const COSIGN_ACTION = "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6";
const LOGIN_ACTION = "docker/login-action@dbcb813823bdd20940b903addbd779551569679f";
const QEMU_ACTION = "docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8";
const SBOM_GENERATOR =
  "docker.io/docker/buildkit-syft-scanner@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68";
const TRIVY_ACTION = "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25";
const ATTEST_ACTION = "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8";

const reviewedActionCounts = new Map([
  [ATTEST_ACTION, 3],
  [BUILD_ACTION, 3],
  [BUILDX_ACTION, 4],
  [CHECKOUT_ACTION, 6],
  [COSIGN_ACTION, 2],
  [LOGIN_ACTION, 3],
  [QEMU_ACTION, 2],
  [TRIVY_ACTION, 6],
]);

const criticalControlKeys = [
  "cache",
  "cache-binary",
  "continue-on-error",
  "driver-opts",
  "env",
  "exit-code",
  "id",
  "if",
  "ignore-unfixed",
  "name",
  "outputs",
  "permissions",
  "platforms",
  "provenance",
  "pull",
  "push-to-registry",
  "run",
  "sbom",
  "severity",
  "shell",
  "subject-digest",
  "subject-name",
  "trivyignores",
  "uses",
  "version",
  "with",
];

function githubExpression(value) {
  return `\${{ ${value} }}`;
}

function shellVariable(name) {
  return `\${${name}}`;
}

const publisherFamilies = [
  {
    build: "Build and push patched Node runtime by digest",
    identity: "Verify patched runtime identity, binary, and symbols",
    job: "build-node-runtime",
    scan: "Fail closed on patched runtime high or critical vulnerabilities",
    tagCommand:
      `docker buildx imagetools create --tag "${shellVariable("IMAGE")}:sha-${shellVariable("REVISION")}" ` +
      `"${shellVariable("IMAGE")}@${shellVariable("DIGEST")}"`,
  },
  {
    build: "Build and push by digest with SBOM and provenance",
    identity: "Verify ARM64 runtime identity",
    job: "build-scan-publish-apps",
    scan: "Fail closed on high or critical vulnerabilities",
    tagCommand:
      `docker buildx imagetools create --tag "${shellVariable("published_ref")}" ` +
      `"${shellVariable("IMAGE")}@${shellVariable("DIGEST")}"`,
  },
  {
    build: "Build and push by digest with SBOM and provenance",
    identity: "Verify ARM64 service identity",
    job: "build-scan-publish-services",
    scan: "Fail closed on high or critical vulnerabilities",
    tagCommand:
      `docker buildx imagetools create --tag "${shellVariable("IMAGE")}:sha-${shellVariable("REVISION")}" ` +
      `"${shellVariable("IMAGE")}@${shellVariable("DIGEST")}"`,
  },
];

const publisherPermissions = [
  ["attestations", "write"],
  ["contents", "read"],
  ["id-token", "write"],
  ["packages", "write"],
];

const publisherTrivySettings = [
  ["version", "v0.74.0"],
  ["scan-type", "image"],
  ["image-ref", githubExpression("steps.candidate.outputs.ref")],
  ["scanners", "vuln"],
  ["vuln-type", "os,library"],
  ["severity", "HIGH,CRITICAL"],
  ["ignore-unfixed", "false"],
  ["trivyignores", `${githubExpression("runner.temp")}/empty.trivyignore`],
  ["exit-code", '"1"'],
  ["format", "table"],
  ["hide-progress", "true"],
  ["timeout", "15m"],
  ["cache", "false"],
];

function leadingSpaces(line) {
  return /^ */u.exec(line)?.[0].length ?? 0;
}

function yamlSyntaxLines(source) {
  const result = [];
  let literalHeaderIndent = null;

  for (const line of source.split("\n")) {
    if (literalHeaderIndent !== null) {
      if (line.trim().length === 0) continue;
      if (leadingSpaces(line) > literalHeaderIndent) continue;
      literalHeaderIndent = null;
    }
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    result.push(line);
    if (/^\s*(?:-\s+)?(?:[a-zA-Z0-9_-]+|"[^"]+"|'[^']+'):\s*[>|][0-9+-]*\s*(?:#.*)?$/u.test(line)) {
      literalHeaderIndent = leadingSpaces(line) + (line.trimStart().startsWith("- ") ? 2 : 0);
    }
  }

  return result;
}

function assertRestrictedWorkflowSyntax(source) {
  const criticalKeys = criticalControlKeys.join("|");
  const quotedKey = new RegExp(
    `^\\s*(?:-\\s*)?(?:"(?:${criticalKeys})"|'(?:${criticalKeys})')\\s*:`,
    "u",
  );

  for (const line of yamlSyntaxLines(source)) {
    assert.doesNotMatch(
      line,
      quotedKey,
      "security-critical workflow keys must use canonical unquoted YAML syntax",
    );
    assert.doesNotMatch(
      line,
      /^\s*(?:-\s*)?<<:|:\s*[&*][a-zA-Z0-9_-]+(?:\s|$)/u,
      "workflow security controls must not use YAML anchors, aliases, or merge keys",
    );
  }
}

function assertOnlyReviewedActions(source) {
  const actionValues = [];

  for (const line of yamlSyntaxLines(source)) {
    const match =
      /^ {8}uses:\s+(\S+)(?:\s+#.*)?$/u.exec(line) ??
      /^ {6}- uses:\s+(\S+)(?:\s+#.*)?$/u.exec(line);
    if (match !== null) {
      actionValues.push(match[1]);
      continue;
    }
    if (leadingSpaces(line) <= 8 && /\buses\s*:/u.test(line)) {
      assert.fail("active actions must use the reviewed canonical uses syntax");
    }
  }

  const actualCounts = new Map();
  for (const action of actionValues) actualCounts.set(action, (actualCounts.get(action) ?? 0) + 1);
  assert.deepEqual(
    [...actualCounts].sort(([left], [right]) => left.localeCompare(right)),
    [...reviewedActionCounts].sort(([left], [right]) => left.localeCompare(right)),
    "the globally reviewed action identities and invocation counts changed",
  );
  assert.deepEqual(
    actionValues.filter((action) => action.includes("setup-buildx-action@")),
    Array.from({ length: 4 }, () => BUILDX_ACTION),
    "all four Buildx setups must use only the reviewed pinned action",
  );
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    assert.doesNotMatch(
      line,
      /\bdocker\s+buildx\s+(?:create|install|rm|stop|uninstall|use)\b/u,
      "shell commands must not replace or reconfigure the reviewed Buildx builders",
    );
  }
}

function assertOnlyReviewedPublicationCommands(source) {
  const activeLines = source
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
  assert.deepEqual(
    activeLines.filter((line) => /\bdocker\s+buildx\s+imagetools\s+create\b/u.test(line)),
    publisherFamilies.map((family) => `          ${family.tagCommand}`),
    "only the three post-verification immutable-tag commands may publish repository images",
  );

  const forbiddenPublication = [
    /\bdocker\s+(?:image\s+)?push\b/u,
    /\bdocker\s+tag\b/u,
    /\bdocker\s+manifest\s+(?:annotate|create|push)\b/u,
    /\bdocker\s+(?:buildx\s+)?build\b/u,
    /\b(?:crane|oras)\s+(?:append|copy|mutate|push)\b/u,
    /\bregctl\s+image\s+copy\b/u,
    /\bskopeo\s+copy\b/u,
  ];
  for (const line of activeLines) {
    assert.equal(
      forbiddenPublication.some((pattern) => pattern.test(line)),
      false,
      `unreviewed registry publication command: ${line.trim()}`,
    );
  }
}

function assertOnlyReviewedIgnorePolicyReferences(source) {
  const expectedCounts = new Map([
    [`run: install -m 600 /dev/null "${shellVariable("RUNNER_TEMP")}/empty.trivyignore"`, 3],
    [
      `run: install -m 600 /dev/null "${shellVariable("RUNNER_TEMP")}/external.empty.trivyignore"`,
      1,
    ],
    [`trivyignores: ${githubExpression("runner.temp")}/empty.trivyignore`, 5],
    [`trivyignores: ${githubExpression("runner.temp")}/external.empty.trivyignore`, 1],
  ]);
  const actualCounts = new Map();
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("#") || !line.includes("empty.trivyignore")) continue;
    const reference = line.trim();
    actualCounts.set(reference, (actualCounts.get(reference) ?? 0) + 1);
  }
  assert.deepEqual(
    [...actualCounts].sort(([left], [right]) => left.localeCompare(right)),
    [...expectedCounts].sort(([left], [right]) => left.localeCompare(right)),
    "empty Trivy ignore files may only be initialized empty and consumed by reviewed scans",
  );
}

function assertAdjacentSteps(job, firstName, secondName) {
  const lines = job.split("\n");
  const firstLine = `      - name: ${firstName}`;
  const starts = lines.flatMap((line, index) => (line === firstLine ? [index] : []));
  assert.equal(starts.length, 1, `job must define step ${firstName} exactly once`);
  const nextStep = lines.slice(starts[0] + 1).find((line) => /^ {6}- /u.test(line));
  assert.equal(
    nextStep,
    `      - name: ${secondName}`,
    `${secondName} must immediately follow ${firstName}`,
  );
}

function directBlock(source, header, label) {
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) => (line === header ? [index] : []));
  assert.equal(starts.length, 1, `${label} must define ${header.trim()} exactly once`);

  const start = starts[0];
  const headerIndent = leadingSpaces(header);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (leadingSpaces(line) <= headerIndent) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function directScalarValues(source, indentation, key) {
  const pattern = new RegExp(`^ {${indentation}}${key}:(?: (.*?))?(?: #.*)?$`, "u");
  return source.split("\n").flatMap((line) => {
    if (line.trimStart().startsWith("#")) return [];
    const match = pattern.exec(line);
    return match === null ? [] : [match[1] ?? ""];
  });
}

function assertExactScalar(source, indentation, key, expected, label) {
  assert.deepEqual(
    directScalarValues(source, indentation, key),
    [expected],
    `${label} must define one exact ${key}`,
  );
}

function assertMissingScalar(source, indentation, key, label) {
  assert.deepEqual(
    directScalarValues(source, indentation, key),
    [],
    `${label} must not define ${key}`,
  );
}

function simpleMappingEntries(source, header, label) {
  const block = directBlock(source, header, label);
  const childIndent = leadingSpaces(header) + 2;
  return block.split("\n").flatMap((line) => {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) return [];
    assert.equal(
      leadingSpaces(line),
      childIndent,
      `${label} must contain only direct scalar entries`,
    );
    const match = /^\s*([a-zA-Z0-9_-]+):(?: (.*?))?(?: #.*)?$/u.exec(line);
    assert.notEqual(match, null, `${label} contains a malformed scalar entry`);
    return [[match[1], match[2] ?? ""]];
  });
}

function assertExactMapping(source, header, expected, label) {
  assert.deepEqual(simpleMappingEntries(source, header, label), expected, `${label} changed`);
}

function assertExactMappingScalar(source, header, key, expected, label) {
  const block = directBlock(source, header, label);
  assertExactScalar(block, leadingSpaces(header) + 2, key, expected, label);
}

function assertPinnedBuildx(job, label) {
  const step = workflowStep(job, "Set up pinned Buildx and BuildKit");
  assertUnconditionalStep(step, `${label} Buildx setup`);
  assertExactScalar(step, 8, "uses", BUILDX_ACTION, `${label} Buildx setup`);
  assertExactMapping(
    step,
    "        with:",
    [
      ["version", "v0.36.1"],
      ["driver-opts", `image=${BUILDKIT_IMAGE}`],
      ["cache-binary", "false"],
    ],
    `${label} Buildx setup inputs`,
  );
}

function assertStrictTrivyScan(step, settings, label) {
  assertExactScalar(step, 8, "uses", TRIVY_ACTION, label);
  assertMissingScalar(step, 8, "run", label);
  assertMissingScalar(step, 8, "shell", label);
  assertExactMapping(step, "        env:", [["TRIVY_PLATFORM", "linux/arm64"]], `${label} env`);
  assertExactMapping(step, "        with:", settings, `${label} inputs`);
}

function assertPublisherBuild(build, label) {
  assertExactScalar(build, 8, "uses", BUILD_ACTION, label);
  assertExactScalar(build, 8, "if", "steps.existing.outputs.exists != 'true'", label);
  assertMissingScalar(build, 8, "continue-on-error", label);
  assertMissingScalar(build, 8, "run", label);
  assertMissingScalar(build, 8, "shell", label);
  assertExactMappingScalar(build, "        with:", "platforms", "linux/arm64", `${label} platform`);
  assertExactMappingScalar(build, "        with:", "pull", "true", `${label} base-image refresh`);
  assertExactMappingScalar(
    build,
    "        with:",
    "outputs",
    `type=image,name=${githubExpression("steps.image.outputs.name")},push-by-digest=true,name-canonical=true,push=true`,
    `${label} digest-only output`,
  );
  assertExactMappingScalar(
    build,
    "        with:",
    "provenance",
    "mode=max,version=v1",
    `${label} BuildKit provenance`,
  );
  assertExactMappingScalar(
    build,
    "        with:",
    "sbom",
    `generator=${SBOM_GENERATOR}`,
    `${label} BuildKit SBOM`,
  );
}

function assertReviewedTagStep(job, family) {
  const step = workflowStep(job, "Create the immutable commit tag");
  const label = `${family.job} immutable-tag publication`;
  assertExactScalar(step, 8, "if", "steps.existing.outputs.exists != 'true'", label);
  assertMissingScalar(step, 8, "continue-on-error", label);
  assertMissingScalar(step, 8, "shell", label);
  assertExactMapping(
    step,
    "        env:",
    [
      ["DIGEST", githubExpression("steps.candidate.outputs.digest")],
      ["IMAGE", githubExpression("steps.image.outputs.name")],
      ["REVISION", githubExpression("github.sha")],
    ],
    `${label} env`,
  );
  assertExactScalar(step, 8, "run", "|", label);
  assert.deepEqual(
    step.split("\n").filter((line) => /\bdocker\s+buildx\s+imagetools\s+create\b/u.test(line)),
    [`          ${family.tagCommand}`],
    `${label} command changed`,
  );
}

function exactGhAttestationCommandLines() {
  return [
    `            if gh attestation verify "oci://${shellVariable("IMAGE")}@${shellVariable("DIGEST")}" \\`,
    `              --repo "${shellVariable("GITHUB_REPOSITORY")}" \\`,
    `              --signer-workflow "${shellVariable("GITHUB_REPOSITORY")}/.github/workflows/container-supply-chain.yml" \\`,
    `              --signer-digest "${shellVariable("GITHUB_WORKFLOW_SHA")}" \\`,
    `              --source-digest "${shellVariable("REVISION")}" \\`,
    `              --source-ref "${shellVariable("GITHUB_REF")}" \\`,
    "              --predicate-type 'https://slsa.dev/provenance/v1' \\",
    "              --deny-self-hosted-runners; then",
  ];
}

function assertExactGhAttestationCommand(step, label) {
  const expected = exactGhAttestationCommandLines();
  const lines = step.split("\n");
  const starts = lines.flatMap((line, index) => (line === expected[0] ? [index] : []));
  assert.equal(starts.length, 1, `${label} must contain one exact gh attestation command`);
  assert.deepEqual(
    lines.slice(starts[0], starts[0] + expected.length),
    expected,
    `${label} gh attestation identity flags changed`,
  );
  assert.equal(
    lines.filter((line) => line.includes("gh attestation verify")).length,
    1,
    `${label} must not duplicate or comment out the gh attestation command`,
  );
}

function assertPublisherFamily(family) {
  const job = workflowJob(workflow, family.job);
  const build = workflowStep(job, family.build);
  const initializeIgnore = workflowStep(
    job,
    "Initialize an explicit empty vulnerability-ignore policy",
  );
  const scan = workflowStep(job, family.scan);
  const record = workflowStep(job, "Record GitHub build provenance");
  const verify = workflowStep(job, "Verify GitHub build provenance");

  assertExactMapping(job, "    permissions:", publisherPermissions, `${family.job} permissions`);
  assertPinnedBuildx(job, family.job);

  assertPublisherBuild(build, `${family.job} producer`);

  assertUnconditionalStep(initializeIgnore, `${family.job} empty Trivy ignore setup`);
  assertExactScalar(
    initializeIgnore,
    8,
    "run",
    `install -m 600 /dev/null "${shellVariable("RUNNER_TEMP")}/empty.trivyignore"`,
    `${family.job} empty Trivy ignore setup`,
  );
  assertUnconditionalStep(scan, `${family.job} strict Trivy scan`);
  assertStrictTrivyScan(scan, publisherTrivySettings, `${family.job} strict Trivy scan`);
  assertAdjacentSteps(job, "Initialize an explicit empty vulnerability-ignore policy", family.scan);

  assertExactScalar(
    record,
    8,
    "if",
    "steps.existing.outputs.exists != 'true'",
    `${family.job} GitHub provenance publication`,
  );
  assertExactScalar(
    record,
    8,
    "uses",
    ATTEST_ACTION,
    `${family.job} GitHub provenance publication`,
  );
  assertMissingScalar(
    record,
    8,
    "continue-on-error",
    `${family.job} GitHub provenance publication`,
  );
  assertExactMapping(
    record,
    "        with:",
    [
      ["subject-name", githubExpression("steps.image.outputs.name")],
      ["subject-digest", githubExpression("steps.candidate.outputs.digest")],
      ["push-to-registry", "true"],
    ],
    `${family.job} GitHub provenance publication inputs`,
  );

  assertUnconditionalStep(verify, `${family.job} GitHub provenance verification`);
  assertExactMapping(
    verify,
    "        env:",
    [
      ["DIGEST", githubExpression("steps.candidate.outputs.digest")],
      ["GH_TOKEN", githubExpression("github.token")],
      ["IMAGE", githubExpression("steps.image.outputs.name")],
      ["REVISION", githubExpression("github.sha")],
    ],
    `${family.job} GitHub provenance verification env`,
  );
  assertExactScalar(verify, 8, "run", "|", `${family.job} GitHub provenance verification`);
  assertExactGhAttestationCommand(verify, `${family.job} GitHub provenance verification`);
  assertReviewedTagStep(job, family);

  assertStepOrder(job, [
    family.build,
    family.identity,
    "Initialize an explicit empty vulnerability-ignore policy",
    family.scan,
    "Record GitHub build provenance",
    "Verify GitHub build provenance",
    "Create the immutable commit tag",
    "Verify the immutable commit tag",
  ]);
}

test("exact-binds every repository publisher toolchain, scan, and provenance gate", () => {
  assertRestrictedWorkflowSyntax(workflow);
  assertOnlyReviewedActions(workflow);
  assertOnlyReviewedPublicationCommands(workflow);
  assertOnlyReviewedIgnorePolicyReferences(workflow);
  for (const family of publisherFamilies) assertPublisherFamily(family);
});

test("exact-binds the external Meilisearch Buildx and current Trivy gate", () => {
  const job = workflowJob(workflow, "validate-external-images");
  const initializeIgnore = workflowStep(
    job,
    "Initialize an explicit empty vulnerability-ignore policy",
  );
  const scan = workflowStep(job, "Scan the exact locked ARM64 image");

  assertExactMapping(job, "    permissions:", [["contents", "read"]], "external-image permissions");
  assertPinnedBuildx(job, "external image");

  assertUnconditionalStep(initializeIgnore, "external-image empty Trivy ignore setup");
  assertExactScalar(
    initializeIgnore,
    8,
    "run",
    `install -m 600 /dev/null "${shellVariable("RUNNER_TEMP")}/external.empty.trivyignore"`,
    "external-image empty Trivy ignore setup",
  );
  assertExactScalar(scan, 8, "id", "scan", "external-image strict Trivy scan");
  assertExactScalar(scan, 8, "continue-on-error", "true", "external-image strict Trivy scan");
  assertMissingScalar(scan, 8, "if", "external-image strict Trivy scan");
  assertStrictTrivyScan(
    scan,
    publisherTrivySettings.map(([key, value]) => [
      key,
      key === "image-ref"
        ? githubExpression("steps.lock.outputs.ref")
        : key === "trivyignores"
          ? `${githubExpression("runner.temp")}/external.empty.trivyignore`
          : value,
    ]),
    "external-image strict Trivy scan",
  );
  assertAdjacentSteps(
    job,
    "Initialize an explicit empty vulnerability-ignore policy",
    "Scan the exact locked ARM64 image",
  );
  assertStepOrder(job, [
    "Set up pinned Buildx and BuildKit",
    "Verify the locked index and ARM64 runtime identity",
    "Initialize an explicit empty vulnerability-ignore policy",
    "Scan the exact locked ARM64 image",
    "Install pinned Cosign for signed upstream images",
    "Verify upstream provenance evidence",
    "Enforce current scan, provenance, and reviewed approval",
  ]);
});

test("structural bindings reject commented and duplicated security controls", () => {
  const nodeJob = workflowJob(workflow, "build-node-runtime");
  const setup = workflowStep(nodeJob, "Set up pinned Buildx and BuildKit");
  const commentedVersion = setup.replace(
    "          version: v0.36.1",
    "          # version: v0.36.1",
  );
  assert.throws(() => assertPinnedBuildx(commentedVersion, "fixture"), /changed/u);

  const scan = workflowStep(
    nodeJob,
    "Fail closed on patched runtime high or critical vulnerabilities",
  );
  const duplicatedSeverity = scan.replace(
    "          severity: HIGH,CRITICAL",
    "          severity: HIGH,CRITICAL\n          severity: HIGH,CRITICAL",
  );
  assert.throws(
    () => assertStrictTrivyScan(duplicatedSeverity, publisherTrivySettings, "fixture"),
    /changed/u,
  );

  const verify = workflowStep(nodeJob, "Verify GitHub build provenance");
  const exactCommand = exactGhAttestationCommandLines()[0];
  const commentedCommand = verify.replace(exactCommand, exactCommand.replace("if gh", "# if gh"));
  assert.throws(
    () => assertExactGhAttestationCommand(commentedCommand, "fixture"),
    /one exact gh attestation command/u,
  );
});

test("restricted workflow syntax rejects quoted control keys and alternate actions", () => {
  const quotedContinueOnError = workflow.replace(
    "        continue-on-error: true",
    '        "continue-on-error": true',
  );
  assert.throws(
    () => assertRestrictedWorkflowSyntax(quotedContinueOnError),
    /canonical unquoted YAML syntax/u,
  );

  const alternateBuildx = workflow.replace(
    "      - name: Set up pinned Buildx and BuildKit",
    "      - name: Override the trusted builder\n" +
      "        uses: docker/setup-buildx-action@main\n\n" +
      "      - name: Set up pinned Buildx and BuildKit",
  );
  assert.throws(
    () => assertOnlyReviewedActions(alternateBuildx),
    /reviewed action identities and invocation counts changed/u,
  );

  const shellBuilderOverride = workflow.replace(
    "      - name: Set up pinned Buildx and BuildKit",
    "      - name: Override the trusted builder from the shell\n" +
      "        run: docker buildx create --use unreviewed\n\n" +
      "      - name: Set up pinned Buildx and BuildKit",
  );
  assert.throws(
    () => assertOnlyReviewedActions(shellBuilderOverride),
    /must not replace or reconfigure the reviewed Buildx builders/u,
  );
});

test("publisher mutations cannot tag before scanning or replace digest-only output", () => {
  const nodeJob = workflowJob(workflow, "build-node-runtime");
  const build = workflowStep(nodeJob, "Build and push patched Node runtime by digest");
  const taggedOutput = build.replace(
    `          outputs: type=image,name=${githubExpression("steps.image.outputs.name")},push-by-digest=true,name-canonical=true,push=true`,
    `          outputs: type=image,name=${githubExpression("steps.image.outputs.name")}:sha-${githubExpression("github.sha")},push=true`,
  );
  assert.throws(
    () => assertPublisherBuild(taggedOutput, "fixture"),
    /digest-only output must define one exact outputs/u,
  );

  const preScanPublication = workflow.replace(
    "      - name: Initialize an explicit empty vulnerability-ignore policy",
    "      - name: Publish an unscanned candidate\n" +
      "        run: docker buildx imagetools create --tag latest candidate\n\n" +
      "      - name: Initialize an explicit empty vulnerability-ignore policy",
  );
  assert.throws(
    () => assertOnlyReviewedPublicationCommands(preScanPublication),
    /only the three post-verification immutable-tag commands/u,
  );
});

test("the empty ignore initializer must remain immediately adjacent to its scan", () => {
  const nodeJob = workflowJob(workflow, "build-node-runtime");
  const rewrittenIgnore = nodeJob.replace(
    `        run: install -m 600 /dev/null "${shellVariable("RUNNER_TEMP")}/empty.trivyignore"`,
    `        run: install -m 600 /dev/null "${shellVariable("RUNNER_TEMP")}/empty.trivyignore"\n\n` +
      "      - name: Rewrite the empty ignore policy\n" +
      `        run: printf 'CVE-0000-0000\\n' > "${shellVariable("RUNNER_TEMP")}/empty.trivyignore"`,
  );
  assert.throws(
    () =>
      assertAdjacentSteps(
        rewrittenIgnore,
        "Initialize an explicit empty vulnerability-ignore policy",
        "Fail closed on patched runtime high or critical vulnerabilities",
      ),
    /must immediately follow/u,
  );
  assert.throws(
    () => assertOnlyReviewedIgnorePolicyReferences(rewrittenIgnore),
    /may only be initialized empty and consumed by reviewed scans/u,
  );
});
