import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/container-supply-chain.yml", import.meta.url),
  "utf8",
);
const buildAction = "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a";
function job(text, name) {
  const marker = `  ${name}:\n`;
  assert.equal(text.split(marker).length - 1, 1);
  const start = text.indexOf(marker);
  const rest = text.slice(start + marker.length);
  const end = /^ {2}[a-z][a-z-]*:\n/mu.exec(rest)?.index;
  return text.slice(start, end === undefined ? undefined : start + marker.length + end);
}
function step(text, name) {
  const marker = `      - name: ${name}\n`;
  assert.equal(text.split(marker).length - 1, 1, `exactly one ${name}`);
  const start = text.indexOf(marker);
  const end = text.indexOf("      - name:", start + marker.length);
  return { start, text: text.slice(start, end < 0 ? undefined : end) };
}
function orderedSteps(text, names) {
  const blocks = names.map((name) => step(text, name));
  for (let index = 0; index < blocks.length; index += 1) {
    assert.doesNotMatch(blocks[index].text, /^ {8}(?:if|continue-on-error):/mu);
    if (index > 0)
      assert.ok(
        blocks[index].start > blocks[index - 1].start,
        "verification must precede execution",
      );
  }
  return blocks;
}
function strictScan(block, imageRef, ignoreFile) {
  for (const value of [
    "TRIVY_PLATFORM: linux/arm64",
    "uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
    "version: v0.74.0",
    "scan-type: image",
    `image-ref: ${imageRef}`,
    "scanners: vuln",
    "vuln-type: os,library",
    "severity: HIGH,CRITICAL",
    "ignore-unfixed: false",
    'exit-code: "1"',
    `trivyignores: \${{ runner.temp }}/${ignoreFile}`,
  ])
    assert.ok(block.includes(value), `missing strict scan setting ${value}`);
}
function verifier(block, mode, upstream = false) {
  assert.match(block, /set -euo pipefail/u);
  assert.ok(block.includes(`node scripts/verify-patched-object-store-image.mjs ${mode} \\`));
  for (const argument of [
    `--image-ref "\${IMAGE_REF}"`,
    `--revision "\${REVISION}"`,
    `--workflow-sha "\${GITHUB_WORKFLOW_SHA}"`,
    `--source-ref "\${GITHUB_REF}"`,
  ]) {
    assert.ok(block.includes(argument));
  }
  assert.doesNotMatch(block, /--binary-metadata/u);
  if (upstream) assert.match(block, /node scripts\/verify-local-object-store-image\.mjs \| tee/u);
}
function verifyStorageWorkflow(text) {
  const storage = job(text, "storage-image");
  assert.match(
    storage,
    /^ {4}if: github\.ref_name == github\.event\.repository\.default_branch$/mu,
  );
  assert.equal(storage.match(/^ {4}if:/gmu)?.length, 1);
  assert.doesNotMatch(storage, /^ {4}continue-on-error:/mu);
  assert.match(storage, /runs-on: ubuntu-24\.04-arm/u);
  for (const permission of [
    "contents: read",
    "packages: write",
    "id-token: write",
    "attestations: write",
  ])
    assert.ok(storage.includes(permission));
  assert.match(storage, /ref: \$\{\{ steps\.export\.outputs\.ref \}\}/u);
  const storageSteps = orderedSteps(storage, [
    "Require the approved storage publication context",
    "Set up pinned storage Buildx and BuildKit",
    "Install pinned storage Cosign",
    "Verify the unchanged signed upstream storage base",
    "Log in for the project storage image",
    "Resolve the immutable storage commit tag",
    "Export the exact storage build evidence",
    "Select the exact storage candidate",
    "Verify patched storage identity without running weed",
    "Initialize an empty patched-storage vulnerability-ignore policy",
    "Reject all high and critical patched-storage vulnerabilities",
    "Inventory the patched storage image",
    "Require the patched gRPC binary in the scan inventory",
    "Verify the signed same-source storage digest",
    "Export the verified storage digest",
  ]);
  for (const condition of [
    `test "\${EVENT_NAME}" = push`,
    `test "\${SOURCE_REF}" = refs/heads/codex/retention-features`,
    `test "\${SOURCE_REPOSITORY}" = liangzixuan/cronometer-gold`,
    `test "\${REVISION}" = "\${WORKFLOW_REVISION}"`,
    `test "\${RUNNER_ARCH}" = ARM64`,
  ])
    assert.ok(storageSteps[0].text.includes(condition));
  assert.match(
    storageSteps[1].text,
    /docker\/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c/u,
  );
  assert.match(storageSteps[1].text, /version: v0\.36\.1/u);
  assert.match(
    storageSteps[1].text,
    /driver-opts: image=moby\/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8/u,
  );
  assert.match(
    storageSteps[2].text,
    /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/u,
  );
  assert.match(storageSteps[2].text, /cosign-release: v3\.1\.3/u);
  assert.match(storageSteps[3].text, /set -euo pipefail/u);
  assert.match(storageSteps[3].text, /node scripts\/verify-local-object-store-image\.mjs \| tee/u);
  assert.match(storageSteps[5].text, /manifest unknown\|not found/u);
  const build = step(storage, "Build the patched storage candidate by digest");
  assert.ok(build.start > storageSteps[5].start && build.start < storageSteps[6].start);
  for (const [block, target] of [
    [build.text, "runtime"],
    [storageSteps[6].text, "build-evidence"],
  ]) {
    assert.ok(block.includes(`uses: ${buildAction}`));
    assert.match(block, /context: \.\n/u);
    assert.match(block, /file: infra\/docker\/object-store\.Dockerfile/u);
    assert.ok(block.includes(`target: ${target}\n`));
    assert.match(block, /platforms: linux\/arm64/u);
    assert.match(block, /pull: true/u);
    assert.ok(block.includes(`build-args: REVISION=\${{ github.sha }}`));
  }
  assert.match(build.text, /provenance: mode=max,version=v1/u);
  assert.match(
    build.text,
    /sbom: generator=docker\.io\/docker\/buildkit-syft-scanner@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68/u,
  );
  assert.match(
    storageSteps[7].text,
    /for evidence in go\.mod go\.sum modules\.json weed-buildinfo\.txt weed\.sha256 licenses\/NOTICES\.txt/u,
  );
  assert.match(storageSteps[7].text, /base64 --wrap=76/u);
  verifier(storageSteps[8].text, "identity");
  assert.match(storageSteps[8].text, /\.binarySha256/u);
  assert.match(storageSteps[8].text, /object-store-build-evidence\/weed\.sha256/u);
  assert.match(storageSteps[9].text, /install -m 600 \/dev\/null/u);
  strictScan(
    storageSteps[10].text,
    `\${{ steps.candidate.outputs.ref }}`,
    "patched-storage.trivyignore",
  );
  const inventory = storageSteps[11].text;
  for (const setting of [
    "TRIVY_PLATFORM: linux/arm64",
    "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
    "version: v0.74.0",
    "skip-setup-trivy: true",
    "list-all-pkgs: true",
    "format: json",
    "scanners: vuln",
    "vuln-type: os,library",
    "ignore-unfixed: false",
    "severity: UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
    `image-ref: \${{ steps.candidate.outputs.ref }}`,
    `trivyignores: \${{ runner.temp }}/patched-storage.trivyignore`,
  ])
    assert.ok(inventory.includes(setting));
  for (const setting of [
    '.Type == "gobinary"',
    '(.Target | ltrimstr("/")) == "usr/bin/weed"',
    '.Name == "google.golang.org/grpc"',
    '.Version == "v1.85.0-dev.0.20260825072537-93e31b48545e"',
    "jq -e",
  ])
    assert.ok(storageSteps[12].text.includes(setting));
  const sign = step(storage, "Sign the scanned project storage digest");
  const attest = step(storage, "Attest the scanned project storage digest");
  assert.ok(
    sign.start > storageSteps[12].start &&
      attest.start > sign.start &&
      storageSteps[13].start > attest.start,
  );
  for (const block of [
    build.text,
    sign.text,
    attest.text,
    step(storage, "Publish the immutable verified storage tag").text,
  ]) {
    assert.match(block, /if: steps\.existing\.outputs\.exists != 'true'/u);
    assert.doesNotMatch(block, /continue-on-error/u);
  }
  assert.match(sign.text, /cosign sign --yes --new-bundle-format=true "\$\{IMAGE_REF\}"/u);
  assert.match(
    attest.text,
    /actions\/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8/u,
  );
  assert.match(attest.text, /push-to-registry: true/u);
  verifier(storageSteps[13].text, "verify");
  assert.match(
    storageSteps[14].text,
    /test "\$\(printf '%s' "\$\{manifest\}" \| jq -er '\.digest'\)" = "\$\{DIGEST\}"/u,
  );
  assert.match(storageSteps[14].text, /storage-verified\.json/u);
}

test("trusted storage build preserves exact source, scan, signature and evidence gates", () =>
  verifyStorageWorkflow(workflow));
for (const [name, before, after] of [
  [
    "upstream bypass",
    "      - name: Verify the unchanged signed upstream storage base\n",
    "      - name: Verify the unchanged signed upstream storage base\n        if: false\n",
  ],
  [
    "wrong publication branch",
    "    name: build, scan, publish (object-store)\n    if: github.ref_name == github.event.repository.default_branch",
    "    name: build, scan, publish (object-store)\n    if: false",
  ],
  ["PR publication", `test "\${EVENT_NAME}" = push`, `test "\${EVENT_NAME}" != missing`],
  ["wrong scan platform", "TRIVY_PLATFORM: linux/arm64", "TRIVY_PLATFORM: linux/amd64"],
  ["ignore unfixed", "ignore-unfixed: false", "ignore-unfixed: true"],
  ["ignore severity", "severity: HIGH,CRITICAL", "severity: CRITICAL"],
  ["ignore exit", 'exit-code: "1"', 'exit-code: "0"'],
  [
    "mutable candidate scan",
    `image-ref: \${{ steps.candidate.outputs.ref }}`,
    "image-ref: ghcr.io/liangzixuan/cronometer-gold-object-store:latest",
  ],
  ["signature omitted", `cosign sign --yes --new-bundle-format=true "\${IMAGE_REF}"`, "true"],
  ["binary evidence unbound", ".binarySha256", ".unverifiedHash"],
  ["missing inventory packages", "list-all-pkgs: true", "list-all-pkgs: false"],
  [
    "unpatched inventory accepted",
    '.Version == "v1.85.0-dev.0.20260825072537-93e31b48545e"',
    '.Version == "v1.85.0-dev"',
  ],
  ["encoded evidence omitted", "base64 --wrap=76", "true"],
])
  test(`rejects patched storage workflow mutation: ${name}`, () => {
    const storage = job(workflow, "storage-image");
    assert.ok(storage.includes(before));
    assert.throws(() => verifyStorageWorkflow(storage.replace(before, after)));
  });
