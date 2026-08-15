import { z } from "zod";

const workerConfigSchema = z.object({
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
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
  return result.data;
}
