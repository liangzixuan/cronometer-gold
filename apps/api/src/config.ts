import { z } from "zod";

const environmentSchema = z.object({
  API_HOST: z.string().trim().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(10).max(60_000).default(2_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
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
