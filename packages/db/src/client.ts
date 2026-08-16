import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool, type PoolConfig } from "pg";

import type { Database } from "./types.js";

export interface DatabaseClientOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly connectionTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly ssl?: PoolConfig["ssl"];
}

/**
 * Construct the process-wide database client. Callers own its lifecycle and must
 * invoke `destroy()` during graceful shutdown.
 */
export function createDatabase(options: DatabaseClientOptions): Kysely<Database> {
  if (options.ssl !== undefined && hasDatabaseTlsQueryParameter(options.connectionString)) {
    throw new Error(
      "DATABASE_URL must not contain TLS query parameters when an explicit SSL policy is configured",
    );
  }
  const pool = new Pool({
    application_name: options.applicationName ?? "nutrition-tracker",
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    connectionString: options.connectionString,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    max: options.maxConnections ?? 10,
    options: `-c statement_timeout=${options.statementTimeoutMs ?? 15_000}`,
    ssl: options.ssl,
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * node-postgres parses connection-string options after object options, so even
 * `sslmode=disable` in the URL would otherwise override `rejectUnauthorized`.
 */
export function hasDatabaseTlsQueryParameter(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return [...url.searchParams.keys()].some((key) => {
      const normalized = key.toLowerCase();
      return normalized.startsWith("ssl") || normalized === "uselibpqcompat";
    });
  } catch {
    // The PostgreSQL driver owns validation/redaction of non-URL socket forms
    // and malformed connection strings. This predicate must never echo them.
    return false;
  }
}

export function createDatabaseFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Kysely<Database> {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const maxConnections = parsePositiveInteger(environment.DATABASE_POOL_MAX, 10);
  const connectionTimeoutMs = parsePositiveInteger(
    environment.DATABASE_CONNECTION_TIMEOUT_MS,
    5_000,
  );
  const statementTimeoutMs = parsePositiveInteger(
    environment.DATABASE_STATEMENT_TIMEOUT_MS,
    15_000,
  );
  const sslMode = environment.DATABASE_SSL_MODE ?? "disable";
  if (environment.NODE_ENV === "production" && sslMode !== "verify-full") {
    throw new Error("DATABASE_SSL_MODE=verify-full is required in production");
  }

  return createDatabase({
    applicationName: environment.DATABASE_APPLICATION_NAME ?? "nutrition-tracker",
    connectionTimeoutMs,
    connectionString,
    maxConnections,
    ssl: parseSslMode(sslMode),
    statementTimeoutMs,
  });
}

export async function assertDatabaseReady(database: Kysely<Database>): Promise<void> {
  await sql`select 1`.execute(database);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function parseSslMode(value: string | undefined): PoolConfig["ssl"] {
  switch (value ?? "disable") {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      throw new Error("DATABASE_SSL_MODE must be disable, require, or verify-full");
  }
}
