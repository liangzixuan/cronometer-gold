import { z } from "zod";

const workerConfigSchema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .default("postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MEILI_ADMIN_KEY: z.string().trim().min(16).optional(),
  MEILI_URL: z.url().default("http://127.0.0.1:7700"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
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
  if (result.data.NODE_ENV === "production") {
    if (environment.DATABASE_URL === undefined) {
      productionIssues.push({ field: "DATABASE_URL" });
    }
    if (!result.data.MEILI_ADMIN_KEY) {
      productionIssues.push({ field: "MEILI_ADMIN_KEY" });
    }
    if (new URL(result.data.MEILI_URL).protocol !== "https:") {
      productionIssues.push({ field: "MEILI_URL" });
    }
  }
  if (productionIssues.length > 0) {
    throw new WorkerConfigValidationError(productionIssues);
  }
  return result.data;
}
