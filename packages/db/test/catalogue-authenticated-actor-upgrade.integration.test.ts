import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createDatabase, type Database, discoverMigrations, runMigrations } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const migrationName = "0022_catalogue_authenticated_actor_binding.sql";
const preflightMessage =
  "catalogue authenticated actor binding found capability-mediated audit labels that differ from database principals";

describeDatabase("0022 authenticated catalogue actor upgrade", { timeout: 120_000 }, () => {
  it.each(["approval", "activation"] as const)(
    "rejects and atomically retains a historical mismatched %s actor",
    async (mismatchKind) => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
      const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
      const token = randomBytes(6).toString("hex");
      const schemaName = `catalogue_actor_upgrade_${token}`;
      const migrationDirectory = await mkdtemp(resolve(tmpdir(), "catalogue-actor-0021-"));
      let database: Kysely<Database> | undefined;

      try {
        await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
        const scopedUrl = new URL(databaseUrl);
        scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
        database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 1 });

        const migrations = await discoverMigrations();
        const migrationIndex = migrations.findIndex(
          (migration) => migration.name === migrationName,
        );
        expect(migrationIndex).toBeGreaterThan(0);
        expect(migrations[migrationIndex - 1]?.name).toBe(
          "0021_catalogue_nutrition_semantic_recheck.sql",
        );
        for (const migration of migrations.slice(0, migrationIndex)) {
          await writeFile(resolve(migrationDirectory, migration.name), migration.sql, "utf8");
        }
        await runMigrations(database, { directory: migrationDirectory });

        const fixture = await seedPendingAuthorityFixture(database, token);
        if (mismatchKind === "approval") {
          await withDisabledTrigger(
            database,
            "food_import_approval",
            "food_import_approval_guard_authority",
            () =>
              sql`
                insert into food_import_approval (
                  approval_reference, approval_role, batch_id,
                  database_capability_role, database_principal, principal_id,
                  rights_manifest_sha256, validation_digest
                ) values (
                  'review://historical-mismatched-actor', 'data', ${fixture.batchId}::uuid,
                  'nutrition_catalogue_approve_data', 'historical_data_login',
                  'principal:spoofed-historical-data', ${"b".repeat(64)}, ${"d".repeat(64)}
                )
              `.execute(database as Kysely<Database>),
          );
        } else {
          await withDisabledTrigger(
            database,
            "food_source_release_activation",
            "food_source_release_activation_guard_authority",
            () =>
              sql`
                insert into food_source_release_activation (
                  food_source_id, operation, reason, performed_by,
                  database_principal, database_capability_role
                ) values (
                  ${fixture.sourceId}::bigint, 'deactivate',
                  'Historical mismatched database actor', 'principal:spoofed-historical-rollback',
                  'historical_rollback_login', 'nutrition_catalogue_rollback'
                )
              `.execute(database as Kysely<Database>),
          );
        }

        const authorityBefore = await collectAuthorityState(database);
        const dirtyRowsBefore = await collectDirtyRows(database);
        expect(dirtyRowsBefore[mismatchKind]).toHaveLength(1);
        expect(authorityBefore.functions).toEqual([
          {
            name: "catalogue_promote_import_batch",
            source_sha256: "309861b6850a99bb565466981602ee19054b9c2500dfee21bf27edc6be382111",
          },
          {
            name: "catalogue_record_import_approval",
            source_sha256: "abb0ca990b74fedffd4ec77cf666e404da89af8158f4b990b6c0de48cd3dfc41",
          },
          {
            name: "catalogue_rollback_source_release",
            source_sha256: "56e9fa2cce7f532c1f405658ff9f07908394d0fb9734b70d0bdb92a12292068a",
          },
        ]);

        await expectPostgresFailure(runMigrations(database), "55000", preflightMessage);

        expect(await collectAuthorityState(database)).toEqual(authorityBefore);
        expect(await collectDirtyRows(database)).toEqual(dirtyRowsBefore);
        expect(
          (
            await sql<{ count: number }>`
              select pg_catalog.count(*)::integer as count
              from app_schema_migration
              where name = ${migrationName}
            `.execute(database)
          ).rows[0],
        ).toEqual({ count: 0 });
      } finally {
        await database?.destroy();
        try {
          await sql`drop schema if exists ${sql.id(schemaName)} cascade`.execute(bootstrap);
        } finally {
          await bootstrap.destroy();
          await rm(migrationDirectory, { force: true, recursive: true });
        }
      }
    },
  );
});

async function seedPendingAuthorityFixture(
  database: Kysely<Database>,
  token: string,
): Promise<{ readonly batchId: string; readonly sourceId: string }> {
  const source = (
    await sql<{ id: string }>`
      insert into food_source (
        active, attribution_required, attribution_text, code,
        commercial_use_allowed, database_rights_notes, display_name,
        homepage_url, kind, license_expression, license_url,
        redistribution_allowed, rights_review_status, rights_reviewed_at,
        rights_reviewed_by
      ) values (
        true, true, '0022 upgrade fixture', ${`UA${token.toUpperCase()}`},
        true, 'Reviewed test fixture', 'Authenticated actor upgrade source',
        'https://example.invalid/catalogue-actor-upgrade', 'government', 'CC0-1.0',
        'https://creativecommons.org/publicdomain/zero/1.0/', true, 'approved',
        pg_catalog.clock_timestamp(), 'principal:upgrade-fixture'
      )
      returning id
    `.execute(database)
  ).rows[0];
  if (!source) throw new Error("0022 upgrade source fixture was not created");

  const artifactDigest = randomBytes(32).toString("hex");
  const evidenceDigest = "e".repeat(64);
  const batch = (
    await sql<{ id: string }>`
      insert into food_import_batch (
        acquired_at, artifact_bytes, artifact_sha256, artifact_uri,
        evidence_bundle_sha256, evidence_bundle_uri, evidence_decision_sha256,
        evidence_object_version_id, evidence_valid_until, food_source_id,
        media_type, parser_version, release_class, release_key,
        rights_manifest_sha256, rights_manifest_uri
      ) values (
        pg_catalog.clock_timestamp(), 1, ${artifactDigest},
        ${`s3://catalogue-artifacts/${artifactDigest}.json`}, ${evidenceDigest},
        ${`s3://catalogue-evidence/sha256/${evidenceDigest}/bundle.json`},
        ${"f".repeat(64)}, ${`actor-upgrade-${token}`},
        pg_catalog.clock_timestamp() + interval '12 hours', ${source.id}::bigint,
        'application/json', 'actor-upgrade@1', 'live-reviewed',
        ${`actor-upgrade-${token}`}, ${"b".repeat(64)},
        'repo://catalogue-actor-upgrade-rights.json'
      )
      returning id
    `.execute(database)
  ).rows[0];
  if (!batch) throw new Error("0022 upgrade batch fixture was not created");
  return { batchId: batch.id, sourceId: source.id };
}

async function withDisabledTrigger(
  database: Kysely<Database>,
  tableName: string,
  triggerName: string,
  insertDirtyRow: () => Promise<unknown>,
): Promise<void> {
  await sql`alter table ${sql.id(tableName)} disable trigger ${sql.id(triggerName)}`.execute(
    database,
  );
  try {
    await insertDirtyRow();
  } finally {
    await sql`alter table ${sql.id(tableName)} enable trigger ${sql.id(triggerName)}`.execute(
      database,
    );
  }
}

async function collectAuthorityState(database: Kysely<Database>) {
  const constraints = (
    await sql<{ definition: string; name: string }>`
      select
        constraint_row.conname as name,
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
      from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid in (
        'food_import_approval'::pg_catalog.regclass,
        'food_source_release_activation'::pg_catalog.regclass
      )
        and constraint_row.conname in (
          'food_import_approval_database_authority_check',
          'food_source_release_activation_database_authority_check'
        )
      order by constraint_row.conname
    `.execute(database)
  ).rows;
  const functions = (
    await sql<{ name: string; source_sha256: string }>`
      select
        procedure_row.proname as name,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
          'hex'
        ) as source_sha256
      from pg_catalog.pg_proc as procedure_row
      where procedure_row.oid in (
        'catalogue_record_import_approval(uuid,text,text,text,text,text)'::pg_catalog.regprocedure,
        'catalogue_promote_import_batch(uuid,text,text)'::pg_catalog.regprocedure,
        'catalogue_rollback_source_release(text,uuid,text,text)'::pg_catalog.regprocedure
      )
      order by procedure_row.proname
    `.execute(database)
  ).rows;
  return { constraints, functions };
}

async function collectDirtyRows(database: Kysely<Database>) {
  const approval = (
    await sql<{
      database_capability_role: string;
      database_principal: string;
      principal_id: string;
    }>`
      select database_capability_role, database_principal, principal_id
      from food_import_approval
      where database_principal is not null
        and principal_id is distinct from database_principal
      order by id
    `.execute(database)
  ).rows;
  const activation = (
    await sql<{
      database_capability_role: string;
      database_principal: string;
      performed_by: string;
    }>`
      select database_capability_role, database_principal, performed_by
      from food_source_release_activation
      where database_principal is not null
        and performed_by is distinct from database_principal
      order by id
    `.execute(database)
  ).rows;
  return { activation, approval };
}

async function expectPostgresFailure(
  operation: Promise<unknown>,
  expectedCode: string,
  expectedMessage: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    code: expectedCode,
    message: expect.stringContaining(expectedMessage),
  });
}
