import { randomBytes } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  assertCatalogueAuthorityDeploymentEvidence,
  CATALOGUE_ACTIVATION_GUARD_SOURCE_SHA256,
  CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
  CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  CATALOGUE_CAPABILITY_ROLES,
  CATALOGUE_OBSERVE_VALIDATION_FUNCTION_SOURCE_SHA256,
  CATALOGUE_PROMOTION_FUNCTION_SOURCE_SHA256,
  CATALOGUE_ROLLBACK_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_BATCH_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_PARSER_REPORT_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_RECORD_CHUNK_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_VALIDATE_GUARD_SOURCE_SHA256,
  CATALOGUE_VALIDATE_BATCH_FUNCTION_SOURCE_SHA256,
  type CatalogueAuthorityDeploymentPolicy,
  catalogueAuthorityDeploymentPolicySha256,
  collectCatalogueAuthorityDeploymentEvidence,
  createDatabase,
  type Database,
  parseCatalogueAuthorityDeploymentPolicy,
  runCatalogueReviewerCanaries,
  runMigrations,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface LoginFixture {
  readonly capability:
    | "nutrition_catalogue_approve_data"
    | "nutrition_catalogue_approve_quality"
    | "nutrition_catalogue_approve_rights"
    | null;
  readonly login: string;
  readonly password: string;
  readonly roleClass: "api" | "data" | "quality" | "rights" | "unassigned" | "worker";
}

describeDatabase("catalogue authority deployment canaries", { timeout: 120_000 }, () => {
  it("fails closed through six isolated real logins without changing protected state", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    assertLoopbackDatabaseUrl(databaseUrl);

    const bootstrap = createDatabase({
      applicationName: "catalogue-authority-deployment-bootstrap",
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const token = randomBytes(6).toString("hex");
    const ephemeralDatabaseName = `catalogue_authority_deploy_${token}`;
    const reviewerLogins = {
      data: `cat_dep_data_${token}`,
      quality: `cat_dep_quality_${token}`,
      rights: `cat_dep_rights_${token}`,
    } as const;
    const nonReviewerLogins = {
      api: `cat_dep_api_${token}`,
      unassigned: `cat_dep_unassigned_${token}`,
      worker: `cat_dep_worker_${token}`,
    } as const;
    const fixtures: LoginFixture[] = [
      {
        capability: "nutrition_catalogue_approve_data",
        login: reviewerLogins.data,
        password: randomBytes(24).toString("hex"),
        roleClass: "data",
      },
      {
        capability: "nutrition_catalogue_approve_quality",
        login: reviewerLogins.quality,
        password: randomBytes(24).toString("hex"),
        roleClass: "quality",
      },
      {
        capability: "nutrition_catalogue_approve_rights",
        login: reviewerLogins.rights,
        password: randomBytes(24).toString("hex"),
        roleClass: "rights",
      },
      {
        capability: null,
        login: nonReviewerLogins.api,
        password: randomBytes(24).toString("hex"),
        roleClass: "api",
      },
      {
        capability: null,
        login: nonReviewerLogins.unassigned,
        password: randomBytes(24).toString("hex"),
        roleClass: "unassigned",
      },
      {
        capability: null,
        login: nonReviewerLogins.worker,
        password: randomBytes(24).toString("hex"),
        roleClass: "worker",
      },
    ];
    const loginClients: Kysely<Database>[] = [];
    const clientByLogin = new Map<string, Kysely<Database>>();
    let cleanupReserved = false;
    let owner: Kysely<Database> | undefined;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      const databaseState = (
        await sql<{
          readonly name: string;
          readonly owner: string;
          readonly session_principal: string;
        }>`
          select
            database_row.datname as name,
            pg_catalog.pg_get_userbyid(database_row.datdba) as owner,
            session_user as session_principal
          from pg_catalog.pg_database as database_row
          where database_row.datname = pg_catalog.current_database()
        `.execute(bootstrap)
      ).rows[0];
      if (!databaseState) throw new Error("Test database identity is unavailable");
      if (databaseState.owner !== databaseState.session_principal) {
        throw new Error("TEST_DATABASE_URL must authenticate as the local test database owner");
      }
      if (databaseState.name === ephemeralDatabaseName) {
        throw new Error("TEST_DATABASE_URL must not target the ephemeral database name");
      }
      const capabilityRoleCount = (
        await sql<{ readonly count: number }>`
          select pg_catalog.count(*)::integer as count
          from pg_catalog.pg_roles as role_row
          where role_row.rolname in (${sql.join(
            CATALOGUE_CAPABILITY_ROLES.map((role) => sql`${role}`),
          )})
        `.execute(bootstrap)
      ).rows[0]?.count;
      if (capabilityRoleCount !== CATALOGUE_CAPABILITY_ROLES.length) {
        throw new Error("Catalogue authority integration requires all capability roles to exist");
      }
      const resourceCollision = (
        await sql<{ readonly exists: boolean }>`
          select
            exists (
              select 1
              from pg_catalog.pg_database as database_row
              where database_row.datname = ${ephemeralDatabaseName}
            ) or exists (
              select 1
              from pg_catalog.pg_roles as role_row
              where role_row.rolname in (${sql.join(fixtures.map((fixture) => sql`${fixture.login}`))})
            ) as exists
        `.execute(bootstrap)
      ).rows[0]?.exists;
      if (resourceCollision !== false) {
        throw new Error("Generated catalogue authority test resources already exist");
      }
      cleanupReserved = true;

      await sql`
        create database ${sql.id(ephemeralDatabaseName)}
        owner ${sql.id(databaseState.owner)}
        template template0
      `.execute(bootstrap);

      const ownerUrl = databaseUrlForName(databaseUrl, ephemeralDatabaseName);
      owner = createDatabase({
        applicationName: "catalogue-authority-deploy-zero-owner",
        connectionString: ownerUrl,
        maxConnections: 1,
      });
      const isolatedDatabaseState = (
        await sql<{
          readonly database_name: string;
          readonly database_owner: string;
          readonly public_schema_owner: string;
          readonly session_principal: string;
        }>`
          select
            pg_catalog.current_database() as database_name,
            pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner,
            pg_catalog.pg_get_userbyid(namespace_row.nspowner) as public_schema_owner,
            session_user as session_principal
          from pg_catalog.pg_database as database_row
          cross join pg_catalog.pg_namespace as namespace_row
          where database_row.datname = pg_catalog.current_database()
            and namespace_row.nspname = 'public'
        `.execute(owner)
      ).rows[0];
      if (
        !isolatedDatabaseState ||
        isolatedDatabaseState.database_name !== ephemeralDatabaseName ||
        isolatedDatabaseState.database_owner !== databaseState.owner ||
        isolatedDatabaseState.session_principal !== databaseState.owner ||
        isolatedDatabaseState.public_schema_owner !== "pg_database_owner"
      ) {
        throw new Error("Ephemeral database does not have the canonical owner and public schema");
      }
      await runMigrations(owner);

      await sql`
        revoke connect on database ${sql.id(ephemeralDatabaseName)} from public
      `.execute(bootstrap);
      const validUntil = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      for (const fixture of fixtures) {
        await sql`
          create role ${sql.id(fixture.login)}
          login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
          connection limit 1
          password ${sql.lit(fixture.password)}
          valid until ${sql.lit(validUntil)}
        `.execute(bootstrap);
        await sql`
          grant connect on database ${sql.id(ephemeralDatabaseName)} to ${sql.id(fixture.login)}
        `.execute(bootstrap);
        if (fixture.capability) {
          await sql`
            grant ${sql.id(fixture.capability)} to ${sql.id(fixture.login)}
            with admin false, inherit true, set false
          `.execute(bootstrap);
        }
      }

      const effectiveLoginAllowlist = (
        await sql<{ readonly name: string }>`
          select role_row.rolname as name
          from pg_catalog.pg_roles as role_row
          where role_row.rolcanlogin
            and pg_catalog.has_database_privilege(
              role_row.oid,
              pg_catalog.current_database(),
              'CONNECT'
            )
          order by role_row.rolname
        `.execute(owner)
      ).rows.map((row) => row.name);
      const policy: CatalogueAuthorityDeploymentPolicy = parseCatalogueAuthorityDeploymentPolicy({
        activationGuardSourceSha256: CATALOGUE_ACTIVATION_GUARD_SOURCE_SHA256,
        applicationSchema: "public",
        applicationSchemaOwner: "pg_database_owner",
        approvalFunctionSourceSha256: CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
        approvalGuardSourceSha256: CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
        databaseName: ephemeralDatabaseName,
        databaseOwner: databaseState.owner,
        effectiveLoginAllowlist,
        nonReviewerLogins,
        observeValidationFunctionSourceSha256: CATALOGUE_OBSERVE_VALIDATION_FUNCTION_SOURCE_SHA256,
        policyKind: "catalogue-authority-deployment",
        promotionFunctionSourceSha256: CATALOGUE_PROMOTION_FUNCTION_SOURCE_SHA256,
        reviewerLogins,
        rollbackFunctionSourceSha256: CATALOGUE_ROLLBACK_FUNCTION_SOURCE_SHA256,
        schemaVersion: 4,
        stageBatchFunctionSourceSha256: CATALOGUE_STAGE_BATCH_FUNCTION_SOURCE_SHA256,
        stageParserReportFunctionSourceSha256: CATALOGUE_STAGE_PARSER_REPORT_FUNCTION_SOURCE_SHA256,
        stageRecordChunkFunctionSourceSha256: CATALOGUE_STAGE_RECORD_CHUNK_FUNCTION_SOURCE_SHA256,
        stageValidateGuardSourceSha256: CATALOGUE_STAGE_VALIDATE_GUARD_SOURCE_SHA256,
        validateBatchFunctionSourceSha256: CATALOGUE_VALIDATE_BATCH_FUNCTION_SOURCE_SHA256,
      });

      for (const fixture of fixtures) {
        const loginUrl = new URL(ownerUrl);
        loginUrl.username = fixture.login;
        loginUrl.password = fixture.password;
        const client = createDatabase({
          applicationName: `catalogue-authority-deploy-zero-${fixture.roleClass}`,
          connectionString: loginUrl.toString(),
          maxConnections: 1,
        });
        loginClients.push(client);
        clientByLogin.set(fixture.login, client);
      }
      const requireClient = (login: string): Kysely<Database> => {
        const client = clientByLogin.get(login);
        if (!client) throw new Error("Catalogue authority test login client is unavailable");
        return client;
      };
      const verifierOwner = owner;
      if (!verifierOwner) throw new Error("Catalogue authority owner client is unavailable");

      const runCanaries = () =>
        runCatalogueReviewerCanaries(
          {
            nonReviewers: {
              api: requireClient(nonReviewerLogins.api),
              unassigned: requireClient(nonReviewerLogins.unassigned),
              worker: requireClient(nonReviewerLogins.worker),
            },
            owner: verifierOwner,
            reviewers: {
              data: requireClient(reviewerLogins.data),
              quality: requireClient(reviewerLogins.quality),
              rights: requireClient(reviewerLogins.rights),
            },
          },
          policy,
        );
      const assertCurrentTriggerSetRejected = async (): Promise<void> => {
        await expect(runCanaries()).rejects.toThrow(/trigger set/u);
      };

      const evidence = await runCanaries();

      expect(evidence.policySha256).toBe(catalogueAuthorityDeploymentPolicySha256(policy));
      expect(evidence.beforeApprovalRowCount).toBe("0");
      expect(evidence.afterApprovalRowCount).toBe(evidence.beforeApprovalRowCount);
      expect(evidence.afterStructureSha256).toBe(evidence.beforeStructureSha256);
      expect(evidence.results).toEqual([
        { canary: "data-matching", sqlstate: "23503" },
        { canary: "quality-matching", sqlstate: "23503" },
        { canary: "rights-matching", sqlstate: "23503" },
        { canary: "data-requesting-quality", sqlstate: "42501" },
        { canary: "api-execute", sqlstate: "42501" },
        { canary: "unassigned-execute", sqlstate: "42501" },
        { canary: "worker-execute", sqlstate: "42501" },
        { canary: "data-direct-dml", sqlstate: "42501" },
      ]);
      const observedTriggerNames = evidence.structure.triggers.map((trigger) => trigger.name);
      expect(observedTriggerNames).toHaveLength(52);
      expect(observedTriggerNames).not.toContain("app_user_set_updated_at");
      expect(observedTriggerNames).toContain("food_version_reject_update");

      const verifierSessions = await Promise.all(
        [verifierOwner, ...fixtures.map((fixture) => requireClient(fixture.login))].map(
          async (client) => {
            const session = (
              await sql<{
                readonly application_name: string;
                readonly login: string;
                readonly pid: number;
              }>`
                select
                  pg_catalog.current_setting('application_name') as application_name,
                  pg_catalog.pg_backend_pid() as pid,
                  session_user as login
              `.execute(client)
            ).rows[0];
            if (!session) throw new Error("Catalogue authority verifier session is unavailable");
            return {
              applicationName: session.application_name,
              login: session.login,
              pid: session.pid,
            };
          },
        ),
      );

      const temporaryTriggerName = "food_import_batch_guard_validation_digest";
      const temporaryTableName = "food_import_batch";
      await sql.raw("begin").execute(verifierOwner);
      try {
        await sql`
          create temporary table ${sql.id(temporaryTableName)} (id integer)
        `.execute(verifierOwner);
        await sql`
          create trigger ${sql.id(temporaryTriggerName)}
          before insert or update on ${sql.id(temporaryTableName)}
          for each row
          execute function public.guard_food_import_batch_validation_digest()
        `.execute(verifierOwner);

        const extraTemporaryBinding = await collectCatalogueAuthorityDeploymentEvidence(
          verifierOwner,
          policy,
          verifierSessions,
        );
        const publicTrigger = extraTemporaryBinding.triggers.find(
          (trigger) =>
            trigger.name === temporaryTriggerName &&
            trigger.tableSchema === policy.applicationSchema,
        );
        const baselineTrigger = evidence.structure.triggers.find(
          (trigger) => trigger.name === temporaryTriggerName,
        );
        const temporaryTrigger = extraTemporaryBinding.triggers.find(
          (trigger) =>
            trigger.name === temporaryTriggerName && /^pg_temp_\d+$/u.test(trigger.tableSchema),
        );
        if (!baselineTrigger || !publicTrigger || !temporaryTrigger) {
          throw new Error("Expected public and temporary trigger evidence is unavailable");
        }
        expect(temporaryTrigger).toEqual({
          ...baselineTrigger,
          tableSchema: temporaryTrigger.tableSchema,
        });
        expect(() =>
          assertCatalogueAuthorityDeploymentEvidence(policy, extraTemporaryBinding),
        ).toThrow(/trigger set/u);

        await sql`
          drop trigger ${sql.id(temporaryTriggerName)}
          on ${sql.id(policy.applicationSchema, temporaryTableName)}
        `.execute(verifierOwner);
        const temporaryReplacement = await collectCatalogueAuthorityDeploymentEvidence(
          verifierOwner,
          policy,
          verifierSessions,
        );
        expect(temporaryReplacement.nonSystemSchemas).toEqual([policy.applicationSchema]);
        const replacementTrigger = temporaryReplacement.triggers.filter(
          (trigger) => trigger.name === temporaryTriggerName,
        );
        expect(replacementTrigger).toEqual([temporaryTrigger]);
        expect(() =>
          assertCatalogueAuthorityDeploymentEvidence(policy, temporaryReplacement),
        ).toThrow(/trigger .* differs/u);
      } finally {
        await sql.raw("rollback").execute(verifierOwner);
      }
      const postTemporaryEvidence = await collectCatalogueAuthorityDeploymentEvidence(
        verifierOwner,
        policy,
        verifierSessions,
      );
      expect(() =>
        assertCatalogueAuthorityDeploymentEvidence(policy, postTemporaryEvidence),
      ).not.toThrow();

      const crossSchema = `cat_dep_trigger_binding_${token}`;
      const crossSchemaTable = "serving_shadow";
      const crossSchemaTrigger = "unreviewed_cross_schema_food_search_serving_binding";
      await sql`
        create schema ${sql.id(crossSchema)}
        authorization ${sql.id(databaseState.owner)}
      `.execute(owner);
      await sql`
        create table ${sql.id(crossSchema, crossSchemaTable)} (
          food_version_id bigint not null
        )
      `.execute(owner);
      await sql`
        create trigger ${sql.id(crossSchemaTrigger)}
        after insert on ${sql.id(crossSchema, crossSchemaTable)}
        referencing new table as new_food_search_servings
        for each statement execute function public.enqueue_food_search_serving_insert()
      `.execute(owner);
      const crossSchemaEvidence = await collectCatalogueAuthorityDeploymentEvidence(
        verifierOwner,
        policy,
        verifierSessions,
      );
      expect(crossSchemaEvidence.triggers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            functionName: "enqueue_food_search_serving_insert",
            functionSchema: policy.applicationSchema,
            name: crossSchemaTrigger,
            tableName: crossSchemaTable,
            tableSchema: crossSchema,
          }),
        ]),
      );
      await sql`
        drop trigger ${sql.id(crossSchemaTrigger)}
        on ${sql.id(crossSchema, crossSchemaTable)}
      `.execute(owner);
      await sql`drop table ${sql.id(crossSchema, crossSchemaTable)}`.execute(owner);
      await sql`drop schema ${sql.id(crossSchema)}`.execute(owner);

      await sql`
        create trigger unreviewed_food_search_barcode_insert_binding
        after insert on food_barcode
        referencing new table as new_food_search_barcodes
        for each statement execute function enqueue_food_search_barcode_insert()
      `.execute(owner);
      await assertCurrentTriggerSetRejected();
      await sql`
        drop trigger unreviewed_food_search_barcode_insert_binding on food_barcode
      `.execute(owner);

      await sql`
        create trigger unreviewed_food_search_barcode_update_binding
        after update on food_barcode
        referencing old table as old_food_search_barcodes new table as new_food_search_barcodes
        for each statement execute function enqueue_food_search_barcode_update()
      `.execute(owner);
      await assertCurrentTriggerSetRejected();
      await sql`
        drop trigger unreviewed_food_search_barcode_update_binding on food_barcode
      `.execute(owner);

      await sql`
        create trigger unreviewed_food_search_food_eligibility_binding
        after update on food
        referencing old table as old_food_search_rows new table as new_food_search_rows
        for each statement execute function enqueue_food_search_food_eligibility_change()
      `.execute(owner);
      await assertCurrentTriggerSetRejected();
      await sql`
        drop trigger unreviewed_food_search_food_eligibility_binding on food
      `.execute(owner);

      await sql`
        create trigger unreviewed_food_search_serving_insert_binding
        after insert on food_serving
        referencing new table as new_food_search_servings
        for each statement execute function enqueue_food_search_serving_insert()
      `.execute(owner);
      await assertCurrentTriggerSetRejected();
      await sql`
        drop trigger unreviewed_food_search_serving_insert_binding on food_serving
      `.execute(owner);

      await sql`
        create trigger food_search_eligibility_outbox
        before update on app_user
        for each row execute function set_row_updated_at()
      `.execute(owner);
      await assertCurrentTriggerSetRejected();
      await sql`
        drop trigger food_search_eligibility_outbox on app_user
      `.execute(owner);

      const backdoorSchema = `cat_dep_backdoor_${token}`;
      const backdoorFunction = "catalogue_backdoor_mutate_batch";
      await sql`
        create schema ${sql.id(backdoorSchema)}
        authorization ${sql.id(databaseState.owner)}
      `.execute(owner);
      await sql`
        create function ${sql.id(backdoorSchema, backdoorFunction)}()
        returns void
        language plpgsql
        security definer
        set search_path = pg_catalog, public, pg_temp
        as $catalogue_backdoor$
        begin
          update public.food_import_batch as batch_row
          set status = batch_row.status
          where false;
        end;
        $catalogue_backdoor$
      `.execute(owner);
      await sql`
        grant usage on schema ${sql.id(backdoorSchema)}
        to ${sql.id(reviewerLogins.data)}
      `.execute(owner);
      const backdoorCallable = (
        await sql<{
          readonly function_execute: boolean;
          readonly schema_usage: boolean;
        }>`
          select
            pg_catalog.has_schema_privilege(
              ${reviewerLogins.data},
              ${backdoorSchema},
              'USAGE'
            ) as schema_usage,
            pg_catalog.has_function_privilege(
              ${reviewerLogins.data},
              pg_catalog.to_regprocedure(
                ${`${backdoorSchema}.${backdoorFunction}()`}
              ),
              'EXECUTE'
            ) as function_execute
        `.execute(owner)
      ).rows[0];
      expect(backdoorCallable).toEqual({ function_execute: true, schema_usage: true });
      await expect(runCanaries()).rejects.toThrow(/non-system schema set/u);
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

      for (const client of loginClients) {
        await attemptCleanup(() => client.destroy());
      }
      const ownerClient = owner;
      if (ownerClient) await attemptCleanup(() => ownerClient.destroy());

      if (cleanupReserved) {
        await attemptCleanup(() =>
          sql`drop database if exists ${sql.id(ephemeralDatabaseName)}`.execute(bootstrap),
        );
        for (const fixture of [...fixtures].reverse()) {
          await attemptCleanup(() =>
            sql`drop role if exists ${sql.id(fixture.login)}`.execute(bootstrap),
          );
        }
        await attemptCleanup(async () => {
          const residue = (
            await sql<{ readonly exists: boolean }>`
              select
                exists (
                  select 1
                  from pg_catalog.pg_database as database_row
                  where database_row.datname = ${ephemeralDatabaseName}
                ) or exists (
                  select 1
                  from pg_catalog.pg_roles as role_row
                  where role_row.rolname in (${sql.join(
                    fixtures.map((fixture) => sql`${fixture.login}`),
                  )})
                ) as exists
            `.execute(bootstrap)
          ).rows[0]?.exists;
          if (residue !== false) {
            throw new Error(
              "Catalogue authority integration cleanup left database or role residue",
            );
          }
        });
      }
      await attemptCleanup(() => bootstrap.destroy());
    }

    if (primaryFailure !== undefined || cleanupFailures.length > 0) {
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
        "Catalogue authority deployment integration test or cleanup failed",
      );
    }
  });
});

describe("catalogue authority deployment test endpoint guard", () => {
  it.each([
    "postgresql://tester:local-only@127.0.0.1:5432/nutrition_test",
    "postgres://tester:local-only@[::1]:5432/nutrition_test",
  ])("accepts literal loopback %s", (connectionString) => {
    expect(() => assertLoopbackDatabaseUrl(connectionString)).not.toThrow();
  });

  it.each([
    "postgresql://tester:local-only@localhost:5432/nutrition_test",
    "postgresql://tester:local-only@database.internal:5432/nutrition_test",
    "postgresql://tester:local-only@127.0.0.1:5432/nutrition_test?host=database.internal",
    "postgresql://tester:local-only@127.0.0.1:5432/nutrition_test?options=-csearch_path%3Dunsafe",
    "postgresql://tester:local-only@127.0.0.1:5432/nutrition_test#unsafe",
    "https://127.0.0.1:5432/nutrition_test",
    "not-a-url",
  ])("rejects non-literal-loopback endpoint %s", (connectionString) => {
    expect(() => assertLoopbackDatabaseUrl(connectionString)).toThrow(/literal loopback/u);
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
