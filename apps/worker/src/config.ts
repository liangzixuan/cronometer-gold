import { isAbsolute, parse, resolve } from "node:path";
import {
  ArtifactEncryptionConfigurationError,
  ErasureLedgerLocatorConfigurationError,
  parseArtifactEncryptionKeyRing,
  parseErasureLedgerLocatorKeyRing,
} from "@nutrition-tracker/artifact-store";
import { MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES } from "@nutrition-tracker/db";
import { z } from "zod";

const workerConfigSchema = z.object({
  DATABASE_RESTORE_EPOCH: z
    .string()
    .min(32)
    .max(500)
    .refine((value) => value.trim() === value)
    .optional(),
  DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .default("postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker"),
  ERASURE_REPLAY_LEDGER_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
  ERASURE_REPLAY_LEDGER_DIRECTORY: z
    .string()
    .trim()
    .min(1)
    .default("/tmp/nutrition-tracker-encrypted-erasure-ledger"),
  ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: z.string().min(1).max(32_768).optional(),
  ERASURE_REPLAY_LEDGER_ENDPOINT: z.url().optional(),
  ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
  ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: z.string().min(1).max(32_768).optional(),
  ERASURE_REPLAY_LEDGER_REGION: z
    .string()
    .regex(/^[a-z0-9-]{2,64}$/)
    .optional(),
  ERASURE_REPLAY_LEDGER_STORE: z.enum(["filesystem", "s3"]).default("filesystem"),
  ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: z.string().trim().min(1).max(512).optional(),
  ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: z.string().min(1).max(2_048).optional(),
  ERASURE_REPLAY_LEDGER_WRITE_SESSION_TOKEN: z.string().min(1).max(8_192).optional(),
  EXPORT_ARTIFACT_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  EXPORT_ARTIFACT_CURRENT_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
  EXPORT_ARTIFACT_DIRECTORY: z
    .string()
    .trim()
    .min(1)
    .default("/tmp/nutrition-tracker-encrypted-exports"),
  EXPORT_ARTIFACT_ENCRYPTION_KEYS: z.string().min(1).max(32_768).optional(),
  EXPORT_ARTIFACT_ENDPOINT: z.url().optional(),
  EXPORT_ARTIFACT_REGION: z
    .string()
    .regex(/^[a-z0-9-]{2,64}$/)
    .optional(),
  EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: z.string().trim().min(1).max(512).optional(),
  EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: z.string().min(1).max(2_048).optional(),
  EXPORT_ARTIFACT_WRITE_SESSION_TOKEN: z.string().min(1).max(8_192).optional(),
  EXPORT_ARTIFACT_STORE: z.enum(["filesystem", "s3"]).default("filesystem"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MEILI_ADMIN_KEY: z.string().trim().min(16).optional(),
  MEILI_URL: z.url().default("http://127.0.0.1:7700"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  RETENTION_EXPORT_SPOOL_DIR: z
    .string()
    .trim()
    .min(1)
    .default("/tmp/nutrition-tracker-export-spool"),
  RETENTION_EXPORT_SPOOL_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  RETENTION_EXPORT_SPOOL_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(104_857_600)
    .max(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES)
    .default(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
  RETENTION_EXPORT_SPOOL_PROTECTION: z
    .enum(["tmpfs", "encrypted_volume", "unverified"])
    .default("unverified"),
  RETENTION_FEATURES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  RETENTION_WORKER_ID: z
    .string()
    .regex(/^[a-z][a-z0-9._:-]{2,127}$/)
    .default("local-retention-worker"),
  SEARCH_REBUILD_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(500),
  SEARCH_REBUILD_EVENT_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  SEARCH_REBUILD_SPOOL_DIR: z.string().trim().min(1).optional(),
  SEARCH_REBUILD_SPOOL_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(107_374_182_400)
    .default(2_147_483_648),
  SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(50_000_000)
    .default(5_000_000),
  SEARCH_REBUILD_WORKER_ID: z
    .string()
    .regex(/^[a-z][a-z0-9._:-]{2,127}$/)
    .default("local-food-search-worker"),
  SEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(10).max(60_000).default(5_000),
  SEARCH_TASK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  SERVICE_VERSION: z.string().min(1).default("dev"),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
});

export type WorkerConfig = z.output<typeof workerConfigSchema>;

export interface WorkerConfigIssue {
  readonly field: string;
}

export class WorkerConfigValidationError extends Error {
  readonly issues: readonly WorkerConfigIssue[];

  constructor(issues: readonly WorkerConfigIssue[]) {
    super(`Invalid worker configuration: ${issues.map((issue) => issue.field).join(", ")}`);
    this.name = "WorkerConfigValidationError";
    this.issues = issues;
  }
}

function safeAbsoluteDirectory(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && value !== parse(value).root;
}

export function parseWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const result = workerConfigSchema.safeParse(environment);
  if (!result.success) {
    throw new WorkerConfigValidationError(
      result.error.issues.map((issue) => ({
        field: issue.path.map(String).join(".") || "environment",
      })),
    );
  }
  const productionIssues: WorkerConfigIssue[] = [];
  const needsRetentionSecrets =
    result.data.NODE_ENV === "production" || result.data.RETENTION_FEATURES_ENABLED;
  if (needsRetentionSecrets) {
    try {
      parseArtifactEncryptionKeyRing({
        purpose: "export",
        currentKeyId: result.data.EXPORT_ARTIFACT_CURRENT_KEY_ID,
        serializedKeys: result.data.EXPORT_ARTIFACT_ENCRYPTION_KEYS,
      });
    } catch (error) {
      productionIssues.push({
        field:
          error instanceof ArtifactEncryptionConfigurationError
            ? error.field
            : "EXPORT_ARTIFACT_ENCRYPTION_KEYS",
      });
    }
    try {
      parseArtifactEncryptionKeyRing({
        purpose: "erasure_replay_ledger",
        currentKeyId: result.data.ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID,
        serializedKeys: result.data.ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS,
      });
    } catch (error) {
      productionIssues.push({
        field:
          error instanceof ArtifactEncryptionConfigurationError
            ? error.field
            : "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS",
      });
    }
    try {
      parseErasureLedgerLocatorKeyRing({
        currentKeyId: result.data.ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID,
        serializedKeys: result.data.ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS,
      });
    } catch (error) {
      productionIssues.push({
        field:
          error instanceof ErasureLedgerLocatorConfigurationError
            ? error.field
            : "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
      });
    }
    if (!safeAbsoluteDirectory(result.data.RETENTION_EXPORT_SPOOL_DIR)) {
      productionIssues.push({ field: "RETENTION_EXPORT_SPOOL_DIR" });
    }
    if (!safeAbsoluteDirectory(result.data.EXPORT_ARTIFACT_DIRECTORY)) {
      productionIssues.push({ field: "EXPORT_ARTIFACT_DIRECTORY" });
    }
    if (!safeAbsoluteDirectory(result.data.ERASURE_REPLAY_LEDGER_DIRECTORY)) {
      productionIssues.push({ field: "ERASURE_REPLAY_LEDGER_DIRECTORY" });
    }
  }
  if (result.data.NODE_ENV === "production") {
    if (!result.data.DATABASE_RESTORE_EPOCH) {
      productionIssues.push({ field: "DATABASE_RESTORE_EPOCH" });
    }
    if (!result.data.RETENTION_FEATURES_ENABLED) {
      productionIssues.push({ field: "RETENTION_FEATURES_ENABLED" });
    }
    if (environment.DATABASE_URL === undefined) {
      productionIssues.push({ field: "DATABASE_URL" });
    }
    if (!result.data.MEILI_ADMIN_KEY) {
      productionIssues.push({ field: "MEILI_ADMIN_KEY" });
    }
    if (new URL(result.data.MEILI_URL).protocol !== "https:") {
      productionIssues.push({ field: "MEILI_URL" });
    }
    if (result.data.EXPORT_ARTIFACT_STORE !== "s3") {
      productionIssues.push({ field: "EXPORT_ARTIFACT_STORE" });
    }
    if (result.data.ERASURE_REPLAY_LEDGER_STORE !== "s3") {
      productionIssues.push({ field: "ERASURE_REPLAY_LEDGER_STORE" });
    }
    if (environment.RETENTION_EXPORT_SPOOL_DIR === undefined) {
      productionIssues.push({ field: "RETENTION_EXPORT_SPOOL_DIR" });
    }
    if (result.data.RETENTION_EXPORT_SPOOL_PROTECTION === "unverified") {
      productionIssues.push({ field: "RETENTION_EXPORT_SPOOL_PROTECTION" });
    }
    if (!result.data.EXPORT_ARTIFACT_ENDPOINT) {
      productionIssues.push({ field: "EXPORT_ARTIFACT_ENDPOINT" });
    } else if (new URL(result.data.EXPORT_ARTIFACT_ENDPOINT).protocol !== "https:") {
      productionIssues.push({ field: "EXPORT_ARTIFACT_ENDPOINT" });
    }
    if (!result.data.ERASURE_REPLAY_LEDGER_ENDPOINT) {
      productionIssues.push({ field: "ERASURE_REPLAY_LEDGER_ENDPOINT" });
    } else if (new URL(result.data.ERASURE_REPLAY_LEDGER_ENDPOINT).protocol !== "https:") {
      productionIssues.push({ field: "ERASURE_REPLAY_LEDGER_ENDPOINT" });
    }
    for (const field of [
      "EXPORT_ARTIFACT_BUCKET",
      "EXPORT_ARTIFACT_REGION",
      "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
      "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
      "ERASURE_REPLAY_LEDGER_BUCKET",
      "ERASURE_REPLAY_LEDGER_REGION",
      "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
      "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
    ] as const) {
      if (!result.data[field]) productionIssues.push({ field });
    }
  }
  if (productionIssues.length > 0) {
    throw new WorkerConfigValidationError(
      productionIssues.filter(
        (issue, index, issues) =>
          issues.findIndex((candidate) => candidate.field === issue.field) === index,
      ),
    );
  }
  return result.data;
}
