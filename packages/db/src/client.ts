import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool, type PoolConfig } from "pg";

import type { Database } from "./types.js";

export interface DatabaseClientOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
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
  const pool = new Pool({
    application_name: options.applicationName ?? "nutrition-tracker",
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

export function createDatabaseFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Kysely<Database> {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const maxConnections = parsePositiveInteger(environment.DATABASE_POOL_MAX, 10);
  const statementTimeoutMs = parsePositiveInteger(
    environment.DATABASE_STATEMENT_TIMEOUT_MS,
    15_000,
  );

  return createDatabase({
    applicationName: environment.DATABASE_APPLICATION_NAME ?? "nutrition-tracker",
    connectionString,
    maxConnections,
    ssl: parseSslMode(environment.DATABASE_SSL_MODE),
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
