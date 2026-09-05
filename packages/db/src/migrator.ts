import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Kysely, sql } from "kysely";

import type { Database } from "./types.js";

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_NAME = "nutrition-tracker:database-migrations:v1";
const SAFE_MIGRATION_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const SKIPPED_SEARCH_PATH_ENTRIES = new Set(["$user", '"$user"', "pg_catalog", "pg_temp"]);

interface MigrationFile {
  readonly checksum: string;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly applied_at: Date;
  readonly checksum: string;
  readonly name: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export interface MigrationOptions {
  readonly directory?: string;
}

interface SearchPathSetting {
  readonly setting: string;
  readonly source: string;
}

/**
 * Select the schema used by the migration ledger and unqualified migration DDL.
 * Only a startup-packet/client search_path may opt a caller into a non-public
 * schema. Role, database, user, environment, and server defaults are ignored so
 * an owner-named schema cannot silently capture production migrations.
 */
export function selectMigrationSchemaFromSearchPath(setting: SearchPathSetting): string {
  if (setting.source !== "client") {
    return "public";
  }

  const entries = setting.setting.split(",");
  let selected: string | undefined;
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      throw new Error("Client search_path contains an empty migration schema entry");
    }
    if (SKIPPED_SEARCH_PATH_ENTRIES.has(entry)) {
      continue;
    }
    if (
      !SAFE_MIGRATION_SCHEMA_PATTERN.test(entry) ||
      entry === "information_schema" ||
      entry.startsWith("pg_")
    ) {
      throw new Error("Client search_path contains an unsafe migration schema identifier");
    }
    selected ??= entry;
  }

  if (selected === undefined) {
    throw new Error("Client search_path does not select an application migration schema");
  }
  return selected;
}

/** Resolve the effective migration schema from the current PostgreSQL session. */
export async function resolveMigrationSchema(database: Kysely<Database>): Promise<string> {
  const setting = (
    await sql<SearchPathSetting>`
      select setting, source
      from pg_catalog.pg_settings
      where name = 'search_path'
    `.execute(database)
  ).rows[0];
  if (!setting) {
    throw new Error("PostgreSQL search_path setting is unavailable");
  }
  return selectMigrationSchemaFromSearchPath(setting);
}

/** Keep extension objects in public available to explicitly scoped test schemas. */
export function migrationSearchPath(migrationSchema: string): string {
  return migrationSchema === "public"
    ? "public, pg_catalog, pg_temp"
    : `${migrationSchema}, public, pg_catalog, pg_temp`;
}

/**
 * Load and hash every forward migration. Applied migration files are part of the
 * audit trail: changing or removing one is rejected instead of silently accepted.
 */
export async function discoverMigrations(directory?: string): Promise<readonly MigrationFile[]> {
  const migrationDirectory = directory ?? (await findDefaultMigrationDirectory());
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (names.length === 0) {
    throw new Error(`No migration files found in ${migrationDirectory}`);
  }

  return Promise.all(
    names.map(async (name) => {
      const migrationSql = await readFile(resolve(migrationDirectory, name), "utf8");
      assertForwardOnly(name, migrationSql);
      return {
        checksum: createHash("sha256").update(migrationSql).digest("hex"),
        name,
        sql: migrationSql,
      };
    }),
  );
}

/**
 * Apply pending migrations under a PostgreSQL transaction-scoped advisory lock.
 * The complete pending set is atomic; a failed statement leaves no partial schema.
 */
export async function runMigrations(
  database: Kysely<Database>,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const files = await discoverMigrations(options.directory);

  return database.transaction().execute(async (transaction) => {
    const migrationSchema = await resolveMigrationSchema(transaction);
    await sql`
      select pg_catalog.set_config(
        'search_path',
        ${migrationSearchPath(migrationSchema)},
        true
      )
    `.execute(transaction);
    await sql`
      select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${MIGRATION_LOCK_NAME}))
    `.execute(transaction);
    await sql`
      create table if not exists ${sql.id(migrationSchema)}.app_schema_migration (
        name text primary key,
        checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default clock_timestamp()
      )
    `.execute(transaction);

    const result = await sql<AppliedMigration>`
      select name, checksum, applied_at
      from ${sql.id(migrationSchema)}.app_schema_migration
      order by name
    `.execute(transaction);
    const appliedByName = new Map(result.rows.map((row) => [row.name, row]));
    const fileByName = new Map(files.map((file) => [file.name, file]));

    for (const applied of result.rows) {
      const file = fileByName.get(applied.name);
      if (!file) {
        throw new Error(`Applied migration ${applied.name} is missing from the repository`);
      }
      if (file.checksum !== applied.checksum) {
        throw new Error(`Applied migration ${applied.name} has been modified`);
      }
    }

    const appliedNow: string[] = [];
    for (const file of files) {
      if (appliedByName.has(file.name)) {
        continue;
      }

      await sql.raw(file.sql).execute(transaction);
      await sql`
        insert into ${sql.id(migrationSchema)}.app_schema_migration (name, checksum)
        values (${file.name}, ${file.checksum})
      `.execute(transaction);
      appliedNow.push(file.name);
    }

    return {
      applied: appliedNow,
      alreadyApplied: result.rows.map((row) => row.name),
    };
  });
}

function assertForwardOnly(name: string, migrationSql: string): void {
  const normalized = migrationSql.toLowerCase();
  if (/^\s*(begin|commit|rollback)\s*;/m.test(normalized)) {
    throw new Error(
      `${name} must not manage transactions; the migration runner owns the transaction`,
    );
  }
  if (/\bdown\s+migration\b/.test(normalized)) {
    throw new Error(`${name} contains a down-migration marker; migrations are forward-only`);
  }
}

async function findDefaultMigrationDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../migrations"),
    resolve(moduleDirectory, "../../migrations"),
  ];

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next source/dist-relative location.
    }
  }

  throw new Error(`Could not find migrations directory; checked ${candidates.join(", ")}`);
}
