import { MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES } from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";

import { parseWorkerConfig, WorkerConfigValidationError } from "./config.js";

describe("worker configuration", () => {
  it("uses bounded local defaults", () => {
    expect(parseWorkerConfig({})).toMatchObject({
      POLL_INTERVAL_MS: 1_000,
      EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS: 30_000,
      RETENTION_EXPORT_SPOOL_MAX_BYTES: 10_737_418_240,
      EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "suspended_null",
      RETENTION_FEATURES_ENABLED: false,
      RETENTION_WORKER_ID: "local-retention-worker",
      SEARCH_REBUILD_BATCH_SIZE: 500,
      SEARCH_REBUILD_EVENT_BATCH_SIZE: 100,
      SEARCH_REBUILD_SPOOL_MAX_BYTES: 2_147_483_648,
      SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS: 5_000_000,
      SEARCH_REBUILD_WORKER_ID: "local-food-search-worker",
      SEARCH_REQUEST_TIMEOUT_MS: 5_000,
      SEARCH_TASK_TIMEOUT_MS: 120_000,
      SHUTDOWN_GRACE_MS: 10_000,
    });
  });

  it("validates the shutdown grace period", () => {
    expect(() => parseWorkerConfig({ SHUTDOWN_GRACE_MS: "99" })).toThrow(
      WorkerConfigValidationError,
    );
    expect(parseWorkerConfig({ SHUTDOWN_GRACE_MS: "25000" }).SHUTDOWN_GRACE_MS).toBe(25_000);
  });

  it("shares the exact DB snapshot ceiling and rejects one byte above it", () => {
    expect(
      parseWorkerConfig({
        RETENTION_EXPORT_SPOOL_MAX_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
      }).RETENTION_EXPORT_SPOOL_MAX_BYTES,
    ).toBe(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES);
    expect(() =>
      parseWorkerConfig({
        RETENTION_EXPORT_SPOOL_MAX_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES + 1),
      }),
    ).toThrow(WorkerConfigValidationError);
  });

  it("fails closed on missing production database, search, encrypted object store, and restore-ledger secrets", () => {
    try {
      parseWorkerConfig({ NODE_ENV: "production" });
      throw new Error("expected production worker configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigValidationError);
      expect((error as WorkerConfigValidationError).issues.map((issue) => issue.field)).toEqual([
        "EXPORT_ARTIFACT_CURRENT_KEY_ID",
        "ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID",
        "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
        "DATABASE_RESTORE_EPOCH",
        "RETENTION_FEATURES_ENABLED",
        "DATABASE_URL",
        "MEILI_ADMIN_KEY",
        "MEILI_URL",
        "EXPORT_ARTIFACT_STORE",
        "ERASURE_REPLAY_LEDGER_STORE",
        "RETENTION_EXPORT_SPOOL_DIR",
        "RETENTION_EXPORT_SPOOL_PROTECTION",
        "EXPORT_ARTIFACT_ENDPOINT",
        "EXPORT_ARTIFACT_DELETE_VERSION_POLICY",
        "ERASURE_REPLAY_LEDGER_ENDPOINT",
        "EXPORT_ARTIFACT_BUCKET",
        "EXPORT_ARTIFACT_REGION",
        "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
        "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
        "ERASURE_REPLAY_LEDGER_BUCKET",
        "ERASURE_REPLAY_LEDGER_REGION",
        "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
        "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
      ]);
    }
  });

  it("accepts an explicit TLS S3 store, versioned AES key ring, and distinct replay-ledger HMAC key", () => {
    const exportKey = Buffer.alloc(32, 1).toString("base64");
    const environment = {
      DATABASE_URL: "postgresql://service:secret@postgres.internal/nutrition",
      DATABASE_RESTORE_EPOCH: "production-restore-epoch-2026-08-16-v1",
      ERASURE_REPLAY_LEDGER_BUCKET: "nutrition-erasure-ledger",
      ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "ledger-key-v1",
      ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
        "ledger-key-v1": Buffer.alloc(32, 3).toString("base64"),
      }),
      ERASURE_REPLAY_LEDGER_ENDPOINT: "https://ledger-objects.internal.example",
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-key-v1",
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
        "locator-key-v1": Buffer.alloc(32, 2).toString("base64"),
      }),
      ERASURE_REPLAY_LEDGER_REGION: "us-east-1",
      ERASURE_REPLAY_LEDGER_STORE: "s3",
      ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: "ledger-writer",
      ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: "ledger-writer-secret",
      EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
      EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-key-v1",
      EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "latest",
      EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({ "export-key-v1": exportKey }),
      EXPORT_ARTIFACT_ENDPOINT: "https://objects.internal.example",
      EXPORT_ARTIFACT_REGION: "us-east-1",
      EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: "worker-access-key",
      EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: "worker-secret-key",
      EXPORT_ARTIFACT_STORE: "s3",
      MEILI_ADMIN_KEY: "search-admin-key-long-enough",
      MEILI_URL: "https://search.internal.example",
      NODE_ENV: "production",
      RETENTION_EXPORT_SPOOL_DIR: "/var/run/nutrition-tracker/export-spool",
      RETENTION_EXPORT_SPOOL_PROTECTION: "encrypted_volume",
      RETENTION_FEATURES_ENABLED: "true",
    };
    expect(parseWorkerConfig(environment)).toMatchObject({
      EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "latest",
      EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-key-v1",
      EXPORT_ARTIFACT_STORE: "s3",
      RETENTION_FEATURES_ENABLED: true,
    });

    const ociEndpoint = "https://namespace.compat.objectstorage.us-ashburn-1.oci.customer-oci.com";
    expect(() =>
      parseWorkerConfig({
        ...environment,
        EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "suspended_null",
        EXPORT_ARTIFACT_ENDPOINT: ociEndpoint,
      }),
    ).toThrow(WorkerConfigValidationError);
    expect(
      parseWorkerConfig({ ...environment, EXPORT_ARTIFACT_ENDPOINT: ociEndpoint })
        .EXPORT_ARTIFACT_DELETE_VERSION_POLICY,
    ).toBe("latest");
  });
});
