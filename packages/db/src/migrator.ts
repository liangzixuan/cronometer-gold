import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Kysely, sql } from "kysely";

import type { Database } from "./types.js";

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_NAME = "nutrition-tracker:database-migrations:v1";

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
    await sql`select pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_NAME}))`.execute(transaction);
    await sql`
      create table if not exists app_schema_migration (
        name text primary key,
        checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default clock_timestamp()
      )
    `.execute(transaction);

    const result = await sql<AppliedMigration>`
      select name, checksum, applied_at
      from app_schema_migration
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
        insert into app_schema_migration (name, checksum)
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
