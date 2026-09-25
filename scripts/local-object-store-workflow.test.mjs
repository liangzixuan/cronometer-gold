import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
    "Verify the approved object-store index and ARM64 release signatures",
    "Initialize an empty object-store vulnerability-ignore policy",
    "Reject high or critical object-store vulnerabilities before execution",
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
  assert.match(ordered[2].text, /node scripts\/verify-local-object-store-image\.mjs \| tee/);
  assert.match(
    ordered[3].text,
    /install -m 600 \/dev\/null "\$\{RUNNER_TEMP\}\/object-store\.trivyignore"/,
  );
  const scan = ordered[4].text;
  for (const value of [
    "TRIVY_PLATFORM: linux/arm64",
    "uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
    "version: v0.74.0",
    "image-ref: ghcr.io/chrislusf/seaweedfs@sha256:d4cf67729aa8777e1a43a5b61d72e5b96179e4b7bac9a221cb14cbc2036cb32e",
    "scanners: vuln",
    "vuln-type: os,library",
    "severity: HIGH,CRITICAL",
    "ignore-unfixed: false",
    'exit-code: "1"',
    `trivyignores: \${{ runner.temp }}/object-store.trivyignore`,
  ])
    assert.ok(scan.includes(value), `missing strict scan setting ${value}`);
  assert.match(ordered[6].text, /assert\.equal\(service\.image, OBJECT_STORE_REF\)/);
  assert.match(ordered[7].text, /up -d --wait object-store\n/);
  assert.match(ordered[7].text, /node scripts\/local-object-store\.mjs bootstrap/);
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
    "      - name: Verify the approved object-store index and ARM64 release signatures\n",
    "      - name: Verify the approved object-store index and ARM64 release signatures\n        if: false\n",
  ],
  ["wrong scan platform", "TRIVY_PLATFORM: linux/arm64", "TRIVY_PLATFORM: linux/amd64"],
  ["ignore unfixed", "ignore-unfixed: false", "ignore-unfixed: true"],
  ["ignore severity", "severity: HIGH,CRITICAL", "severity: CRITICAL"],
  ["ignore exit", 'exit-code: "1"', 'exit-code: "0"'],
  [
    "mutable scan",
    "image-ref: ghcr.io/chrislusf/seaweedfs@sha256:d4cf67729aa8777e1a43a5b61d72e5b96179e4b7bac9a221cb14cbc2036cb32e",
    "image-ref: ghcr.io/chrislusf/seaweedfs:latest",
  ],
  ["credentials omitted", "-e .local-data/object-store/runtime.env", "-e .env"],
]) {
  test(`rejects workflow mutation: ${name}`, () => {
    assert.ok(workflow.includes(before));
    assert.throws(() => verifyStorageWorkflow(workflow.replace(before, after)));
  });
}
