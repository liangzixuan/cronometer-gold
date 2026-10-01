import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { MAILPIT_INPUTS } from "./verify-mailpit-build.mjs";
import {
  extractBinaryMetadata,
  MAILPIT_IMAGE,
  validateOptions,
  verifyBinaryMetadata,
  verifyBuildMaterials,
  verifyRuntimeConfiguration,
  verifyScanCoverage,
} from "./verify-mailpit-image.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revision = "a".repeat(40);
const options = {
  mode: "identity",
  imageRef: `${MAILPIT_IMAGE.repository}@sha256:${"b".repeat(64)}`,
  revision,
  workflowSha: revision,
  sourceRef: MAILPIT_IMAGE.sourceRef,
};
const lockBytes = readFileSync(
  new URL("../infra/docker/mailpit-build-inputs.json", import.meta.url),
);
const notices = readFileSync(new URL("../infra/docker/mailpit-NOTICES.txt", import.meta.url));
function metadata() {
  return `/inspect/mailpit: go1.26.6\n\tpath\tgithub.com/axllent/mailpit\n\tmod\tgithub.com/axllent/mailpit\t(devel)\n${Object.entries(
    MAILPIT_INPUTS.goProductionModules,
  )
    .map(([name, item]) => `\tdep\t${name}\t${item.version}\t${item.sum}\n`)
    .join(
      "",
    )}\tbuild\t-trimpath=true\n\tbuild\t-buildmode=exe\n\tbuild\t-compiler=gc\n\tbuild\tGOARM64=v8.0\n\tbuild\tCGO_ENABLED=0\n\tbuild\tGOOS=linux\n\tbuild\tGOARCH=arm64\n`;
}
function scan() {
  return {
    Results: [
      {
        Target: "usr/bin/mailpit",
        Type: "gobinary",
        Packages: [
          ...Object.entries(MAILPIT_INPUTS.goProductionModules).map(([Name, item]) => ({
            Name,
            Version: item.version,
          })),
          { Name: "stdlib", Version: "v1.26.6" },
          { Name: "github.com/axllent/mailpit" },
        ],
        Vulnerabilities: [],
      },
    ],
  };
}
function runtime() {
  return {
    os: "linux",
    architecture: "arm64",
    config: {
      User: "1000:1000",
      Entrypoint: ["/usr/bin/mailpit"],
      WorkingDir: "/data",
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME=/home/mailpit",
        "TMPDIR=/tmp",
        "TZ=UTC",
      ],
      ExposedPorts: { "1025/tcp": {}, "8025/tcp": {} },
      Labels: {
        "org.opencontainers.image.source": MAILPIT_IMAGE.source,
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.version": "v1.31.3",
        "io.cronometer.runtime.component": "mailpit",
        "io.cronometer.upstream.source.revision": MAILPIT_INPUTS.upstream.revision,
        "io.cronometer.build-inputs.sha256": sha(lockBytes),
        "io.cronometer.notices.sha256": sha(notices),
      },
    },
  };
}
function provenance() {
  return {
    SLSA: {
      buildDefinition: {
        externalParameters: {
          configSource: { path: "mailpit.Dockerfile" },
          request: {
            args: { target: "runtime" },
            root: {
              configSource: { path: "mailpit.Dockerfile" },
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
            uri: MAILPIT_INPUTS.upstream.archive,
            digest: { sha256: MAILPIT_INPUTS.upstream.archiveSha256 },
          },
          {
            uri: MAILPIT_INPUTS.licenseTool.archive,
            digest: { sha256: MAILPIT_INPUTS.licenseTool.archiveSha256 },
          },
          {
            uri: "pkg:docker/golang@1.26.6-alpine3.24",
            digest: { sha256: MAILPIT_INPUTS.goArm64Digest.slice(7) },
          },
          {
            uri: "pkg:docker/node@22-bookworm-slim",
            digest: { sha256: MAILPIT_INPUTS.nodeArm64Digest.slice(7) },
          },
        ],
      },
    },
  };
}
test("image verifier accepts only exact repository/ref/full source identities", () => {
  assert.equal(validateOptions(options), options);
  for (const patch of [
    { imageRef: "ghcr.io/other/image@sha256:" + "a".repeat(64) },
    { sourceRef: "refs/heads/main" },
    { revision: "short" },
    { workflowSha: "short" },
    { mode: "publish" },
  ])
    assert.throws(() => validateOptions({ ...options, ...patch }));
});
test("binary verifier requires all 52 production modules and exact toolchain", () =>
  assert.equal(verifyBinaryMetadata(metadata()).dependencyCount, 52));
for (const [name, mutate] of [
  ["toolchain", (s) => s.replace("go1.26.6", "go1.26.5")],
  ["architecture", (s) => s.replace("GOARCH=arm64", "GOARCH=amd64")],
  ["CGO", (s) => s.replace("CGO_ENABLED=0", "CGO_ENABLED=1")],
  ["trimpath", (s) => s.replace("-trimpath=true", "-trimpath=false")],
  ["unexpected linker record", (s) => `${s}\tbuild\t-ldflags=unreviewed\n`],
  ["build mode", (s) => s.replace("-buildmode=exe", "-buildmode=plugin")],
  ["compiler", (s) => s.replace("-compiler=gc", "-compiler=gccgo")],
  ["missing module", (s) => s.replace(/\tdep[^\n]+\n/u, "")],
  ["replacement", (s) => s + "\t=>\tother\tv1.0.0\th1:bad\n"],
  ["checksum", (s) => s.replace(/h1:[^\n]+/u, "h1:bad")],
])
  test(`binary rejects ${name}`, () =>
    assert.throws(() => verifyBinaryMetadata(mutate(metadata()))));
test("scan requires exact 54-package inventory and actual Go target", () =>
  assert.equal(verifyScanCoverage(scan()).packages, 54));
for (const [name, mutate] of [
  ["empty targets", (x) => (x.Results = [])],
  ["wrong target", (x) => (x.Results[0].Target = "other")],
  ["missing package", (x) => x.Results[0].Packages.pop()],
  ["wrong version", (x) => (x.Results[0].Packages[0].Version = "v0")],
  ["duplicate package", (x) => x.Results[0].Packages.push(x.Results[0].Packages[0])],
  ["HIGH finding", (x) => x.Results[0].Vulnerabilities.push({ Severity: "HIGH" })],
  ["CRITICAL elsewhere", (x) => x.Results.push({ Vulnerabilities: [{ Severity: "CRITICAL" }] })],
  ["modified finding", (x) => (x.Results[0].ModifiedFindings = [{}])],
])
  test(`scan rejects ${name}`, () => {
    const value = scan();
    mutate(value);
    assert.throws(() => verifyScanCoverage(value));
  });
test("runtime exact nonroot contract and all required materials pass", () => {
  verifyRuntimeConfiguration(runtime(), revision, lockBytes, notices);
  verifyBuildMaterials(provenance());
});
for (const [name, mutate] of [
  ["root user", (x) => (x.config.User = "0")],
  ["command", (x) => (x.config.Cmd = ["relay"])],
  ["injected env", (x) => x.config.Env.push("MP_SMTP_RELAY_CONFIG=x")],
  ["notice label", (x) => (x.config.Labels["io.cronometer.notices.sha256"] = "bad")],
  ["architecture", (x) => (x.architecture = "amd64")],
])
  test(`runtime rejects ${name}`, () => {
    const value = runtime();
    mutate(value);
    assert.throws(() => verifyRuntimeConfiguration(value, revision, lockBytes, notices));
  });
for (const index of [0, 1, 2, 3])
  test(`provenance rejects missing material ${index}`, () => {
    const value = provenance();
    value.SLSA.buildDefinition.resolvedDependencies.splice(index, 1);
    assert.throws(() => verifyBuildMaterials(value));
  });
test("provenance rejects another build context", () => {
  const value = provenance();
  value.SLSA.buildDefinition.externalParameters.request.root.request.args["vcs:localdir:context"] =
    "other";
  assert.throws(() => verifyBuildMaterials(value));
});
for (const failAt of [undefined, "cp", "run"])
  test(`binary extraction settles its exact stopped container and temp directory after ${failAt ?? "success"}`, () => {
    const calls = [];
    let directory;
    const id = "1".repeat(64);
    const run = (command, args) => {
      calls.push([command, ...args]);
      assert.equal(command, "docker");
      if (args[0] === "create") {
        assert.ok(args.includes("none"));
        return id;
      }
      if (args[0] === "cp") {
        directory = args[2].slice(0, -"/mailpit".length);
        if (failAt === "cp") throw new Error("copy failure");
        writeFileSync(args[2], "fixture");
        return "";
      }
      if (args[0] === "run") {
        assert.ok(args.includes("--read-only"));
        assert.ok(args.includes("--cap-drop"));
        assert.ok(args.includes(MAILPIT_IMAGE.goImage));
        if (failAt === "run") throw new Error("metadata failure");
        return metadata();
      }
      assert.deepEqual(args, ["rm", "-v", id]);
      return "";
    };
    if (failAt) assert.throws(() => extractBinaryMetadata(options.imageRef, run));
    else assert.equal(extractBinaryMetadata(options.imageRef, run).binarySha256, sha("fixture"));
    assert.deepEqual(calls.at(-1), ["docker", "rm", "-v", id]);
    assert.equal(existsSync(directory), false);
  });
