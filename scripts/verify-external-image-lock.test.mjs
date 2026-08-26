import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateExternalImageLock } from "./verify-external-image-lock.mjs";
import {
  assertStepOrder,
  assertUnconditionalStep,
  workflowJob,
  workflowStep,
} from "./workflow-contract-helpers.mjs";

const reviewedLock = JSON.parse(
  readFileSync(new URL("../infra/oci/external-images.lock.json", import.meta.url), "utf8"),
);
const workflow = readFileSync(
  new URL("../.github/workflows/container-supply-chain.yml", import.meta.url),
  "utf8",
);

function cloneLock() {
  return structuredClone(reviewedLock);
}

const enforcementMappings = [
  ["LOCK_OUTCOME", "steps.lock.outcome"],
  ["RUNTIME_OUTCOME", "steps.runtime.outcome"],
  ["SCAN_OUTCOME", "steps.scan.outcome"],
  ["PROVENANCE_OUTCOME", "steps.provenance.outcome"],
  ["APPROVED", "steps.lock.outputs.approved"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertExactEnforcementMappings(step) {
  for (const [environmentName, producer] of enforcementMappings) {
    const expectedLine = `          ${environmentName}: \${{ ${producer} }}`;
    assert.match(
      step,
      new RegExp(`^${escapeRegExp(expectedLine)}$`, "m"),
      `${environmentName} must be sourced only from ${producer}`,
    );
  }
}

test("accepts the exact reviewed signed Meilisearch lock", () => {
  assert.equal(validateExternalImageLock(cloneLock()).ref, reviewedLock.images.MEILI_IMAGE.ref);
});

test("binds lock validation to explicit bundle verification and final enforcement", () => {
  const job = workflowJob(workflow, "validate-external-images");
  const validate = workflowStep(job, "Validate and resolve the reviewed image lock");
  const installCosign = workflowStep(job, "Install pinned Cosign for signed upstream images");
  const verify = workflowStep(job, "Verify upstream provenance evidence");
  const enforce = workflowStep(job, "Enforce current scan, provenance, and reviewed approval");

  assertStepOrder(job, [
    "Validate and resolve the reviewed image lock",
    "Install pinned Cosign for signed upstream images",
    "Verify upstream provenance evidence",
    "Enforce current scan, provenance, and reviewed approval",
  ]);

  assertUnconditionalStep(validate, "external lock validation");
  assert.match(validate, /^ {8}id: lock$/m);
  assert.match(validate, /^ {10}node scripts\/verify-external-image-lock\.mjs "\$\{LOCK_FILE\}"$/m);

  assertUnconditionalStep(installCosign, "Cosign installation");
  assert.match(
    installCosign,
    /^ {8}uses: sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4\.1\.2$/m,
  );
  assert.match(installCosign, /^ {10}cosign-release: v3\.1\.3$/m);

  assertUnconditionalStep(verify, "upstream bundle verification");
  assert.match(verify, /^ {8}id: provenance$/m);
  assert.match(
    verify,
    /^ {10}CERTIFICATE_IDENTITY: \$\{\{ steps\.lock\.outputs\.certificate_identity \}\}$/m,
  );
  assert.match(
    verify,
    /^ {10}CERTIFICATE_OIDC_ISSUER: \$\{\{ steps\.lock\.outputs\.certificate_oidc_issuer \}\}$/m,
  );
  assert.match(verify, /^ {10}DIGEST: \$\{\{ steps\.lock\.outputs\.digest \}\}$/m);
  assert.match(verify, /^ {10}IMAGE_REF: \$\{\{ steps\.lock\.outputs\.ref \}\}$/m);
  assert.equal(verify.match(/^ {10}cosign verify \\$/gm)?.length, 1);
  assert.match(verify, /^ {12}--new-bundle-format=true \\$/m);
  assert.match(verify, /^ {12}--certificate-identity "\$\{CERTIFICATE_IDENTITY\}" \\$/m);
  assert.match(verify, /^ {12}--certificate-oidc-issuer "\$\{CERTIFICATE_OIDC_ISSUER\}" \\$/m);
  assert.match(verify, /^ {10}jq -e --arg digest "\$\{DIGEST\}" '$/m);
  assert.match(
    verify,
    /^ {14}\.critical\.type == "https:\/\/sigstore\.dev\/cosign\/sign\/v1" and$/m,
  );
  assert.match(verify, /^ {14}\.critical\.image\["docker-manifest-digest"\] == \$digest\)$/m);
  assert.match(verify, /^ {10}' "\$\{verification_file\}" >\/dev\/null$/m);
  assert.doesNotMatch(
    verify,
    /--(?:insecure-ignore-sct|insecure-ignore-tlog|allow-insecure-registry|new-bundle-format=false)/,
  );

  assert.match(enforce, /^ {8}if: always\(\)$/m);
  assert.doesNotMatch(enforce, /^ {8}continue-on-error:/m);
  assertExactEnforcementMappings(enforce);
  for (const outcome of ["LOCK_OUTCOME", "PROVENANCE_OUTCOME", "RUNTIME_OUTCOME", "SCAN_OUTCOME"]) {
    assert.match(
      enforce,
      new RegExp(`^ {10}if \\[ "\\$\\{${outcome}\\}" != 'success' \\]; then$`, "m"),
    );
  }
  assert.match(enforce, /^ {10}if \[ "\$\{APPROVED\}" != 'true' \]; then$/m);
  assert.match(enforce, /^ {10}if \[ "\$\{failed\}" = 'true' \]; then$/m);
  assert.match(enforce, /^ {12}exit 1$/m);
  assert.doesNotMatch(workflow, /reviewed-unsigned-container/);
});

test("rejects every final enforcement producer miswire", () => {
  const job = workflowJob(workflow, "validate-external-images");
  const enforce = workflowStep(job, "Enforce current scan, provenance, and reviewed approval");
  const wrongProducers = [
    "steps.scan.outcome",
    "steps.lock.outcome",
    "steps.provenance.outcome",
    "steps.runtime.outcome",
    "steps.lock.outputs.ref",
  ];

  for (const [[environmentName, producer], wrongProducer] of enforcementMappings.map(
    (mapping, index) => [mapping, wrongProducers[index]],
  )) {
    const expectedLine = `          ${environmentName}: \${{ ${producer} }}`;
    const wrongLine = `          ${environmentName}: \${{ ${wrongProducer} }}`;
    assert.notEqual(producer, wrongProducer);
    assert.equal(enforce.split(expectedLine).length - 1, 1);

    const miswired = enforce.replace(expectedLine, wrongLine);
    assert.throws(
      () => assertExactEnforcementMappings(miswired),
      new RegExp(`${environmentName} must be sourced only from ${escapeRegExp(producer)}`),
    );
  }
});

test("rejects the legacy reviewed unsigned-container bypass", () => {
  const lock = cloneLock();
  lock.images.MEILI_IMAGE.provenance.method = "reviewed-unsigned-container";
  lock.images.MEILI_IMAGE.provenance.containerSignature = "unavailable";
  lock.images.MEILI_IMAGE.provenance.certificateIdentity = null;
  lock.images.MEILI_IMAGE.provenance.certificateOidcIssuer = null;

  assert.throws(
    () => validateExternalImageLock(lock),
    /verified Sigstore keyless container signature/,
  );
});

test("rejects an unverified signature and another OIDC issuer", () => {
  const unverified = cloneLock();
  unverified.images.MEILI_IMAGE.provenance.containerSignature = "unavailable";
  assert.throws(() => validateExternalImageLock(unverified), /verified Sigstore keyless/);

  const wrongIssuer = cloneLock();
  wrongIssuer.images.MEILI_IMAGE.provenance.certificateOidcIssuer = "https://example.invalid";
  assert.throws(
    () => validateExternalImageLock(wrongIssuer),
    /certificate identity or OIDC issuer/,
  );
});

test("binds the certificate identity and runtime labels to the reviewed source tag", () => {
  const wrongIdentity = cloneLock();
  wrongIdentity.images.MEILI_IMAGE.provenance.certificateIdentity =
    "https://github.com/another/project/.github/workflows/release.yml@refs/tags/v1.53.1";
  assert.throws(
    () => validateExternalImageLock(wrongIdentity),
    /certificate identity or OIDC issuer/,
  );

  const wrongWorkflow = cloneLock();
  wrongWorkflow.images.MEILI_IMAGE.provenance.certificateIdentity =
    "https://github.com/meilisearch/meilisearch/.github/workflows/another.yml@refs/tags/v1.53.1";
  assert.throws(
    () => validateExternalImageLock(wrongWorkflow),
    /certificate identity or OIDC issuer/,
  );

  const unsafeIdentity = cloneLock();
  unsafeIdentity.images.MEILI_IMAGE.provenance.certificateIdentity =
    "https://github.com/meilisearch/meilisearch/.github/workflows/publish\n-docker-images.yml@refs/tags/v1.53.1";
  assert.throws(() => validateExternalImageLock(unsafeIdentity), /certificateIdentity/);

  const wrongRevision = cloneLock();
  wrongRevision.images.MEILI_IMAGE.provenance.expectedRuntime.labels[
    "org.opencontainers.image.revision"
  ] = "0".repeat(40);
  assert.throws(() => validateExternalImageLock(wrongRevision), /expected labels/);
});
