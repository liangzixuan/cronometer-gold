import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { OBJECT_STORE_IMAGE } from "./verify-local-object-store-image.mjs";
import {
  extractBinaryMetadata,
  PATCHED_STORE,
  validateOptions,
  verifyBinaryMetadata,
  verifyBuildMaterials,
  verifyPatchedObjectStoreImage,
} from "./verify-patched-object-store-image.mjs";

const baseRaw =
  '{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.manifest.v1+json",\n  "config": {\n    "mediaType": "application/vnd.oci.image.config.v1+json",\n    "digest": "sha256:a4dfe9e6d63c1a1da95c319fe8cee74fe0748eed4bd2ad7cb87a691b79aa5d56",\n    "size": 13692\n  },\n  "layers": [\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:5de55e5ef9c033997441461efe7ba23a986db059c0bb78b38f84ee0d72b99167",\n      "size": 4183037\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:0718aa00a52b43daec18c57181a7f155f68c0216a6186872bd296deffe2f5220",\n      "size": 82202406\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:cef2e1f044931c9dbe17e9ef986438e255e23ad7a8d8f2bb0a474b2edca54fd9",\n      "size": 13877369\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:30d54239d1fc0b5a23d9e95c706f2d148ca35711fc9ca6b5cf2543bcb6ae6f2e",\n      "size": 80493094\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:ea26aab6014a3367baa3cc28cb9ff464dbc2a186a562c2a12ca38e68de1ea897",\n      "size": 117\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:b16011d28552329797d913e8857a0d22750be76022083cd33d7658386362a8a6",\n      "size": 200\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:b31a588122a74258da6886ce0139c305148de93de3327d8c970ff32807222252",\n      "size": 1570\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:045ccc0ff21cae01142fbce1a6aa31c465a332ba168ba93c5da418f62a349c10",\n      "size": 5632987\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:5ec1346356f2d8c7f97f3fa8209048626665de0a66c292f90a49af867e7d40c8",\n      "size": 239\n    },\n    {\n      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",\n      "digest": "sha256:4f4fb700ef54461cfa02571ae0db9a0dc1e0cdb5577484a6d75e68dc38e8acc1",\n      "size": 32\n    }\n  ]\n}';
const lockBytes = readFileSync(
  new URL("../infra/docker/object-store-modules.json", import.meta.url),
);
const lock = JSON.parse(lockBytes);
const sums = readFileSync(new URL("../infra/docker/object-store.go.sum", import.meta.url), "utf8");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const digest = (text) => `sha256:${hash(text)}`;
const revision = "a".repeat(40);
const media = "application/vnd.oci.image.manifest.v1+json";
function metadata() {
  const grpc = lock.reviewedModules.find((item) => item.path === "google.golang.org/grpc");
  return `/inspect/weed: go1.26.6
\tpath\tgithub.com/seaweedfs/seaweedfs/weed
\tmod\tgithub.com/seaweedfs/seaweedfs\t(devel)
\tdep\tgoogle.golang.org/grpc\t${grpc.version}\t${grpc.sum}
\tbuild\t-ldflags="-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=${OBJECT_STORE_IMAGE.sourceRevision}"
\tbuild\tCGO_ENABLED=0
\tbuild\tGOARCH=arm64
\tbuild\tGOOS=linux
`;
}
function fixture() {
  const base = {
    os: "linux",
    architecture: "arm64",
    config: {
      Entrypoint: ["/entrypoint.sh"],
      Cmd: ["mini", "-dir=/data"],
      WorkingDir: "/data",
      Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
      Volumes: { "/data": {} },
      ExposedPorts: { "8333/tcp": {} },
    },
  };
  const runtime = structuredClone(base);
  runtime.config.Labels = {
    "org.opencontainers.image.source": PATCHED_STORE.source,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.version": PATCHED_STORE.version,
    "io.cronometer.runtime.component": "object-store",
    "io.cronometer.upstream.source.revision": OBJECT_STORE_IMAGE.sourceRevision,
    "io.cronometer.upstream.image.digest": OBJECT_STORE_IMAGE.digest,
    "io.cronometer.module-lock.sha256": hash(lockBytes),
    "io.cronometer.grpc.version": PATCHED_STORE.grpcVersion,
  };
  const runtimeManifest = {
    schemaVersion: 2,
    mediaType: media,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${"0".repeat(64)}`,
      size: 100,
    },
    layers: [
      ...JSON.parse(baseRaw).layers,
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: `sha256:${"8".repeat(64)}`,
        size: 100,
      },
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: `sha256:${"9".repeat(64)}`,
        size: 100,
      },
    ],
  };
  const runtimeRaw = JSON.stringify(runtimeManifest);
  const runtimeDigest = digest(runtimeRaw);
  const attestManifest = {
    schemaVersion: 2,
    mediaType: media,
    artifactType: "application/vnd.docker.attestation.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      size: 2,
      data: "e30=",
    },
    subject: { mediaType: media, digest: runtimeDigest, size: Buffer.byteLength(runtimeRaw) },
    layers: ["https://spdx.dev/Document", "https://slsa.dev/provenance/v1"].map(
      (predicate, index) => ({
        mediaType: "application/vnd.in-toto+json",
        digest: `sha256:${String(index + 1).repeat(64)}`,
        size: 200,
        annotations: { "in-toto.io/predicate-type": predicate },
      }),
    ),
  };
  const attestRaw = JSON.stringify(attestManifest);
  const attestDigest = digest(attestRaw);
  const indexRaw = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: media,
        digest: runtimeDigest,
        size: Buffer.byteLength(runtimeRaw),
        platform: { os: "linux", architecture: "arm64" },
      },
      {
        mediaType: media,
        digest: attestDigest,
        size: Buffer.byteLength(attestRaw),
        platform: { os: "unknown", architecture: "unknown" },
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": runtimeDigest,
        },
      },
    ],
  });
  const options = {
    mode: "identity",
    imageRef: `${PATCHED_STORE.repository}@${digest(indexRaw)}`,
    revision,
    workflowSha: revision,
    sourceRef: PATCHED_STORE.sourceRef,
  };
  const provenance = {
    SLSA: {
      buildDefinition: {
        buildType:
          "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
        externalParameters: {
          // Exact local-context tuple captured from the ae34e629 BuildKit
          // SLSA predicate (sha256:2b9b530d33b82a09751a42f6ec6837ad451eef79476994c29efb964f2cf41ac4).
          configSource: { path: "object-store.Dockerfile" },
          request: {
            args: { target: "runtime" },
            root: {
              configSource: { path: "object-store.Dockerfile" },
              request: {
                args: {
                  target: "runtime",
                  "vcs:localdir:dockerfile": "infra/docker",
                  "vcs:localdir:context": ".",
                },
              },
            },
          },
        },
        internalParameters: { builderPlatform: "linux/arm64" },
        resolvedDependencies: [
          {
            uri: `https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/${OBJECT_STORE_IMAGE.sourceRevision}`,
            digest: { sha256: lock.sourceArchiveSha256 },
          },
          {
            uri: "pkg:docker/golang@1.26.6-alpine3.24?platform=linux%2Farm64",
            digest: { sha256: PATCHED_STORE.goArm64Digest.slice(7) },
          },
          {
            uri: "pkg:docker/ghcr.io/chrislusf/seaweedfs@4.47?platform=linux%2Farm64",
            digest: { sha256: OBJECT_STORE_IMAGE.arm64Digest.slice(7) },
          },
        ],
      },
      runDetails: {
        builder: { id: "github-actions" },
        metadata: {
          invocationId: "build",
          startedOn: "2026-09-26T00:00:00Z",
          finishedOn: "2026-09-26T00:05:00Z",
        },
      },
    },
  };
  const sbom = {
    SPDX: {
      SPDXID: "SPDXRef-DOCUMENT",
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      packages: [{ name: "weed" }],
      relationships: [],
      documentNamespace: "https://example.test/sbom",
      creationInfo: { creators: ["Tool: syft"] },
    },
  };
  const state = {
    runtime,
    provenance,
    sbom,
    options,
    // Captured predicates attached to index 48fc4e0c6e1272d2745fa3516039eaae4d12d76371233cd8f4ddd31b81f42138.
    // Cosign v3.1.3 transformOutput maps each verified predicateType to critical.type.
    signatures: ["https://sigstore.dev/cosign/sign/v1", "https://slsa.dev/provenance/v1"].map(
      (type) => ({
        critical: {
          type,
          image: { "docker-manifest-digest": digest(indexRaw) },
        },
      }),
    ),
    metadata: metadata(),
    calls: [],
  };
  state.run = (command, args) => {
    state.calls.push([command, args]);
    if (command === "cosign") return JSON.stringify(state.signatures);
    if (command === "gh") return "Verified";
    assert.equal(command, "docker");
    assert.deepEqual(args.slice(0, 3), ["buildx", "imagetools", "inspect"]);
    const ref = args[3];
    const field = args[4] === "--format" ? args[5] : "raw";
    if (ref === options.imageRef) {
      if (field === "raw") return indexRaw;
      if (field === "{{json .Provenance}}") return JSON.stringify(provenance);
      if (field === "{{json .SBOM}}") return JSON.stringify(sbom);
    }
    if (ref === `${PATCHED_STORE.repository}@${attestDigest}`) return attestRaw;
    if (ref === `${PATCHED_STORE.repository}@${runtimeDigest}`)
      return field === "raw" ? runtimeRaw : JSON.stringify(runtime);
    if (ref === `${OBJECT_STORE_IMAGE.repository}@${OBJECT_STORE_IMAGE.arm64Digest}`)
      return field === "raw" ? baseRaw : JSON.stringify(base);
    throw new Error("unexpected reference");
  };
  state.verify = () =>
    verifyPatchedObjectStoreImage(options, state.run, () => ({
      metadata: state.metadata,
      binarySha256: "b".repeat(64),
    }));
  return state;
}

test("binds the exact index, runtime, original layers, frozen modules and build materials", () => {
  const state = fixture();
  const result = state.verify();
  assert.equal(result.ref, state.options.imageRef);
  assert.equal(result.grpcVersion, PATCHED_STORE.grpcVersion);
  assert.equal(result.binarySha256, "b".repeat(64));
  assert.equal(result.dependencyCount, 1);
  assert.ok(!state.calls.some(([command]) => command === "cosign"));
});
test("full verification binds project signing and GitHub provenance to the exact commit", () => {
  const state = fixture();
  state.options.mode = "verify";
  state.verify();
  const cosign = state.calls.find(([command]) => command === "cosign")[1];
  assert.ok(cosign.includes("--new-bundle-format=true"));
  assert.ok(
    cosign.includes(`https://github.com/${PATCHED_STORE.workflow}@${PATCHED_STORE.sourceRef}`),
  );
  const gh = state.calls.find(([command]) => command === "gh")[1];
  assert.equal(
    cosign[cosign.indexOf("--certificate-oidc-issuer") + 1],
    "https://token.actions.githubusercontent.com",
  );
  assert.equal(cosign.at(-1), state.options.imageRef);
  assert.ok(gh.includes("--deny-self-hosted-runners"));
  assert.equal(gh[gh.indexOf("--source-digest") + 1], revision);
  assert.equal(gh[gh.indexOf("--signer-digest") + 1], revision);
  assert.equal(gh[gh.indexOf("--signer-workflow") + 1], PATCHED_STORE.workflow);
  assert.equal(gh[gh.indexOf("--source-ref") + 1], PATCHED_STORE.sourceRef);
  assert.equal(gh[gh.indexOf("--predicate-type") + 1], "https://slsa.dev/provenance/v1");
});
test("accepts an actual signing predicate with or without the separate provenance output", () => {
  for (const reverse of [false, true]) {
    const state = fixture();
    state.options.mode = "verify";
    if (reverse) state.signatures.reverse();
    else state.signatures.splice(1, 1);
    state.verify();
    assert.ok(state.calls.some(([command]) => command === "gh"));
  }
});
test("a valid signature and provenance output cannot bypass GitHub source verification", () => {
  const state = fixture();
  state.options.mode = "verify";
  const run = state.run;
  state.run = (command, args) => {
    if (command === "gh") throw new Error("GitHub source verification rejected");
    return run(command, args);
  };
  assert.throws(state.verify, /GitHub source verification rejected/);
});
for (const [name, change] of [
  [
    "provenance without a signing predicate",
    (s) => {
      s.signatures.shift();
    },
  ],
  [
    "another digest in accompanying provenance",
    (s) => {
      s.signatures[1].critical.image["docker-manifest-digest"] = `sha256:${"0".repeat(64)}`;
    },
  ],
  [
    "unknown accompanying predicate",
    (s) => {
      s.signatures[1].critical.type = "https://example.test/unknown";
    },
  ],
  [
    "missing accompanying predicate",
    (s) => {
      delete s.signatures[1].critical.type;
    },
  ],
  [
    "missing accompanying digest",
    (s) => {
      delete s.signatures[1].critical.image;
    },
  ],
  [
    "missing critical record",
    (s) => {
      delete s.signatures[1].critical;
    },
  ],
  [
    "null output entry",
    (s) => {
      s.signatures[1] = null;
    },
  ],
  [
    "non-array output",
    (s) => {
      s.signatures = {};
    },
  ],
]) {
  test(`rejects ${name} before GitHub verification`, () => {
    const state = fixture();
    state.options.mode = "verify";
    change(state);
    assert.throws(state.verify);
    assert.ok(!state.calls.some(([command]) => command === "gh"));
  });
}
for (const [name, change] of [
  [
    "runtime user",
    (s) => {
      s.runtime.config.User = "1000:1000";
    },
  ],
  [
    "entrypoint",
    (s) => {
      s.runtime.config.Entrypoint = ["/usr/bin/weed"];
    },
  ],
  [
    "source revision",
    (s) => {
      s.runtime.config.Labels["org.opencontainers.image.revision"] = "b".repeat(40);
    },
  ],
  [
    "module lock",
    (s) => {
      s.runtime.config.Labels["io.cronometer.module-lock.sha256"] = "0".repeat(64);
    },
  ],
  [
    "source archive",
    (s) => {
      s.provenance.SLSA.buildDefinition.resolvedDependencies[0].digest.sha256 = "0".repeat(64);
    },
  ],
  [
    "wrong build",
    (s) => {
      s.provenance.SLSA.buildDefinition.externalParameters.configSource.path = "other.Dockerfile";
    },
  ],
  [
    "empty SBOM",
    (s) => {
      s.sbom.SPDX.packages = [];
    },
  ],
  [
    "unpatched binary",
    (s) => {
      s.metadata = s.metadata.replace(PATCHED_STORE.grpcVersion, "v1.85.0-dev");
    },
  ],
  [
    "empty signature",
    (s) => {
      s.options.mode = "verify";
      s.signatures = [];
    },
  ],
  [
    "wrong signature digest",
    (s) => {
      s.options.mode = "verify";
      s.signatures[0].critical.image["docker-manifest-digest"] = `sha256:${"0".repeat(64)}`;
    },
  ],
  [
    "old signature format",
    (s) => {
      s.options.mode = "verify";
      s.signatures[0].critical.type = "cosign container image signature";
    },
  ],
])
  test(`rejects ${name}`, () => {
    const state = fixture();
    change(state);
    assert.throws(state.verify);
  });

test("rejects unknown binary modules, changed sums and undeclared replacements", () => {
  for (const bad of [
    metadata().replace("h1:ar+feAPij1Znzug45m6AoShUCc5AaR8FLA3I6LZd94k=", "h1:wrong"),
    `${metadata()}\tdep\tunknown.test/module\tv1.0.0\th1:sum\n`,
    metadata().replace(
      "\tbuild\tCGO_ENABLED=0",
      "\t=>\tevil.test/fork\tv1.0.0\th1:sum\n\tbuild\tCGO_ENABLED=0",
    ),
    metadata().replace("GOARCH=arm64", "GOARCH=amd64"),
    `${metadata()}\tbuild\t-trimpath=true\n`,
    metadata().replace(OBJECT_STORE_IMAGE.sourceRevision, "f".repeat(40)),
  ])
    assert.throws(() => verifyBinaryMetadata(bad, lock, sums));
});
test("retains only the exact declared upstream replacement with its actual content hash", () => {
  const path = "github.com/tyler-smith/go-bip39";
  const replacement = lock.allowedReplacements.find((item) => item.path === path);
  const version = lock.expectedSelectedVersions[path];
  const sum = sums
    .split("\n")
    .find((line) =>
      line.startsWith(`${replacement.replacementPath} ${replacement.replacementVersion} `),
    )
    .split(" ")[2];
  const text =
    metadata() +
    `\tdep\t${path}\t${version}\n\t=>\t${replacement.replacementPath}\t${replacement.replacementVersion}\t${sum}\n`;
  assert.equal(verifyBinaryMetadata(text, lock, sums).dependencyCount, 2);
  assert.throws(() =>
    verifyBinaryMetadata(text.replace(replacement.replacementPath, "other.test/fork"), lock, sums),
  );
});
test("rejects unsafe image and source arguments before any subprocess", () => {
  const good = fixture().options;
  for (const changed of [
    { imageRef: `ghcr.io/other/object-store@sha256:${"a".repeat(64)}` },
    { imageRef: `${good.imageRef}\n` },
    { revision: "main" },
    { workflowSha: undefined },
    { sourceRef: "refs/heads/main" },
    { mode: "anything" },
  ])
    assert.throws(() => validateOptions({ ...good, ...changed }));
});
test("extracts from a stopped exact image and executes only the pinned Go reader with no network", () => {
  let file;
  const calls = [];
  const result = extractBinaryMetadata("exact-runtime", (command, args) => {
    calls.push([command, args]);
    if (args[0] === "create") return "c".repeat(64);
    if (args[0] === "cp") {
      file = args[2];
      writeFileSync(file, "binary bytes");
      return "";
    }
    if (args[0] === "run") return metadata();
    assert.equal(args[0], "rm");
    return "";
  });
  assert.equal(result.binarySha256, hash("binary bytes"));
  assert.equal(existsSync(file), false);
  const run = calls.find(([, args]) => args[0] === "run")[1];
  assert.ok(run.includes(PATCHED_STORE.goImage));
  assert.ok(run.includes("none"));
  assert.ok(run.includes("--read-only"));
  assert.deepEqual(run.slice(-4), [PATCHED_STORE.goImage, "version", "-m", "/inspect/weed"]);
  assert.deepEqual(calls.at(-1), ["docker", ["rm", "-v", "c".repeat(64)]]);
});
test("cleans the owned stopped container and inspection files when static reading fails", () => {
  let file;
  let removed = false;
  assert.throws(
    () =>
      extractBinaryMetadata("exact-runtime", (_command, args) => {
        if (args[0] === "create") return "c".repeat(64);
        if (args[0] === "cp") {
          file = args[2];
          writeFileSync(file, "binary bytes");
          return "";
        }
        if (args[0] === "run") throw new Error("reader failure");
        if (args[0] === "rm") {
          removed = true;
          return "";
        }
        throw new Error("unexpected call");
      }),
    /reader failure/,
  );
  assert.equal(removed, true);
  assert.equal(existsSync(file), false);
});
test("requires every exact upstream material", () => {
  for (let index = 0; index < 3; index++) {
    const state = fixture();
    state.provenance.SLSA.buildDefinition.resolvedDependencies.splice(index, 1);
    assert.throws(() => verifyBuildMaterials(state.provenance, lock));
  }
});

test("accepts the captured basename and exact Dockerfile/context directory tuple", () => {
  assert.doesNotThrow(() => verifyBuildMaterials(fixture().provenance, lock));
});
for (const [field, values] of [
  [
    "basename",
    [
      undefined,
      "other.Dockerfile",
      "../object-store.Dockerfile",
      "infra/docker/object-store.Dockerfile",
    ],
  ],
  ["root basename", [undefined, "other.Dockerfile", "../object-store.Dockerfile"]],
  ["directory", [undefined, "other", "../infra/docker", "infra/./docker", "/infra/docker"]],
  ["context", [undefined, "..", "./", "/"]],
  ["target", [undefined, "build-evidence"]],
  ["root target", [undefined, "build-evidence"]],
  ["platform", [undefined, "linux/amd64"]],
]) {
  for (const value of values)
    test(`rejects ${field}=${String(value)} in the provenance tuple`, () => {
      const state = fixture();
      const build = state.provenance.SLSA.buildDefinition;
      const external = build.externalParameters;
      const root = external.request.root;
      if (field === "basename") external.configSource.path = value;
      if (field === "root basename") root.configSource.path = value;
      if (field === "directory") root.request.args["vcs:localdir:dockerfile"] = value;
      if (field === "context") root.request.args["vcs:localdir:context"] = value;
      if (field === "target") external.request.args.target = value;
      if (field === "root target") root.request.args.target = value;
      if (field === "platform") build.internalParameters.builderPlatform = value;
      assert.throws(() => verifyBuildMaterials(state.provenance, lock), /another build definition/);
    });
}
test("rejects a missing local-context root record", () => {
  const state = fixture();
  delete state.provenance.SLSA.buildDefinition.externalParameters.request.root;
  assert.throws(() => verifyBuildMaterials(state.provenance, lock), /another build definition/);
});
