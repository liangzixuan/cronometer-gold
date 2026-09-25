import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const OBJECT_STORE_IMAGE = {
  repository: "ghcr.io/chrislusf/seaweedfs",
  version: "4.47",
  digest: "sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882",
  arm64Digest: "sha256:d4cf67729aa8777e1a43a5b61d72e5b96179e4b7bac9a221cb14cbc2036cb32e",
  sourceRevision: "c5073360007d28385a33426a42ac3e4ec504c5a3",
  certificateIdentity:
    "https://github.com/seaweedfs/seaweedfs/.github/workflows/container_release_unified.yml@refs/tags/4.47",
  certificateOidcIssuer: "https://token.actions.githubusercontent.com",
};
export const OBJECT_STORE_REF = `${OBJECT_STORE_IMAGE.repository}:${OBJECT_STORE_IMAGE.version}@${OBJECT_STORE_IMAGE.digest}`;

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed during object-store provenance verification.`, {
      cause: result.error ?? new Error(result.stderr),
    });
  }
  return result.stdout;
}

export function verifyObjectStoreImage(run = capture) {
  const image = OBJECT_STORE_IMAGE;
  const raw = run("docker", ["buildx", "imagetools", "inspect", OBJECT_STORE_REF, "--raw"]);
  if (`sha256:${createHash("sha256").update(raw).digest("hex")}` !== image.digest) {
    throw new Error("Object-store index bytes differ from the approved digest.");
  }
  const index = JSON.parse(raw);
  const arm64 = index.manifests?.filter(
    (entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "arm64",
  );
  if (index.schemaVersion !== 2 || arm64?.length !== 1 || arm64[0].digest !== image.arm64Digest) {
    throw new Error("Object-store index must select the approved ARM64 platform digest.");
  }
  const runtime = JSON.parse(
    run("docker", [
      "buildx",
      "imagetools",
      "inspect",
      `${image.repository}@${image.arm64Digest}`,
      "--format",
      "{{json .Image}}",
    ]),
  );
  const labels = runtime.config?.Labels;
  if (
    runtime.os !== "linux" ||
    runtime.architecture !== "arm64" ||
    labels?.["org.opencontainers.image.source"] !== "https://github.com/seaweedfs/seaweedfs" ||
    labels?.["org.opencontainers.image.version"] !== image.version ||
    labels?.["org.opencontainers.image.revision"] !== image.sourceRevision
  ) {
    throw new Error("Object-store runtime source identity differs from the reviewed release.");
  }

  const signatures = [];
  for (const digest of [image.digest, image.arm64Digest]) {
    const records = JSON.parse(
      run("cosign", [
        "verify",
        "--certificate-identity",
        image.certificateIdentity,
        "--certificate-oidc-issuer",
        image.certificateOidcIssuer,
        "--output",
        "json",
        `${image.repository}@${digest}`,
      ]),
    );
    if (
      !Array.isArray(records) ||
      records.length === 0 ||
      records.some(
        (record) =>
          record.critical?.type !== "cosign container image signature" ||
          record.critical?.image?.["docker-manifest-digest"] !== digest,
      )
    ) {
      throw new Error("Object-store signature output is empty or names another digest.");
    }
    signatures.push({ digest, records });
  }
  return { image, ref: OBJECT_STORE_REF, runtime, signatures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error("This verifier takes no arguments.");
    if (process.platform !== "linux" || process.arch !== "arm64") {
      throw new Error("Object-store CI verification requires native Linux ARM64.");
    }
    process.stdout.write(`${JSON.stringify(verifyObjectStoreImage(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Verification failed."}\n`);
    process.exitCode = 1;
  }
}
