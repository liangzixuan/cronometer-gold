import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifyOciBuildkitAttestations } from "./verify-oci-buildkit-attestations.mjs";
import {
  assertStepOrder,
  assertUnconditionalStep,
  workflowJob,
  workflowStep,
} from "./workflow-contract-helpers.mjs";

const runtimeDigest = `sha256:${"1".repeat(64)}`;
const attestationDigest = `sha256:${"2".repeat(64)}`;
const spdxDigest = `sha256:${"3".repeat(64)}`;
const provenanceDigest = `sha256:${"4".repeat(64)}`;
const workflow = readFileSync(
  new URL("../.github/workflows/container-supply-chain.yml", import.meta.url),
  "utf8",
);

function validIndex() {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: runtimeDigest,
        size: 1200,
        platform: { architecture: "arm64", os: "linux" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: attestationDigest,
        size: 800,
        platform: { architecture: "unknown", os: "unknown" },
        annotations: {
          "vnd.docker.reference.digest": runtimeDigest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
      },
    ],
  };
}

function validAttestationManifest() {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.docker.attestation.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      size: 2,
      data: "e30=",
    },
    layers: [
      {
        mediaType: "application/vnd.in-toto+json",
        digest: spdxDigest,
        size: 1024,
        annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
      },
      {
        mediaType: "application/vnd.in-toto+json",
        digest: provenanceDigest,
        size: 512,
        annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" },
      },
    ],
    subject: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: runtimeDigest,
      size: 1200,
    },
  };
}

function validPayloads() {
  return {
    sbom: {
      SPDX: {
        SPDXID: "SPDXRef-DOCUMENT",
        creationInfo: { creators: ["Tool: syft-v1.42.3"] },
        dataLicense: "CC0-1.0",
        documentNamespace: "https://anchore.example/sbom",
        packages: [{ SPDXID: "SPDXRef-Package", name: "fixture" }],
        relationships: [],
        spdxVersion: "SPDX-2.3",
      },
    },
    provenance: {
      SLSA: {
        buildDefinition: {
          buildType:
            "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
          externalParameters: {},
          internalParameters: {},
          resolvedDependencies: [{ uri: "pkg:docker/example/base" }],
        },
        runDetails: {
          builder: { id: "https://github.com/example/project/actions/runs/1/attempts/1" },
          metadata: {
            finishedOn: "2026-08-26T01:01:00Z",
            invocationId: "fixture-build",
            startedOn: "2026-08-26T01:00:00Z",
          },
        },
      },
    },
  };
}

function verify(
  index = validIndex(),
  manifest = validAttestationManifest(),
  payloads = validPayloads(),
) {
  return verifyOciBuildkitAttestations(
    index,
    (requestedDigest) => {
      assert.equal(requestedDigest, attestationDigest);
      return manifest;
    },
    (requestedRuntimeDigest) => {
      assert.equal(requestedRuntimeDigest, runtimeDigest);
      return payloads;
    },
  );
}

test("accepts one exact ARM64 runtime with SPDX and SLSA BuildKit predicates", () => {
  assert.deepEqual(verify(), {
    attestationDigest,
    predicateDigests: {
      "https://spdx.dev/Document": spdxDigest,
      "https://slsa.dev/provenance/v1": provenanceDigest,
    },
    runtimeDigest,
  });
});

test("binds new and reused candidates to the same verifier in every image job", () => {
  const families = [
    {
      job: "build-node-runtime",
      build: "Build and push patched Node runtime by digest",
      select: "Select the patched runtime candidate digest",
      verify: "Verify patched runtime identity, binary, and symbols",
      afterTag: "Export the verified patched Node runtime",
    },
    {
      job: "build-scan-publish-apps",
      build: "Build and push by digest with SBOM and provenance",
      select: "Select the candidate digest",
      verify: "Verify ARM64 runtime identity",
      afterTag: "Summarize the deployable digest",
    },
    {
      job: "build-scan-publish-services",
      build: "Build and push by digest with SBOM and provenance",
      select: "Select the candidate digest",
      verify: "Verify ARM64 service identity",
      afterTag: "Summarize the deployable digest",
    },
  ];

  for (const family of families) {
    const job = workflowJob(workflow, family.job);
    const existing = workflowStep(job, "Resolve an existing immutable commit tag");
    const build = workflowStep(job, family.build);
    const select = workflowStep(job, family.select);
    const verifyIdentity = workflowStep(job, family.verify);
    const recordGitHubProvenance = workflowStep(job, "Record GitHub build provenance");
    const verifyGitHubProvenance = workflowStep(job, "Verify GitHub build provenance");
    const createTag = workflowStep(job, "Create the immutable commit tag");
    const verifyTag = workflowStep(job, "Verify the immutable commit tag");

    assertStepOrder(job, [
      "Resolve an existing immutable commit tag",
      family.build,
      family.select,
      family.verify,
      "Record GitHub build provenance",
      "Verify GitHub build provenance",
      "Create the immutable commit tag",
      "Verify the immutable commit tag",
      family.afterTag,
    ]);

    assertUnconditionalStep(existing, `${family.job} existing-image resolution`);
    assert.match(existing, /^ {8}id: existing$/m);
    assert.match(build, /^ {8}id: build$/m);
    assert.match(build, /^ {8}if: steps\.existing\.outputs\.exists != 'true'$/m);
    assert.match(build, /^ {10}provenance: mode=max,version=v1$/m);
    assert.match(build, /^ {10}sbom: generator=docker\.io\//m);

    assertUnconditionalStep(select, `${family.job} candidate selection`);
    assert.match(select, /^ {8}id: candidate$/m);
    assert.match(select, /BUILT_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
    assert.match(select, /EXISTING_DIGEST: \$\{\{ steps\.existing\.outputs\.digest \}\}/);
    assert.match(select, /EXISTING_TAG: \$\{\{ steps\.existing\.outputs\.exists \}\}/);
    assert.match(select, /digest="\$\{EXISTING_DIGEST\}"/);
    assert.match(select, /digest="\$\{BUILT_DIGEST\}"/);

    assertUnconditionalStep(verifyIdentity, `${family.job} OCI attestation verification`);
    assert.match(verifyIdentity, /^ {10}IMAGE_REF: \$\{\{ steps\.candidate\.outputs\.ref \}\}$/m);
    assert.equal(
      verifyIdentity.match(
        /^ {10}runtime_digest="\$\(node scripts\/verify-oci-buildkit-attestations\.mjs \\$/gm,
      )?.length,
      1,
    );

    assert.match(recordGitHubProvenance, /^ {8}if: steps\.existing\.outputs\.exists != 'true'$/m);
    assert.match(recordGitHubProvenance, /uses: actions\/attest-build-provenance@/);
    assertUnconditionalStep(verifyGitHubProvenance, `${family.job} GitHub provenance verification`);
    assert.match(
      verifyGitHubProvenance,
      /^ {12}if gh attestation verify "oci:\/\/\$\{IMAGE\}@\$\{DIGEST\}" \\$/m,
    );

    assert.match(createTag, /^ {8}if: steps\.existing\.outputs\.exists != 'true'$/m);
    assert.match(createTag, /^ {10}DIGEST: \$\{\{ steps\.candidate\.outputs\.digest \}\}$/m);
    assert.match(createTag, /^ {10}docker buildx imagetools create /m);
    assertUnconditionalStep(verifyTag, `${family.job} immutable tag verification`);
    assert.match(verifyTag, /^ {10}DIGEST: \$\{\{ steps\.candidate\.outputs\.digest \}\}$/m);
    assert.match(verifyTag, /^ {10}published_manifest="\$\(docker buildx imagetools inspect /m);
  }
});

test("rejects a missing or duplicate attestation descriptor", () => {
  const missing = validIndex();
  missing.manifests.pop();
  assert.throws(() => verify(missing), /exactly one ARM64 runtime and one attestation/);

  const duplicate = validIndex();
  duplicate.manifests.push({
    ...structuredClone(duplicate.manifests[1]),
    digest: `sha256:${"5".repeat(64)}`,
  });
  assert.throws(() => verify(duplicate), /exactly one ARM64 runtime and one attestation/);
});

test("rejects an attestation descriptor that references another runtime", () => {
  const index = validIndex();
  index.manifests[1].annotations["vnd.docker.reference.digest"] = `sha256:${"9".repeat(64)}`;
  assert.throws(() => verify(index), /refer to the exact ARM64 runtime digest/);
});

test("rejects a wrong attestation artifact type or runtime subject", () => {
  const wrongArtifact = validAttestationManifest();
  wrongArtifact.artifactType = "application/vnd.example.attestation+json";
  assert.throws(() => verify(validIndex(), wrongArtifact), /exact OCI attestation artifact/);

  const wrongSubject = validAttestationManifest();
  wrongSubject.subject.digest = `sha256:${"9".repeat(64)}`;
  assert.throws(() => verify(validIndex(), wrongSubject), /exact ARM64 runtime descriptor/);
});

test("rejects wrong descriptor and predicate-layer media types", () => {
  const wrongDescriptor = validIndex();
  wrongDescriptor.manifests[1].mediaType = "application/vnd.docker.distribution.manifest.v2+json";
  assert.throws(() => verify(wrongDescriptor), /OCI image-manifest media type/);

  const wrongLayer = validAttestationManifest();
  wrongLayer.layers[0].mediaType = "application/json";
  assert.throws(() => verify(validIndex(), wrongLayer), /in-toto media type/);
});

test("rejects missing, duplicate, and unreviewed predicate types", () => {
  const missing = validAttestationManifest();
  missing.layers.pop();
  assert.throws(() => verify(validIndex(), missing), /exactly two predicate layers/);

  const duplicate = validAttestationManifest();
  duplicate.layers[1].annotations["in-toto.io/predicate-type"] = "https://spdx.dev/Document";
  assert.throws(() => verify(validIndex(), duplicate), /requires exactly one .* predicate layer/);

  const unreviewed = validAttestationManifest();
  unreviewed.layers[1].annotations["in-toto.io/predicate-type"] = "https://example.invalid";
  assert.throws(() => verify(validIndex(), unreviewed), /unreviewed predicate type/);
});

test("rejects a noncanonical attestation config or repeated layer digest", () => {
  const wrongConfig = validAttestationManifest();
  wrongConfig.config.digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => verify(validIndex(), wrongConfig), /canonical empty OCI config/);

  const repeatedDigest = validAttestationManifest();
  repeatedDigest.layers[1].digest = repeatedDigest.layers[0].digest;
  assert.throws(() => verify(validIndex(), repeatedDigest), /digests must be distinct/);
});

test("rejects empty or non-SPDX SBOM payload semantics", () => {
  const emptyPackages = validPayloads();
  emptyPackages.sbom.SPDX.packages = [];
  assert.throws(
    () => verify(validIndex(), validAttestationManifest(), emptyPackages),
    /nonempty SPDX 2.3 document/,
  );

  const wrongVersion = validPayloads();
  wrongVersion.sbom.SPDX.spdxVersion = "SPDX-2.2";
  assert.throws(
    () => verify(validIndex(), validAttestationManifest(), wrongVersion),
    /nonempty SPDX 2.3 document/,
  );
});

test("rejects empty or v0.2 provenance payload semantics", () => {
  const emptyDependencies = validPayloads();
  emptyDependencies.provenance.SLSA.buildDefinition.resolvedDependencies = [];
  assert.throws(
    () => verify(validIndex(), validAttestationManifest(), emptyDependencies),
    /nonempty SLSA v1 build definition/,
  );

  const legacy = validPayloads();
  legacy.provenance.SLSA = {
    builder: { id: "" },
    buildType: "https://mobyproject.org/buildkit@v1",
  };
  assert.throws(() => verify(validIndex(), validAttestationManifest(), legacy), /buildDefinition/);
});
