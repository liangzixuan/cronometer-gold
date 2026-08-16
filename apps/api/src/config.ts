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
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_URL: z.string().trim().min(1),
  MEILI_SEARCH_KEY: z.string().trim().min(16).optional(),
  MEILI_URL: z.url().default("http://127.0.0.1:7700"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  readonly databaseUrl: string;
  readonly meiliSearchKey?: string;
  readonly meiliUrl: string;
  readonly searchDatabaseMaxConcurrency: number;
  readonly searchDatabaseMaxQueue: number;
  readonly searchRequestTimeoutMs: number;
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
  }
  if (issues.length > 0 || cursorSecret === undefined) {
    throw new ConfigValidationError(issues);
  }

  return {
    cursorSecret,
    databaseUrl: result.data.DATABASE_URL,
    ...(result.data.MEILI_SEARCH_KEY === undefined
      ? {}
      : { meiliSearchKey: result.data.MEILI_SEARCH_KEY }),
    meiliUrl: result.data.MEILI_URL,
    searchDatabaseMaxConcurrency: result.data.SEARCH_DB_MAX_CONCURRENCY,
    searchDatabaseMaxQueue: result.data.SEARCH_DB_MAX_QUEUE,
    searchRequestTimeoutMs: result.data.SEARCH_REQUEST_TIMEOUT_MS,
  };
}
