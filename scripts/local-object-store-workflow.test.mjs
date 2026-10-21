import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { workflowJob } from "./workflow-contract-helpers.mjs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
function step(text, name) {
  const marker = `      - name: ${name}\n`;
  assert.equal(text.split(marker).length - 1, 1, `exactly one ${name}`);
  const start = text.indexOf(marker);
  const end = text.indexOf("      - name:", start + marker.length);
  return { start, text: text.slice(start, end < 0 ? undefined : end) };
}
function verifyStorageWorkflow(text) {
  const ordered = [
    "Set up pinned Buildx metadata inspection",
    "Install pinned Cosign for the object-store fixture",
    "Verify the qualified patched object-store image",
    "Prepare private object-store fixture credentials",
    "Validate local service topology",
    "Bootstrap least-privilege private object storage",
    "Exercise encrypted artifact storage with split credentials",
  ].map((name) => step(text, name));
  for (let i = 0; i < ordered.length; i += 1) {
    assert.doesNotMatch(ordered[i].text, /^ {8}(?:if|continue-on-error):/m);
    if (i > 0)
      assert.ok(ordered[i].start > ordered[i - 1].start, "verification must precede execution");
  }
  assert.match(
    ordered[0].text,
    /docker\/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c/,
  );
  assert.match(ordered[0].text, /version: v0\.36\.1\n/);
  assert.match(ordered[0].text, /driver: docker\n/);
  assert.match(
    ordered[1].text,
    /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/,
  );
  assert.match(ordered[1].text, /cosign-release: v3\.1\.3\n/);
  assert.match(ordered[2].text, /set -euo pipefail/);
  assert.match(ordered[2].text, /node scripts\/prepare-ci-object-store\.mjs verify \| tee/);
  const security = workflowJob(text, "object-store-vulnerabilities");
  assert.doesNotMatch(security, /^ {4}(?:if|needs|continue-on-error):/m);
  const ignore = step(security, "Initialize an empty object-store vulnerability-ignore policy");
  const scanStep = step(security, "Reject high or critical object-store vulnerabilities");
  assert.ok(ignore.start < scanStep.start);
  for (const block of [ignore.text, scanStep.text]) {
    assert.doesNotMatch(block, /^ {8}(?:if|continue-on-error):/m);
  }
  assert.match(
    ignore.text,
    /install -m 600 \/dev\/null "\$\{RUNNER_TEMP\}\/object-store\.trivyignore"/,
  );
  const scan = scanStep.text;
  for (const value of [
    "TRIVY_PLATFORM: linux/arm64",
    "uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
    "version: v0.74.0",
    "image-ref: ghcr.io/liangzixuan/cronometer-gold-object-store@sha256:52eed42db355d06738916fc8a5c71b38387f5ae2fbf194211a54d2b85015a817",
    "scanners: vuln",
    "vuln-type: os,library",
    "severity: HIGH,CRITICAL",
    "ignore-unfixed: false",
    'exit-code: "1"',
    `trivyignores: \${{ runner.temp }}/object-store.trivyignore`,
  ])
    assert.ok(scan.includes(value), `missing strict scan setting ${value}`);
  assert.match(ordered[2].text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(ordered[4].text, /node scripts\/prepare-ci-object-store\.mjs prepare/);
  assert.match(
    ordered[5].text,
    /docker compose -f infra\/docker\/compose\.yml -f "\$\{RUNNER_TEMP\}\/patched-object-store\.compose\.json" up -d --wait object-store\n/,
  );
  assert.match(ordered[5].text, /node scripts\/local-object-store\.mjs bootstrap/);
  assert.match(ordered[5].text, /node scripts\/prepare-ci-object-store\.mjs runtime/);
  assert.ok(
    ordered[5].text.indexOf(" bootstrap") < ordered[5].text.indexOf(" runtime"),
    "inspect the bootstrapped process before integration tests",
  );
  const database = text.slice(
    text.indexOf("  database:\n"),
    text.indexOf("    steps:\n", text.indexOf("  database:\n")),
  );
  assert.doesNotMatch(database, /^ {4}(?:if|needs|continue-on-error):/m);
  assert.doesNotMatch(workflowJob(text, "database"), /trivy-action|object-store\.trivyignore/);
  assert.doesNotMatch(text, /^ {2}storage-image:|cosign sign|docker login/m);
  for (const name of [
    "Exercise encrypted artifact storage with split credentials",
    "Drill retention export and erasure production wiring",
    "Rehearse a complete PostgreSQL backup and isolated restore",
    "Exercise live erasure-ledger replay and API/worker readiness",
  ]) {
    const block = step(text, name).text;
    assert.match(block, /node node_modules\/dotenv-cli\/cli\.js/);
    assert.match(block, /--no-expand/);
    assert.match(block, /-e \.local-data\/object-store\/runtime\.env/);
    assert.doesNotMatch(block, /_SECRET_ACCESS_KEY:|_ACCESS_KEY_ID:/);
  }
  const cleanup = step(text, "Stop and remove the owned CI object-store fixture").text;
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /down --volumes --timeout 10/);
  assert.match(cleanup, /test "\$\{GITHUB_ACTIONS\}" = true/);
  assert.match(cleanup, /cleanup \|\| cleanup_status=\$\?/);
  assert.match(cleanup, /node scripts\/local-object-store\.mjs cleanup/);
}

test("CI verifies the exact fixture before startup and supplies private runtime credentials", () => {
  verifyStorageWorkflow(workflow);
});
for (const [name, before, after] of [
  [
    "bypass",
    "      - name: Verify the qualified patched object-store image\n",
    "      - name: Verify the qualified patched object-store image\n        if: false\n",
  ],
  ["wrong scan platform", "TRIVY_PLATFORM: linux/arm64", "TRIVY_PLATFORM: linux/amd64"],
  ["ignore unfixed", "ignore-unfixed: false", "ignore-unfixed: true"],
  ["ignore severity", "severity: HIGH,CRITICAL", "severity: CRITICAL"],
  ["ignore exit", 'exit-code: "1"', 'exit-code: "0"'],
  [
    "mutable scan",
    "image-ref: ghcr.io/liangzixuan/cronometer-gold-object-store@sha256:52eed42db355d06738916fc8a5c71b38387f5ae2fbf194211a54d2b85015a817",
    "image-ref: ghcr.io/liangzixuan/cronometer-gold-object-store:latest",
  ],
  [
    "security dependency",
    "  database:\n",
    "  database:\n    needs: object-store-vulnerabilities\n",
  ],
  [
    "skipped scan job",
    "  object-store-vulnerabilities:\n",
    "  object-store-vulnerabilities:\n    if: false\n",
  ],
  [
    "ignored scan failure",
    "  object-store-vulnerabilities:\n",
    "  object-store-vulnerabilities:\n    continue-on-error: true\n",
  ],
  ["publisher dependency", "  database:\n", "  database:\n    needs: storage-image\n"],
  ["skipped database", "  database:\n", "  database:\n    if: false\n"],
  ["override omitted", ` -f "\${RUNNER_TEMP}/patched-object-store.compose.json"`, ""],
  ["runtime check omitted", "node scripts/prepare-ci-object-store.mjs runtime", "true"],
  ["credentials omitted", "-e .local-data/object-store/runtime.env", "-e .env"],
]) {
  test(`rejects workflow mutation: ${name}`, () => {
    assert.ok(workflow.includes(before));
    assert.throws(() => verifyStorageWorkflow(workflow.replace(before, after)));
  });
}
