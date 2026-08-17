import { chmod, lstat, mkdir } from "node:fs/promises";

import {
  cleanupOrphanedAuthenticatedArtifactSpools,
  cleanupOrphanedPrivateSpools,
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  FileRawArtifactStore,
  parseArtifactEncryptionKeyRing,
  parseErasureLedgerLocatorKeyRing,
  S3RawArtifactStore,
} from "@nutrition-tracker/artifact-store";

import type { WorkerConfig } from "./config.js";

export interface RetentionStorageRuntime {
  readonly erasureLedger: EncryptedErasureReplayLedger;
  readonly exportArtifactStore: EncryptedArtifactStore;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new TypeError(`Missing retention storage setting: ${field}`);
  return value;
}

function rawStore(
  config: WorkerConfig,
  purpose: "export" | "erasure",
): FileRawArtifactStore | S3RawArtifactStore {
  if (purpose === "export") {
    return config.EXPORT_ARTIFACT_STORE === "filesystem"
      ? new FileRawArtifactStore(config.EXPORT_ARTIFACT_DIRECTORY)
      : new S3RawArtifactStore({
          accessKeyId: required(
            config.EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID,
            "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
          ),
          bucket: required(config.EXPORT_ARTIFACT_BUCKET, "EXPORT_ARTIFACT_BUCKET"),
          deleteVersionPolicy: "suspended_null",
          endpoint: required(config.EXPORT_ARTIFACT_ENDPOINT, "EXPORT_ARTIFACT_ENDPOINT"),
          region: required(config.EXPORT_ARTIFACT_REGION, "EXPORT_ARTIFACT_REGION"),
          requestTimeoutMs: config.EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS,
          secretAccessKey: required(
            config.EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY,
            "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
          ),
          ...(config.EXPORT_ARTIFACT_WRITE_SESSION_TOKEN
            ? { sessionToken: config.EXPORT_ARTIFACT_WRITE_SESSION_TOKEN }
            : {}),
        });
  }
  return config.ERASURE_REPLAY_LEDGER_STORE === "filesystem"
    ? new FileRawArtifactStore(config.ERASURE_REPLAY_LEDGER_DIRECTORY)
    : new S3RawArtifactStore({
        accessKeyId: required(
          config.ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID,
          "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
        ),
        bucket: required(config.ERASURE_REPLAY_LEDGER_BUCKET, "ERASURE_REPLAY_LEDGER_BUCKET"),
        endpoint: required(config.ERASURE_REPLAY_LEDGER_ENDPOINT, "ERASURE_REPLAY_LEDGER_ENDPOINT"),
        region: required(config.ERASURE_REPLAY_LEDGER_REGION, "ERASURE_REPLAY_LEDGER_REGION"),
        requestTimeoutMs: config.EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS,
        secretAccessKey: required(
          config.ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY,
          "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
        ),
        ...(config.ERASURE_REPLAY_LEDGER_WRITE_SESSION_TOKEN
          ? { sessionToken: config.ERASURE_REPLAY_LEDGER_WRITE_SESSION_TOKEN }
          : {}),
      });
}

export async function createRetentionStorageRuntime(
  config: WorkerConfig,
): Promise<RetentionStorageRuntime> {
  await mkdir(config.RETENTION_EXPORT_SPOOL_DIR, { mode: 0o700, recursive: true });
  const details = await lstat(config.RETENTION_EXPORT_SPOOL_DIR);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
    throw new TypeError("Retention export spool directory is not private");
  }
  await chmod(config.RETENTION_EXPORT_SPOOL_DIR, 0o700);
  await cleanupOrphanedPrivateSpools({
    directory: config.RETENTION_EXPORT_SPOOL_DIR,
    olderThanMs: config.RETENTION_EXPORT_SPOOL_MAX_AGE_MS,
    prefix: "nutrition-account-export-",
  });
  // Both export retry verification and ledger append verification authenticate
  // into this protected directory before exposing plaintext. A process crash can
  // therefore leave either prefix behind; startup must scavenge both with the
  // same ownership, symlink, age and mount-policy boundary.
  await cleanupOrphanedAuthenticatedArtifactSpools({
    directory: config.RETENTION_EXPORT_SPOOL_DIR,
    olderThanMs: config.RETENTION_EXPORT_SPOOL_MAX_AGE_MS,
  });

  const exportArtifactStore = new EncryptedArtifactStore({
    keyRing: parseArtifactEncryptionKeyRing({
      currentKeyId: config.EXPORT_ARTIFACT_CURRENT_KEY_ID,
      purpose: "export",
      serializedKeys: config.EXPORT_ARTIFACT_ENCRYPTION_KEYS,
    }),
    maxPlaintextBytes: config.RETENTION_EXPORT_SPOOL_MAX_BYTES,
    rawStore: rawStore(config, "export"),
    temporaryDirectory: config.RETENTION_EXPORT_SPOOL_DIR,
  });
  const ledgerArtifactStore = new EncryptedArtifactStore({
    keyRing: parseArtifactEncryptionKeyRing({
      currentKeyId: config.ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID,
      purpose: "erasure_replay_ledger",
      serializedKeys: config.ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS,
    }),
    maxPlaintextBytes: 16_384,
    rawStore: rawStore(config, "erasure"),
    temporaryDirectory: config.RETENTION_EXPORT_SPOOL_DIR,
  });
  return {
    erasureLedger: new EncryptedErasureReplayLedger({
      artifactStore: ledgerArtifactStore,
      locatorKeyRing: parseErasureLedgerLocatorKeyRing({
        currentKeyId: config.ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID,
        serializedKeys: config.ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS,
      }),
    }),
    exportArtifactStore,
  };
}
