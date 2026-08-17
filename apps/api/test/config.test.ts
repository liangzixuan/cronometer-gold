import { MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES } from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadApiDependencyConfig, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies safe local defaults", () => {
    expect(loadConfig({})).toEqual({
      apiHost: "127.0.0.1",
      apiPort: 3_001,
      logLevel: "info",
      nodeEnv: "development",
      readinessTimeoutMs: 2_000,
      shutdownGraceMs: 10_000,
    });
  });

  it("coerces validated numeric environment values", () => {
    expect(
      loadConfig({
        API_PORT: "4100",
        READINESS_TIMEOUT_MS: "1500",
        SHUTDOWN_GRACE_MS: "25000",
      }),
    ).toMatchObject({
      apiPort: 4_100,
      readinessTimeoutMs: 1_500,
      shutdownGraceMs: 25_000,
    });
  });

  it("fails fast without including invalid values in the error message", () => {
    const invalidPort = "not-a-port-that-must-not-leak";

    expect(() => loadConfig({ API_PORT: invalidPort })).toThrow(ConfigValidationError);

    try {
      loadConfig({ API_PORT: invalidPort });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual([
        expect.objectContaining({ field: "API_PORT" }),
      ]);
      expect((error as Error).message).not.toContain(invalidPort);
    }
  });
});

describe("loadApiDependencyConfig", () => {
  it("uses loopback search defaults only outside production", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "development",
      }),
    ).toMatchObject({
      databaseRestoreEpoch: null,
      databaseUrl: "postgresql://local.invalid/nutrition",
      meiliUrl: "http://127.0.0.1:7700",
      searchDatabaseMaxConcurrency: 4,
      searchDatabaseMaxQueue: 16,
      searchRequestTimeoutMs: 5_000,
    });
  });

  it("bounds the process-local search database bulkhead configuration", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "development",
        SEARCH_DB_MAX_CONCURRENCY: "2",
        SEARCH_DB_MAX_QUEUE: "3",
      }),
    ).toMatchObject({ searchDatabaseMaxConcurrency: 2, searchDatabaseMaxQueue: 3 });

    expect(() =>
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        SEARCH_DB_MAX_CONCURRENCY: "0",
      }),
    ).toThrow(ConfigValidationError);
  });

  it("requires a scoped key, cursor secret, and verified database/search TLS in production", () => {
    try {
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://production.invalid/nutrition",
        MEILI_URL: "http://search.internal:7700",
        NODE_ENV: "production",
      });
      throw new Error("expected production dependency configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues.map((issue) => issue.field)).toEqual([
        "SEARCH_CURSOR_SECRET",
        "DATABASE_RESTORE_EPOCH",
        "DATABASE_SSL_MODE",
        "MEILI_SEARCH_KEY",
        "MEILI_URL",
        "RETENTION_FEATURES_ENABLED",
      ]);
    }

    expect(
      loadApiDependencyConfig({
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_RESTORE_EPOCH: "production-restore-epoch-2026-08-16-v1",
        DATABASE_URL: "postgresql://production.invalid/nutrition",
        DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
        MEILI_SEARCH_KEY: "scoped-production-search-key",
        MEILI_URL: "https://search.internal",
        NODE_ENV: "production",
        RETENTION_FEATURES_ENABLED: "true",
        SEARCH_CURSOR_SECRET: "production-cursor-secret-at-least-32-bytes",
        EXPORT_ARTIFACT_STORE: "s3",
        EXPORT_ARTIFACT_ENDPOINT: "https://objects.internal.example",
        EXPORT_ARTIFACT_REGION: "us-east-1",
        EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
        EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
        EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
          "export-v1": Buffer.alloc(32, 1).toString("base64"),
        }),
        EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "export-reader",
        EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "export-reader-secret",
        EXPORT_ARTIFACT_READ_SPOOL_DIR: "/var/run/nutrition-tracker/export-read-spool",
        EXPORT_ARTIFACT_READ_SPOOL_PROTECTION: "encrypted_volume",
        ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
        ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
          "locator-v1": Buffer.alloc(32, 2).toString("base64"),
        }),
        ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
      }),
    ).toMatchObject({
      databaseUrl: "postgresql://production.invalid/nutrition",
      databaseRestoreEpoch: "production-restore-epoch-2026-08-16-v1",
      requireDatabaseRestoreAttestation: true,
      retention: {
        artifactStore: "s3",
        artifactReadMaximumConcurrency: 2,
      },
    });
  });

  it("bounds authenticated download spools and rejects root or overcommitted paths", () => {
    const base = {
      DATABASE_URL: "postgresql://local.invalid/nutrition",
      DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
      RETENTION_FEATURES_ENABLED: "true",
      EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
      EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
        "export-v1": Buffer.alloc(32, 1).toString("base64"),
      }),
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
        "locator-v1": Buffer.alloc(32, 2).toString("base64"),
      }),
      ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    };
    expect(() => loadApiDependencyConfig({ ...base, EXPORT_ARTIFACT_READ_SPOOL_DIR: "/" })).toThrow(
      ConfigValidationError,
    );
    expect(() =>
      loadApiDependencyConfig({
        ...base,
        EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES + 1),
      }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      loadApiDependencyConfig({
        ...base,
        EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: "104857600",
      }),
    ).toThrow(ConfigValidationError);
    expect(
      loadApiDependencyConfig({
        ...base,
        EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
      }).retention?.artifactReadMaximumArtifactBytes,
    ).toBe(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES);
  });

  it("requires an explicit protected plaintext spool contract in production", () => {
    const production = {
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_RESTORE_EPOCH: "production-restore-epoch-2026-08-16-v1",
      DATABASE_URL: "postgresql://production.invalid/nutrition",
      DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
      MEILI_SEARCH_KEY: "scoped-production-search-key",
      MEILI_URL: "https://search.internal",
      NODE_ENV: "production",
      RETENTION_FEATURES_ENABLED: "true",
      SEARCH_CURSOR_SECRET: "production-cursor-secret-at-least-32-bytes",
      EXPORT_ARTIFACT_STORE: "s3",
      EXPORT_ARTIFACT_ENDPOINT: "https://objects.internal.example",
      EXPORT_ARTIFACT_REGION: "us-east-1",
      EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
      EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
      EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
        "export-v1": Buffer.alloc(32, 1).toString("base64"),
      }),
      EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "export-reader",
      EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "export-reader-secret",
      EXPORT_ARTIFACT_READ_SPOOL_DIR: "/var/run/nutrition-tracker/export-read-spool",
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
        "locator-v1": Buffer.alloc(32, 2).toString("base64"),
      }),
      ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    } as const;
    expect(() => loadApiDependencyConfig(production)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ field: "EXPORT_ARTIFACT_READ_SPOOL_PROTECTION" }),
        ]),
      }),
    );
  });
});
