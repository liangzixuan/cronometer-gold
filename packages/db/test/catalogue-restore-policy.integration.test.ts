import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createDatabase, runMigrations } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const restorePolicySql = readFileSync(
  new URL("../restore/0014_catalogue_authority_policy.sql", import.meta.url),
  "utf8",
);

describeDatabase("catalogue restore authority schema identity", { timeout: 120_000 }, () => {
  it("ignores foreign-schema lookalikes but still rejects drift in public", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    assertLoopbackDatabaseUrl(databaseUrl);

    const bootstrap = createDatabase({
      applicationName: "catalogue-restore-schema-bootstrap",
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const token = randomBytes(6).toString("hex");
    const ephemeralDatabaseName = `nutrition_restore_scope_${token}`;
    const shadowSchema = `restore_shadow_${token}`;
    let cleanupReserved = false;
    let isolated: ReturnType<typeof createDatabase> | undefined;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      const databaseState = (
        await sql<{
          readonly database_owner: string;
          readonly name_collision: boolean;
          readonly session_principal: string;
        }>`
          select
            pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner,
            session_user as session_principal,
            exists (
              select 1
              from pg_catalog.pg_database as collision
              where collision.datname = ${ephemeralDatabaseName}
            ) as name_collision
          from pg_catalog.pg_database as database_row
          where database_row.datname = pg_catalog.current_database()
        `.execute(bootstrap)
      ).rows[0];
      if (!databaseState) throw new Error("Test database identity is unavailable");
      if (databaseState.database_owner !== databaseState.session_principal) {
        throw new Error("TEST_DATABASE_URL must authenticate as the local test database owner");
      }
      if (databaseState.name_collision) {
        throw new Error("Generated restore-policy test database already exists");
      }
      cleanupReserved = true;

      await sql`
        create database ${sql.id(ephemeralDatabaseName)}
        owner ${sql.id(databaseState.database_owner)}
        template template0
      `.execute(bootstrap);
      isolated = createDatabase({
        applicationName: "catalogue-restore-schema-isolated",
        connectionString: databaseUrlForName(databaseUrl, ephemeralDatabaseName),
        maxConnections: 1,
      });
      await runMigrations(isolated);

      // Simulate the ACL loss and drift that a --no-privileges logical restore
      // can leave behind. The reviewed policy must reconstruct only the fixed
      // public stage/validate surface and keep semantic helpers/v1 bodies owner-only.
      await sql
        .raw(`
        revoke execute on function public.catalogue_stage_import_batch(text)
          from nutrition_catalogue_stage;
        grant execute on function public.catalogue_stage_import_batch(text)
          to nutrition_catalogue_validate;
        revoke execute on function public.catalogue_validate_import_batch(uuid,text,text,text)
          from nutrition_catalogue_validate;
        grant execute on function public.catalogue_validate_import_batch_v1(uuid,text,text,text)
          to nutrition_catalogue_validate;
        grant execute on function public.catalogue_attest_import_nutrition_semantics(uuid)
          to nutrition_catalogue_validate;
        revoke usage on schema public
          from nutrition_catalogue_stage, nutrition_catalogue_validate;
      `)
        .execute(isolated);

      await sql
        .raw(`
        create schema ${shadowSchema};
        create table ${shadowSchema}.food_import_batch (id integer);
        create function ${shadowSchema}.guard_food_import_batch_validation_digest()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, public, pg_temp
        as $function$
        begin
          return new;
        end;
        $function$;
        create trigger food_import_batch_guard_validation_digest
        before insert or update on ${shadowSchema}.food_import_batch
        for each row
        execute function ${shadowSchema}.guard_food_import_batch_validation_digest();
      `)
        .execute(isolated);
      await sql`
        revoke connect on database ${sql.id(ephemeralDatabaseName)} from public
      `.execute(bootstrap);
      await sql`
        select pg_catalog.set_config(
          'nutrition.expected_restore_owner',
          ${databaseState.database_owner},
          false
        )
      `.execute(isolated);

      await expect(sql.raw(restorePolicySql).execute(isolated)).resolves.toBeDefined();

      const repairedAuthority = (
        await sql<{
          readonly stage_can_execute_stage: boolean;
          readonly stage_can_execute_seal_helper: boolean;
          readonly stage_has_schema_usage: boolean;
          readonly validate_can_execute_attestor: boolean;
          readonly validate_can_execute_stage: boolean;
          readonly validate_can_execute_validate: boolean;
          readonly validate_can_execute_validate_v1: boolean;
          readonly validate_has_schema_usage: boolean;
        }>`
          select
            pg_catalog.has_function_privilege(
              'nutrition_catalogue_stage',
              'public.catalogue_stage_import_batch(text)',
              'EXECUTE'
            ) as stage_can_execute_stage,
            pg_catalog.has_function_privilege(
              'nutrition_catalogue_stage',
              'public.catalogue_compute_import_staging_seal(uuid)',
              'EXECUTE'
            ) as stage_can_execute_seal_helper,
            pg_catalog.has_schema_privilege(
              'nutrition_catalogue_stage',
              'public',
              'USAGE'
            ) as stage_has_schema_usage,
            pg_catalog.has_function_privilege(
              'nutrition_catalogue_validate',
              'public.catalogue_attest_import_nutrition_semantics(uuid)',
              'EXECUTE'
            ) as validate_can_execute_attestor,
            pg_catalog.has_function_privilege(
              'nutrition_catalogue_validate',
              'public.catalogue_stage_import_batch(text)',
              'EXECUTE'
            ) as validate_can_execute_stage,
            pg_catalog.has_function_privilege(
              'nutrition_catalogue_validate',
              'public.catalogue_validate_import_batch(uuid,text,text,text)',
              'EXECUTE'
            ) as validate_can_execute_validate,
            pg_catalog.has_function_privilege(
              'nutrition_catalogue_validate',
              'public.catalogue_validate_import_batch_v1(uuid,text,text,text)',
              'EXECUTE'
            ) as validate_can_execute_validate_v1,
            pg_catalog.has_schema_privilege(
              'nutrition_catalogue_validate',
              'public',
              'USAGE'
            ) as validate_has_schema_usage
        `.execute(isolated)
      ).rows[0];
      expect(repairedAuthority).toEqual({
        stage_can_execute_seal_helper: false,
        stage_can_execute_stage: true,
        stage_has_schema_usage: true,
        validate_can_execute_attestor: false,
        validate_can_execute_stage: false,
        validate_can_execute_validate: true,
        validate_can_execute_validate_v1: false,
        validate_has_schema_usage: true,
      });

      await sql
        .raw(`
        drop trigger food_import_record_guard_nutrition_semantics
          on public.food_import_record;
        create trigger food_import_record_guard_nutrition_semantics
        before update on public.food_import_record
        for each row
        execute function public.guard_food_import_record_nutrition_semantics();
      `)
        .execute(isolated);
      await expect(sql.raw(restorePolicySql).execute(isolated)).rejects.toThrow(
        "catalogue authority trigger identity, definition, or enabled state differs from policy",
      );
      await sql.raw("rollback").execute(isolated);
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
            throw new Error("Restore-policy integration cleanup left database residue");
          }
        });
      }
      await attemptCleanup(() => bootstrap.destroy());
    }

    if (primaryFailure !== undefined || cleanupFailures.length > 0) {
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
        "Catalogue restore-policy schema integration test or cleanup failed",
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
