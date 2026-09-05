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
  readonly capability: (typeof capabilityRoles)[number] | null;
  readonly login: string;
  readonly password: string;
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
          "food_import_batch",
          "food_import_approval",
          "food_import_record",
          "food_source",
          "food_source_release",
          "food_source_release_activation",
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
          "food_import_approval_id_seq",
          "food_source_release_activation_id_seq",
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
        if (credential.capability) {
          await sql.raw(`grant ${credential.capability} to ${credential.login}`).execute(bootstrap);
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
      const [dataReviewer, qualityReviewer, rightsReviewer, unassignedReviewer] = clients;
      if (!dataReviewer || !qualityReviewer || !rightsReviewer || !unassignedReviewer) {
        throw new Error("reviewer database clients were not created");
      }

      const validationDigest = "d".repeat(64);
      const rightsDigest = "b".repeat(64);
      const { batchId, sourceId } = await seedReadyBatch(
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
        "23514",
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
        "23514",
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

async function seedReadyBatch(
  database: Kysely<Database>,
  suffix: string,
  validationDigest: string,
  rightsDigest: string,
): Promise<{ batchId: string; sourceId: string }> {
  const source = (
    await sql<{ id: string }>`
      insert into food_source (
        active, attribution_required, attribution_text, code,
        commercial_use_allowed, database_rights_notes, display_name,
        homepage_url, kind, license_expression, license_url,
        redistribution_allowed, rights_review_status, rights_reviewed_at,
        rights_reviewed_by
      ) values (
        true, true, 'Authority boundary fixture', ${`AB${suffix.toUpperCase()}`},
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
        'application/json', 'authority-parser@1', 'live-reviewed',
        ${`authority-release-${suffix}`}, ${rightsDigest},
        'repo://catalogue-authority-rights.json'
      )
      returning id
    `.execute(database)
  ).rows[0];
  if (!batch) throw new Error("batch fixture was not created");
  await sql`
    update food_import_batch
    set status = 'ready',
        validated_at = pg_catalog.clock_timestamp(),
        validation_digest = ${validationDigest}
    where id = ${batch.id}::uuid
  `.execute(database);
  return { batchId: batch.id, sourceId: source.id };
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
