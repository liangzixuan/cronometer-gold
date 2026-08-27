import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateExternalImageLock } from "./verify-external-image-lock.mjs";
import { assertStepOrder, workflowJob, workflowStep } from "./workflow-contract-helpers.mjs";

const reviewedLock = JSON.parse(
  readFileSync(new URL("../infra/oci/external-images.lock.json", import.meta.url), "utf8"),
);
const workflow = readFileSync(
  new URL("../.github/workflows/container-supply-chain.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const meiliDockerfile = readFileSync(
  new URL("../infra/docker/meilisearch.Dockerfile", import.meta.url),
  "utf8",
);

const REPOSITORY_POSTGRES_CI_REF =
  "ghcr.io/liangzixuan/cronometer-gold-postgres@sha256:8619f613a586a1bbeee096cc229cbdcf18e9bf12f8d1b1e5c2f517b5be210e74";
const REPOSITORY_MEILI_CI_REF =
  "ghcr.io/liangzixuan/cronometer-gold-meilisearch@sha256:d05ad0c8303b284c587b9b2167adad4fdd9705d7b011ea983ddba5f22cc548fa";
const UPSTREAM_POSTGRES_CI_REF =
  "postgres:17.11-alpine3.24@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";

function cloneLock() {
  return structuredClone(reviewedLock);
}

function workflowMappingBlock(source, key, indentation) {
  const lines = source.split("\n");
  const header = `${" ".repeat(indentation)}${key}:`;
  const starts = lines.flatMap((line, index) => (line === header ? [index] : []));
  assert.equal(starts.length, 1, `${key} mapping must be defined exactly once`);

  const start = starts[0];
  const relativeEnd = lines.slice(start + 1).findIndex((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return false;
    return (line.match(/^ */u)?.[0].length ?? 0) <= indentation;
  });
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

function assertExactScalar(block, indentation, key, expected, label) {
  const prefix = `${" ".repeat(indentation)}${key}:`;
  const matches = block.split("\n").filter((line) => line.startsWith(prefix));
  assert.deepEqual(matches, [`${prefix} ${expected}`], `${label} must define one exact ${key}`);
}

function assertDatabaseServiceBoundary(job) {
  assertExactScalar(job, 4, "runs-on", "ubuntu-24.04-arm", "database job");
  const services = workflowMappingBlock(job, "services", 4);
  const serviceNames = [];
  for (const line of services.split("\n")) {
    const currentIndentation = line.match(/^ */u)?.[0].length ?? 0;
    if (line.trim() === "" || currentIndentation !== 6) continue;
    const match = /^ {6}([a-zA-Z0-9_-]+):$/u.exec(line);
    assert.ok(match, "database services must use canonical bare mapping keys");
    serviceNames.push(match[1]);
  }
  assert.deepEqual(
    serviceNames,
    ["postgres", "meilisearch"],
    "database services must remain exact",
  );

  const postgres = workflowMappingBlock(services, "postgres", 6);
  const meilisearch = workflowMappingBlock(services, "meilisearch", 6);
  assertExactScalar(postgres, 8, "image", REPOSITORY_POSTGRES_CI_REF, "PostgreSQL service");
  assertExactScalar(meilisearch, 8, "image", REPOSITORY_MEILI_CI_REF, "Meilisearch service");
  assert.equal(
    meilisearch,
    [
      "      meilisearch:",
      `        image: ${REPOSITORY_MEILI_CI_REF}`,
      "        env:",
      "          MEILI_ENV: development",
      "          MEILI_MASTER_KEY: search-integration-key-20260815",
      "          MEILI_NO_ANALYTICS: true",
      "        ports:",
      "          - 7700:7700",
      "        options: >-",
      "          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700",
      '          --health-cmd "curl --fail --silent http://127.0.0.1:7700/health"',
      "          --health-interval 5s",
      "          --health-timeout 5s",
      "          --health-retries 20",
    ].join("\n"),
    "Meilisearch service must remain one exact canonical mapping",
  );
}

test("accepts the exact signed, non-deployable Meilisearch build-input lock", () => {
  const image = validateExternalImageLock(cloneLock());
  assert.equal(image.ref, reviewedLock.images.MEILI_IMAGE.ref);
  assert.equal(image.directDeploymentApproved, false);
  assert.equal(reviewedLock.purpose, "derivative-bootstrap-input-only");
  assert.equal(
    image.remediation.derivativeRepository,
    "ghcr.io/liangzixuan/cronometer-gold-meilisearch",
  );
});

test("rejects deployment approval, widened usage, and weakened remediation", () => {
  const approved = cloneLock();
  approved.images.MEILI_IMAGE.directDeploymentApproved = true;
  assert.throws(() => validateExternalImageLock(approved), /non-deployable ARM64 build input/);

  const widened = cloneLock();
  widened.images.MEILI_IMAGE.usage = "runtime";
  assert.throws(() => validateExternalImageLock(widened), /non-deployable ARM64 build input/);

  const wrongPurpose = cloneLock();
  wrongPurpose.purpose = "runtime-approval";
  assert.throws(() => validateExternalImageLock(wrongPurpose), /ARM64 upstream build inputs/);

  const wrongDerivative = cloneLock();
  wrongDerivative.images.MEILI_IMAGE.remediation.derivativeRepository =
    "ghcr.io/attacker/meilisearch";
  assert.throws(() => validateExternalImageLock(wrongDerivative), /reviewed GHCR package/);

  const wrongFix = cloneLock();
  wrongFix.images.MEILI_IMAGE.remediation.requiredPackages[1] = "libssl3=3.5.7-r0";
  assert.throws(() => validateExternalImageLock(wrongFix), /exactly pinned/);

  const missingFinding = cloneLock();
  missingFinding.images.MEILI_IMAGE.remediation.findings.pop();
  assert.throws(() => validateExternalImageLock(missingFinding), /two reviewed findings/);

  const wrongIndex = cloneLock();
  wrongIndex.images.MEILI_IMAGE.digest = `sha256:${"0".repeat(64)}`;
  wrongIndex.images.MEILI_IMAGE.ref = `${wrongIndex.images.MEILI_IMAGE.repository}@${wrongIndex.images.MEILI_IMAGE.digest}`;
  assert.throws(() => validateExternalImageLock(wrongIndex), /non-deployable ARM64 build input/);

  const wrongChild = cloneLock();
  wrongChild.images.MEILI_IMAGE.arm64Digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateExternalImageLock(wrongChild), /non-deployable ARM64 build input/);
});

test("rejects an unsigned image, another source, issuer, identity, or runtime label", () => {
  const unsigned = cloneLock();
  unsigned.images.MEILI_IMAGE.provenance.containerSignature = "unavailable";
  assert.throws(() => validateExternalImageLock(unsigned), /verified Sigstore keyless/);

  const wrongSource = cloneLock();
  wrongSource.images.MEILI_IMAGE.provenance.sourceRepository = "https://example.invalid/repo";
  assert.throws(() => validateExternalImageLock(wrongSource), /source identity/);

  const wrongSourceRevision = cloneLock();
  wrongSourceRevision.images.MEILI_IMAGE.provenance.sourceRevision = "0".repeat(40);
  wrongSourceRevision.images.MEILI_IMAGE.provenance.expectedRuntime.labels[
    "org.opencontainers.image.revision"
  ] = "0".repeat(40);
  assert.throws(() => validateExternalImageLock(wrongSourceRevision), /source identity/);

  const wrongIssuer = cloneLock();
  wrongIssuer.images.MEILI_IMAGE.provenance.certificateOidcIssuer = "https://example.invalid";
  assert.throws(
    () => validateExternalImageLock(wrongIssuer),
    /certificate identity or OIDC issuer/,
  );

  const wrongIdentity = cloneLock();
  wrongIdentity.images.MEILI_IMAGE.provenance.certificateIdentity =
    "https://github.com/meilisearch/meilisearch/.github/workflows/other.yml@refs/tags/v1.53.1";
  assert.throws(
    () => validateExternalImageLock(wrongIdentity),
    /certificate identity or OIDC issuer/,
  );

  const wrongRevision = cloneLock();
  wrongRevision.images.MEILI_IMAGE.provenance.expectedRuntime.labels[
    "org.opencontainers.image.revision"
  ] = "0".repeat(40);
  assert.throws(() => validateExternalImageLock(wrongRevision), /expected labels/);
});

test("hardcodes the exact locked upstream input in the derivative Dockerfile", () => {
  const image = validateExternalImageLock(cloneLock());
  assert.match(
    meiliDockerfile,
    new RegExp(`^FROM ${image.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} AS runtime$`, "m"),
  );
  assert.doesNotMatch(meiliDockerfile, /^ARG .*MEILI/m);
  assert.doesNotMatch(meiliDockerfile, /^FROM \$\{/m);
  for (const requiredPackage of image.remediation.requiredPackages) {
    assert.match(meiliDockerfile, new RegExp(requiredPackage.replace("=", "=")));
  }
});

test("binds database CI exclusively to immutable repository derivatives on native ARM64", () => {
  const upstreamMeili = validateExternalImageLock(cloneLock());
  const database = workflowJob(ciWorkflow, "database");

  assert.match(database, /^ {4}runs-on: ubuntu-24\.04-arm$/m);
  assertDatabaseServiceBoundary(database);
  for (const repositoryRef of [REPOSITORY_POSTGRES_CI_REF, REPOSITORY_MEILI_CI_REF]) {
    const exactServiceLine = `        image: ${repositoryRef}`;
    assert.equal(
      database.split("\n").filter((line) => line === exactServiceLine).length,
      1,
      "the database job must use each reviewed repository index exactly once",
    );
    assert.equal(
      ciWorkflow.split("\n").filter((line) => line === exactServiceLine).length,
      1,
      "each reviewed repository index must remain confined to the database job",
    );
  }
  assert.ok(!ciWorkflow.includes(upstreamMeili.ref));
  assert.ok(!ciWorkflow.includes(UPSTREAM_POSTGRES_CI_REF));
  assert.doesNotMatch(
    ciWorkflow,
    /image: ghcr\.io\/liangzixuan\/cronometer-gold-(?:postgres|meilisearch):/,
  );
  assert.doesNotMatch(ciWorkflow, /image: docker\.io\/getmeili\/meilisearch/);
});

test("rejects database runner and service-boundary overrides", () => {
  const database = workflowJob(ciWorkflow, "database");
  const attacker = `ghcr.io/attacker/service@sha256:${"0".repeat(64)}`;
  const mutations = [
    database.replace(
      "    runs-on: ubuntu-24.04-arm",
      "    runs-on: ubuntu-24.04-arm\n    runs-on: ubuntu-latest",
    ),
    database.replace(
      `        image: ${REPOSITORY_POSTGRES_CI_REF}`,
      `        image: ${REPOSITORY_POSTGRES_CI_REF}\n        image: ${attacker}`,
    ),
    database.replace(REPOSITORY_POSTGRES_CI_REF, attacker),
    database.replace(REPOSITORY_MEILI_CI_REF, attacker),
    database.replace(
      "      meilisearch:",
      `      attacker:\n        image: ${attacker}\n      meilisearch:`,
    ),
    database.replace(
      "      meilisearch:",
      `      "attacker":\n        image: ${attacker}\n      meilisearch:`,
    ),
    database.replace("    services:", "    services:\n    services:"),
    database.replace(
      "          MEILI_NO_ANALYTICS: true",
      "          MEILI_NO_ANALYTICS: true\n          MEILI_DB_PATH: /tmp",
    ),
    database.replace(
      "          MEILI_NO_ANALYTICS: true",
      "          MEILI_NO_ANALYTICS: true\n        # Keep the default database path.\n          MEILI_DB_PATH: /tmp",
    ),
    database.replace("          - 7700:7700", "          - 7700:80"),
    database.replace(
      "        ports:\n          - 7700:7700",
      "        volumes:\n          - /tmp/meili_data:/meili_data\n        ports:\n          - 7700:7700",
    ),
    database.replace(
      "        ports:\n          - 7700:7700",
      '        "volumes":\n          - /tmp/meili_data:/meili_data\n        ports:\n          - 7700:7700',
    ),
    database.replace(
      '          --health-cmd "curl --fail --silent http://127.0.0.1:7700/health"\n          --health-interval 5s\n          --health-timeout 5s\n          --health-retries 20',
      '          --health-cmd "curl --fail --silent http://127.0.0.1:7700/health"\n          --health-interval 5s\n          --health-timeout 5s\n          --health-retries 20\n     # Hide a sibling key behind a shallow comment.\n        "volumes":\n          - /tmp/meili_data:/meili_data',
    ),
    database.replace(
      "        ports:\n          - 7700:7700\n        options: >-",
      "        ports:\n          - 7700:7700\n        entrypoint: /bin/sh\n        options: >-",
    ),
    database.replace(
      "        ports:\n          - 7700:7700\n        options: >-",
      "        ports:\n          - 7700:7700\n        command: /bin/sh\n        options: >-",
    ),
    database.replace("          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700\n", ""),
    database.replace("uid=1000,gid=1000", "uid=0,gid=1000"),
    database.replace("uid=1000,gid=1000", "uid=1000,gid=0"),
    database.replace("mode=0700", "mode=0777"),
    database.replace(
      "--tmpfs /meili_data:uid=1000,gid=1000,mode=0700",
      "--volume /tmp/meili_data:/meili_data",
    ),
    database.replace(
      "          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700",
      "          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700\n          --user 0:0",
    ),
    database.replace(
      "          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700",
      "          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700\n          --privileged",
    ),
    database.replace(
      "          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700",
      "          --tmpfs /meili_data:uid=1000,gid=1000,mode=0700\n          -v /tmp/meili_data:/meili_data",
    ),
  ];

  for (const mutated of mutations) {
    assert.throws(() => assertDatabaseServiceBoundary(mutated));
  }
});

test("gates the Meilisearch publisher before credentials, lookup, and build", () => {
  const services = workflowJob(workflow, "build-scan-publish-services");
  const apps = workflowJob(workflow, "build-scan-publish-apps");
  const install = workflowStep(
    services,
    "Install pinned Cosign for the Meilisearch upstream input",
  );
  const verify = workflowStep(
    services,
    "Verify the locked Meilisearch build input before building",
  );

  assert.match(install, /^ {8}if: matrix\.component == 'meilisearch'$/m);
  assert.match(
    install,
    /^ {8}uses: sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4\.1\.2$/m,
  );
  assert.match(install, /^ {10}cosign-release: v3\.1\.3$/m);
  assert.match(verify, /^ {8}if: matrix\.component == 'meilisearch'$/m);
  assert.match(verify, /node scripts\/verify-external-image-lock\.mjs "\$\{LOCK_FILE\}"/);
  assert.match(verify, /grep -Fx "FROM \$\{image_ref\} AS runtime"/);
  assert.match(verify, /--arg expected_arm64 "\$\{arm64_digest\}"/);
  assert.match(verify, /\$arm64_descriptors\[0\]\.digest == \$expected_arm64/);
  assert.doesNotMatch(verify, /\bas \$arm64\b/);
  assert.match(verify, /--new-bundle-format=true/);
  assert.match(verify, /--certificate-identity "\$\{certificate_identity\}"/);
  assert.match(verify, /--certificate-oidc-issuer "\$\{certificate_oidc_issuer\}"/);
  assert.match(verify, /critical\.image\["docker-manifest-digest"\] == \$expected_digest/);
  assert.doesNotMatch(
    verify,
    /--(?:insecure-ignore-sct|insecure-ignore-tlog|allow-insecure-registry|new-bundle-format=false)/,
  );
  assertStepOrder(services, [
    "Set up pinned Buildx and BuildKit",
    "Install pinned Cosign for the Meilisearch upstream input",
    "Verify the locked Meilisearch build input before building",
    "Log in to GHCR with the job token",
    "Resolve an existing immutable commit tag",
    "Build and push by digest with SBOM and provenance",
  ]);
  assert.doesNotMatch(apps, /locked Meilisearch build input/);
  assert.match(services, /^ {4}needs: validate-external-images$/m);
});

test("keeps the read-only upstream evidence job fail closed", () => {
  const job = workflowJob(workflow, "validate-external-images");
  const validate = workflowStep(job, "Validate and resolve the reviewed image lock");
  const runtime = workflowStep(job, "Verify the locked index and ARM64 runtime identity");
  const provenance = workflowStep(job, "Verify upstream provenance evidence");
  const enforce = workflowStep(job, "Enforce locked upstream identity and provenance");

  assert.match(job, /^ {4}permissions:\n {6}contents: read /m);
  assert.match(validate, /^ {8}id: lock$/m);
  assert.match(validate, /\.directDeploymentApproved/);
  assert.match(runtime, /\$arm64\[0\]\.digest == \$expected\.arm64Digest/);
  assert.match(provenance, /--new-bundle-format=true/);
  assert.match(enforce, /^ {8}if: always\(\)$/m);
  assert.match(
    enforce,
    /^ {10}DIRECT_DEPLOYMENT_APPROVED: \$\{\{ steps\.lock\.outputs\.direct_deployment_approved \}\}$/m,
  );
  assert.match(enforce, /if \[ "\$\{DIRECT_DEPLOYMENT_APPROVED\}" != 'false' \]; then/);
  assert.doesNotMatch(enforce, /SCAN_OUTCOME|steps\.scan/);
  assertStepOrder(job, [
    "Validate and resolve the reviewed image lock",
    "Verify the locked index and ARM64 runtime identity",
    "Install pinned Cosign for signed upstream images",
    "Verify upstream provenance evidence",
    "Enforce locked upstream identity and provenance",
  ]);
});
