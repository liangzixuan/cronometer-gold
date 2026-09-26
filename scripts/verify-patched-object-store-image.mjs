import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { OBJECT_STORE_IMAGE } from "./verify-local-object-store-image.mjs";
import { verifyOciBuildkitAttestations } from "./verify-oci-buildkit-attestations.mjs";

export const PATCHED_STORE = {
  repository: "ghcr.io/liangzixuan/cronometer-gold-object-store",
  source: "https://github.com/liangzixuan/cronometer-gold",
  sourceRef: "refs/heads/codex/retention-features",
  workflow: "liangzixuan/cronometer-gold/.github/workflows/container-supply-chain.yml",
  version: "4.47-grpc-patched",
  goImage:
    "docker.io/library/golang:1.26.6-alpine3.24@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83",
  goArm64Digest: "sha256:1b2cb58c3df8b93b8bcb5739778692c35e491087599139deb2c8c03567cbb03e",
  grpcVersion: "v1.85.0-dev.0.20260825072537-93e31b48545e",
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lockPath = new URL("../infra/docker/object-store-modules.json", import.meta.url);
const sumPath = new URL("../infra/docker/object-store.go.sum", import.meta.url);
const modPath = new URL("../infra/docker/object-store.go.mod", import.meta.url);

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed during patched storage verification.`, {
      cause: result.error ?? new Error(result.stderr),
    });
  }
  return result.stdout;
}

export function validateOptions(options) {
  if (
    !["identity", "verify"].includes(options.mode) ||
    !new RegExp(`^${PATCHED_STORE.repository}@sha256:[0-9a-f]{64}$`.replaceAll(".", "\\.")).test(
      options.imageRef,
    ) ||
    !/^[0-9a-f]{40}$/.test(options.revision) ||
    !/^[0-9a-f]{40}$/.test(options.workflowSha) ||
    options.sourceRef !== PATCHED_STORE.sourceRef
  ) {
    throw new Error(
      "Expected the exact project digest, source ref and full source/workflow revisions.",
    );
  }
  return options;
}

export function verifyBinaryMetadata(text, lock, sums) {
  const lines = text.trimEnd().split("\n");
  if (!/^.+: go1\.26\.6$/.test(lines.shift() ?? ""))
    throw new Error("Unexpected weed Go toolchain.");
  const known = new Map(
    sums
      .trim()
      .split("\n")
      .map((line) => {
        const [path, version, sum] = line.trim().split(/\s+/);
        return [`${path}@${version}`, sum];
      }),
  );
  const dependencies = [];
  const settings = {};
  let path;
  let main;
  for (const line of lines) {
    const [kind, ...parts] = line.trim().split("\t");
    if (kind === "path") path = parts.join("\t");
    else if (kind === "mod") main = parts;
    else if (kind === "dep")
      dependencies.push({ path: parts[0], version: parts[1], sum: parts[2] });
    else if (kind === "=>") {
      const prior = dependencies.at(-1);
      if (!prior || prior.replacement) throw new Error("Unexpected weed module replacement.");
      prior.replacement = { path: parts[0], version: parts[1], sum: parts[2] };
    } else if (kind === "build") {
      const value = parts.join("\t");
      const split = value.indexOf("=");
      const key = value.slice(0, split);
      if (split < 1 || Object.hasOwn(settings, key))
        throw new Error("Malformed weed build settings.");
      settings[key] = value.slice(split + 1).replace(/^"|"$/g, "");
    } else if (kind !== "") throw new Error("Unknown weed build metadata record.");
  }
  if (
    path !== "github.com/seaweedfs/seaweedfs/weed" ||
    main?.[0] !== "github.com/seaweedfs/seaweedfs" ||
    main?.[1] !== "(devel)" ||
    settings.CGO_ENABLED !== "0" ||
    settings.GOOS !== "linux" ||
    settings.GOARCH !== "arm64" ||
    settings["-trimpath"] !== undefined ||
    settings["-ldflags"] !==
      `-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=${OBJECT_STORE_IMAGE.sourceRevision}`
  ) {
    throw new Error("Weed source, build flags or runtime architecture differ.");
  }
  const seen = new Set();
  for (const dependency of dependencies) {
    if (
      seen.has(dependency.path) ||
      lock.expectedSelectedVersions[dependency.path] !== dependency.version
    ) {
      throw new Error(`Unreviewed weed module: ${dependency.path}@${dependency.version}`);
    }
    seen.add(dependency.path);
    const replacement = lock.allowedReplacements.find((item) => item.path === dependency.path);
    let actual = dependency;
    if (replacement) {
      if (
        dependency.replacement?.path !== replacement.replacementPath ||
        dependency.replacement?.version !== replacement.replacementVersion
      ) {
        throw new Error("The exact upstream module replacement is required.");
      }
      actual = dependency.replacement;
    } else if (dependency.replacement) throw new Error("Unreviewed weed module replacement.");
    if (!actual.sum || known.get(`${actual.path}@${actual.version}`) !== actual.sum) {
      throw new Error(`Weed module content checksum differs: ${actual.path}`);
    }
  }
  if (
    !seen.has("google.golang.org/grpc") ||
    lock.expectedSelectedVersions["google.golang.org/grpc"] !== PATCHED_STORE.grpcVersion
  ) {
    throw new Error("The patched gRPC dependency is required.");
  }
  return { dependencyCount: dependencies.length, grpcVersion: PATCHED_STORE.grpcVersion };
}

export function extractBinaryMetadata(runtimeRef, run = capture) {
  const directory = mkdtempSync(join(tmpdir(), "nourishing-weed-inspect-"));
  let container;
  try {
    const id = run("docker", [
      "create",
      "--platform",
      "linux/arm64",
      "--network",
      "none",
      "--entrypoint",
      "/bin/false",
      runtimeRef,
    ]).trim();
    if (!/^[0-9a-f]{64}$/.test(id))
      throw new Error("Invalid stopped inspection-container identity.");
    container = id;
    const file = join(directory, "weed");
    run("docker", ["cp", `${container}:/usr/bin/weed`, file]);
    chmodSync(directory, 0o755);
    chmodSync(file, 0o444);
    const binarySha256 = sha(readFileSync(file));
    const metadata = run("docker", [
      "run",
      "--rm",
      "--platform",
      "linux/arm64",
      "--network",
      "none",
      "--read-only",
      "--user",
      "65534:65534",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${directory},dst=/inspect,readonly`,
      "--entrypoint",
      "/usr/local/go/bin/go",
      PATCHED_STORE.goImage,
      "version",
      "-m",
      "/inspect/weed",
    ]);
    return { metadata, binarySha256 };
  } finally {
    try {
      if (container) run("docker", ["rm", "-v", container]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

export function verifyBuildMaterials(payload, lock) {
  const build = payload.SLSA?.buildDefinition;
  if (
    build?.externalParameters?.configSource?.path !== "infra/docker/object-store.Dockerfile" ||
    build.externalParameters.request?.args?.target !== "runtime" ||
    build.internalParameters?.builderPlatform !== "linux/arm64"
  ) {
    throw new Error("Patched storage provenance names another build definition.");
  }
  const materials = build.resolvedDependencies ?? [];
  const has = (uri, digests) =>
    materials.some((item) => uri(item.uri) && digests.includes(item.digest?.sha256));
  if (
    !has(
      (uri) =>
        uri ===
        `https://codeload.github.com/seaweedfs/seaweedfs/tar.gz/${OBJECT_STORE_IMAGE.sourceRevision}`,
      [lock.sourceArchiveSha256],
    ) ||
    !has(
      (uri) =>
        typeof uri === "string" &&
        uri.startsWith("pkg:docker/") &&
        uri.includes("golang@1.26.6-alpine3.24"),
      [PATCHED_STORE.goImage.split("@sha256:")[1], PATCHED_STORE.goArm64Digest.slice(7)],
    ) ||
    !has(
      (uri) =>
        typeof uri === "string" && uri.startsWith("pkg:docker/") && uri.includes("seaweedfs@4.47"),
      [OBJECT_STORE_IMAGE.digest.slice(7), OBJECT_STORE_IMAGE.arm64Digest.slice(7)],
    )
  ) {
    throw new Error("Patched storage provenance is missing exact source or base materials.");
  }
}

export function verifyPatchedObjectStoreImage(
  options,
  run = capture,
  extract = extractBinaryMetadata,
) {
  validateOptions(options);
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  const sums = readFileSync(sumPath, "utf8");
  if (
    sha(sums) !== lock.goSumSha256 ||
    sha(readFileSync(modPath)) !== lock.goModSha256 ||
    lock.sourceRevision !== OBJECT_STORE_IMAGE.sourceRevision ||
    lock.grpcVersion !== PATCHED_STORE.grpcVersion
  )
    throw new Error("Reviewed module inputs differ.");
  const raw = run("docker", ["buildx", "imagetools", "inspect", options.imageRef, "--raw"]);
  const digest = options.imageRef.split("@")[1];
  if (`sha256:${sha(raw)}` !== digest) throw new Error("Patched storage index digest differs.");
  const inspect = (ref, field) =>
    run("docker", [
      "buildx",
      "imagetools",
      "inspect",
      ref,
      ...(field ? ["--format", `{{json .${field}}}`] : ["--raw"]),
    ]);
  const provenance = JSON.parse(inspect(options.imageRef, "Provenance"));
  const sbom = JSON.parse(inspect(options.imageRef, "SBOM"));
  const attestation = verifyOciBuildkitAttestations(
    raw,
    (hash) => {
      const bytes = inspect(`${PATCHED_STORE.repository}@${hash}`);
      if (`sha256:${sha(bytes)}` !== hash) throw new Error("Attestation manifest digest differs.");
      return bytes;
    },
    () => ({ provenance, sbom }),
  );
  verifyBuildMaterials(provenance, lock);
  const runtimeRef = `${PATCHED_STORE.repository}@${attestation.runtimeDigest}`;
  const runtime = JSON.parse(inspect(runtimeRef, "Image"));
  const baseRef = `${OBJECT_STORE_IMAGE.repository}@${OBJECT_STORE_IMAGE.arm64Digest}`;
  const base = JSON.parse(inspect(baseRef, "Image"));
  for (const key of [
    "User",
    "Entrypoint",
    "Cmd",
    "WorkingDir",
    "Env",
    "Volumes",
    "ExposedPorts",
    "StopSignal",
    "Healthcheck",
  ]) {
    if (JSON.stringify(runtime.config?.[key]) !== JSON.stringify(base.config?.[key])) {
      throw new Error(`Upstream storage runtime configuration changed: ${key}`);
    }
  }
  const labels = runtime.config?.Labels;
  const required = {
    "org.opencontainers.image.source": PATCHED_STORE.source,
    "org.opencontainers.image.revision": options.revision,
    "org.opencontainers.image.version": PATCHED_STORE.version,
    "io.cronometer.runtime.component": "object-store",
    "io.cronometer.upstream.source.revision": OBJECT_STORE_IMAGE.sourceRevision,
    "io.cronometer.upstream.image.digest": OBJECT_STORE_IMAGE.digest,
    "io.cronometer.module-lock.sha256": sha(lockBytes),
    "io.cronometer.grpc.version": PATCHED_STORE.grpcVersion,
  };
  if (
    runtime.os !== "linux" ||
    runtime.architecture !== "arm64" ||
    Object.entries(required).some(([key, value]) => labels?.[key] !== value)
  ) {
    throw new Error("Patched storage runtime identity differs.");
  }
  const runtimeRaw = inspect(runtimeRef);
  if (`sha256:${sha(runtimeRaw)}` !== attestation.runtimeDigest)
    throw new Error("Runtime manifest digest differs.");
  const baseRaw = inspect(baseRef);
  if (`sha256:${sha(baseRaw)}` !== OBJECT_STORE_IMAGE.arm64Digest)
    throw new Error("Original base manifest digest differs.");
  const baseLayers = JSON.parse(baseRaw).layers;
  const layers = JSON.parse(runtimeRaw).layers;
  if (
    !Array.isArray(baseLayers) ||
    baseLayers.length === 0 ||
    layers?.length !== baseLayers.length + 2 ||
    baseLayers.some((layer, index) => JSON.stringify(layer) !== JSON.stringify(layers[index]))
  ) {
    throw new Error("Patched storage must preserve all original runtime layers.");
  }
  const binary = extract(runtimeRef, run);
  if (!/^[0-9a-f]{64}$/.test(binary.binarySha256))
    throw new Error("Missing extracted weed content identity.");
  const modules = verifyBinaryMetadata(binary.metadata, lock, sums);
  if (options.mode === "verify") {
    const signatures = JSON.parse(
      run("cosign", [
        "verify",
        "--new-bundle-format=true",
        "--certificate-identity",
        `https://github.com/${PATCHED_STORE.workflow}@${options.sourceRef}`,
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--output",
        "json",
        options.imageRef,
      ]),
    );
    if (
      !Array.isArray(signatures) ||
      signatures.length === 0 ||
      signatures.some(
        (item) =>
          item.critical?.type !== "https://sigstore.dev/cosign/sign/v1" ||
          item.critical?.image?.["docker-manifest-digest"] !== digest,
      )
    ) {
      throw new Error("Project signature output is empty or names another digest.");
    }
    run("gh", [
      "attestation",
      "verify",
      `oci://${options.imageRef}`,
      "--repo",
      "liangzixuan/cronometer-gold",
      "--signer-workflow",
      PATCHED_STORE.workflow,
      "--signer-digest",
      options.workflowSha,
      "--source-digest",
      options.revision,
      "--source-ref",
      options.sourceRef,
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--deny-self-hosted-runners",
    ]);
  }
  return {
    ref: options.imageRef,
    runtimeRef,
    ...attestation,
    revision: options.revision,
    binarySha256: binary.binarySha256,
    ...modules,
  };
}

function parseArguments(args) {
  const [mode, ...flags] = args;
  const options = { mode };
  const names = {
    "--image-ref": "imageRef",
    "--revision": "revision",
    "--workflow-sha": "workflowSha",
    "--source-ref": "sourceRef",
  };
  for (let index = 0; index < flags.length; index += 2) {
    const key = names[flags[index]];
    if (!key || Object.hasOwn(options, key) || flags[index + 1] === undefined)
      throw new Error("Invalid verifier argument.");
    options[key] = flags[index + 1];
  }
  return validateOptions(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.platform !== "linux" || process.arch !== "arm64")
      throw new Error("Patched storage verification requires native Linux ARM64.");
    process.stdout.write(
      `${JSON.stringify(verifyPatchedObjectStoreImage(parseArguments(process.argv.slice(2))), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Patched storage verification failed."}\n`,
    );
    process.exitCode = 1;
  }
}
