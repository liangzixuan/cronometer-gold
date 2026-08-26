import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_EMPTY_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";
const IN_TOTO_MEDIA_TYPE = "application/vnd.in-toto+json";
const DOCKER_ATTESTATION_ARTIFACT_TYPE = "application/vnd.docker.attestation.manifest.v1+json";
const SPDX_PREDICATE = "https://spdx.dev/Document";
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const BUILDKIT_SLSA_BUILD_TYPE =
  "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REFERENCE_PATTERN =
  /^([a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?)@(sha256:[0-9a-f]{64})$/;
const MAX_JSON_BYTES = 32 * 1024 * 1024;

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const keys = Object.keys(assertPlainObject(value, label)).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain only: ${expected.join(", ")}.`);
  }
}

function assertSafeString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new TypeError(`${label} must be a nonempty string without control characters.`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function parseJson(value, label) {
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) return value;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  if (bytes.length < 2 || bytes.length > MAX_JSON_BYTES) {
    throw new TypeError(`${label} has an invalid encoded size.`);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new TypeError(`${label} must be valid UTF-8 JSON.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} must contain valid JSON.`);
  }
}

function assertManifestDescriptor(descriptor, label) {
  assertPlainObject(descriptor, label);
  if (descriptor.mediaType !== OCI_MANIFEST_MEDIA_TYPE) {
    throw new TypeError(`${label} must use the OCI image-manifest media type.`);
  }
  assertDigest(descriptor.digest, `${label} digest`);
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) {
    throw new TypeError(`${label} size must be a positive integer.`);
  }
  assertPlainObject(descriptor.platform, `${label} platform`);
}

function assertPayloadSemantics(payloadInput) {
  const payloads = assertPlainObject(payloadInput, "BuildKit predicate payloads");
  assertExactKeys(payloads, ["sbom", "provenance"], "BuildKit predicate payloads");

  const sbomEnvelope = assertPlainObject(
    parseJson(payloads.sbom, "BuildKit SBOM payload"),
    "BuildKit SBOM payload",
  );
  assertExactKeys(sbomEnvelope, ["SPDX"], "BuildKit SBOM payload");
  const spdx = assertPlainObject(sbomEnvelope.SPDX, "BuildKit SPDX predicate");
  if (
    spdx.SPDXID !== "SPDXRef-DOCUMENT" ||
    spdx.spdxVersion !== "SPDX-2.3" ||
    spdx.dataLicense !== "CC0-1.0" ||
    !Array.isArray(spdx.packages) ||
    spdx.packages.length === 0 ||
    !Array.isArray(spdx.relationships)
  ) {
    throw new TypeError("BuildKit SPDX predicate must contain a nonempty SPDX 2.3 document.");
  }
  assertSafeString(spdx.documentNamespace, "BuildKit SPDX documentNamespace");
  const creationInfo = assertPlainObject(spdx.creationInfo, "BuildKit SPDX creationInfo");
  if (!Array.isArray(creationInfo.creators) || creationInfo.creators.length === 0) {
    throw new TypeError("BuildKit SPDX creationInfo must identify at least one creator.");
  }
  creationInfo.creators.forEach((creator, index) => {
    assertSafeString(creator, `BuildKit SPDX creator ${index}`);
  });

  const provenanceEnvelope = assertPlainObject(
    parseJson(payloads.provenance, "BuildKit provenance payload"),
    "BuildKit provenance payload",
  );
  assertExactKeys(provenanceEnvelope, ["SLSA"], "BuildKit provenance payload");
  const slsa = assertPlainObject(provenanceEnvelope.SLSA, "BuildKit SLSA v1 predicate");
  const buildDefinition = assertPlainObject(
    slsa.buildDefinition,
    "BuildKit SLSA v1 buildDefinition",
  );
  const runDetails = assertPlainObject(slsa.runDetails, "BuildKit SLSA v1 runDetails");
  if (
    buildDefinition.buildType !== BUILDKIT_SLSA_BUILD_TYPE ||
    !Array.isArray(buildDefinition.resolvedDependencies) ||
    buildDefinition.resolvedDependencies.length === 0
  ) {
    throw new TypeError("BuildKit provenance must contain a nonempty SLSA v1 build definition.");
  }
  assertPlainObject(buildDefinition.externalParameters, "BuildKit SLSA v1 externalParameters");
  assertPlainObject(buildDefinition.internalParameters, "BuildKit SLSA v1 internalParameters");
  const builder = assertPlainObject(runDetails.builder, "BuildKit SLSA v1 builder");
  assertSafeString(builder.id, "BuildKit SLSA v1 builder id");
  const metadata = assertPlainObject(runDetails.metadata, "BuildKit SLSA v1 metadata");
  assertSafeString(metadata.invocationId, "BuildKit SLSA v1 invocation id");
  assertSafeString(metadata.startedOn, "BuildKit SLSA v1 start time");
  assertSafeString(metadata.finishedOn, "BuildKit SLSA v1 finish time");
}

function assertAttestationManifest(manifestInput, runtime, loadPayloads) {
  const manifest = assertPlainObject(
    parseJson(manifestInput, "BuildKit attestation manifest"),
    "BuildKit attestation manifest",
  );
  assertExactKeys(
    manifest,
    ["schemaVersion", "mediaType", "artifactType", "config", "layers", "subject"],
    "BuildKit attestation manifest",
  );
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
    manifest.artifactType !== DOCKER_ATTESTATION_ARTIFACT_TYPE
  ) {
    throw new TypeError("BuildKit attestation manifest must be an exact OCI attestation artifact.");
  }

  const config = assertPlainObject(manifest.config, "BuildKit attestation config");
  assertExactKeys(config, ["mediaType", "digest", "size", "data"], "BuildKit attestation config");
  if (
    config.mediaType !== OCI_EMPTY_MEDIA_TYPE ||
    config.digest !== "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" ||
    config.size !== 2 ||
    (config.data !== undefined && config.data !== "e30=")
  ) {
    throw new TypeError("BuildKit attestation manifest must use the canonical empty OCI config.");
  }
  const subject = assertPlainObject(manifest.subject, "BuildKit attestation subject");
  assertExactKeys(subject, ["mediaType", "digest", "size"], "BuildKit attestation subject");
  if (
    subject.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
    subject.digest !== runtime.digest ||
    subject.size !== runtime.size
  ) {
    throw new TypeError("BuildKit attestation subject must be the exact ARM64 runtime descriptor.");
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length !== 2) {
    throw new TypeError("BuildKit attestation manifest must contain exactly two predicate layers.");
  }

  const predicateCounts = new Map([
    [SPDX_PREDICATE, 0],
    [SLSA_PREDICATE, 0],
  ]);
  const layerDigests = new Set();
  for (const [index, layer] of manifest.layers.entries()) {
    assertPlainObject(layer, `BuildKit predicate layer ${index}`);
    assertExactKeys(
      layer,
      ["mediaType", "digest", "size", "annotations"],
      `BuildKit predicate layer ${index}`,
    );
    if (layer.mediaType !== IN_TOTO_MEDIA_TYPE) {
      throw new TypeError(`BuildKit predicate layer ${index} must use the in-toto media type.`);
    }
    const digest = assertDigest(layer.digest, `BuildKit predicate layer ${index} digest`);
    if (layerDigests.has(digest)) {
      throw new TypeError("BuildKit predicate-layer digests must be distinct.");
    }
    layerDigests.add(digest);
    if (!Number.isSafeInteger(layer.size) || layer.size <= 0) {
      throw new TypeError(`BuildKit predicate layer ${index} size must be a positive integer.`);
    }
    const annotations = assertPlainObject(
      layer.annotations,
      `BuildKit predicate layer ${index} annotations`,
    );
    assertExactKeys(
      annotations,
      ["in-toto.io/predicate-type"],
      `BuildKit predicate layer ${index} annotations`,
    );
    const predicate = annotations["in-toto.io/predicate-type"];
    if (!predicateCounts.has(predicate)) {
      throw new TypeError(`BuildKit predicate layer ${index} has an unreviewed predicate type.`);
    }
    predicateCounts.set(predicate, predicateCounts.get(predicate) + 1);
  }
  for (const [predicate, count] of predicateCounts) {
    if (count !== 1) {
      throw new TypeError(
        `BuildKit attestation requires exactly one ${predicate} predicate layer.`,
      );
    }
  }

  assertPayloadSemantics(loadPayloads(runtime.digest));

  return {
    predicateDigests: Object.fromEntries(
      manifest.layers.map((layer) => [
        layer.annotations["in-toto.io/predicate-type"],
        layer.digest,
      ]),
    ),
    runtimeDigest: runtime.digest,
  };
}

export function verifyOciBuildkitAttestations(indexInput, loadManifest, loadPayloads) {
  if (typeof loadManifest !== "function") {
    throw new TypeError("An exact attestation-manifest loader is required.");
  }
  if (typeof loadPayloads !== "function") {
    throw new TypeError("An exact BuildKit predicate-payload loader is required.");
  }
  const index = assertPlainObject(parseJson(indexInput, "OCI image index"), "OCI image index");
  if (index.schemaVersion !== 2 || index.mediaType !== OCI_INDEX_MEDIA_TYPE) {
    throw new TypeError("Candidate image must be an OCI image index.");
  }
  if (!Array.isArray(index.manifests) || index.manifests.length !== 2) {
    throw new TypeError(
      "Candidate image index must contain exactly one ARM64 runtime and one attestation manifest.",
    );
  }

  const runtimeDescriptors = index.manifests.filter(
    (descriptor) =>
      descriptor?.platform?.os === "linux" && descriptor?.platform?.architecture === "arm64",
  );
  const attestationDescriptors = index.manifests.filter(
    (descriptor) =>
      descriptor?.platform?.os === "unknown" && descriptor?.platform?.architecture === "unknown",
  );
  if (runtimeDescriptors.length !== 1 || attestationDescriptors.length !== 1) {
    throw new TypeError(
      "Candidate image index must identify one linux/arm64 runtime and one unknown-platform attestation.",
    );
  }

  const runtime = runtimeDescriptors[0];
  const attestation = attestationDescriptors[0];
  assertManifestDescriptor(runtime, "ARM64 runtime descriptor");
  assertManifestDescriptor(attestation, "BuildKit attestation descriptor");
  if (runtime.platform.variant !== undefined && runtime.platform.variant !== "v8") {
    throw new TypeError("ARM64 runtime variant must be absent or v8.");
  }
  const annotations = assertPlainObject(
    attestation.annotations,
    "BuildKit attestation descriptor annotations",
  );
  if (
    annotations["vnd.docker.reference.type"] !== "attestation-manifest" ||
    annotations["vnd.docker.reference.digest"] !== runtime.digest
  ) {
    throw new TypeError(
      "BuildKit attestation descriptor must refer to the exact ARM64 runtime digest.",
    );
  }

  const result = assertAttestationManifest(loadManifest(attestation.digest), runtime, loadPayloads);
  return {
    ...result,
    attestationDigest: attestation.digest,
  };
}

function parseArguments(arguments_) {
  let indexPath;
  let imageReference;
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new TypeError(`Missing value for ${flag}.`);
    if (flag === "--index" && indexPath === undefined) indexPath = value;
    else if (flag === "--image-ref" && imageReference === undefined) imageReference = value;
    else throw new TypeError(`Unsupported or duplicate argument: ${flag}.`);
  }
  if (indexPath === undefined || imageReference === undefined) {
    throw new TypeError(
      "Usage: node scripts/verify-oci-buildkit-attestations.mjs --index <file> --image-ref <repository@digest>",
    );
  }
  const match = IMAGE_REFERENCE_PATTERN.exec(imageReference);
  if (match === null) {
    throw new TypeError(
      "Candidate image reference must be a lowercase digest-qualified repository.",
    );
  }
  return { imageDigest: match[2], indexPath, repository: match[1] };
}

function inspectManifest(reference) {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", reference, "--raw"], {
    encoding: null,
    maxBuffer: MAX_JSON_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    throw new TypeError(
      `Could not load exact BuildKit attestation manifest${stderr ? `: ${stderr}` : "."}`,
    );
  }
  return result.stdout;
}

function inspectPredicatePayload(reference, field) {
  const result = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", reference, "--format", `{{json .${field}}}`],
    { encoding: null, maxBuffer: MAX_JSON_BYTES },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    throw new TypeError(
      `Could not load exact BuildKit ${field} payload${stderr ? `: ${stderr}` : "."}`,
    );
  }
  return result.stdout;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const { imageDigest, indexPath, repository } = parseArguments(process.argv.slice(2));
    const indexBytes = readFileSync(indexPath);
    const imageReference = `${repository}@${imageDigest}`;
    const resolvedIndexBytes = inspectManifest(imageReference);
    if (!indexBytes.equals(resolvedIndexBytes)) {
      throw new TypeError(
        "Candidate index file must exactly match the digest-qualified image reference.",
      );
    }
    const result = verifyOciBuildkitAttestations(
      indexBytes,
      (digest) => inspectManifest(`${repository}@${digest}`),
      () => ({
        provenance: inspectPredicatePayload(imageReference, "Provenance"),
        sbom: inspectPredicatePayload(imageReference, "SBOM"),
      }),
    );
    if (result.runtimeDigest === imageDigest) {
      throw new TypeError(
        "Candidate index digest must not be confused with its ARM64 child digest.",
      );
    }
    process.stdout.write(`${result.runtimeDigest}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "BuildKit attestation verification failed."}\n`,
    );
    process.exitCode = 1;
  }
}
