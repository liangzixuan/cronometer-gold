import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { MAILPIT_INPUTS } from "./verify-mailpit-build.mjs";
import { verifyOciBuildkitAttestations } from "./verify-oci-buildkit-attestations.mjs";

export const MAILPIT_IMAGE = {
  repository: "ghcr.io/liangzixuan/cronometer-gold-mailpit",
  source: "https://github.com/liangzixuan/cronometer-gold",
  sourceRef: "refs/heads/codex/retention-features",
  workflow: "liangzixuan/cronometer-gold/.github/workflows/mailpit-image.yml",
  version: "v1.31.3",
  goImage: MAILPIT_INPUTS.goImage,
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lockPath = new URL("../infra/docker/mailpit-build-inputs.json", import.meta.url);
const noticePath = new URL("../infra/docker/mailpit-NOTICES.txt", import.meta.url);

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed during Mailpit verification.`, {
      cause: result.error ?? new Error(result.stderr),
    });
  }
  return result.stdout;
}

export function validateOptions(options) {
  if (
    !["identity", "verify"].includes(options.mode) ||
    !new RegExp(`^${MAILPIT_IMAGE.repository}@sha256:[0-9a-f]{64}$`.replaceAll(".", "\\.")).test(
      options.imageRef,
    ) ||
    !/^[0-9a-f]{40}$/.test(options.revision) ||
    !/^[0-9a-f]{40}$/.test(options.workflowSha) ||
    options.sourceRef !== MAILPIT_IMAGE.sourceRef
  ) {
    throw new Error(
      "Expected the exact project digest, source ref and full source/workflow revisions.",
    );
  }
  return options;
}

export function verifyBinaryMetadata(text, lock = MAILPIT_INPUTS) {
  const lines = text.trimEnd().split("\n");
  if (!/^.+: go1\.26\.6$/.test(lines.shift() ?? ""))
    throw new Error("Unexpected Mailpit Go toolchain.");
  const dependencies = new Map();
  const settings = {};
  let path;
  let main;
  for (const line of lines) {
    const [kind, ...parts] = line.trim().split("\t");
    if (kind === "path" && path === undefined) path = parts.join("\t");
    else if (kind === "mod" && main === undefined) main = parts;
    else if (kind === "dep" && parts.length === 3 && !dependencies.has(parts[0]))
      dependencies.set(parts[0], { version: parts[1], sum: parts[2] });
    else if (kind === "build") {
      const value = parts.join("\t");
      const split = value.indexOf("=");
      const key = value.slice(0, split);
      if (split < 1 || Object.hasOwn(settings, key))
        throw new Error("Malformed Mailpit build settings.");
      settings[key] = value.slice(split + 1).replace(/^"|"$/g, "");
    } else throw new Error("Unexpected or duplicate Mailpit metadata record.");
  }
  // Go omits linker flags from trimpath build info. The signed build definition
  // binds the exact linker command; this check admits only fields actually recorded.
  if (
    path !== "github.com/axllent/mailpit" ||
    main?.[0] !== path ||
    main?.[1] !== "(devel)" ||
    settings.CGO_ENABLED !== "0" ||
    settings.GOOS !== "linux" ||
    settings.GOARCH !== "arm64" ||
    settings["-trimpath"] !== "true" ||
    settings["-ldflags"] !== undefined ||
    settings["-buildmode"] !== "exe" ||
    settings["-compiler"] !== "gc" ||
    settings.GOARM64 !== "v8.0"
  ) {
    throw new Error("Mailpit source, build flags or runtime architecture differ.");
  }
  if (
    JSON.stringify([...dependencies].sort()) !==
    JSON.stringify(Object.entries(lock.goProductionModules).sort())
  ) {
    throw new Error("Mailpit binary module versions, checksums or complete dependency set differ.");
  }
  return { dependencyCount: dependencies.size, toolchain: "go1.26.6" };
}

export function verifyScanCoverage(report, lock = MAILPIT_INPUTS) {
  const targets = report.Results?.filter(
    (item) => item.Type === "gobinary" && /(?:^|\/)mailpit$/.test(item.Target),
  );
  if (targets?.length !== 1) throw new Error("Scan lacks the exact Mailpit Go binary target.");
  const packages = targets[0].Packages ?? [];
  const seen = new Map();
  for (const item of packages) {
    if (seen.has(item.Name)) throw new Error("Duplicate scanned Go package.");
    seen.set(item.Name, item.Version ?? "");
  }
  const expected = new Map(
    Object.entries(lock.goProductionModules).map(([name, item]) => [name, item.version]),
  );
  expected.set("stdlib", "v1.26.6");
  expected.set("github.com/axllent/mailpit", "");
  if (JSON.stringify([...seen].sort()) !== JSON.stringify([...expected].sort()))
    throw new Error("Scan Go package inventory is incomplete or changed.");
  if (
    report.Results.some((item) =>
      (item.Vulnerabilities ?? []).some((finding) =>
        ["HIGH", "CRITICAL"].includes(finding.Severity),
      ),
    ) ||
    report.Results.some(
      (item) =>
        (item.Misconfigurations ?? []).length ||
        (item.ExperimentalModifiedFindings ?? []).length ||
        (item.ModifiedFindings ?? []).length,
    )
  ) {
    throw new Error("Image vulnerability policy did not pass without modifications.");
  }
  return { packages: seen.size };
}

export function extractBinaryMetadata(runtimeRef, run = capture) {
  const directory = mkdtempSync(join(tmpdir(), "nourishing-mailpit-inspect-"));
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
    const file = join(directory, "mailpit");
    run("docker", ["cp", `${container}:/usr/bin/mailpit`, file]);
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
      MAILPIT_IMAGE.goImage,
      "version",
      "-m",
      "/inspect/mailpit",
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

export function verifyBuildMaterials(payload, lock = MAILPIT_INPUTS) {
  const build = payload.SLSA?.buildDefinition;
  const root = build?.externalParameters?.request?.root;
  if (
    build?.externalParameters?.configSource?.path !== "mailpit.Dockerfile" ||
    root?.configSource?.path !== "mailpit.Dockerfile" ||
    root?.request?.args?.["vcs:localdir:dockerfile"] !== "infra/docker" ||
    root?.request?.args?.["vcs:localdir:context"] !== "." ||
    root?.request?.args?.target !== "runtime" ||
    build.externalParameters.request?.args?.target !== "runtime" ||
    build.internalParameters?.builderPlatform !== "linux/arm64"
  ) {
    throw new Error("Mailpit provenance names another build definition.");
  }
  const materials = build.resolvedDependencies ?? [];
  const has = (uri, digests) =>
    materials.some((item) => uri(item.uri) && digests.includes(item.digest?.sha256));
  for (const [url, hash] of [
    [lock.upstream.archive, lock.upstream.archiveSha256],
    [lock.licenseTool.archive, lock.licenseTool.archiveSha256],
  ]) {
    if (!has((uri) => uri === url, [hash]))
      throw new Error("Mailpit provenance lacks exact source archives.");
  }
  for (const [name, index, child] of [
    ["golang@1.26.6-alpine3.24", lock.goImage, lock.goArm64Digest],
    ["node@22-bookworm-slim", lock.nodeImage, lock.nodeArm64Digest],
  ]) {
    if (
      !has(
        (uri) => typeof uri === "string" && uri.startsWith("pkg:docker/") && uri.includes(name),
        [index.split("@sha256:")[1], child.slice(7)],
      )
    )
      throw new Error("Mailpit provenance lacks exact builder material.");
  }
}

export function verifyRuntimeConfiguration(runtime, revision, lockBytes, notices) {
  const expected = {
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
  };
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(runtime.config?.[key]) !== JSON.stringify(value))
      throw new Error(`Mailpit runtime configuration differs: ${key}`);
  }
  for (const key of ["Cmd", "Volumes", "Healthcheck", "StopSignal", "OnBuild"]) {
    if (runtime.config?.[key] !== undefined && runtime.config[key] !== null)
      throw new Error(`Unexpected Mailpit runtime configuration: ${key}`);
  }
  const required = {
    "org.opencontainers.image.source": MAILPIT_IMAGE.source,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.version": MAILPIT_IMAGE.version,
    "io.cronometer.runtime.component": "mailpit",
    "io.cronometer.upstream.source.revision": MAILPIT_INPUTS.upstream.revision,
    "io.cronometer.build-inputs.sha256": sha(lockBytes),
    "io.cronometer.notices.sha256": sha(notices),
  };
  if (
    runtime.os !== "linux" ||
    runtime.architecture !== "arm64" ||
    Object.entries(required).some(([key, value]) => runtime.config?.Labels?.[key] !== value)
  )
    throw new Error("Mailpit runtime identity differs.");
}

export function verifyMailpitImage(options, run = capture, extract = extractBinaryMetadata) {
  validateOptions(options);
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  const notices = readFileSync(noticePath);
  if (sha(notices) !== lock.noticesSha256) throw new Error("Reviewed Mailpit notices differ.");
  const raw = run("docker", ["buildx", "imagetools", "inspect", options.imageRef, "--raw"]);
  const digest = options.imageRef.split("@")[1];
  if (`sha256:${sha(raw)}` !== digest) throw new Error("Mailpit index digest differs.");
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
      const bytes = inspect(`${MAILPIT_IMAGE.repository}@${hash}`);
      if (`sha256:${sha(bytes)}` !== hash) throw new Error("Attestation manifest digest differs.");
      return bytes;
    },
    () => ({ provenance, sbom }),
  );
  verifyBuildMaterials(provenance, lock);
  const runtimeRef = `${MAILPIT_IMAGE.repository}@${attestation.runtimeDigest}`;
  const runtime = JSON.parse(inspect(runtimeRef, "Image"));
  verifyRuntimeConfiguration(runtime, options.revision, lockBytes, notices);
  const runtimeRaw = inspect(runtimeRef);
  if (`sha256:${sha(runtimeRaw)}` !== attestation.runtimeDigest)
    throw new Error("Runtime manifest digest differs.");
  const binary = extract(runtimeRef, run);
  if (!/^[0-9a-f]{64}$/.test(binary.binarySha256))
    throw new Error("Missing extracted mailpit content identity.");
  const modules = verifyBinaryMetadata(binary.metadata, lock);
  if (options.mode === "verify") {
    const signatures = JSON.parse(
      run("cosign", [
        "verify",
        "--new-bundle-format=true",
        "--certificate-identity",
        `https://github.com/${MAILPIT_IMAGE.workflow}@${options.sourceRef}`,
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--output",
        "json",
        options.imageRef,
      ]),
    );
    // Cosign v3.1.3 includes other verified bundles for this subject and maps
    // their predicate types to critical.type. GitHub provenance is checked below.
    if (
      !Array.isArray(signatures) ||
      !signatures.some((item) => item?.critical?.type === "https://sigstore.dev/cosign/sign/v1") ||
      signatures.some(
        (item) =>
          !["https://sigstore.dev/cosign/sign/v1", "https://slsa.dev/provenance/v1"].includes(
            item?.critical?.type,
          ) || item?.critical?.image?.["docker-manifest-digest"] !== digest,
      )
    ) {
      throw new Error(
        "Project signature output lacks a signing predicate or has an unexpected type or digest.",
      );
    }
    run("gh", [
      "attestation",
      "verify",
      `oci://${options.imageRef}`,
      "--repo",
      "liangzixuan/cronometer-gold",
      "--signer-workflow",
      MAILPIT_IMAGE.workflow,
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
      throw new Error("Mailpit verification requires native Linux ARM64.");
    const args = process.argv.slice(2);
    const result =
      args[0] === "scan" && args.length === 2
        ? verifyScanCoverage(JSON.parse(readFileSync(args[1], "utf8")))
        : verifyMailpitImage(parseArguments(args));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Mailpit verification failed."}\n`,
    );
    process.exitCode = 1;
  }
}
