import { chmod, lstat, mkdir } from "node:fs/promises";

import {
  ArtifactReadBulkhead,
  cleanupOrphanedAuthenticatedArtifactSpools,
  EncryptedArtifactStore,
  FileRawArtifactStore,
  S3RawArtifactStore,
} from "@nutrition-tracker/artifact-store";

import type { ApiRetentionDependencyConfig } from "./config.js";

export interface ApiRetentionArtifactRuntime {
  readonly bulkhead: ArtifactReadBulkhead;
  readonly store: EncryptedArtifactStore;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new TypeError(`Missing retention artifact setting: ${field}`);
  return value;
}

/**
 * Prepares the operator-declared protected plaintext mount and removes only old,
 * owned, exact-prefix crash spools before accepting download traffic.
 */
export async function createApiRetentionArtifactRuntime(
  config: ApiRetentionDependencyConfig,
): Promise<ApiRetentionArtifactRuntime> {
  await mkdir(config.artifactReadSpoolDirectory, { mode: 0o700, recursive: true });
  const spool = await lstat(config.artifactReadSpoolDirectory);
  if (!spool.isDirectory() || spool.isSymbolicLink() || (spool.mode & 0o077) !== 0) {
    throw new TypeError("Authenticated artifact spool directory is not private");
  }
  await chmod(config.artifactReadSpoolDirectory, 0o700);
  await cleanupOrphanedAuthenticatedArtifactSpools({
    directory: config.artifactReadSpoolDirectory,
    olderThanMs: config.artifactReadSpoolMaximumAgeMs,
  });

  const rawStore =
    config.artifactStore === "filesystem"
      ? new FileRawArtifactStore(config.artifactDirectory)
      : new S3RawArtifactStore({
          accessKeyId: required(
            config.artifactReadAccessKeyId,
            "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
          ),
          bucket: required(config.artifactBucket, "EXPORT_ARTIFACT_BUCKET"),
          endpoint: required(config.artifactEndpoint, "EXPORT_ARTIFACT_ENDPOINT"),
          region: required(config.artifactRegion, "EXPORT_ARTIFACT_REGION"),
          requestTimeoutMs: config.artifactRequestTimeoutMs,
          secretAccessKey: required(
            config.artifactReadSecretAccessKey,
            "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
          ),
          ...(config.artifactReadSessionToken
            ? { sessionToken: config.artifactReadSessionToken }
            : {}),
        });
  const store = new EncryptedArtifactStore({
    keyRing: config.artifactEncryptionKeyRing,
    maxPlaintextBytes: config.artifactReadMaximumArtifactBytes,
    rawStore,
    temporaryDirectory: config.artifactReadSpoolDirectory,
  });
  return {
    bulkhead: new ArtifactReadBulkhead({
      maximumArtifactBytes: config.artifactReadMaximumArtifactBytes,
      maximumBytesPerOwnerPerWindow: config.artifactReadMaximumBytesPerWindow,
      maximumConcurrentReads: config.artifactReadMaximumConcurrency,
      maximumOpensPerOwnerPerWindow: config.artifactReadMaximumDownloadsPerWindow,
      maximumReservedPlaintextBytes: config.artifactReadMaximumReservedBytes,
      rateWindowMs: config.artifactReadRateWindowMs,
    }),
    store,
  };
}
