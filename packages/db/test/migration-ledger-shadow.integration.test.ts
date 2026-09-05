import { randomBytes } from "node:crypto";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  assertDatabaseMigrationLedgerReady,
  createDatabase,
  discoverMigrations,
  runMigrations,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("migration ledger schema identity", { timeout: 120_000 }, () => {
  it("honors a safe client-scoped schema and fails closed for quoted client settings", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    assertLoopbackDatabaseUrl(databaseUrl);

    const bootstrap = createDatabase({
      applicationName: "migration-ledger-client-schema-bootstrap",
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const schemaName = `migration_client_${randomBytes(6).toString("hex")}`;
    let scoped: ReturnType<typeof createDatabase> | undefined;
    let malformed: ReturnType<typeof createDatabase> | undefined;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
      const scopedUrl = new URL(databaseUrl);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
      scoped = createDatabase({
        applicationName: "migration-ledger-client-schema",
        connectionString: scopedUrl.toString(),
        maxConnections: 1,
      });
      expect(
        (
          await sql<{ readonly setting: string; readonly source: string }>`
            select setting, source
            from pg_catalog.pg_settings
            where name = 'search_path'
          `.execute(scoped)
        ).rows[0],
      ).toEqual({ setting: `${schemaName},public`, source: "client" });

      const migrations = await discoverMigrations();
      const result = await runMigrations(scoped);
      expect(result.applied).toEqual(migrations.map((migration) => migration.name));
      await expect(assertDatabaseMigrationLedgerReady(scoped)).resolves.toBeUndefined();
      expect(
        (
          await sql<{
            readonly ledger_exists: boolean;
            readonly migrated_table_exists: boolean;
          }>`
            select
              pg_catalog.to_regclass(${`${schemaName}.app_schema_migration`}) is not null
                as ledger_exists,
              pg_catalog.to_regclass(${`${schemaName}.app_user`}) is not null
                as migrated_table_exists
          `.execute(scoped)
        ).rows[0],
      ).toEqual({
        ledger_exists: true,
        migrated_table_exists: true,
      });

      const malformedUrl = new URL(databaseUrl);
      malformedUrl.searchParams.set("options", `-csearch_path="${schemaName}",public`);
      malformed = createDatabase({
        applicationName: "migration-ledger-malformed-client-schema",
        connectionString: malformedUrl.toString(),
        maxConnections: 1,
      });
      await expect(runMigrations(malformed)).rejects.toThrow(
        "Client search_path contains an unsafe migration schema identifier",
      );
      await expect(assertDatabaseMigrationLedgerReady(malformed)).rejects.toThrow(
        "Database schema migration ledger is not current",
      );
    } catch (error) {
      primaryFailure = error;
    } finally {
      const attemptCleanup = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupFailures.push(error);
        }
      };
      const malformedClient = malformed;
      if (malformedClient) await attemptCleanup(() => malformedClient.destroy());
      const scopedClient = scoped;
      if (scopedClient) await attemptCleanup(() => scopedClient.destroy());
      await attemptCleanup(() =>
        sql`drop schema if exists ${sql.id(schemaName)} cascade`.execute(bootstrap),
      );
      await attemptCleanup(() => bootstrap.destroy());
    }

    if (primaryFailure !== undefined || cleanupFailures.length > 0) {
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
        "Client migration schema integration test or cleanup failed",
      );
    }
  });

  it("ignores an owner-schema shadow ledger and reads only public", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    assertLoopbackDatabaseUrl(databaseUrl);

    const bootstrap = createDatabase({
      applicationName: "migration-ledger-shadow-bootstrap",
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const ephemeralDatabaseName = `migration_ledger_shadow_${randomBytes(6).toString("hex")}`;
    let cleanupReserved = false;
    let isolated: ReturnType<typeof createDatabase> | undefined;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      const databaseState = (
        await sql<{
          readonly database_name: string;
          readonly database_owner: string;
          readonly session_principal: string;
        }>`
          select
            pg_catalog.current_database() as database_name,
            pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner,
            session_user as session_principal
          from pg_catalog.pg_database as database_row
          where database_row.datname = pg_catalog.current_database()
        `.execute(bootstrap)
      ).rows[0];
      if (!databaseState) throw new Error("Test database identity is unavailable");
      if (databaseState.database_owner !== databaseState.session_principal) {
        throw new Error("TEST_DATABASE_URL must authenticate as the local test database owner");
      }
      if (databaseState.database_name === ephemeralDatabaseName) {
        throw new Error("TEST_DATABASE_URL must not target the ephemeral database name");
      }
      const collision = (
        await sql<{ readonly exists: boolean }>`
          select exists (
            select 1
            from pg_catalog.pg_database as database_row
            where database_row.datname = ${ephemeralDatabaseName}
          ) as exists
        `.execute(bootstrap)
      ).rows[0]?.exists;
      if (collision !== false) throw new Error("Generated migration test database already exists");
      cleanupReserved = true;

      await sql`
        create database ${sql.id(ephemeralDatabaseName)}
        owner ${sql.id(databaseState.database_owner)}
        template template0
      `.execute(bootstrap);

      isolated = createDatabase({
        applicationName: "migration-ledger-shadow-owner",
        connectionString: databaseUrlForName(databaseUrl, ephemeralDatabaseName),
        maxConnections: 1,
      });
      await sql`
        create schema ${sql.id(databaseState.database_owner)}
        authorization ${sql.id(databaseState.database_owner)}
      `.execute(isolated);
      await sql`
        create table ${sql.id(databaseState.database_owner)}.app_schema_migration (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default clock_timestamp()
        )
      `.execute(isolated);
      await sql`
        create temporary table app_user (
          shadow_marker text not null
        )
      `.execute(isolated);

      const migrations = await discoverMigrations();
      for (const migration of migrations) {
        await sql`
          insert into ${sql.id(databaseState.database_owner)}.app_schema_migration (name, checksum)
          values (${migration.name}, ${migration.checksum})
        `.execute(isolated);
      }
      const unqualifiedLedgerSchema = (
        await sql<{ readonly schema_name: string }>`
          select namespace_row.nspname as schema_name
          from pg_catalog.pg_class as class_row
          join pg_catalog.pg_namespace as namespace_row
            on namespace_row.oid = class_row.relnamespace
          where class_row.oid = 'app_schema_migration'::pg_catalog.regclass
        `.execute(isolated)
      ).rows[0]?.schema_name;
      expect(unqualifiedLedgerSchema).toBe(databaseState.database_owner);

      const result = await runMigrations(isolated);
      expect(result.applied).toEqual(migrations.map((migration) => migration.name));
      expect(result.alreadyApplied).toEqual([]);
      await expect(assertDatabaseMigrationLedgerReady(isolated)).resolves.toBeUndefined();

      const publicLedger = (
        await sql<{ readonly checksum: string; readonly name: string }>`
          select name, checksum
          from public.app_schema_migration
          order by name
        `.execute(isolated)
      ).rows;
      expect(publicLedger).toEqual(
        migrations.map((migration) => ({ checksum: migration.checksum, name: migration.name })),
      );
      const applicationSchema = (
        await sql<{
          readonly public_app_user: string | null;
          readonly shadow_app_user: string | null;
        }>`
          select
            pg_catalog.to_regclass('public.app_user')::text as public_app_user,
            pg_catalog.to_regclass(
              ${`${databaseState.database_owner}.app_user`}
            )::text as shadow_app_user
        `.execute(isolated)
      ).rows[0];
      expect(applicationSchema?.public_app_user).toBe("public.app_user");
      expect(applicationSchema?.shadow_app_user).toBeNull();
      expect(
        (
          await sql<{ readonly temp_app_user_exists: boolean }>`
            select pg_catalog.to_regclass('pg_temp.app_user') is not null as temp_app_user_exists
          `.execute(isolated)
        ).rows[0]?.temp_app_user_exists,
      ).toBe(true);

      const finalMigration = migrations.at(-1);
      if (!finalMigration) throw new Error("Expected at least one migration");
      await sql`
        delete from public.app_schema_migration
        where name = ${finalMigration.name}
      `.execute(isolated);
      await expect(assertDatabaseMigrationLedgerReady(isolated)).rejects.toThrow(
        "Database schema migration ledger is not current",
      );
      await sql`
        insert into public.app_schema_migration (name, checksum)
        values (${finalMigration.name}, ${"0".repeat(64)})
      `.execute(isolated);
      await expect(assertDatabaseMigrationLedgerReady(isolated)).rejects.toThrow(
        "Database schema migration ledger is not current",
      );
      expect(
        (
          await sql<{ readonly count: number }>`
            select pg_catalog.count(*)::integer as count
            from ${sql.id(databaseState.database_owner)}.app_schema_migration
          `.execute(isolated)
        ).rows[0]?.count,
      ).toBe(migrations.length);
    } catch (error) {
      primaryFailure = error;
    } finally {
      const attemptCleanup = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupFailures.push(error);
        }
      };
      const isolatedClient = isolated;
      if (isolatedClient) await attemptCleanup(() => isolatedClient.destroy());
      if (cleanupReserved) {
        await attemptCleanup(() =>
          sql`drop database if exists ${sql.id(ephemeralDatabaseName)}`.execute(bootstrap),
        );
        await attemptCleanup(async () => {
          const residue = (
            await sql<{ readonly exists: boolean }>`
              select exists (
                select 1
                from pg_catalog.pg_database as database_row
                where database_row.datname = ${ephemeralDatabaseName}
              ) as exists
            `.execute(bootstrap)
          ).rows[0]?.exists;
          if (residue !== false) {
            throw new Error("Migration ledger integration cleanup left database residue");
          }
        });
      }
      await attemptCleanup(() => bootstrap.destroy());
    }

    if (primaryFailure !== undefined || cleanupFailures.length > 0) {
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
        "Migration ledger shadow integration test or cleanup failed",
      );
    }
  });
});

function assertLoopbackDatabaseUrl(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a PostgreSQL URL on literal loopback");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("TEST_DATABASE_URL must use a literal loopback PostgreSQL host");
  }
}

function databaseUrlForName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
