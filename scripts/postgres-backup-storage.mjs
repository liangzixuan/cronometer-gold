import { isAbsolute, resolve } from "node:path";
import {
  AzureBlobRawArtifactStore,
  FileRawArtifactStore,
  MAX_ARTIFACT_ENVELOPE_OVERHEAD_BYTES,
  validateAzureBlobCredential,
} from "../packages/artifact-store/dist/index.js";

const fail = () => new Error("PostgreSQL backup storage configuration failed");
export function postgresBackupStorage(value, operation, maxDumpBytes) {
  if (
    !["backup", "restore"].includes(operation) ||
    !Number.isSafeInteger(maxDumpBytes) ||
    maxDumpBytes < 5 ||
    maxDumpBytes > 2_147_483_648 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw fail();
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "file") {
    if (
      keys !== "directory,kind" ||
      typeof value.directory !== "string" ||
      !isAbsolute(value.directory) ||
      resolve(value.directory) !== value.directory
    )
      throw fail();
    return Object.freeze({ kind: "file", directory: value.directory });
  }
  if (
    value.kind !== "azure-blob" ||
    keys !== "containerUrl,kind,prefix,requestTimeoutMs,sasToken" ||
    !Number.isSafeInteger(value.requestTimeoutMs) ||
    value.requestTimeoutMs < 100 ||
    value.requestTimeoutMs > 300_000
  )
    throw fail();
  const options = {
    containerUrl: value.containerUrl,
    prefix: value.prefix,
    sasToken: value.sasToken,
    requestTimeoutMs: value.requestTimeoutMs,
    role: operation === "backup" ? "backup-writer" : "restore-reader",
    maximumObjectBytes:
      maxDumpBytes + 12 + 16_384 + 1_048_576 + MAX_ARTIFACT_ENVELOPE_OVERHEAD_BYTES,
  };
  try {
    validateAzureBlobCredential(options);
  } catch {
    throw fail();
  }
  return Object.freeze({ kind: "azure-blob", options: Object.freeze(options) });
}

export function createPostgresBackupRawStore(storage) {
  return storage.kind === "file"
    ? new FileRawArtifactStore(storage.directory)
    : new AzureBlobRawArtifactStore(storage.options);
}
