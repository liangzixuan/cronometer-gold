import { isAbsolute, parse, resolve } from "node:path";
import {
  ArtifactEncryptionConfigurationError,
  type ArtifactEncryptionKeyRing,
  ErasureLedgerLocatorConfigurationError,
  type ErasureLedgerLocatorKeyRing,
  parseArtifactEncryptionKeyRing,
  parseErasureLedgerLocatorKeyRing,
} from "@nutrition-tracker/artifact-store";
import { MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES } from "@nutrition-tracker/db";
import { z } from "zod";

const environmentSchema = z.object({
  API_HOST: z.string().trim().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(10).max(60_000).default(2_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
});

const dependencyEnvironmentSchema = z.object({
  DATABASE_RESTORE_EPOCH: z
    .string()
    .min(32)
    .max(500)
    .refine((value) => value.trim() === value)
    .optional(),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_URL: z.string().trim().min(1),
  DEVICE_CHALLENGE_HMAC_KEY: z.string().min(1).max(1_024).optional(),
  ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: z.string().max(64).optional(),
  ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: z.string().min(1).max(32_768).optional(),
  ERASURE_STATUS_CAPABILITY_HMAC_KEY: z.string().min(1).max(1_024).optional(),
  EXPORT_ARTIFACT_BUCKET: z.string().optional(),
  EXPORT_ARTIFACT_CURRENT_KEY_ID: z.string().max(64).optional(),
  EXPORT_ARTIFACT_DIRECTORY: z.string().default("/tmp/nutrition-tracker-encrypted-exports"),
  EXPORT_ARTIFACT_ENCRYPTION_KEYS: z.string().min(1).max(32_768).optional(),
  EXPORT_ARTIFACT_ENDPOINT: z.url().optional(),
  EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: z.string().min(1).max(512).optional(),
  EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: z.coerce
    .number()
    .int()
    .min(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES)
    .max(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES)
    .default(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
  EXPORT_ARTIFACT_READ_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES: z.coerce
    .number()
    .int()
    .min(104_857_600)
    .max(214_748_364_800)
    .default(21_474_836_480),
  EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW: z.coerce
    .number()
    .int()
    .min(104_857_600)
    .max(214_748_364_800)
    .default(21_474_836_480),
  EXPORT_ARTIFACT_READ_MAX_DOWNLOADS_PER_WINDOW: z.coerce.number().int().min(1).max(100).default(3),
  EXPORT_ARTIFACT_READ_RATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: z.string().min(1).max(2_048).optional(),
  EXPORT_ARTIFACT_READ_SESSION_TOKEN: z.string().min(1).max(8_192).optional(),
  EXPORT_ARTIFACT_READ_SPOOL_DIR: z
    .string()
    .default("/tmp/nutrition-tracker-authenticated-export-reads"),
  EXPORT_ARTIFACT_READ_SPOOL_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  EXPORT_ARTIFACT_READ_SPOOL_PROTECTION: z
    .enum(["tmpfs", "encrypted_volume", "unverified"])
    .default("unverified"),
  EXPORT_ARTIFACT_REGION: z.string().optional(),
  EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  EXPORT_ARTIFACT_STORE: z.enum(["filesystem", "s3"]).default("filesystem"),
  MEILI_SEARCH_KEY: z.string().trim().min(16).optional(),
  MEILI_URL: z.url().default("http://127.0.0.1:7700"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  RETENTION_FEATURES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SEARCH_CURSOR_SECRET: z.string().min(32).optional(),
  SEARCH_DB_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  SEARCH_DB_MAX_QUEUE: z.coerce.number().int().min(0).max(100).default(16),
  SEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10).max(60_000).default(5_000),
});

export interface ConfigIssue {
  field: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid API configuration: ${issues.map((issue) => issue.field).join(", ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export interface AppConfig {
  apiHost: string;
  apiPort: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  nodeEnv: "development" | "test" | "production";
  readinessTimeoutMs: number;
  shutdownGraceMs: number;
}

export interface ApiDependencyConfig {
  readonly cursorSecret: string;
  readonly databaseRestoreEpoch: string | null;
  readonly databaseUrl: string;
  readonly meiliSearchKey?: string;
  readonly meiliUrl: string;
  readonly searchDatabaseMaxConcurrency: number;
  readonly searchDatabaseMaxQueue: number;
  readonly searchRequestTimeoutMs: number;
  readonly requireDatabaseRestoreAttestation: boolean;
  readonly retention: ApiRetentionDependencyConfig | null;
}

export interface ApiRetentionDependencyConfig {
  readonly artifactEncryptionKeyRing: ArtifactEncryptionKeyRing;
  readonly artifactStore: "filesystem" | "s3";
  readonly artifactDirectory: string;
  readonly artifactEndpoint?: string;
  readonly artifactRegion?: string;
  readonly artifactBucket?: string;
  readonly artifactReadAccessKeyId?: string;
  readonly artifactReadSecretAccessKey?: string;
  readonly artifactReadSessionToken?: string;
  readonly artifactRequestTimeoutMs: number;
  readonly artifactReadSpoolDirectory: string;
  readonly artifactReadSpoolMaximumAgeMs: number;
  readonly artifactReadSpoolProtection: "tmpfs" | "encrypted_volume" | "unverified";
  readonly artifactReadMaximumArtifactBytes: number;
  readonly artifactReadMaximumReservedBytes: number;
  readonly artifactReadMaximumConcurrency: number;
  readonly artifactReadMaximumBytesPerWindow: number;
  readonly artifactReadMaximumDownloadsPerWindow: number;
  readonly artifactReadRateWindowMs: number;
  readonly erasureLedgerLocatorKeyRing: ErasureLedgerLocatorKeyRing;
  readonly erasureStatusCapabilityHmacKey: Uint8Array;
  readonly deviceChallengeHmacKey: Uint8Array;
}

function canonicalBase64Key(value: string | undefined): Buffer | null {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 32 && bytes.toString("base64") === value ? bytes : null;
}

function safeAbsoluteDirectory(value: string): boolean {
  if (!isAbsolute(value) || resolve(value) !== value || value === parse(value).root) return false;
  const segments = value.split("/").filter(Boolean);
  return segments.length >= 2 && !segments.includes(".") && !segments.includes("..");
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => ({
        field: issue.path.map(String).join(".") || "environment",
        message: issue.message,
      })),
    );
  }

  return {
    apiHost: result.data.API_HOST,
    apiPort: result.data.API_PORT,
    logLevel: result.data.LOG_LEVEL,
    nodeEnv: result.data.NODE_ENV,
    readinessTimeoutMs: result.data.READINESS_TIMEOUT_MS,
    shutdownGraceMs: result.data.SHUTDOWN_GRACE_MS,
  };
}

/** Validate only the dependencies created by the production server entrypoint. */
export function loadApiDependencyConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiDependencyConfig {
  const result = dependencyEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => ({
        field: issue.path.map(String).join(".") || "environment",
        message: issue.message,
      })),
    );
  }

  const cursorSecret =
    result.data.SEARCH_CURSOR_SECRET ??
    (result.data.NODE_ENV === "production"
      ? undefined
      : "local-search-cursor-secret-change-before-shared-use-32-bytes");
  const issues: ConfigIssue[] = [];
  if (cursorSecret === undefined) {
    issues.push({ field: "SEARCH_CURSOR_SECRET", message: "Required in production" });
  }
  if (result.data.NODE_ENV === "production") {
    if (!result.data.DATABASE_RESTORE_EPOCH) {
      issues.push({ field: "DATABASE_RESTORE_EPOCH", message: "Required in production" });
    }
    if (result.data.DATABASE_SSL_MODE !== "verify-full") {
      issues.push({
        field: "DATABASE_SSL_MODE",
        message: "verify-full is required in production",
      });
    }
    if (!result.data.MEILI_SEARCH_KEY) {
      issues.push({ field: "MEILI_SEARCH_KEY", message: "Required in production" });
    }
    if (new URL(result.data.MEILI_URL).protocol !== "https:") {
      issues.push({ field: "MEILI_URL", message: "HTTPS is required in production" });
    }
    if (!result.data.RETENTION_FEATURES_ENABLED) {
      issues.push({ field: "RETENTION_FEATURES_ENABLED", message: "Must be explicitly enabled" });
    }
  }
  let retention: ApiRetentionDependencyConfig | null = null;
  if (result.data.RETENTION_FEATURES_ENABLED) {
    let artifactEncryptionKeyRing: ArtifactEncryptionKeyRing | undefined;
    try {
      artifactEncryptionKeyRing = parseArtifactEncryptionKeyRing({
        currentKeyId: result.data.EXPORT_ARTIFACT_CURRENT_KEY_ID,
        purpose: "export",
        serializedKeys: result.data.EXPORT_ARTIFACT_ENCRYPTION_KEYS,
      });
    } catch (error) {
      issues.push({
        field:
          error instanceof ArtifactEncryptionConfigurationError
            ? error.field
            : "EXPORT_ARTIFACT_ENCRYPTION_KEYS",
        message: "A valid versioned export AES key ring is required",
      });
    }
    let locatorKeyRing: ErasureLedgerLocatorKeyRing | undefined;
    try {
      locatorKeyRing = parseErasureLedgerLocatorKeyRing({
        currentKeyId: result.data.ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID,
        serializedKeys: result.data.ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS,
      });
    } catch (error) {
      issues.push({
        field:
          error instanceof ErasureLedgerLocatorConfigurationError
            ? error.field
            : "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
        message: "A valid versioned locator HMAC key ring is required",
      });
    }
    const statusKey = canonicalBase64Key(result.data.ERASURE_STATUS_CAPABILITY_HMAC_KEY);
    if (!statusKey) {
      issues.push({
        field: "ERASURE_STATUS_CAPABILITY_HMAC_KEY",
        message: "A canonical base64 256-bit status capability key is required",
      });
    }
    const deviceChallengeKey = canonicalBase64Key(result.data.DEVICE_CHALLENGE_HMAC_KEY);
    if (!deviceChallengeKey) {
      issues.push({
        field: "DEVICE_CHALLENGE_HMAC_KEY",
        message: "A canonical base64 256-bit device challenge key is required",
      });
    }
    if (!safeAbsoluteDirectory(result.data.EXPORT_ARTIFACT_READ_SPOOL_DIR)) {
      issues.push({
        field: "EXPORT_ARTIFACT_READ_SPOOL_DIR",
        message: "Safe absolute path required",
      });
    }
    if (!safeAbsoluteDirectory(result.data.EXPORT_ARTIFACT_DIRECTORY)) {
      issues.push({ field: "EXPORT_ARTIFACT_DIRECTORY", message: "Safe absolute path required" });
    }
    if (
      result.data.EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES >
      result.data.EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES
    ) {
      issues.push({
        field: "EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES",
        message: "Must fit at least one maximum artifact",
      });
    }
    if (
      result.data.EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES >
      result.data.EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW
    ) {
      issues.push({
        field: "EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW",
        message: "Must permit at least one maximum artifact",
      });
    }
    if (result.data.NODE_ENV === "production") {
      if (result.data.EXPORT_ARTIFACT_STORE !== "s3") {
        issues.push({ field: "EXPORT_ARTIFACT_STORE", message: "S3 is required in production" });
      }
      if (!result.data.EXPORT_ARTIFACT_ENDPOINT) {
        issues.push({ field: "EXPORT_ARTIFACT_ENDPOINT", message: "Required in production" });
      } else if (new URL(result.data.EXPORT_ARTIFACT_ENDPOINT).protocol !== "https:") {
        issues.push({ field: "EXPORT_ARTIFACT_ENDPOINT", message: "HTTPS is required" });
      }
      for (const field of [
        "EXPORT_ARTIFACT_BUCKET",
        "EXPORT_ARTIFACT_REGION",
        "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
        "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
      ] as const) {
        if (!result.data[field]) issues.push({ field, message: "Required in production" });
      }
      if (environment.EXPORT_ARTIFACT_READ_SPOOL_DIR === undefined) {
        issues.push({
          field: "EXPORT_ARTIFACT_READ_SPOOL_DIR",
          message: "An encrypted ephemeral spool must be explicit in production",
        });
      }
      if (result.data.EXPORT_ARTIFACT_READ_SPOOL_PROTECTION === "unverified") {
        issues.push({
          field: "EXPORT_ARTIFACT_READ_SPOOL_PROTECTION",
          message:
            "Production plaintext spools require an operator-verified tmpfs or encrypted volume",
        });
      }
    }
    if (artifactEncryptionKeyRing && locatorKeyRing && statusKey && deviceChallengeKey) {
      retention = {
        artifactDirectory: result.data.EXPORT_ARTIFACT_DIRECTORY,
        artifactEncryptionKeyRing,
        artifactReadMaximumArtifactBytes: result.data.EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES,
        artifactReadMaximumBytesPerWindow: result.data.EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW,
        artifactReadMaximumConcurrency: result.data.EXPORT_ARTIFACT_READ_MAX_CONCURRENCY,
        artifactReadMaximumDownloadsPerWindow:
          result.data.EXPORT_ARTIFACT_READ_MAX_DOWNLOADS_PER_WINDOW,
        artifactReadMaximumReservedBytes: result.data.EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES,
        artifactReadSpoolDirectory: result.data.EXPORT_ARTIFACT_READ_SPOOL_DIR,
        artifactReadSpoolMaximumAgeMs: result.data.EXPORT_ARTIFACT_READ_SPOOL_MAX_AGE_MS,
        artifactReadSpoolProtection: result.data.EXPORT_ARTIFACT_READ_SPOOL_PROTECTION,
        artifactReadRateWindowMs: result.data.EXPORT_ARTIFACT_READ_RATE_WINDOW_MS,
        artifactRequestTimeoutMs: result.data.EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS,
        artifactStore: result.data.EXPORT_ARTIFACT_STORE,
        deviceChallengeHmacKey: deviceChallengeKey,
        erasureLedgerLocatorKeyRing: locatorKeyRing,
        erasureStatusCapabilityHmacKey: statusKey,
        ...(result.data.EXPORT_ARTIFACT_BUCKET
          ? { artifactBucket: result.data.EXPORT_ARTIFACT_BUCKET }
          : {}),
        ...(result.data.EXPORT_ARTIFACT_ENDPOINT
          ? { artifactEndpoint: result.data.EXPORT_ARTIFACT_ENDPOINT }
          : {}),
        ...(result.data.EXPORT_ARTIFACT_READ_ACCESS_KEY_ID
          ? { artifactReadAccessKeyId: result.data.EXPORT_ARTIFACT_READ_ACCESS_KEY_ID }
          : {}),
        ...(result.data.EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY
          ? { artifactReadSecretAccessKey: result.data.EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY }
          : {}),
        ...(result.data.EXPORT_ARTIFACT_READ_SESSION_TOKEN
          ? { artifactReadSessionToken: result.data.EXPORT_ARTIFACT_READ_SESSION_TOKEN }
          : {}),
        ...(result.data.EXPORT_ARTIFACT_REGION
          ? { artifactRegion: result.data.EXPORT_ARTIFACT_REGION }
          : {}),
      };
    }
  }
  if (issues.length > 0 || cursorSecret === undefined) {
    throw new ConfigValidationError(issues);
  }

  return {
    cursorSecret,
    databaseRestoreEpoch: result.data.DATABASE_RESTORE_EPOCH ?? null,
    databaseUrl: result.data.DATABASE_URL,
    ...(result.data.MEILI_SEARCH_KEY === undefined
      ? {}
      : { meiliSearchKey: result.data.MEILI_SEARCH_KEY }),
    meiliUrl: result.data.MEILI_URL,
    requireDatabaseRestoreAttestation: result.data.NODE_ENV === "production",
    searchDatabaseMaxConcurrency: result.data.SEARCH_DB_MAX_CONCURRENCY,
    searchDatabaseMaxQueue: result.data.SEARCH_DB_MAX_QUEUE,
    searchRequestTimeoutMs: result.data.SEARCH_REQUEST_TIMEOUT_MS,
    retention,
  };
}
