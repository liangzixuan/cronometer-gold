import { randomBytes } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";

import { createDatabase, type Database, discoverMigrations, runMigrations } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const capabilityRoles = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
] as const;

interface ApprovalCall {
  readonly approvalReference: string;
  readonly approvalRole: "data" | "quality" | "rights";
  readonly batchId: string;
  readonly principalId: string;
  readonly rightsDigest: string;
  readonly validationDigest: string;
}

interface LoginCredential {
  readonly additionalCapabilities?: readonly (typeof capabilityRoles)[number][];
  readonly capability: (typeof capabilityRoles)[number] | null;
  readonly login: string;
  readonly password: string;
}

interface PromotionResult {
  readonly activatedReleaseId: string;
  readonly materializedCount: number;
  readonly previousReleaseId: string | null;
  readonly wasAlreadyCompleted: boolean;
}

interface RollbackResult {
  readonly activeReleaseId: string | null;
  readonly changed: boolean;
  readonly previousReleaseId: string | null;
}

describeDatabase("catalogue database authority boundary", { timeout: 60_000 }, () => {
  it("records exact approvals through separated real-login capabilities only", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `catalogue_authority_${token}`;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const owner = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    const roleClients: Kysely<Database>[] = [];
    const credentials: LoginCredential[] = [
      {
        capability: "nutrition_catalogue_approve_data",
        login: `cat_data_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      {
        capability: "nutrition_catalogue_approve_quality",
        login: `cat_quality_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      {
        capability: "nutrition_catalogue_approve_rights",
        login: `cat_rights_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      {
        capability: null,
        login: `cat_unassigned_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      {
        capability: "nutrition_catalogue_promote_activate",
        login: `cat_promote_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      {
        capability: "nutrition_catalogue_rollback",
        login: `cat_rollback_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      {
        capability: "nutrition_catalogue_validate",
        login: `cat_validate_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      {
        additionalCapabilities: ["nutrition_catalogue_rollback"],
        capability: "nutrition_catalogue_promote_activate",
        login: `cat_multi_${token}`,
        password: randomBytes(24).toString("hex"),
      },
    ];

    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    try {
      await runMigrations(owner);
      const functionIdentity = `${schemaName}.catalogue_record_import_approval(uuid,text,text,text,text,text)`;

      const roleRows = (
        await sql<{
          outgoing_membership: boolean;
          rolbypassrls: boolean;
          rolcanlogin: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolname: string;
          rolreplication: boolean;
          rolsuper: boolean;
        }>`
          select
            role_row.rolname,
            role_row.rolcanlogin,
            role_row.rolsuper,
            role_row.rolcreatedb,
            role_row.rolcreaterole,
            role_row.rolreplication,
            role_row.rolbypassrls,
            exists (
              select 1
              from pg_catalog.pg_auth_members as membership
              where membership.member = role_row.oid
            ) as outgoing_membership
          from pg_catalog.pg_roles as role_row
          where role_row.rolname like 'nutrition_catalogue_%'
        `.execute(owner)
      ).rows.filter((row) =>
        capabilityRoles.includes(row.rolname as (typeof capabilityRoles)[number]),
      );
      expect(roleRows).toHaveLength(capabilityRoles.length);
      for (const role of roleRows) {
        expect(role).toMatchObject({
          outgoing_membership: false,
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolsuper: false,
        });
      }

      const functionPolicy = (
        await sql<{
          owner_name: string;
          table_owner_name: string;
          proconfig: string[] | null;
          prosecdef: boolean;
          public_execute: boolean;
        }>`
          select
            pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner_name,
            pg_catalog.pg_get_userbyid((
              select table_row.relowner
              from pg_catalog.pg_class as table_row
              where table_row.oid = pg_catalog.to_regclass(${`${schemaName}.food_import_approval`})
            )) as table_owner_name,
            procedure_row.proconfig,
            procedure_row.prosecdef,
            exists (
              select 1
              from pg_catalog.aclexplode(procedure_row.proacl) as acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            ) as public_execute
          from pg_catalog.pg_proc as procedure_row
          where procedure_row.oid = pg_catalog.to_regprocedure(${functionIdentity})
        `.execute(owner)
      ).rows[0];
      expect(functionPolicy).toMatchObject({ prosecdef: true, public_execute: false });
      expect(functionPolicy?.owner_name).toBe(functionPolicy?.table_owner_name);
      expect(functionPolicy?.proconfig).toContain(`search_path=pg_catalog, ${schemaName}, pg_temp`);

      for (const capability of capabilityRoles) {
        const expectedExecute = capability.startsWith("nutrition_catalogue_approve_");
        expect(
          (
            await sql<{ allowed: boolean }>`
              select pg_catalog.has_function_privilege(
                ${capability},
                ${functionIdentity},
                'execute'
              ) as allowed
            `.execute(owner)
          ).rows[0]?.allowed,
        ).toBe(expectedExecute);
        for (const tableName of [
          "food",
          "food_barcode",
          "food_import_batch",
          "food_import_approval",
          "food_import_record",
          "food_nutrient_value",
          "food_search_projection_revision",
          "food_serving",
          "food_source",
          "food_source_release",
          "food_source_release_activation",
          "food_version",
          "outbox_event",
        ]) {
          for (const privilege of ["select", "insert", "update", "delete"]) {
            expect(
              (
                await sql<{ allowed: boolean }>`
                  select pg_catalog.has_table_privilege(
                    ${capability},
                    ${`${schemaName}.${tableName}`},
                    ${privilege}
                  ) as allowed
                `.execute(owner)
              ).rows[0]?.allowed,
            ).toBe(false);
          }
        }
        for (const sequenceName of [
          "food_barcode_id_seq",
          "food_id_seq",
          "food_import_approval_id_seq",
          "food_serving_id_seq",
          "food_source_release_activation_id_seq",
          "food_version_id_seq",
        ]) {
          for (const privilege of ["usage", "select", "update"]) {
            expect(
              (
                await sql<{ allowed: boolean }>`
                  select pg_catalog.has_sequence_privilege(
                    ${capability},
                    ${`${schemaName}.${sequenceName}`},
                    ${privilege}
                  ) as allowed
                `.execute(owner)
              ).rows[0]?.allowed,
            ).toBe(false);
          }
        }
      }

      const validUntil = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      for (const credential of credentials) {
        await sql
          .raw(
            `create role ${credential.login} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${credential.password}' valid until '${validUntil}'`,
          )
          .execute(bootstrap);
        const grantedCapabilities = [
          ...(credential.capability ? [credential.capability] : []),
          ...(credential.additionalCapabilities ?? []),
        ];
        for (const capability of grantedCapabilities) {
          await sql.raw(`grant ${capability} to ${credential.login}`).execute(bootstrap);
        }
      }

      const clients = credentials.map((credential) => {
        const loginUrl = new URL(databaseUrl);
        loginUrl.username = credential.login;
        loginUrl.password = credential.password;
        loginUrl.searchParams.set("options", `-csearch_path=pg_temp,${schemaName},public`);
        const client = createDatabase({
          applicationName: `catalogue-authority-${credential.login}`,
          connectionString: loginUrl.toString(),
          maxConnections: 1,
        });
        roleClients.push(client);
        return client;
      });
      const [
        dataReviewer,
        qualityReviewer,
        rightsReviewer,
        unassignedReviewer,
        promoteOperator,
        rollbackOperator,
        validateOperator,
        multiCapabilityOperator,
      ] = clients;
      if (
        !dataReviewer ||
        !qualityReviewer ||
        !rightsReviewer ||
        !unassignedReviewer ||
        !promoteOperator ||
        !rollbackOperator ||
        !validateOperator ||
        !multiCapabilityOperator
      ) {
        throw new Error("reviewer database clients were not created");
      }

      const validationDigest = "d".repeat(64);
      const rightsDigest = "b".repeat(64);
      const { batchId, sourceCode, sourceId } = await seedReadyBatch(
        owner,
        token,
        validationDigest,
        rightsDigest,
      );
      const dataCall: ApprovalCall = {
        approvalReference: "review://authority/data",
        approvalRole: "data",
        batchId,
        principalId: "principal:authority-data",
        rightsDigest,
        validationDigest,
      };

      await expectPostgresCode(recordApproval(unassignedReviewer, schemaName, dataCall), "42501");
      await expectPostgresCode(
        recordApproval(dataReviewer, schemaName, { ...dataCall, approvalRole: "quality" }),
        "42501",
      );
      await expectPostgresCode(
        recordApproval(dataReviewer, schemaName, {
          ...dataCall,
          validationDigest: "a".repeat(64),
        }),
        "23514",
      );
      await expectPostgresCode(
        recordApproval(dataReviewer, schemaName, { ...dataCall, rightsDigest: "c".repeat(64) }),
        "23514",
      );
      await expectPostgresCode(
        sql`
          insert into ${sql.id(schemaName)}.food_import_approval (
            approval_reference, approval_role, batch_id, principal_id,
            rights_manifest_sha256, validation_digest
          ) values (
            'review://direct', 'data', ${batchId}::uuid, 'principal:direct',
            ${rightsDigest}, ${validationDigest}
          )
        `.execute(dataReviewer),
        "42501",
      );
      await expectPostgresCode(
        sql`
          insert into ${sql.id(schemaName)}.food_source_release_activation (
            food_source_id, operation, reason, performed_by, database_principal
          ) values (
            ${sourceId}::bigint, 'deactivate', 'Reject unpaired database audit',
            'principal:authority-pair-check', 'cat_unpaired_audit'
          )
        `.execute(owner),
        "42501",
      );
      await expectPostgresCode(
        sql`
          insert into ${sql.id(schemaName)}.food_source_release_activation (
            food_source_id, operation, reason, performed_by,
            database_principal, database_capability_role
          ) values (
            ${sourceId}::bigint, 'deactivate', 'Reject paired activation forgery',
            'principal:authority-pair-forgery', 'cat_paired_audit',
            'nutrition_catalogue_rollback'
          )
        `.execute(owner),
        "42501",
      );

      await expect(recordApproval(dataReviewer, schemaName, dataCall)).resolves.toBe(true);
      await expect(recordApproval(dataReviewer, schemaName, dataCall)).resolves.toBe(false);
      await expectPostgresCode(
        recordApproval(dataReviewer, schemaName, {
          ...dataCall,
          approvalReference: "review://authority/data-changed",
        }),
        "23505",
        `Batch ${batchId} already has a different immutable approval`,
      );

      const qualityCall: ApprovalCall = {
        ...dataCall,
        approvalReference: "review://authority/quality",
        approvalRole: "quality",
        principalId: "principal:authority-quality",
      };
      await expect(recordApproval(qualityReviewer, schemaName, qualityCall)).resolves.toBe(true);

      await sql`create temporary table food_import_batch (id uuid)`.execute(rightsReviewer);
      await sql`create temporary table food_import_approval (id uuid)`.execute(rightsReviewer);
      const rightsCall: ApprovalCall = {
        ...dataCall,
        approvalReference: "review://authority/rights",
        approvalRole: "rights",
        principalId: "principal:authority-rights",
      };
      await expect(recordApproval(rightsReviewer, schemaName, rightsCall)).resolves.toBe(true);

      const approvals = (
        await sql<{
          approval_role: string;
          database_capability_role: string | null;
          database_principal: string | null;
        }>`
          select approval_role, database_capability_role, database_principal
          from food_import_approval
          where batch_id = ${batchId}::uuid
          order by approval_role
        `.execute(owner)
      ).rows;
      expect(approvals).toEqual([
        {
          approval_role: "data",
          database_capability_role: "nutrition_catalogue_approve_data",
          database_principal: credentials[0]?.login,
        },
        {
          approval_role: "quality",
          database_capability_role: "nutrition_catalogue_approve_quality",
          database_principal: credentials[1]?.login,
        },
        {
          approval_role: "rights",
          database_capability_role: "nutrition_catalogue_approve_rights",
          database_principal: credentials[2]?.login,
        },
      ]);

      await sql
        .raw(`grant nutrition_catalogue_approve_data to ${credentials[1]?.login}`)
        .execute(bootstrap);
      await expectPostgresCode(recordApproval(qualityReviewer, schemaName, qualityCall), "42501");

      const { batchId: ownerBatchId } = await seedReadyBatch(
        owner,
        `${token}f`,
        validationDigest,
        rightsDigest,
      );
      const ownerCall: ApprovalCall = {
        ...dataCall,
        approvalReference: "review://authority/owner-local",
        batchId: ownerBatchId,
        principalId: "principal:authority-owner-local",
      };
      await expect(recordApproval(owner, schemaName, ownerCall)).resolves.toBe(true);
      await expect(recordApproval(owner, schemaName, ownerCall)).resolves.toBe(false);
      expect(
        (
          await sql<{
            database_capability_role: string | null;
            database_principal: string | null;
          }>`
            select database_capability_role, database_principal
            from food_import_approval
            where batch_id = ${ownerBatchId}::uuid
          `.execute(owner)
        ).rows[0],
      ).toEqual({ database_capability_role: null, database_principal: null });

      const promoteFunctionIdentity = `${schemaName}.catalogue_promote_import_batch(uuid,text,text)`;
      const rollbackFunctionIdentity = `${schemaName}.catalogue_rollback_source_release(text,uuid,text,text)`;
      for (const capability of capabilityRoles) {
        expect(
          (
            await sql<{ allowed: boolean }>`
              select pg_catalog.has_function_privilege(
                ${capability},
                ${promoteFunctionIdentity},
                'execute'
              ) as allowed
            `.execute(owner)
          ).rows[0]?.allowed,
        ).toBe(capability === "nutrition_catalogue_promote_activate");
        expect(
          (
            await sql<{ allowed: boolean }>`
              select pg_catalog.has_function_privilege(
                ${capability},
                ${rollbackFunctionIdentity},
                'execute'
              ) as allowed
            `.execute(owner)
          ).rows[0]?.allowed,
        ).toBe(capability === "nutrition_catalogue_rollback");
      }

      await expectPostgresCode(
        promoteImportBatch(
          rollbackOperator,
          schemaName,
          batchId,
          "principal:wrong-role-promote",
          "Reject rollback capability on promotion",
        ),
        "42501",
      );
      await expectPostgresCode(
        promoteImportBatch(
          validateOperator,
          schemaName,
          batchId,
          "principal:validate-role-promote",
          "Reject validation capability on promotion",
        ),
        "42501",
      );
      await expectPostgresCode(
        promoteImportBatch(
          multiCapabilityOperator,
          schemaName,
          batchId,
          "principal:multi-role-promote",
          "Reject ambiguous multi-capability promotion",
        ),
        "42501",
      );

      const promotion = await promoteImportBatch(
        promoteOperator,
        schemaName,
        batchId,
        "principal:authority-promoter",
        "Exercise database-authenticated catalogue promotion",
      );
      expect(promotion).toMatchObject({
        materializedCount: 0,
        previousReleaseId: null,
        wasAlreadyCompleted: false,
      });
      expect(promotion.activatedReleaseId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(
        await promoteImportBatch(
          promoteOperator,
          schemaName,
          batchId,
          "principal:authority-promoter",
          "Exercise idempotent completed-batch replay",
        ),
      ).toEqual({ ...promotion, wasAlreadyCompleted: true });

      expect(
        (
          await sql<{
            database_capability_role: string | null;
            database_principal: string | null;
            operation: string;
          }>`
            select operation, database_principal, database_capability_role
            from food_source_release_activation
            where import_batch_id = ${batchId}::uuid
          `.execute(owner)
        ).rows[0],
      ).toEqual({
        database_capability_role: "nutrition_catalogue_promote_activate",
        database_principal: credentials[4]?.login,
        operation: "activate",
      });
      expect(
        (
          await sql<{ activation_count: number }>`
            select pg_catalog.count(*)::integer as activation_count
            from food_source_release_activation
            where import_batch_id = ${batchId}::uuid
          `.execute(owner)
        ).rows[0],
      ).toEqual({ activation_count: 1 });

      await expectPostgresCode(
        rollbackSourceRelease(
          promoteOperator,
          schemaName,
          sourceCode,
          null,
          "principal:wrong-role-rollback",
          "Reject promotion capability on rollback",
        ),
        "42501",
      );
      await expectPostgresCode(
        rollbackSourceRelease(
          multiCapabilityOperator,
          schemaName,
          sourceCode,
          null,
          "principal:multi-role-rollback",
          "Reject ambiguous multi-capability rollback",
        ),
        "42501",
      );

      expect(
        await rollbackSourceRelease(
          rollbackOperator,
          schemaName,
          sourceCode,
          null,
          "principal:authority-rollback",
          "Exercise database-authenticated catalogue deactivation",
        ),
      ).toEqual({
        activeReleaseId: null,
        changed: true,
        previousReleaseId: promotion.activatedReleaseId,
      });
      expect(
        (
          await sql<{
            database_capability_role: string | null;
            database_principal: string | null;
            operation: string;
          }>`
            select operation, database_principal, database_capability_role
            from food_source_release_activation
            where food_source_id = ${sourceId}::bigint
            order by id desc
            limit 1
          `.execute(owner)
        ).rows[0],
      ).toEqual({
        database_capability_role: "nutrition_catalogue_rollback",
        database_principal: credentials[5]?.login,
        operation: "deactivate",
      });

      expect(
        await rollbackSourceRelease(
          owner,
          schemaName,
          sourceCode,
          promotion.activatedReleaseId,
          "principal:authority-owner",
          "Exercise owner-local rollback audit semantics",
        ),
      ).toEqual({
        activeReleaseId: promotion.activatedReleaseId,
        changed: true,
        previousReleaseId: null,
      });
      expect(
        (
          await sql<{
            database_capability_role: string | null;
            database_principal: string | null;
            operation: string;
          }>`
            select operation, database_principal, database_capability_role
            from food_source_release_activation
            where food_source_id = ${sourceId}::bigint
            order by id desc
            limit 1
          `.execute(owner)
        ).rows[0],
      ).toEqual({
        database_capability_role: null,
        database_principal: null,
        operation: "rollback",
      });
    } finally {
      for (const client of roleClients) await client.destroy();
      await owner.destroy();
      try {
        await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      } finally {
        for (const credential of credentials.reverse()) {
          await sql.raw(`drop role if exists ${credential.login}`).execute(bootstrap);
        }
        await bootstrap.destroy();
      }
    }
  });

  it("replays a completed pre-0019 activation without fabricating frozen evidence", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `catalogue_authority_replay_${token}`;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({
      connectionString: scopedUrl.toString(),
      maxConnections: 1,
    });

    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    try {
      const migrations = await discoverMigrations();
      const promotionMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0019_catalogue_promotion_rollback_authority.sql",
      );
      expect(promotionMigrationIndex).toBeGreaterThan(0);
      expect(migrations[promotionMigrationIndex - 1]?.name).toBe(
        "0018_active_nutrient_registry_lock_protocol.sql",
      );
      for (const migration of migrations.slice(0, promotionMigrationIndex)) {
        await sql.raw(migration.sql).execute(database);
      }

      const legacy = await seedCompletedLegacyBatch(database, token);
      const promotionMigration = migrations[promotionMigrationIndex];
      if (!promotionMigration) throw new Error("0019 promotion migration was not discovered");
      await sql.raw(promotionMigration.sql).execute(database);

      expect(
        await promoteImportBatch(
          database,
          schemaName,
          legacy.batchId,
          "principal:legacy-replay",
          "Replay completed pre-0019 catalogue activation",
        ),
      ).toEqual({
        activatedReleaseId: legacy.releaseId,
        materializedCount: 0,
        previousReleaseId: null,
        wasAlreadyCompleted: true,
      });
      expect(
        (
          await sql<{
            activation_count: number;
            nutrient_mapping_digest: string | null;
            validated_food_contract_version: number | null;
          }>`
            select
              (
                select pg_catalog.count(*)::integer
                from food_source_release_activation
                where import_batch_id = ${legacy.batchId}::uuid
              ) as activation_count,
              nutrient_mapping_digest,
              validated_food_contract_version
            from food_import_batch
            where id = ${legacy.batchId}::uuid
          `.execute(database)
        ).rows[0],
      ).toEqual({
        activation_count: 1,
        nutrient_mapping_digest: null,
        validated_food_contract_version: null,
      });
    } finally {
      await database.destroy();
      try {
        await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      } finally {
        await bootstrap.destroy();
      }
    }
  });

  it("commits a guarded owner-only state across legacy activation evidence and membership", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `catalogue_authority_upgrade_${token}`;
    const memberRole = `cat_member_${token}`;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({
      connectionString: scopedUrl.toString(),
      maxConnections: 1,
    });

    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    try {
      const migrations = await discoverMigrations();
      const authorityMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0014_catalogue_workflow_authority_expand.sql",
      );
      const hardeningMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0015_catalogue_authority_expand_hardening.sql",
      );
      expect(authorityMigrationIndex).toBeGreaterThan(0);
      expect(hardeningMigrationIndex).toBe(authorityMigrationIndex + 1);

      for (const migration of migrations.slice(0, authorityMigrationIndex)) {
        await sql.raw(migration.sql).execute(database);
      }

      const authorityMigration = migrations[authorityMigrationIndex];
      const hardeningMigration = migrations[hardeningMigrationIndex];
      if (!authorityMigration) throw new Error("0014 authority migration was not discovered");
      if (!hardeningMigration) throw new Error("0015 hardening migration was not discovered");
      await sql.raw(authorityMigration.sql).execute(database);

      const functionIdentity = `${schemaName}.catalogue_record_import_approval(uuid,text,text,text,text,text)`;
      const { sourceId } = await seedReadyBatch(
        database,
        `${token}l`,
        "d".repeat(64),
        "b".repeat(64),
      );
      const legacyActivation = (
        await sql<{ id: string }>`
          insert into food_source_release_activation (
            food_source_id, operation, reason, performed_by,
            database_principal, database_capability_role
          ) values (
            ${sourceId}::bigint, 'deactivate', 'Legacy 0014 activation evidence',
            'principal:legacy-upgrade', ${memberRole}, 'nutrition_catalogue_rollback'
          )
          returning id
        `.execute(database)
      ).rows[0];
      if (!legacyActivation) throw new Error("legacy activation fixture was not created");

      await sql`
        create role ${sql.id(memberRole)}
        nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      `.execute(bootstrap);
      await sql`
        grant ${sql.id("nutrition_catalogue_approve_data")} to ${sql.id(memberRole)}
      `.execute(bootstrap);

      await sql.raw(hardeningMigration.sql).execute(database);
      expect(
        (
          await sql<{ convalidated: boolean }>`
            select constraint_row.convalidated
            from pg_catalog.pg_constraint as constraint_row
            join pg_catalog.pg_class as class_row
              on class_row.oid = constraint_row.conrelid
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = class_row.relnamespace
            where namespace_row.nspname = ${schemaName}
              and class_row.relname = 'food_source_release_activation'
              and constraint_row.conname =
                'food_source_release_activation_expand_audit_null_check'
          `.execute(database)
        ).rows[0],
      ).toEqual({ convalidated: false });
      expect(
        (
          await sql<{ database_capability_role: string | null; database_principal: string | null }>`
            select database_principal, database_capability_role
            from food_source_release_activation
            where id = ${legacyActivation.id}::bigint
          `.execute(database)
        ).rows[0],
      ).toEqual({
        database_capability_role: "nutrition_catalogue_rollback",
        database_principal: memberRole,
      });
      await expectPostgresCode(
        sql`
          insert into food_source_release_activation (
            food_source_id, operation, reason, performed_by,
            database_principal, database_capability_role
          ) values (
            ${sourceId}::bigint, 'deactivate', 'Reject new activation forgery',
            'principal:new-forgery', ${memberRole}, 'nutrition_catalogue_rollback'
          )
        `.execute(database),
        "23514",
      );
      expect(
        (
          await sql<{ admin_option: boolean }>`
            select membership.admin_option
            from pg_catalog.pg_auth_members as membership
            join pg_catalog.pg_roles as capability
              on capability.oid = membership.roleid
            join pg_catalog.pg_roles as member_role
              on member_role.oid = membership.member
            where capability.rolname = 'nutrition_catalogue_approve_data'
              and member_role.rolname = ${memberRole}
          `.execute(bootstrap)
        ).rows[0],
      ).toEqual({ admin_option: false });

      const functionAcl = (
        await sql<{
          grantable: boolean;
          grantee: string;
          grantor: string;
          owner_name: string;
          privilege: string;
        }>`
          select
            pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner_name,
            coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
            pg_catalog.pg_get_userbyid(acl.grantor) as grantor,
            acl.privilege_type as privilege,
            acl.is_grantable as grantable
          from pg_catalog.pg_proc as procedure_row
          cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
          left join pg_catalog.pg_roles as grantee_role
            on grantee_role.oid = acl.grantee
          where procedure_row.oid = pg_catalog.to_regprocedure(${functionIdentity})
          order by grantee
        `.execute(database)
      ).rows;
      expect(functionAcl).toHaveLength(1);
      const ownerName = functionAcl[0]?.owner_name;
      if (!ownerName) throw new Error("approval function owner was not returned");
      expect(functionAcl.map((entry) => entry.grantee)).toEqual([ownerName]);
      for (const entry of functionAcl) {
        expect(entry).toMatchObject({
          grantable: false,
          grantor: ownerName,
          owner_name: ownerName,
          privilege: "EXECUTE",
        });
      }
      expect(
        (
          await sql<{ allowed: boolean }>`
            select pg_catalog.has_function_privilege(
              ${memberRole},
              ${functionIdentity},
              'execute'
            ) as allowed
          `.execute(database)
        ).rows[0]?.allowed,
      ).toBe(false);
    } finally {
      await database.destroy();
      try {
        await sql`
          revoke ${sql.id("nutrition_catalogue_approve_data")} from ${sql.id(memberRole)}
        `.execute(bootstrap);
      } catch {
        // The role or membership might not have been created before cleanup.
      }
      try {
        await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      } finally {
        await sql`drop role if exists ${sql.id(memberRole)}`.execute(bootstrap);
        await bootstrap.destroy();
      }
    }
  });

  it("normalizes inherited approval EXECUTE when capability roles have no members", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `catalogue_authority_acl_${token}`;
    const unexpectedGrantee = `cat_acl_${token}`;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({
      connectionString: scopedUrl.toString(),
      maxConnections: 1,
    });

    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    try {
      const migrations = await discoverMigrations();
      const authorityMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0014_catalogue_workflow_authority_expand.sql",
      );
      const hardeningMigrationIndex = migrations.findIndex(
        (migration) => migration.name === "0015_catalogue_authority_expand_hardening.sql",
      );
      expect(authorityMigrationIndex).toBeGreaterThan(0);
      expect(hardeningMigrationIndex).toBe(authorityMigrationIndex + 1);

      await sql`
        create role ${sql.id(unexpectedGrantee)}
        nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      `.execute(bootstrap);
      await sql`
        alter default privileges in schema ${sql.id(schemaName)}
        grant execute on functions to ${sql.id(unexpectedGrantee)}
      `.execute(database);

      for (const migration of migrations.slice(0, authorityMigrationIndex)) {
        await sql.raw(migration.sql).execute(database);
      }

      const authorityMigration = migrations[authorityMigrationIndex];
      const hardeningMigration = migrations[hardeningMigrationIndex];
      if (!authorityMigration) throw new Error("0014 authority migration was not discovered");
      if (!hardeningMigration) throw new Error("0015 hardening migration was not discovered");
      await sql.raw(authorityMigration.sql).execute(database);

      const functionIdentity = `${schemaName}.catalogue_record_import_approval(uuid,text,text,text,text,text)`;
      const guardIdentity = `${schemaName}.guard_food_import_approval_authority()`;
      expect(
        (
          await sql<{ allowed: boolean }>`
            select pg_catalog.has_function_privilege(
              ${unexpectedGrantee},
              ${functionIdentity},
              'execute'
            ) as allowed
          `.execute(database)
        ).rows[0]?.allowed,
      ).toBe(true);
      expect(
        (
          await sql<{ allowed: boolean }>`
            select pg_catalog.has_function_privilege(
              ${unexpectedGrantee},
              ${guardIdentity},
              'execute'
            ) as allowed
          `.execute(database)
        ).rows[0]?.allowed,
      ).toBe(true);

      await sql`
        alter default privileges in schema ${sql.id(schemaName)}
        revoke execute on functions from ${sql.id(unexpectedGrantee)}
      `.execute(database);
      await sql.raw(hardeningMigration.sql).execute(database);
      expect(
        (
          await sql<{ convalidated: boolean }>`
            select constraint_row.convalidated
            from pg_catalog.pg_constraint as constraint_row
            join pg_catalog.pg_class as class_row
              on class_row.oid = constraint_row.conrelid
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = class_row.relnamespace
            where namespace_row.nspname = ${schemaName}
              and class_row.relname = 'food_source_release_activation'
              and constraint_row.conname =
                'food_source_release_activation_expand_audit_null_check'
          `.execute(database)
        ).rows[0],
      ).toEqual({ convalidated: true });

      const functionAcl = (
        await sql<{
          grantable: boolean;
          grantee: string;
          grantor: string;
          owner_name: string;
          privilege: string;
        }>`
          select
            pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner_name,
            coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
            pg_catalog.pg_get_userbyid(acl.grantor) as grantor,
            acl.privilege_type as privilege,
            acl.is_grantable as grantable
          from pg_catalog.pg_proc as procedure_row
          cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
          left join pg_catalog.pg_roles as grantee_role
            on grantee_role.oid = acl.grantee
          where procedure_row.oid = pg_catalog.to_regprocedure(${functionIdentity})
          order by grantee
        `.execute(database)
      ).rows;
      expect(functionAcl).toHaveLength(4);
      const ownerName = functionAcl[0]?.owner_name;
      if (!ownerName) throw new Error("approval function owner was not returned");
      expect(functionAcl.map((entry) => entry.grantee).sort()).toEqual(
        [
          ownerName,
          "nutrition_catalogue_approve_data",
          "nutrition_catalogue_approve_quality",
          "nutrition_catalogue_approve_rights",
        ].sort(),
      );
      for (const entry of functionAcl) {
        expect(entry).toMatchObject({
          grantable: false,
          grantor: ownerName,
          owner_name: ownerName,
          privilege: "EXECUTE",
        });
      }
      expect(
        (
          await sql<{ allowed: boolean }>`
            select pg_catalog.has_function_privilege(
              ${unexpectedGrantee},
              ${functionIdentity},
              'execute'
            ) as allowed
          `.execute(database)
        ).rows[0]?.allowed,
      ).toBe(false);

      const guardAcl = (
        await sql<{
          grantable: boolean;
          grantee: string;
          grantor: string;
          owner_name: string;
          privilege: string;
        }>`
          select
            pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner_name,
            coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
            pg_catalog.pg_get_userbyid(acl.grantor) as grantor,
            acl.privilege_type as privilege,
            acl.is_grantable as grantable
          from pg_catalog.pg_proc as procedure_row
          cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
          left join pg_catalog.pg_roles as grantee_role
            on grantee_role.oid = acl.grantee
          where procedure_row.oid = pg_catalog.to_regprocedure(${guardIdentity})
          order by grantee
        `.execute(database)
      ).rows;
      expect(guardAcl).toEqual([
        {
          grantable: false,
          grantee: ownerName,
          grantor: ownerName,
          owner_name: ownerName,
          privilege: "EXECUTE",
        },
      ]);
      expect(
        (
          await sql<{ allowed: boolean }>`
            select pg_catalog.has_function_privilege(
              ${unexpectedGrantee},
              ${guardIdentity},
              'execute'
            ) as allowed
          `.execute(database)
        ).rows[0]?.allowed,
      ).toBe(false);
    } finally {
      await database.destroy();
      try {
        await sql`
          alter default privileges in schema ${sql.id(schemaName)}
          revoke execute on functions from ${sql.id(unexpectedGrantee)}
        `.execute(bootstrap);
      } catch {
        // The role, schema, or default privilege might not have been created.
      }
      try {
        await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      } finally {
        await sql`drop role if exists ${sql.id(unexpectedGrantee)}`.execute(bootstrap);
        await bootstrap.destroy();
      }
    }
  });

  it("pins the food-source search rebuild path ahead of hostile permanent and temporary namespaces", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `food_search_hardening_${token}`;
    const hostileSchema = `food_search_hostile_${token}`;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 1 });
    let schemaCreated = false;
    let hostileSchemaCreated = false;

    try {
      await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
      schemaCreated = true;
      await sql`create schema ${sql.id(hostileSchema)}`.execute(bootstrap);
      hostileSchemaCreated = true;
      const migrations = await discoverMigrations();
      const hardeningIndex = migrations.findIndex(
        (migration) => migration.name === "0016_food_search_function_hardening.sql",
      );
      expect(hardeningIndex).toBeGreaterThan(0);
      expect(migrations[hardeningIndex - 1]?.name).toBe(
        "0015_catalogue_authority_expand_hardening.sql",
      );
      for (const migration of migrations.slice(0, hardeningIndex)) {
        await sql.raw(migration.sql).execute(database);
      }
      const hardeningMigration = migrations[hardeningIndex];
      if (!hardeningMigration) throw new Error("0016 hardening migration was not discovered");

      const { sourceId } = await seedReadyBatch(
        database,
        `${token}h`,
        "d".repeat(64),
        "b".repeat(64),
      );
      await sql`
        create function ${sql.id(hostileSchema)}.advance_food_search_projection_revision()
        returns void
        language plpgsql
        as $function$
        begin
          update shadow_function_call set calls = calls + 1;
        end;
        $function$
      `.execute(database);
      await sql`
        create temporary table shadow_function_call (
          calls integer not null
        ) on commit preserve rows
      `.execute(database);
      await sql`insert into pg_temp.shadow_function_call (calls) values (0)`.execute(database);
      await sql`
        create temporary table food_search_projection_revision (
          singleton boolean primary key,
          current_revision bigint not null,
          published_revision bigint,
          updated_at timestamptz not null
        ) on commit preserve rows
      `.execute(database);
      await sql`
        insert into pg_temp.food_search_projection_revision (
          singleton, current_revision, published_revision, updated_at
        ) values (true, 0, null, pg_catalog.clock_timestamp())
      `.execute(database);
      await sql`
        create temporary table outbox_event (
          aggregate_type text,
          aggregate_id text,
          event_type text,
          deduplication_key text,
          payload jsonb
        ) on commit preserve rows
      `.execute(database);

      await sql`set search_path = ${sql.id(hostileSchema)}, ${sql.id(schemaName)}, public`.execute(
        database,
      );
      await sql`
        update ${sql.id(schemaName)}.food_source
        set display_name = display_name || ' pre-hardening'
        where id = ${sourceId}::bigint
      `.execute(database);

      expect(
        (
          await sql<{ current_revision: string }>`
            select current_revision
            from ${sql.id(schemaName)}.food_search_projection_revision
            where singleton
          `.execute(database)
        ).rows[0],
      ).toEqual({ current_revision: "0" });
      expect(
        (
          await sql<{ event_count: number }>`
            select pg_catalog.count(*)::integer as event_count
            from ${sql.id(schemaName)}.outbox_event
            where event_type = 'catalogue.source_release_activated'
              and aggregate_id = ${sourceId}
          `.execute(database)
        ).rows[0],
      ).toEqual({ event_count: 0 });
      expect(
        (
          await sql<{ calls: number }>`
            select calls from pg_temp.shadow_function_call
          `.execute(database)
        ).rows[0],
      ).toEqual({ calls: 1 });
      expect(
        (
          await sql<{ event_count: number }>`
            select pg_catalog.count(*)::integer as event_count
            from pg_temp.outbox_event
          `.execute(database)
        ).rows[0],
      ).toEqual({ event_count: 1 });

      await sql`set search_path = ${sql.id(schemaName)}, public`.execute(database);
      await sql`
        create function ${sql.id(hostileSchema)}.enqueue_food_search_source_eligibility_change()
        returns trigger
        language plpgsql
        as $function$
        begin
          return new;
        end;
        $function$
      `.execute(database);
      await sql`
        drop trigger food_source_search_eligibility_outbox
        on ${sql.id(schemaName)}.food_source
      `.execute(database);
      await sql`
        create trigger food_source_search_eligibility_outbox
        after update of
          active, active_release_id, code, display_name, license_expression,
          attribution_required, attribution_text, commercial_use_allowed,
          redistribution_allowed, rights_review_status, rights_reviewed_at,
          rights_reviewed_by
        on ${sql.id(schemaName)}.food_source
        for each row execute function
          ${sql.id(hostileSchema)}.enqueue_food_search_source_eligibility_change()
      `.execute(database);
      await expectPostgresCode(
        sql.raw(hardeningMigration.sql).execute(database),
        "55000",
        "food-search source eligibility trigger identity or definition differs",
      );
      await sql`
        drop trigger food_source_search_eligibility_outbox
        on ${sql.id(schemaName)}.food_source
      `.execute(database);
      await sql`
        create trigger food_source_search_eligibility_outbox
        after update of
          active, active_release_id, code, display_name, license_expression,
          attribution_required, attribution_text, commercial_use_allowed,
          redistribution_allowed, rights_review_status, rights_reviewed_at,
          rights_reviewed_by
        on ${sql.id(schemaName)}.food_source
        for each row execute function
          ${sql.id(schemaName)}.enqueue_food_search_source_eligibility_change()
      `.execute(database);
      await sql.raw(hardeningMigration.sql).execute(database);
      const functionConfigurations = (
        await sql<{ name: string; proconfig: string[] | null }>`
          select procedure_row.proname as name, procedure_row.proconfig
          from pg_catalog.pg_proc as procedure_row
          join pg_catalog.pg_namespace as namespace_row
            on namespace_row.oid = procedure_row.pronamespace
          where namespace_row.nspname = ${schemaName}
            and procedure_row.proname in (
              'advance_food_search_projection_revision',
              'enqueue_food_search_source_eligibility_change'
            )
          order by procedure_row.proname
        `.execute(database)
      ).rows;
      expect(functionConfigurations).toEqual([
        {
          name: "advance_food_search_projection_revision",
          proconfig: [`search_path=pg_catalog, ${schemaName}, pg_temp`],
        },
        {
          name: "enqueue_food_search_source_eligibility_change",
          proconfig: [`search_path=pg_catalog, ${schemaName}, pg_temp`],
        },
      ]);

      await sql`update pg_temp.shadow_function_call set calls = 0`.execute(database);
      await sql`truncate pg_temp.outbox_event`.execute(database);
      await sql`set search_path = ${sql.id(hostileSchema)}, ${sql.id(schemaName)}, public`.execute(
        database,
      );
      await sql`
        update ${sql.id(schemaName)}.food_source
        set display_name = display_name || ' hardened'
        where id = ${sourceId}::bigint
      `.execute(database);

      expect(
        (
          await sql<{ current_revision: string }>`
            select current_revision
            from ${sql.id(schemaName)}.food_search_projection_revision
            where singleton
          `.execute(database)
        ).rows[0],
      ).toEqual({ current_revision: "1" });
      expect(
        (
          await sql<{ reason: string; source_id: string }>`
            select payload ->> 'reason' as reason, payload ->> 'sourceId' as source_id
            from ${sql.id(schemaName)}.outbox_event
            where event_type = 'catalogue.source_release_activated'
              and aggregate_id = ${sourceId}
          `.execute(database)
        ).rows,
      ).toEqual([{ reason: "source_eligibility_changed", source_id: sourceId }]);
      expect(
        (
          await sql<{ calls: number }>`
            select calls from pg_temp.shadow_function_call
          `.execute(database)
        ).rows[0],
      ).toEqual({ calls: 0 });
      expect(
        (
          await sql<{ current_revision: string }>`
            select current_revision
            from pg_temp.food_search_projection_revision
            where singleton
          `.execute(database)
        ).rows[0],
      ).toEqual({ current_revision: "0" });
      expect(
        (
          await sql<{ event_count: number }>`
            select pg_catalog.count(*)::integer as event_count
            from pg_temp.outbox_event
          `.execute(database)
        ).rows[0],
      ).toEqual({ event_count: 0 });
    } finally {
      try {
        await database.destroy();
      } finally {
        try {
          if (hostileSchemaCreated) {
            await sql`drop schema ${sql.id(hostileSchema)} cascade`.execute(bootstrap);
          }
        } finally {
          try {
            if (schemaCreated) {
              await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
            }
          } finally {
            await bootstrap.destroy();
          }
        }
      }
    }
  });

  it("pins every food-search projection trigger ahead of hostile permanent and temporary namespaces", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `food_projection_hardening_${token}`;
    const hostileSchema = `food_projection_hostile_${token}`;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 1 });
    let schemaCreated = false;
    let hostileSchemaCreated = false;

    try {
      await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
      schemaCreated = true;
      await sql`create schema ${sql.id(hostileSchema)}`.execute(bootstrap);
      hostileSchemaCreated = true;
      const migrations = await discoverMigrations();
      const hardeningIndex = migrations.findIndex(
        (migration) => migration.name === "0017_food_search_projection_trigger_hardening.sql",
      );
      const evidenceBindingIndex = migrations.findIndex(
        (migration) => migration.name === "0011_food_import_evidence_binding.sql",
      );
      expect(hardeningIndex).toBeGreaterThan(0);
      expect(evidenceBindingIndex).toBeGreaterThan(0);
      expect(evidenceBindingIndex).toBeLessThan(hardeningIndex);
      expect(migrations[hardeningIndex - 1]?.name).toBe("0016_food_search_function_hardening.sql");
      for (const migration of migrations.slice(0, evidenceBindingIndex)) {
        await sql.raw(migration.sql).execute(database);
      }
      const hardeningMigration = migrations[hardeningIndex];
      if (!hardeningMigration) throw new Error("0017 hardening migration was not discovered");

      const source = (
        await sql<{ id: string }>`
          insert into food_source (
            active, attribution_required, attribution_text, code,
            commercial_use_allowed, database_rights_notes, display_name,
            homepage_url, kind, license_expression, license_url,
            redistribution_allowed, rights_review_status, rights_reviewed_at,
            rights_reviewed_by
          ) values (
            true, true, 'Projection hardening fixture',
            ${`PH${token.toUpperCase()}`}, true, 'Reviewed integration fixture',
            ${`Projection source ${token}`},
            'https://example.invalid/projection-hardening', 'government',
            'CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/',
            true, 'approved', pg_catalog.clock_timestamp(),
            'principal:projection-hardening'
          )
          returning id
        `.execute(database)
      ).rows[0];
      if (!source) throw new Error("projection source fixture was not created");
      const sourceId = source.id;
      const release = (
        await sql<{ id: string }>`
          insert into food_source_release (
            acquired_at, artifact_bytes, artifact_sha256, artifact_uri,
            food_source_id, media_type, parser_version, record_counts, release_key,
            rights_manifest_sha256, rights_manifest_uri, status, validation_summary
          ) values (
            pg_catalog.clock_timestamp(), 1, ${"a".repeat(64)},
            ${`s3://catalogue-artifacts/${token}.json`}, ${sourceId}::bigint,
            'application/json', 'projection-hardening@1', '{"fixture":true}'::jsonb,
            ${`projection-release-${token}`}, ${"b".repeat(64)},
            'repo://projection-hardening-rights.json', 'imported',
            '{"fixture":true}'::jsonb
          )
          returning id
        `.execute(database)
      ).rows[0];
      if (!release) throw new Error("projection release fixture was not created");
      await sql`
        update food_source
        set active_release_id = ${release.id}::uuid
        where id = ${sourceId}::bigint
      `.execute(database);
      for (const migration of migrations.slice(evidenceBindingIndex, hardeningIndex)) {
        await sql.raw(migration.sql).execute(database);
      }
      const food = (
        await sql<{ id: string }>`
          insert into food (
            kind, food_source_id, source_food_key, visibility
          ) values (
            'generic', ${sourceId}::bigint, ${`projection-food-${token}`}, 'public'
          )
          returning id
        `.execute(database)
      ).rows[0];
      if (!food) throw new Error("projection food fixture was not created");
      const version = (
        await sql<{ id: string }>`
          insert into food_version (
            food_id, version_number, source_release_id, name, normalized_name,
            data_quality, basis_quantity, basis_unit
          ) values (
            ${food.id}::bigint, 1, ${release.id}::uuid,
            'Projection hardening fixture', 'projection hardening fixture',
            'verified', 100, 'g'
          )
          returning id
        `.execute(database)
      ).rows[0];
      if (!version) throw new Error("projection food version fixture was not created");
      await sql`
        update food set current_version_id = ${version.id}::bigint
        where id = ${food.id}::bigint
      `.execute(database);
      await sql`
        insert into food_serving (
          food_version_id, label, quantity, unit, unit_kind, gram_weight,
          is_default
        ) values (
          ${version.id}::bigint, 'Initial serving', 100, 'g', 'mass', 100, true
        )
      `.execute(database);
      await sql`
        insert into food_barcode (
          gtin, food_id, food_version_id, source_release_id
        ) values (
          '000000000001', ${food.id}::bigint, ${version.id}::bigint, ${release.id}::uuid
        )
      `.execute(database);
      await sql`delete from outbox_event`.execute(database);
      await sql`
        update food_search_projection_revision
        set current_revision = 0,
            published_revision = null,
            updated_at = pg_catalog.clock_timestamp()
        where singleton
      `.execute(database);

      const readProjectionFunctionState = async () =>
        (
          await sql<{
            name: string;
            owner_name: string;
            proacl: string[] | null;
            proconfig: string[] | null;
            prosecdef: boolean;
            source_sha256: string;
          }>`
            select
              procedure_row.proname as name,
              pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner_name,
              procedure_row.proacl,
              procedure_row.proconfig,
              procedure_row.prosecdef,
              pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
                'hex'
              ) as source_sha256
            from pg_catalog.pg_proc as procedure_row
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = procedure_row.pronamespace
            where namespace_row.nspname = ${schemaName}
              and procedure_row.proname in (
                'enqueue_food_search_barcode_insert',
                'enqueue_food_search_barcode_update',
                'enqueue_food_search_food_eligibility_change',
                'enqueue_food_search_serving_insert'
              )
            order by procedure_row.proname
          `.execute(database)
        ).rows;
      const tableOwner = (
        await sql<{ owner_name: string }>`
          select pg_catalog.pg_get_userbyid(class_row.relowner) as owner_name
          from pg_catalog.pg_class as class_row
          join pg_catalog.pg_namespace as namespace_row
            on namespace_row.oid = class_row.relnamespace
          where namespace_row.nspname = ${schemaName}
            and class_row.relname = 'food'
        `.execute(database)
      ).rows[0]?.owner_name;
      if (!tableOwner) throw new Error("projection table owner was not returned");
      const preHardeningFunctionState = await readProjectionFunctionState();
      expect(preHardeningFunctionState).toEqual([
        {
          name: "enqueue_food_search_barcode_insert",
          owner_name: tableOwner,
          proacl: null,
          proconfig: null,
          prosecdef: false,
          source_sha256: "4e888f3ef0b3af1e7eee14568069ae3fe06b65b88718614ed0e2c243a5d22318",
        },
        {
          name: "enqueue_food_search_barcode_update",
          owner_name: tableOwner,
          proacl: null,
          proconfig: null,
          prosecdef: false,
          source_sha256: "9d7a90d0fee1a6923631c9b9018d9c813d3c8f7eea2df941fc32fbb4f5d453b0",
        },
        {
          name: "enqueue_food_search_food_eligibility_change",
          owner_name: tableOwner,
          proacl: null,
          proconfig: null,
          prosecdef: false,
          source_sha256: "85ada305a6fd6b40cd5fb0652d64c240d1953033a243b0f7ce243caa9bc9c4de",
        },
        {
          name: "enqueue_food_search_serving_insert",
          owner_name: tableOwner,
          proacl: null,
          proconfig: null,
          prosecdef: false,
          source_sha256: "223f2d1dc8f90c6bc04c4d85ec763bcb50727473f5576b0bcdbbf394c1c9d804",
        },
      ]);

      await sql`
        create function ${sql.id(hostileSchema)}.advance_food_search_projection_revision()
        returns void
        language plpgsql
        as $function$
        begin
          update shadow_function_call set calls = calls + 1;
        end;
        $function$
      `.execute(database);
      await sql`
        create function ${sql.id(hostileSchema)}.enqueue_food_search_serving_insert()
        returns trigger
        language plpgsql
        as $function$
        begin
          return null;
        end;
        $function$
      `.execute(database);
      await sql`
        create temporary table shadow_function_call (
          calls integer not null
        ) on commit preserve rows
      `.execute(database);
      await sql`insert into pg_temp.shadow_function_call (calls) values (0)`.execute(database);
      await sql`
        create temporary table food_search_projection_revision (
          singleton boolean primary key,
          current_revision bigint not null,
          published_revision bigint,
          updated_at timestamptz not null
        ) on commit preserve rows
      `.execute(database);
      await sql`
        insert into pg_temp.food_search_projection_revision (
          singleton, current_revision, published_revision, updated_at
        ) values (true, 0, null, pg_catalog.clock_timestamp())
      `.execute(database);
      await sql`
        create temporary table outbox_event (
          aggregate_type text,
          aggregate_id text,
          event_type text,
          deduplication_key text,
          payload jsonb
        ) on commit preserve rows
      `.execute(database);
      await sql`
        create temporary table food_version (
          id bigint,
          food_id bigint,
          source_release_id uuid
        ) on commit preserve rows
      `.execute(database);
      await sql`
        create temporary table food (
          id bigint,
          kind text,
          food_source_id bigint,
          current_version_id bigint
        ) on commit preserve rows
      `.execute(database);
      await sql`
        create temporary table food_source (
          id bigint,
          active_release_id uuid
        ) on commit preserve rows
      `.execute(database);
      await sql`
        insert into pg_temp.food_version (id, food_id, source_release_id)
        values (${version.id}::bigint, ${food.id}::bigint, ${release.id}::uuid)
      `.execute(database);
      await sql`
        insert into pg_temp.food (id, kind, food_source_id, current_version_id)
        values (
          ${food.id}::bigint, 'generic', ${sourceId}::bigint, ${version.id}::bigint
        )
      `.execute(database);
      await sql`
        insert into pg_temp.food_source (id, active_release_id)
        values (${sourceId}::bigint, ${release.id}::uuid)
      `.execute(database);

      await sql`set search_path = ${sql.id(hostileSchema)}, ${sql.id(schemaName)}, public`.execute(
        database,
      );
      await sql`
        update ${sql.id(schemaName)}.food
        set archived_at = pg_catalog.clock_timestamp()
        where id = ${food.id}::bigint
      `.execute(database);
      await sql`
        insert into ${sql.id(schemaName)}.food_serving (
          food_version_id, label, quantity, unit, unit_kind, gram_weight
        ) values (
          ${version.id}::bigint, 'Pre-hardening serving', 50, 'g', 'mass', 50
        )
      `.execute(database);
      const preHardeningBarcode = (
        await sql<{ id: string }>`
          insert into ${sql.id(schemaName)}.food_barcode (
            gtin, food_id, food_version_id, source_release_id
          ) values (
            '000000000002', ${food.id}::bigint, ${version.id}::bigint,
            ${release.id}::uuid
          )
          returning id
        `.execute(database)
      ).rows[0];
      if (!preHardeningBarcode) throw new Error("pre-hardening barcode was not created");
      await sql`
        update ${sql.id(schemaName)}.food_barcode
        set valid_to = pg_catalog.clock_timestamp() + interval '1 second'
        where id = ${preHardeningBarcode.id}::bigint
      `.execute(database);

      expect(
        (
          await sql<{ reason: string }>`
            select payload ->> 'reason' as reason
            from pg_temp.outbox_event
            order by reason
          `.execute(database)
        ).rows,
      ).toEqual([
        { reason: "barcode_closed_for_current_version" },
        { reason: "barcode_inserted_for_current_version" },
        { reason: "food_eligibility_changed" },
        { reason: "serving_inserted_for_current_version" },
      ]);
      expect(
        (
          await sql<{ calls: number }>`
            select calls from pg_temp.shadow_function_call
          `.execute(database)
        ).rows[0],
      ).toEqual({ calls: 4 });
      expect(
        (
          await sql<{ event_count: number }>`
            select pg_catalog.count(*)::integer as event_count
            from ${sql.id(schemaName)}.outbox_event
          `.execute(database)
        ).rows[0],
      ).toEqual({ event_count: 0 });
      expect(
        (
          await sql<{ current_revision: string }>`
            select current_revision
            from ${sql.id(schemaName)}.food_search_projection_revision
            where singleton
          `.execute(database)
        ).rows[0],
      ).toEqual({ current_revision: "0" });

      await sql`set search_path = ${sql.id(schemaName)}, public`.execute(database);
      await sql`
        create table ${sql.id(hostileSchema)}.unexpected_food_search_serving (
          food_version_id bigint
        )
      `.execute(database);
      await sql`
        create trigger unexpected_food_search_serving_insert_outbox
        after insert on ${sql.id(hostileSchema)}.unexpected_food_search_serving
        referencing new table as new_food_search_servings
        for each statement execute function
          ${sql.id(schemaName)}.enqueue_food_search_serving_insert()
      `.execute(database);
      await expectPostgresCode(
        sql.raw(hardeningMigration.sql).execute(database),
        "55000",
        "food-search projection trigger identity or definition differs",
      );
      expect(await readProjectionFunctionState()).toEqual(preHardeningFunctionState);
      await sql`
        drop table ${sql.id(hostileSchema)}.unexpected_food_search_serving
      `.execute(database);

      await sql`
        drop trigger food_search_serving_insert_outbox
        on ${sql.id(schemaName)}.food_serving
      `.execute(database);
      await sql`
        create trigger food_search_serving_insert_outbox
        after insert on ${sql.id(schemaName)}.food_serving
        referencing new table as new_food_search_servings
        for each statement execute function
          ${sql.id(hostileSchema)}.enqueue_food_search_serving_insert()
      `.execute(database);
      await expectPostgresCode(
        sql.raw(hardeningMigration.sql).execute(database),
        "55000",
        "food-search projection trigger identity or definition differs",
      );
      expect(await readProjectionFunctionState()).toEqual(preHardeningFunctionState);
      await sql`
        drop trigger food_search_serving_insert_outbox
        on ${sql.id(schemaName)}.food_serving
      `.execute(database);
      await sql`
        create trigger food_search_serving_insert_outbox
        after insert on ${sql.id(schemaName)}.food_serving
        referencing new table as new_food_search_servings
        for each statement execute function
          ${sql.id(schemaName)}.enqueue_food_search_serving_insert()
      `.execute(database);
      await sql`
        set search_path = ${sql.id(schemaName)}, pg_catalog, pg_temp, public
      `.execute(database);
      const triggerState = (
        await sql<{
          enabled: string;
          function_arguments: string;
          function_name: string;
          function_schema: string;
          table_name: string;
          table_schema: string;
          trigger_definition: string;
          trigger_name: string;
        }>`
          select
            trigger_row.tgname as trigger_name,
            table_namespace_row.nspname as table_schema,
            class_row.relname as table_name,
            procedure_namespace_row.nspname as function_schema,
            procedure_row.proname as function_name,
            pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
              as function_arguments,
            trigger_row.tgenabled as enabled,
            pg_catalog.pg_get_triggerdef(trigger_row.oid, true) as trigger_definition
          from pg_catalog.pg_trigger as trigger_row
          join pg_catalog.pg_proc as procedure_row
            on procedure_row.oid = trigger_row.tgfoid
          join pg_catalog.pg_namespace as procedure_namespace_row
            on procedure_namespace_row.oid = procedure_row.pronamespace
          join pg_catalog.pg_class as class_row
            on class_row.oid = trigger_row.tgrelid
          join pg_catalog.pg_namespace as table_namespace_row
            on table_namespace_row.oid = class_row.relnamespace
          where not trigger_row.tgisinternal
            and (
              (
                table_namespace_row.nspname = ${schemaName}
                and trigger_row.tgname in (
                  'food_search_barcode_insert_outbox',
                  'food_search_barcode_update_outbox',
                  'food_search_eligibility_outbox',
                  'food_search_serving_insert_outbox'
                )
              )
              or (
                procedure_namespace_row.nspname = ${schemaName}
                and procedure_row.proname in (
                  'enqueue_food_search_barcode_insert',
                  'enqueue_food_search_barcode_update',
                  'enqueue_food_search_food_eligibility_change',
                  'enqueue_food_search_serving_insert'
                )
                and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
              )
            )
          order by trigger_row.tgname, table_namespace_row.nspname, class_row.relname
        `.execute(database)
      ).rows;
      expect(triggerState).toEqual([
        {
          enabled: "O",
          function_arguments: "",
          function_name: "enqueue_food_search_barcode_insert",
          function_schema: schemaName,
          table_name: "food_barcode",
          table_schema: schemaName,
          trigger_definition:
            "CREATE TRIGGER food_search_barcode_insert_outbox AFTER INSERT ON food_barcode REFERENCING NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()",
          trigger_name: "food_search_barcode_insert_outbox",
        },
        {
          enabled: "O",
          function_arguments: "",
          function_name: "enqueue_food_search_barcode_update",
          function_schema: schemaName,
          table_name: "food_barcode",
          table_schema: schemaName,
          trigger_definition:
            "CREATE TRIGGER food_search_barcode_update_outbox AFTER UPDATE ON food_barcode REFERENCING OLD TABLE AS old_food_search_barcodes NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_update()",
          trigger_name: "food_search_barcode_update_outbox",
        },
        {
          enabled: "O",
          function_arguments: "",
          function_name: "enqueue_food_search_food_eligibility_change",
          function_schema: schemaName,
          table_name: "food",
          table_schema: schemaName,
          trigger_definition:
            "CREATE TRIGGER food_search_eligibility_outbox AFTER UPDATE ON food REFERENCING OLD TABLE AS old_food_search_rows NEW TABLE AS new_food_search_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_food_eligibility_change()",
          trigger_name: "food_search_eligibility_outbox",
        },
        {
          enabled: "O",
          function_arguments: "",
          function_name: "enqueue_food_search_serving_insert",
          function_schema: schemaName,
          table_name: "food_serving",
          table_schema: schemaName,
          trigger_definition:
            "CREATE TRIGGER food_search_serving_insert_outbox AFTER INSERT ON food_serving REFERENCING NEW TABLE AS new_food_search_servings FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_serving_insert()",
          trigger_name: "food_search_serving_insert_outbox",
        },
      ]);
      await sql.raw(hardeningMigration.sql).execute(database);

      expect(await readProjectionFunctionState()).toEqual(
        preHardeningFunctionState.map((state) => ({
          ...state,
          proconfig: [`search_path=pg_catalog, ${schemaName}, pg_temp`],
        })),
      );

      await sql`update pg_temp.shadow_function_call set calls = 0`.execute(database);
      await sql`truncate pg_temp.outbox_event`.execute(database);
      await sql`set search_path = ${sql.id(hostileSchema)}, ${sql.id(schemaName)}, public`.execute(
        database,
      );
      await sql`
        update ${sql.id(schemaName)}.food
        set archived_at = null
        where id = ${food.id}::bigint
      `.execute(database);
      await sql`
        insert into ${sql.id(schemaName)}.food_serving (
          food_version_id, label, quantity, unit, unit_kind, gram_weight
        ) values (
          ${version.id}::bigint, 'Hardened serving', 25, 'g', 'mass', 25
        )
      `.execute(database);
      const hardenedBarcode = (
        await sql<{ id: string }>`
          insert into ${sql.id(schemaName)}.food_barcode (
            gtin, food_id, food_version_id, source_release_id
          ) values (
            '000000000003', ${food.id}::bigint, ${version.id}::bigint,
            ${release.id}::uuid
          )
          returning id
        `.execute(database)
      ).rows[0];
      if (!hardenedBarcode) throw new Error("hardened barcode was not created");
      await sql`
        update ${sql.id(schemaName)}.food_barcode
        set valid_to = pg_catalog.clock_timestamp() + interval '1 second'
        where id = ${hardenedBarcode.id}::bigint
      `.execute(database);

      expect(
        (
          await sql<{ reason: string }>`
            select payload ->> 'reason' as reason
            from ${sql.id(schemaName)}.outbox_event
            order by reason
          `.execute(database)
        ).rows,
      ).toEqual([
        { reason: "barcode_closed_for_current_version" },
        { reason: "barcode_inserted_for_current_version" },
        { reason: "food_eligibility_changed" },
        { reason: "serving_inserted_for_current_version" },
      ]);
      expect(
        (
          await sql<{ current_revision: string }>`
            select current_revision
            from ${sql.id(schemaName)}.food_search_projection_revision
            where singleton
          `.execute(database)
        ).rows[0],
      ).toEqual({ current_revision: "4" });
      expect(
        (
          await sql<{ calls: number }>`
            select calls from pg_temp.shadow_function_call
          `.execute(database)
        ).rows[0],
      ).toEqual({ calls: 0 });
      expect(
        (
          await sql<{ current_revision: string }>`
            select current_revision
            from pg_temp.food_search_projection_revision
            where singleton
          `.execute(database)
        ).rows[0],
      ).toEqual({ current_revision: "0" });
      expect(
        (
          await sql<{ event_count: number }>`
            select pg_catalog.count(*)::integer as event_count
            from pg_temp.outbox_event
          `.execute(database)
        ).rows[0],
      ).toEqual({ event_count: 0 });
    } finally {
      try {
        await database.destroy();
      } finally {
        try {
          if (hostileSchemaCreated) {
            await sql`drop schema ${sql.id(hostileSchema)} cascade`.execute(bootstrap);
          }
        } finally {
          try {
            if (schemaCreated) {
              await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
            }
          } finally {
            await bootstrap.destroy();
          }
        }
      }
    }
  });

  it("fails closed on unexpected nutrient-lock bindings before pinning the exact protocol", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const token = randomBytes(6).toString("hex");
    const schemaName = `nutrient_lock_hardening_${token}`;
    const hostileSchema = `nutrient_lock_hostile_${token}`;
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 1 });
    let schemaCreated = false;
    let hostileSchemaCreated = false;

    try {
      await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
      schemaCreated = true;
      await sql`create schema ${sql.id(hostileSchema)}`.execute(bootstrap);
      hostileSchemaCreated = true;

      const migrations = await discoverMigrations();
      const hardeningIndex = migrations.findIndex(
        (migration) => migration.name === "0018_active_nutrient_registry_lock_protocol.sql",
      );
      expect(hardeningIndex).toBeGreaterThan(0);
      expect(migrations[hardeningIndex - 1]?.name).toBe(
        "0017_food_search_projection_trigger_hardening.sql",
      );
      for (const migration of migrations.slice(0, hardeningIndex)) {
        await sql.raw(migration.sql).execute(database);
      }
      const hardeningMigration = migrations[hardeningIndex];
      if (!hardeningMigration) throw new Error("0018 hardening migration was not discovered");

      const readFunctionState = async () =>
        (
          await sql<{
            language_name: string;
            name: string;
            owner_name: string;
            proacl: string[] | null;
            proconfig: string[] | null;
            security_mode: "definer" | "invoker";
            source_sha256: string;
          }>`
            select
              procedure_row.proname as name,
              pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner_name,
              language_row.lanname as language_name,
              procedure_row.proacl,
              procedure_row.proconfig,
              case when procedure_row.prosecdef then 'definer' else 'invoker' end
                as security_mode,
              pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
                'hex'
              ) as source_sha256
            from pg_catalog.pg_proc as procedure_row
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = procedure_row.pronamespace
            join pg_catalog.pg_language as language_row
              on language_row.oid = procedure_row.prolang
            where namespace_row.nspname = ${schemaName}
              and procedure_row.proname in (
                'guard_active_nutrient_vector_size',
                'lock_active_nutrient_registry_before_write',
                'lock_active_nutrient_registry_for_read',
                'reconcile_recipe_components_v2'
              )
              and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
            order by procedure_row.proname
          `.execute(database)
        ).rows;
      const readTriggerState = async () =>
        (
          await sql<{
            enabled: string;
            function_name: string;
            function_schema: string;
            table_name: string;
            table_schema: string;
            trigger_definition: string;
            trigger_name: string;
          }>`
            select
              trigger_row.tgname as trigger_name,
              table_namespace_row.nspname as table_schema,
              class_row.relname as table_name,
              procedure_namespace_row.nspname as function_schema,
              procedure_row.proname as function_name,
              trigger_row.tgenabled as enabled,
              pg_catalog.pg_get_triggerdef(trigger_row.oid, true) as trigger_definition
            from pg_catalog.pg_trigger as trigger_row
            join pg_catalog.pg_proc as procedure_row
              on procedure_row.oid = trigger_row.tgfoid
            join pg_catalog.pg_namespace as procedure_namespace_row
              on procedure_namespace_row.oid = procedure_row.pronamespace
            join pg_catalog.pg_class as class_row
              on class_row.oid = trigger_row.tgrelid
            join pg_catalog.pg_namespace as table_namespace_row
              on table_namespace_row.oid = class_row.relnamespace
            where not trigger_row.tgisinternal
              and table_namespace_row.nspname = ${schemaName}
              and trigger_row.tgname in (
                'nutrient_active_vector_size_guard',
                'nutrient_registry_lock_before_active_update',
                'nutrient_registry_lock_before_insert',
                'recipe_ingredient_reconcile_v2',
                'recipe_nutrient_reconcile_v2',
                'recipe_source_reconcile_v2',
                'recipe_version_components_reconcile_v2'
              )
            order by trigger_row.tgname
          `.execute(database)
        ).rows;

      const preHardeningFunctions = await readFunctionState();
      const preHardeningTriggers = await readTriggerState();
      expect(preHardeningFunctions).toHaveLength(3);
      expect(preHardeningFunctions.every((state) => state.proconfig === null)).toBe(true);
      expect(preHardeningTriggers).toHaveLength(7);

      await sql`
        create table ${sql.id(hostileSchema)}.unexpected_nutrient_write (
          active boolean not null
        )
      `.execute(database);
      await sql`
        create trigger unexpected_nutrient_writer_binding
        before insert on ${sql.id(hostileSchema)}.unexpected_nutrient_write
        for each statement execute function
          ${sql.id(schemaName)}.lock_active_nutrient_registry_before_write()
      `.execute(database);

      await expectPostgresCode(
        sql.raw(hardeningMigration.sql).execute(database),
        "55000",
        "active nutrient registry trigger identity or definition differs",
      );
      expect(await readFunctionState()).toEqual(preHardeningFunctions);
      expect(await readTriggerState()).toEqual(preHardeningTriggers);
      expect(
        (
          await sql<{ binding_count: number }>`
            select pg_catalog.count(*)::integer as binding_count
            from pg_catalog.pg_trigger as trigger_row
            join pg_catalog.pg_class as class_row
              on class_row.oid = trigger_row.tgrelid
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = class_row.relnamespace
            where not trigger_row.tgisinternal
              and namespace_row.nspname = ${hostileSchema}
              and trigger_row.tgname = 'unexpected_nutrient_writer_binding'
          `.execute(database)
        ).rows[0],
      ).toEqual({ binding_count: 1 });

      await sql`drop table ${sql.id(hostileSchema)}.unexpected_nutrient_write`.execute(database);
      await sql.raw(hardeningMigration.sql).execute(database);

      const tableOwner = (
        await sql<{ owner_name: string }>`
          select pg_catalog.pg_get_userbyid(class_row.relowner) as owner_name
          from pg_catalog.pg_class as class_row
          join pg_catalog.pg_namespace as namespace_row
            on namespace_row.oid = class_row.relnamespace
          where namespace_row.nspname = ${schemaName}
            and class_row.relname = 'nutrient'
        `.execute(database)
      ).rows[0]?.owner_name;
      if (!tableOwner) throw new Error("nutrient table owner was not returned");
      const pinnedSearchPath = [`search_path=pg_catalog, ${schemaName}, pg_temp`];
      expect(await readFunctionState()).toEqual([
        {
          language_name: "plpgsql",
          name: "guard_active_nutrient_vector_size",
          owner_name: tableOwner,
          proacl: null,
          proconfig: pinnedSearchPath,
          security_mode: "invoker",
          source_sha256: "24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda",
        },
        {
          language_name: "plpgsql",
          name: "lock_active_nutrient_registry_before_write",
          owner_name: tableOwner,
          proacl: null,
          proconfig: pinnedSearchPath,
          security_mode: "invoker",
          source_sha256: "c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de",
        },
        {
          language_name: "sql",
          name: "lock_active_nutrient_registry_for_read",
          owner_name: tableOwner,
          proacl: null,
          proconfig: pinnedSearchPath,
          security_mode: "invoker",
          source_sha256: "22ab05f2e9749ecff7035e5188e1b9353d46533e7bc558748c76c43dbfc37ea5",
        },
        {
          language_name: "plpgsql",
          name: "reconcile_recipe_components_v2",
          owner_name: tableOwner,
          proacl: null,
          proconfig: pinnedSearchPath,
          security_mode: "invoker",
          source_sha256: "c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a",
        },
      ]);

      expect(await readTriggerState()).toEqual([
        {
          enabled: "O",
          function_name: "guard_active_nutrient_vector_size",
          function_schema: schemaName,
          table_name: "nutrient",
          table_schema: schemaName,
          trigger_definition:
            "CREATE CONSTRAINT TRIGGER nutrient_active_vector_size_guard AFTER INSERT OR UPDATE OF active ON nutrient DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_active_nutrient_vector_size()",
          trigger_name: "nutrient_active_vector_size_guard",
        },
        {
          enabled: "O",
          function_name: "lock_active_nutrient_registry_before_write",
          function_schema: schemaName,
          table_name: "nutrient",
          table_schema: schemaName,
          trigger_definition:
            "CREATE TRIGGER nutrient_registry_lock_before_active_update BEFORE DELETE OR UPDATE ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
          trigger_name: "nutrient_registry_lock_before_active_update",
        },
        {
          enabled: "O",
          function_name: "lock_active_nutrient_registry_before_write",
          function_schema: schemaName,
          table_name: "nutrient",
          table_schema: schemaName,
          trigger_definition:
            "CREATE TRIGGER nutrient_registry_lock_before_insert BEFORE INSERT ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()",
          trigger_name: "nutrient_registry_lock_before_insert",
        },
        {
          enabled: "O",
          function_name: "reconcile_recipe_components_v2",
          function_schema: schemaName,
          table_name: "recipe_ingredient",
          table_schema: schemaName,
          trigger_definition:
            "CREATE CONSTRAINT TRIGGER recipe_ingredient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_ingredient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
          trigger_name: "recipe_ingredient_reconcile_v2",
        },
        {
          enabled: "O",
          function_name: "reconcile_recipe_components_v2",
          function_schema: schemaName,
          table_name: "recipe_version_nutrient",
          table_schema: schemaName,
          trigger_definition:
            "CREATE CONSTRAINT TRIGGER recipe_nutrient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_nutrient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
          trigger_name: "recipe_nutrient_reconcile_v2",
        },
        {
          enabled: "O",
          function_name: "reconcile_recipe_components_v2",
          function_schema: schemaName,
          table_name: "recipe_version_source",
          table_schema: schemaName,
          trigger_definition:
            "CREATE CONSTRAINT TRIGGER recipe_source_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
          trigger_name: "recipe_source_reconcile_v2",
        },
        {
          enabled: "O",
          function_name: "reconcile_recipe_components_v2",
          function_schema: schemaName,
          table_name: "recipe_version",
          table_schema: schemaName,
          trigger_definition:
            "CREATE CONSTRAINT TRIGGER recipe_version_components_reconcile_v2 AFTER INSERT ON recipe_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()",
          trigger_name: "recipe_version_components_reconcile_v2",
        },
      ]);

      await sql`
        create temporary table nutrient (
          active boolean not null
        ) on commit preserve rows
      `.execute(database);
      await sql`
        insert into pg_temp.nutrient (active)
        select true from pg_catalog.generate_series(1, 257)
      `.execute(database);
      await sql`set search_path = pg_temp, ${sql.id(schemaName)}, public`.execute(database);
      await expect(
        sql`
          insert into ${sql.id(schemaName)}.nutrient (
            code, name, canonical_unit, dimension
          ) values (
            ${`shadow_safe_${token}`}, 'Shadow-safe nutrient', 'g', 'mass'
          )
        `.execute(database),
      ).resolves.toBeDefined();
      expect(
        (
          await sql<{ application_count: number; shadow_count: number }>`
            select
              (select pg_catalog.count(*)::integer from ${sql.id(schemaName)}.nutrient)
                as application_count,
              (select pg_catalog.count(*)::integer from pg_temp.nutrient) as shadow_count
          `.execute(database)
        ).rows[0],
      ).toEqual({ application_count: 1, shadow_count: 257 });
    } finally {
      try {
        await database.destroy();
      } finally {
        try {
          if (hostileSchemaCreated) {
            await sql`drop schema ${sql.id(hostileSchema)} cascade`.execute(bootstrap);
          }
        } finally {
          try {
            if (schemaCreated) {
              await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
            }
          } finally {
            await bootstrap.destroy();
          }
        }
      }
    }
  });
});

async function recordApproval(
  database: Kysely<Database>,
  schemaName: string,
  input: ApprovalCall,
): Promise<boolean> {
  const result = await sql<{ recorded: boolean }>`
    select ${sql.id(schemaName)}.catalogue_record_import_approval(
      p_batch_id => ${input.batchId}::uuid,
      p_requested_approval_role => ${input.approvalRole},
      p_validation_digest => ${input.validationDigest},
      p_rights_digest => ${input.rightsDigest},
      p_external_principal_id => ${input.principalId},
      p_approval_reference => ${input.approvalReference}
    ) as recorded
  `.execute(database);
  const recorded = result.rows[0]?.recorded;
  if (recorded === undefined) throw new Error("approval function returned no row");
  return recorded;
}

async function promoteImportBatch(
  database: Kysely<Database>,
  schemaName: string,
  batchId: string,
  principalId: string,
  reason: string,
): Promise<PromotionResult> {
  const result = (
    await sql<{ result: PromotionResult }>`
      select ${sql.id(schemaName)}.catalogue_promote_import_batch(
        p_batch_id => ${batchId}::uuid,
        p_external_principal_id => ${principalId},
        p_reason => ${reason}
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("catalogue promotion function returned no row");
  return result;
}

async function rollbackSourceRelease(
  database: Kysely<Database>,
  schemaName: string,
  sourceCode: string,
  targetReleaseId: string | null,
  principalId: string,
  reason: string,
): Promise<RollbackResult> {
  const result = (
    await sql<{ result: RollbackResult }>`
      select ${sql.id(schemaName)}.catalogue_rollback_source_release(
        p_source_code => ${sourceCode},
        p_target_release_id => ${targetReleaseId}::uuid,
        p_external_principal_id => ${principalId},
        p_reason => ${reason}
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("catalogue rollback function returned no row");
  return result;
}

async function seedReadyBatch(
  database: Kysely<Database>,
  suffix: string,
  validationDigest: string,
  rightsDigest: string,
): Promise<{ batchId: string; sourceCode: string; sourceId: string }> {
  const sourceCode = `AB${suffix.toUpperCase()}`;
  const mappingDigest = "a".repeat(64);
  const source = (
    await sql<{ id: string }>`
      insert into food_source (
        active, attribution_required, attribution_text, code,
        commercial_use_allowed, database_rights_notes, display_name,
        homepage_url, kind, license_expression, license_url,
        redistribution_allowed, rights_review_status, rights_reviewed_at,
        rights_reviewed_by
      ) values (
        true, true, 'Authority boundary fixture', ${sourceCode},
        true, 'Reviewed integration fixture', ${`Authority source ${suffix}`},
        'https://example.invalid/catalogue-authority', 'government', 'CC0-1.0',
        'https://creativecommons.org/publicdomain/zero/1.0/', true, 'approved',
        pg_catalog.clock_timestamp(), 'principal:authority-fixture'
      )
      returning id
    `.execute(database)
  ).rows[0];
  if (!source) throw new Error("source fixture was not created");

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
        ${`s3://catalogue-artifacts/${artifactDigest}.json`},
        ${evidenceDigest},
        ${`s3://catalogue-evidence/sha256/${evidenceDigest}/bundle.json`},
        ${"f".repeat(64)}, ${`authority-version-${suffix}`},
        pg_catalog.clock_timestamp() + interval '12 hours', ${source.id},
        'application/json', ${`authority-parser@1+mapping.${mappingDigest}`}, 'live-reviewed',
        ${`authority-release-${suffix}`}, ${rightsDigest},
        'repo://catalogue-authority-rights.json'
      )
      returning id
    `.execute(database)
  ).rows[0];
  if (!batch) throw new Error("batch fixture was not created");
  await sql`
    insert into food_import_parser_report (
      batch_id, emitted_nutrient_count, emitted_portion_count,
      emitted_record_count, excluded_nutrient_count, excluded_portion_count,
      excluded_record_count, report, report_sha256, source_nutrient_count,
      source_portion_count, source_record_count
    ) values (
      ${batch.id}::uuid, 0, 0, 0, 0, 0, 0,
      pg_catalog.jsonb_build_object('fixture', 'catalogue-authority-boundary'),
      ${"c".repeat(64)}, 0, 0, 0
    )
  `.execute(database);
  const materializationContractPresent = (
    await sql<{ present: boolean }>`
      select exists (
        select 1
        from pg_catalog.pg_attribute as attribute_row
        where attribute_row.attrelid = 'food_import_batch'::pg_catalog.regclass
          and attribute_row.attname = 'validated_food_contract_version'
          and not attribute_row.attisdropped
      ) as present
    `.execute(database)
  ).rows[0]?.present;
  if (materializationContractPresent) {
    await sql`
      update food_import_batch
      set status = 'ready',
          validated_at = pg_catalog.clock_timestamp(),
          validation_digest = ${validationDigest},
          validated_food_contract_version = 1,
          nutrient_mapping_digest = ${mappingDigest},
          nutrient_mapping_revision_ids = '[]'::jsonb
      where id = ${batch.id}::uuid
    `.execute(database);
  } else {
    await sql`
      update food_import_batch
      set status = 'ready',
          validated_at = pg_catalog.clock_timestamp(),
          validation_digest = ${validationDigest}
      where id = ${batch.id}::uuid
    `.execute(database);
  }
  const nutritionSemanticAttestor = (
    await sql<{ present: boolean; schema_name: string }>`
      select
        pg_catalog.current_schema()::text as schema_name,
        pg_catalog.to_regprocedure(pg_catalog.format(
          '%I.catalogue_attest_import_nutrition_semantics(uuid)',
          pg_catalog.current_schema()
        )) is not null as present
    `.execute(database)
  ).rows[0];
  if (nutritionSemanticAttestor?.present) {
    await sql`
      select ${sql.id(
        nutritionSemanticAttestor.schema_name,
      )}.catalogue_attest_import_nutrition_semantics(${batch.id}::uuid)
    `.execute(database);
  }
  return { batchId: batch.id, sourceCode, sourceId: source.id };
}

async function seedCompletedLegacyBatch(
  database: Kysely<Database>,
  suffix: string,
): Promise<{
  batchId: string;
  releaseId: string;
  sourceCode: string;
  sourceId: string;
}> {
  const rightsDigest = "b".repeat(64);
  const { batchId, sourceCode, sourceId } = await seedReadyBatch(
    database,
    `${suffix}r`,
    "d".repeat(64),
    rightsDigest,
  );
  const release = (
    await sql<{ id: string }>`
      insert into food_source_release (
        acquired_at, artifact_bytes, artifact_sha256, artifact_uri,
        evidence_bundle_sha256, evidence_bundle_uri, evidence_decision_sha256,
        evidence_object_version_id, evidence_valid_until, food_source_id,
        media_type, parser_version, record_counts, release_class,
        release_key, rights_manifest_sha256, rights_manifest_uri, status,
        validation_summary
      )
      select
        batch.acquired_at, batch.artifact_bytes, batch.artifact_sha256,
        batch.artifact_uri, batch.evidence_bundle_sha256,
        batch.evidence_bundle_uri, batch.evidence_decision_sha256,
        batch.evidence_object_version_id, batch.evidence_valid_until,
        batch.food_source_id, batch.media_type, batch.parser_version,
        '{}'::jsonb, batch.release_class,
        batch.release_key, batch.rights_manifest_sha256,
        batch.rights_manifest_uri, 'imported', '{}'::jsonb
      from food_import_batch as batch
      where batch.id = ${batchId}::uuid
      returning id
    `.execute(database)
  ).rows[0];
  if (!release) throw new Error("legacy release fixture was not created");

  await sql`
    update food_source_release
    set promoted_at = pg_catalog.clock_timestamp(), status = 'promoted'
    where id = ${release.id}::uuid
  `.execute(database);
  await sql`
    update food_import_batch
    set release_id = ${release.id}::uuid, status = 'promoting'
    where id = ${batchId}::uuid
  `.execute(database);
  await sql`
    update food_import_batch
    set
      completed_at = pg_catalog.clock_timestamp(),
      materialized_count = 0,
      status = 'completed'
    where id = ${batchId}::uuid
  `.execute(database);
  await sql`
    update food_source
    set active_release_id = ${release.id}::uuid
    where id = ${sourceId}::bigint
  `.execute(database);
  await sql`
    insert into food_source_release_activation (
      food_source_id, import_batch_id, operation, performed_by,
      previous_release_id, reason, release_id
    ) values (
      ${sourceId}::bigint, ${batchId}::uuid, 'activate',
      'principal:legacy-promoter', null,
      'Completed before database-owned promotion authority',
      ${release.id}::uuid
    )
  `.execute(database);
  return { batchId, releaseId: release.id, sourceCode, sourceId };
}

async function expectPostgresCode(
  operation: Promise<unknown>,
  expectedCode: string,
  expectedMessage?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: expectedCode });
  if (expectedMessage)
    expect(caught).toMatchObject({ message: expect.stringContaining(expectedMessage) });
}
