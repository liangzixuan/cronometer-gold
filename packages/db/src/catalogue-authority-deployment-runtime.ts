import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

import {
  assertCatalogueAuthorityCanaryEvidence,
  assertCatalogueAuthorityDeploymentEvidence,
  CATALOGUE_AUTHORITY_PROTECTED_TABLES,
  CATALOGUE_AUTHORITY_TRIGGER_POLICY,
  CATALOGUE_CAPABILITY_ROLES,
  type CatalogueAuthorityCanaryEvidence,
  type CatalogueAuthorityCanaryName,
  type CatalogueAuthorityDeploymentEvidence,
  type CatalogueAuthorityDeploymentPolicy,
  type CatalogueFunctionEvidence,
  type CatalogueRoleMembershipEvidence,
  catalogueAuthorityDeploymentPolicySha256,
  catalogueAuthorityDeploymentStructure,
  catalogueAuthorityDeploymentStructureSha256,
} from "./catalogue-authority-deployment.js";
import type { Database } from "./types.js";

export interface CatalogueAuthorityCanaryConnections {
  readonly nonReviewers: {
    readonly api: Kysely<Database>;
    readonly unassigned: Kysely<Database>;
    readonly worker: Kysely<Database>;
  };
  readonly owner: Kysely<Database>;
  readonly reviewers: {
    readonly data: Kysely<Database>;
    readonly quality: Kysely<Database>;
    readonly rights: Kysely<Database>;
  };
}

interface RoleRow {
  readonly approval_function_execute: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcanlogin: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolinherit: boolean;
  readonly rolname: string;
  readonly rolreplication: boolean;
  readonly rolsuper: boolean;
  readonly owned_object_count: number;
  readonly schema_create: boolean;
  readonly schema_usage: boolean;
}

interface MembershipRow {
  readonly admin_option: boolean;
  readonly grantor: string;
  readonly inherit_option: boolean;
  readonly member: string;
  readonly role: string;
  readonly set_option: boolean;
}

interface AclRow {
  readonly grantable: boolean;
  readonly grantee: string;
  readonly grantor: string;
  readonly privilege: string;
}

interface FunctionRow {
  readonly acl_is_default: boolean;
  readonly arguments: string;
  readonly language: string;
  readonly leakproof: boolean;
  readonly name: string;
  readonly owner: string;
  readonly parallel: string;
  readonly result_type: string;
  readonly search_path: string[] | null;
  readonly security_definer: boolean;
  readonly source_sha256: string;
  readonly strict: boolean;
  readonly volatility: string;
}

interface FunctionAclRow extends AclRow {
  readonly arguments: string;
  readonly function_name: string;
}

interface OwnedObjectRow {
  readonly acl_is_default: boolean;
  readonly kind: string;
  readonly name: string;
  readonly owner: string;
}

interface ObjectAclRow extends AclRow {
  readonly object_name: string;
}

interface DefaultAclRow extends AclRow {
  readonly object_type: string;
  readonly owner: string;
  readonly schema_name: string;
}

interface DefaultAclIdentityRow {
  readonly object_type: string;
  readonly owner: string;
  readonly schema_name: string;
}

const REVIEWER_CLASSES = ["data", "quality", "rights"] as const;
const NON_REVIEWER_CLASSES = ["api", "unassigned", "worker"] as const;
const _TABLE_PRIVILEGES = [
  "DELETE",
  "INSERT",
  "REFERENCES",
  "SELECT",
  "TRIGGER",
  "TRUNCATE",
  "UPDATE",
];
const _SEQUENCE_PRIVILEGES = ["SELECT", "UPDATE", "USAGE"];
// These helpers are intentionally reused across the application. Their catalogue
// bindings are discovered by exact reviewed trigger name instead of function name.
const SHARED_APPLICATION_TRIGGER_FUNCTIONS = new Set([
  "reject_immutable_row_update",
  "set_row_updated_at",
]);

export async function collectCatalogueAuthorityDeploymentEvidence(
  database: Kysely<Database>,
  policy: CatalogueAuthorityDeploymentPolicy,
  expectedSessions: CatalogueAuthorityDeploymentEvidence["database"]["verifierSessions"],
): Promise<CatalogueAuthorityDeploymentEvidence> {
  if (expectedSessions.length === 0) {
    throw new Error("Catalogue authority verifier sessions are unavailable");
  }
  const databaseRow = (
    await sql<{
      readonly name: string;
      readonly owner: string;
      readonly public_connect: boolean;
    }>`
      select
        database_row.datname as name,
        pg_catalog.pg_get_userbyid(database_row.datdba) as owner,
        exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              database_row.datacl,
              pg_catalog.acldefault('d', database_row.datdba)
            )
          ) as acl
          where acl.grantee = 0
            and acl.privilege_type = 'CONNECT'
        ) as public_connect
      from pg_catalog.pg_database as database_row
      where database_row.datname = pg_catalog.current_database()
    `.execute(database)
  ).rows[0];
  if (!databaseRow) throw new Error("Catalogue authority database identity is unavailable");

  const databaseAcl = (
    await sql<AclRow>`
      select
        coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
        coalesce(grantor_role.rolname, 'PUBLIC') as grantor,
        acl.privilege_type as privilege,
        acl.is_grantable as grantable
      from pg_catalog.pg_database as database_row
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          database_row.datacl,
          pg_catalog.acldefault('d', database_row.datdba)
        )
      ) as acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = acl.grantee
      left join pg_catalog.pg_roles as grantor_role
        on grantor_role.oid = acl.grantor
      where database_row.datname = pg_catalog.current_database()
      order by grantee, privilege
    `.execute(database)
  ).rows;

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
    `.execute(database)
  ).rows.map((row) => row.name);

  const expectedSessionPids = sql.join(expectedSessions.map((session) => sql`${session.pid}`));
  const verifierSessions = (
    await sql<{
      readonly application_name: string;
      readonly login: string;
      readonly pid: number;
    }>`
      select
        activity.pid,
        activity.usename as login,
        activity.application_name
      from pg_catalog.pg_stat_activity as activity
      where activity.datname = pg_catalog.current_database()
        and activity.backend_type = 'client backend'
        and activity.pid in (${expectedSessionPids})
      order by activity.pid
    `.execute(database)
  ).rows.map((row) => ({
    applicationName: row.application_name,
    login: row.login,
    pid: row.pid,
  }));
  const unexpectedClientSessionCount =
    (
      await sql<{ readonly count: number }>`
        select pg_catalog.count(*)::integer as count
        from pg_catalog.pg_stat_activity as activity
        where activity.datname = pg_catalog.current_database()
          and activity.backend_type = 'client backend'
          and activity.pid not in (${expectedSessionPids})
      `.execute(database)
    ).rows[0]?.count ?? -1;

  const nonSystemSchemas = (
    await sql<{ readonly name: string }>`
      select namespace_row.nspname as name
      from pg_catalog.pg_namespace as namespace_row
      where namespace_row.nspname <> 'information_schema'
        and not pg_catalog.starts_with(namespace_row.nspname, 'pg_')
      order by namespace_row.nspname
    `.execute(database)
  ).rows.map((row) => row.name);

  const schemaRow = (
    await sql<{
      readonly name: string;
      readonly owner: string;
      readonly public_create: boolean;
    }>`
      select
        namespace_row.nspname as name,
        pg_catalog.pg_get_userbyid(namespace_row.nspowner) as owner,
        exists (
          select 1
          from pg_catalog.aclexplode(
            coalesce(
              namespace_row.nspacl,
              pg_catalog.acldefault('n', namespace_row.nspowner)
            )
          ) as acl
          where acl.grantee = 0
            and acl.privilege_type = 'CREATE'
        ) as public_create
      from pg_catalog.pg_namespace as namespace_row
      where namespace_row.nspname = ${policy.applicationSchema}
    `.execute(database)
  ).rows[0];
  if (!schemaRow) throw new Error("Catalogue authority application schema is unavailable");

  const schemaAcl = (
    await sql<AclRow>`
      select
        coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
        coalesce(grantor_role.rolname, 'PUBLIC') as grantor,
        acl.privilege_type as privilege,
        acl.is_grantable as grantable
      from pg_catalog.pg_namespace as namespace_row
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          namespace_row.nspacl,
          pg_catalog.acldefault('n', namespace_row.nspowner)
        )
      ) as acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = acl.grantee
      left join pg_catalog.pg_roles as grantor_role
        on grantor_role.oid = acl.grantor
      where namespace_row.nspname = ${policy.applicationSchema}
      order by grantee, privilege
    `.execute(database)
  ).rows;

  const relationRows = (
    await sql<OwnedObjectRow>`
      select
        class_row.relname as name,
        class_row.relkind::text as kind,
        pg_catalog.pg_get_userbyid(class_row.relowner) as owner,
        class_row.relacl is null as acl_is_default
      from pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      where namespace_row.nspname = ${policy.applicationSchema}
        and class_row.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      order by class_row.relname, class_row.relkind
    `.execute(database)
  ).rows;
  const relationAclRows = (
    await sql<ObjectAclRow>`
      select
        class_row.relname as object_name,
        coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
        coalesce(grantor_role.rolname, 'PUBLIC') as grantor,
        acl.privilege_type as privilege,
        acl.is_grantable as grantable
      from pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          class_row.relacl,
          pg_catalog.acldefault(
            (case when class_row.relkind = 'S' then 's' else 'r' end)::"char",
            class_row.relowner
          )
        )
      ) as acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = acl.grantee
      left join pg_catalog.pg_roles as grantor_role
        on grantor_role.oid = acl.grantor
      where namespace_row.nspname = ${policy.applicationSchema}
        and class_row.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      order by class_row.relname, grantee, privilege
    `.execute(database)
  ).rows;
  const relations = relationRows.map((row) => ({
    acl: relationAclRows.filter((entry) => entry.object_name === row.name).map(toAclEvidence),
    aclIsDefault: row.acl_is_default,
    kind: row.kind,
    name: row.name,
    owner: row.owner,
  }));

  const typeRows = (
    await sql<OwnedObjectRow>`
      select
        type_row.typname as name,
        type_row.typtype::text as kind,
        pg_catalog.pg_get_userbyid(type_row.typowner) as owner,
        type_row.typacl is null as acl_is_default
      from pg_catalog.pg_type as type_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = type_row.typnamespace
      where namespace_row.nspname = ${policy.applicationSchema}
      order by type_row.typname, type_row.typtype
    `.execute(database)
  ).rows;
  const typeAclRows = (
    await sql<ObjectAclRow>`
      select
        type_row.typname as object_name,
        coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
        coalesce(grantor_role.rolname, 'PUBLIC') as grantor,
        acl.privilege_type as privilege,
        acl.is_grantable as grantable
      from pg_catalog.pg_type as type_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = type_row.typnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(type_row.typacl, pg_catalog.acldefault('T', type_row.typowner))
      ) as acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = acl.grantee
      left join pg_catalog.pg_roles as grantor_role
        on grantor_role.oid = acl.grantor
      where namespace_row.nspname = ${policy.applicationSchema}
      order by type_row.typname, grantee, privilege
    `.execute(database)
  ).rows;
  const types = typeRows.map((row) => ({
    acl: typeAclRows.filter((entry) => entry.object_name === row.name).map(toAclEvidence),
    aclIsDefault: row.acl_is_default,
    kind: row.kind,
    name: row.name,
    owner: row.owner,
  }));

  const defaultAclIdentities = (
    await sql<DefaultAclIdentityRow>`
      select
        pg_catalog.pg_get_userbyid(default_acl.defaclrole) as owner,
        coalesce(namespace_row.nspname, '*') as schema_name,
        default_acl.defaclobjtype::text as object_type
      from pg_catalog.pg_default_acl as default_acl
      left join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = default_acl.defaclnamespace
      where default_acl.defaclnamespace = 0
         or namespace_row.nspname = ${policy.applicationSchema}
      order by owner, schema_name, object_type
    `.execute(database)
  ).rows;
  const defaultAclRows = (
    await sql<DefaultAclRow>`
      select
        pg_catalog.pg_get_userbyid(default_acl.defaclrole) as owner,
        coalesce(namespace_row.nspname, '*') as schema_name,
        default_acl.defaclobjtype::text as object_type,
        coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
        coalesce(grantor_role.rolname, 'PUBLIC') as grantor,
        acl.privilege_type as privilege,
        acl.is_grantable as grantable
      from pg_catalog.pg_default_acl as default_acl
      left join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = default_acl.defaclnamespace
      cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) as acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = acl.grantee
      left join pg_catalog.pg_roles as grantor_role
        on grantor_role.oid = acl.grantor
      where default_acl.defaclnamespace = 0
         or namespace_row.nspname = ${policy.applicationSchema}
      order by owner, schema_name, object_type, grantee, privilege
    `.execute(database)
  ).rows;
  const defaultAclKeys = defaultAclIdentities.map(
    (row) => `${row.owner}\u0000${row.schema_name}\u0000${row.object_type}`,
  );
  const defaultAcls = defaultAclKeys.map((key) => {
    const [owner, schemaName, objectType] = key.split("\u0000");
    if (!owner || !schemaName || !objectType) {
      throw new Error("Catalogue authority default ACL identity is malformed");
    }
    return {
      acl: defaultAclRows
        .filter(
          (row) =>
            row.owner === owner && row.schema_name === schemaName && row.object_type === objectType,
        )
        .map(toAclEvidence),
      objectType,
      owner,
      schemaName,
    };
  });

  const columnAcls = (
    await sql<{
      readonly column_name: string;
      readonly grantable: boolean;
      readonly grantee: string;
      readonly grantor: string;
      readonly privilege: string;
      readonly relation_name: string;
    }>`
      select
        class_row.relname as relation_name,
        attribute_row.attname as column_name,
        coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
        coalesce(grantor_role.rolname, 'PUBLIC') as grantor,
        acl.privilege_type as privilege,
        acl.is_grantable as grantable
      from pg_catalog.pg_attribute as attribute_row
      join pg_catalog.pg_class as class_row
        on class_row.oid = attribute_row.attrelid
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      cross join lateral pg_catalog.aclexplode(attribute_row.attacl) as acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = acl.grantee
      left join pg_catalog.pg_roles as grantor_role
        on grantor_role.oid = acl.grantor
      where namespace_row.nspname = ${policy.applicationSchema}
        and attribute_row.attnum > 0
        and not attribute_row.attisdropped
        and attribute_row.attacl is not null
      order by class_row.relname, attribute_row.attname, grantee, privilege
    `.execute(database)
  ).rows.map((row) => ({
    columnName: row.column_name,
    grantable: row.grantable,
    grantee: row.grantee,
    grantor: row.grantor,
    privilege: row.privilege,
    relationName: row.relation_name,
  }));
  const explicitColumnAclAttributeCount =
    (
      await sql<{ readonly count: number }>`
        select pg_catalog.count(*)::integer as count
        from pg_catalog.pg_attribute as attribute_row
        join pg_catalog.pg_class as class_row
          on class_row.oid = attribute_row.attrelid
        join pg_catalog.pg_namespace as namespace_row
          on namespace_row.oid = class_row.relnamespace
        where namespace_row.nspname = ${policy.applicationSchema}
          and attribute_row.attnum > 0
          and not attribute_row.attisdropped
          and attribute_row.attacl is not null
      `.execute(database)
    ).rows[0]?.count ?? -1;

  const authorityConstraints = (
    await sql<{
      readonly constraint_type: string;
      readonly definition: string;
      readonly name: string;
      readonly table_name: string;
      readonly validated: boolean;
    }>`
      select
        constraint_row.conname as name,
        class_row.relname as table_name,
        constraint_row.contype::text as constraint_type,
        constraint_row.convalidated as validated,
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
      from pg_catalog.pg_constraint as constraint_row
      join pg_catalog.pg_class as class_row
        on class_row.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      where namespace_row.nspname = ${policy.applicationSchema}
        and constraint_row.conname in (
          'food_import_batch_materialization_contract_check',
          'food_import_batch_promotable_contract_check',
          'food_import_batch_stage_validate_database_authority_check',
          'food_import_batch_staging_seal_check',
          'food_import_record_validated_food_contract_check',
          'food_source_release_activation_database_authority_check'
        )
      order by class_row.relname, constraint_row.conname
    `.execute(database)
  ).rows.map((row) => ({
    constraintType: row.constraint_type,
    definition: row.definition,
    name: row.name,
    tableName: row.table_name,
    validated: row.validated,
  }));

  const authorityFrozenColumns = (
    await sql<{
      readonly column_name: string;
      readonly data_type: string;
      readonly default_expression: string | null;
      readonly not_null: boolean;
      readonly schema_name: string;
      readonly table_name: string;
    }>`
      select
        namespace_row.nspname as schema_name,
        class_row.relname as table_name,
        attribute_row.attname as column_name,
        pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) as data_type,
        attribute_row.attnotnull as not_null,
        pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid, true) as default_expression
      from pg_catalog.pg_attribute as attribute_row
      join pg_catalog.pg_class as class_row
        on class_row.oid = attribute_row.attrelid
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      left join pg_catalog.pg_attrdef as default_row
        on default_row.adrelid = attribute_row.attrelid
        and default_row.adnum = attribute_row.attnum
      where namespace_row.nspname = ${policy.applicationSchema}
        and (
          (class_row.relname = 'food_import_batch' and attribute_row.attname in (
            'nutrient_mapping_digest',
            'nutrient_mapping_revision_ids',
            'staged_database_capability_role',
            'staged_database_principal',
            'staging_seal_sha256',
            'staging_sealed_at',
            'validated_database_capability_role',
            'validated_database_principal',
            'validated_food_contract_version'
          ))
          or (class_row.relname = 'food_import_record' and attribute_row.attname in (
            'validated_food_contract_version',
            'validated_food_document',
            'validated_food_sha256'
          ))
        )
      order by class_row.relname, attribute_row.attname
    `.execute(database)
  ).rows.map((row) => ({
    columnName: row.column_name,
    dataType: row.data_type,
    defaultExpression: row.default_expression,
    notNull: row.not_null,
    schemaName: row.schema_name,
    tableName: row.table_name,
  }));

  const authorityIndexes = (
    await sql<{
      readonly access_method: string;
      readonly definition: string;
      readonly is_primary: boolean;
      readonly is_ready: boolean;
      readonly is_unique: boolean;
      readonly is_valid: boolean;
      readonly key_attribute_count: number;
      readonly key_expression: string;
      readonly name: string;
      readonly owner: string;
      readonly predicate: string | null;
      readonly schema_name: string;
      readonly table_name: string;
      readonly total_attribute_count: number;
    }>`
      select
        namespace_row.nspname as schema_name,
        table_row.relname as table_name,
        index_row.relname as name,
        pg_catalog.pg_get_userbyid(index_row.relowner) as owner,
        access_method.amname as access_method,
        index_metadata.indisunique as is_unique,
        index_metadata.indisprimary as is_primary,
        index_metadata.indisvalid as is_valid,
        index_metadata.indisready as is_ready,
        index_metadata.indnkeyatts::integer as key_attribute_count,
        index_metadata.indnatts::integer as total_attribute_count,
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 1, true) as key_expression,
        pg_catalog.pg_get_expr(
          index_metadata.indpred,
          index_metadata.indrelid,
          true
        ) as predicate,
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid) as definition
      from pg_catalog.pg_index as index_metadata
      join pg_catalog.pg_class as index_row
        on index_row.oid = index_metadata.indexrelid
      join pg_catalog.pg_class as table_row
        on table_row.oid = index_metadata.indrelid
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = table_row.relnamespace
      join pg_catalog.pg_am as access_method
        on access_method.oid = index_row.relam
      where namespace_row.nspname = ${policy.applicationSchema}
        and index_row.relname = 'food_source_release_activation_import_batch_unique'
      order by namespace_row.nspname, table_row.relname, index_row.relname
    `.execute(database)
  ).rows.map((row) => ({
    accessMethod: row.access_method,
    definition: row.definition,
    isPrimary: row.is_primary,
    isReady: row.is_ready,
    isUnique: row.is_unique,
    isValid: row.is_valid,
    keyAttributeCount: row.key_attribute_count,
    keyExpression: row.key_expression,
    name: row.name,
    owner: row.owner,
    predicate: row.predicate,
    schemaName: row.schema_name,
    tableName: row.table_name,
    totalAttributeCount: row.total_attribute_count,
  }));

  const protectedNames = [
    ...CATALOGUE_CAPABILITY_ROLES,
    ...REVIEWER_CLASSES.map((role) => policy.reviewerLogins[role]),
    ...NON_REVIEWER_CLASSES.map((role) => policy.nonReviewerLogins[role]),
  ];
  const protectedSql = sql.join(protectedNames.map((name) => sql`${name}`));
  const approvalFunctionIdentity = `${policy.applicationSchema}.catalogue_record_import_approval(uuid,text,text,text,text,text)`;
  const roleRows = (
    await sql<RoleRow>`
      select
        role_row.rolname,
        role_row.rolcanlogin,
        role_row.rolinherit,
        role_row.rolsuper,
        role_row.rolcreatedb,
        role_row.rolcreaterole,
        role_row.rolreplication,
        role_row.rolbypassrls,
        pg_catalog.has_schema_privilege(
          role_row.oid,
          namespace_row.oid,
          'CREATE'
        ) as schema_create,
        pg_catalog.has_schema_privilege(
          role_row.oid,
          namespace_row.oid,
          'USAGE'
        ) as schema_usage,
        pg_catalog.has_function_privilege(
          role_row.oid,
          pg_catalog.to_regprocedure(${approvalFunctionIdentity}),
          'EXECUTE'
        ) as approval_function_execute,
        (
          select pg_catalog.count(*)::integer
          from pg_catalog.pg_shdepend as dependency
          where dependency.refclassid =
              'pg_catalog.pg_authid'::pg_catalog.regclass
            and dependency.refobjid = role_row.oid
            and dependency.deptype = 'o'
        ) as owned_object_count
      from pg_catalog.pg_roles as role_row
      cross join pg_catalog.pg_namespace as namespace_row
      where namespace_row.nspname = ${policy.applicationSchema}
        and role_row.rolname in (${protectedSql})
      order by role_row.rolname
    `.execute(database)
  ).rows;

  const membershipRows = (
    await sql<MembershipRow>`
      select
        target_role.rolname as role,
        member_role.rolname as member,
        pg_catalog.pg_get_userbyid(membership.grantor) as grantor,
        membership.admin_option,
        membership.inherit_option,
        membership.set_option
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as target_role
        on target_role.oid = membership.roleid
      join pg_catalog.pg_roles as member_role
        on member_role.oid = membership.member
      where target_role.rolname in (${protectedSql})
         or member_role.rolname in (${protectedSql})
      order by target_role.rolname, member_role.rolname, grantor
    `.execute(database)
  ).rows;

  const reviewerLoginNames = REVIEWER_CLASSES.map((role) => policy.reviewerLogins[role]);
  const nonReviewerLoginNames = NON_REVIEWER_CLASSES.map((role) => policy.nonReviewerLogins[role]);
  const loginNames = [...reviewerLoginNames, ...nonReviewerLoginNames].sort();
  const loginSql = sql.join(loginNames.map((name) => sql`${name}`));

  const tablePrivileges = (
    await sql<{
      readonly login: string;
      readonly object_name: string;
      readonly privilege: string;
    }>`
      select
        login_role.rolname as login,
        class_row.relname as object_name,
        privilege.name as privilege
      from pg_catalog.pg_roles as login_role
      cross join pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      cross join (
        values
          ('DELETE'), ('INSERT'), ('REFERENCES'), ('SELECT'),
          ('TRIGGER'), ('TRUNCATE'), ('UPDATE')
      ) as privilege(name)
      where login_role.rolname in (${loginSql})
        and namespace_row.nspname = ${policy.applicationSchema}
        and class_row.relkind in ('r', 'p', 'v', 'm', 'f')
        and pg_catalog.has_table_privilege(login_role.oid, class_row.oid, privilege.name)
      order by login_role.rolname, class_row.relname, privilege.name
    `.execute(database)
  ).rows;

  const columnPrivileges = (
    await sql<{
      readonly login: string;
      readonly object_name: string;
      readonly privilege: string;
    }>`
      select
        login_role.rolname as login,
        class_row.relname || '.' || attribute_row.attname as object_name,
        privilege.name as privilege
      from pg_catalog.pg_roles as login_role
      cross join pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      join pg_catalog.pg_attribute as attribute_row
        on attribute_row.attrelid = class_row.oid
       and attribute_row.attnum > 0
       and not attribute_row.attisdropped
      cross join (
        values ('INSERT'), ('REFERENCES'), ('SELECT'), ('UPDATE')
      ) as privilege(name)
      where login_role.rolname in (${loginSql})
        and namespace_row.nspname = ${policy.applicationSchema}
        and class_row.relkind in ('r', 'p', 'v', 'm', 'f')
        and pg_catalog.has_column_privilege(
          login_role.oid,
          class_row.oid,
          attribute_row.attnum,
          privilege.name
        )
      order by
        login_role.rolname,
        class_row.relname,
        attribute_row.attname,
        privilege.name
    `.execute(database)
  ).rows;

  const sequencePrivileges = (
    await sql<{
      readonly login: string;
      readonly object_name: string;
      readonly privilege: string;
    }>`
      select
        login_role.rolname as login,
        class_row.relname as object_name,
        privilege.name as privilege
      from pg_catalog.pg_roles as login_role
      cross join pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      cross join (values ('SELECT'), ('UPDATE'), ('USAGE')) as privilege(name)
      where login_role.rolname in (${loginSql})
        and namespace_row.nspname = ${policy.applicationSchema}
        and class_row.relkind = 'S'
        and pg_catalog.has_sequence_privilege(login_role.oid, class_row.oid, privilege.name)
      order by login_role.rolname, class_row.relname, privilege.name
    `.execute(database)
  ).rows;

  const functionRows = (
    await sql<FunctionRow>`
      select
        procedure_row.proname as name,
        pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as arguments,
        pg_catalog.pg_get_function_result(procedure_row.oid) as result_type,
        language_row.lanname as language,
        procedure_row.provolatile as volatility,
        procedure_row.proisstrict as strict,
        procedure_row.proleakproof as leakproof,
        procedure_row.proparallel as parallel,
        procedure_row.prosecdef as security_definer,
        procedure_row.proacl is null as acl_is_default,
        pg_catalog.pg_get_userbyid(procedure_row.proowner) as owner,
        procedure_row.proconfig as search_path,
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
          'hex'
        ) as source_sha256
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      join pg_catalog.pg_language as language_row
        on language_row.oid = procedure_row.prolang
      where namespace_row.nspname = ${policy.applicationSchema}
      order by procedure_row.proname,
        pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
    `.execute(database)
  ).rows;

  const functionAclRows = (
    await sql<FunctionAclRow>`
      select
        procedure_row.proname as function_name,
        pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as arguments,
        coalesce(grantee_role.rolname, 'PUBLIC') as grantee,
        pg_catalog.pg_get_userbyid(acl.grantor) as grantor,
        acl.privilege_type as privilege,
        acl.is_grantable as grantable
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          procedure_row.proacl,
          pg_catalog.acldefault('f', procedure_row.proowner)
        )
      ) as acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = acl.grantee
      where namespace_row.nspname = ${policy.applicationSchema}
      order by procedure_row.proname, arguments, grantee
    `.execute(database)
  ).rows;

  const functionEvidence = (row: FunctionRow): CatalogueFunctionEvidence => {
    const acl = functionAclRows
      .filter((entry) => entry.function_name === row.name && entry.arguments === row.arguments)
      .map((entry) => ({
        grantable: entry.grantable,
        grantee: entry.grantee,
        grantor: entry.grantor,
        privilege: entry.privilege,
      }));
    return {
      acl,
      aclIsDefault: row.acl_is_default,
      arguments: row.arguments,
      language: row.language,
      leakproof: row.leakproof,
      name: row.name,
      owner: row.owner,
      parallel: row.parallel,
      publicExecute: acl.some(
        (entry) => entry.grantee === "PUBLIC" && entry.privilege === "EXECUTE",
      ),
      resultType: row.result_type,
      searchPath: row.search_path ?? [],
      securityDefiner: row.security_definer,
      sourceSha256: row.source_sha256,
      strict: row.strict,
      volatility: row.volatility,
    };
  };
  const functions = functionRows.map(functionEvidence);

  const protectedCatalogueTables = sql.join(
    CATALOGUE_AUTHORITY_PROTECTED_TABLES.map((entry) => sql`${entry}`),
  );
  const reviewedCatalogueTriggerNames = sql.join(
    CATALOGUE_AUTHORITY_TRIGGER_POLICY.map((entry) => sql`${entry.name}`),
  );
  const reviewedCatalogueExclusiveTriggerFunctions = sql.join(
    [
      ...new Set(
        CATALOGUE_AUTHORITY_TRIGGER_POLICY.map((entry) => entry.functionName).filter(
          (entry) => !SHARED_APPLICATION_TRIGGER_FUNCTIONS.has(entry),
        ),
      ),
    ].map((entry) => sql`${entry}`),
  );
  const triggers = (
    await sql<{
      readonly definition: string;
      readonly enabled: string;
      readonly function_arguments: string;
      readonly function_name: string;
      readonly function_schema: string;
      readonly name: string;
      readonly table_name: string;
      readonly table_schema: string;
    }>`
      select
        trigger_row.tgname as name,
        namespace_row.nspname as table_schema,
        class_row.relname as table_name,
        procedure_namespace.nspname as function_schema,
        procedure_row.proname as function_name,
        pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
          as function_arguments,
        trigger_row.tgenabled::text as enabled,
        pg_catalog.pg_get_triggerdef(trigger_row.oid, true) as definition
      from pg_catalog.pg_trigger as trigger_row
      join pg_catalog.pg_class as class_row
        on class_row.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      join pg_catalog.pg_proc as procedure_row
        on procedure_row.oid = trigger_row.tgfoid
      join pg_catalog.pg_namespace as procedure_namespace
        on procedure_namespace.oid = procedure_row.pronamespace
      where not trigger_row.tgisinternal
        and (
          (
            namespace_row.nspname = ${policy.applicationSchema}
            and class_row.relname in (${protectedCatalogueTables})
          )
          or (
            namespace_row.nspname = ${policy.applicationSchema}
            and trigger_row.tgname in (${reviewedCatalogueTriggerNames})
          )
          or (
            procedure_namespace.nspname = ${policy.applicationSchema}
            and procedure_row.proname in (${reviewedCatalogueExclusiveTriggerFunctions})
            and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
          )
        )
      order by
        trigger_row.tgname,
        namespace_row.nspname,
        class_row.relname,
        procedure_namespace.nspname,
        procedure_row.proname
    `.execute(database)
  ).rows.map((row) => ({
    definition: row.definition,
    enabled: row.enabled,
    functionArguments: row.function_arguments,
    functionName: row.function_name,
    functionSchema: row.function_schema,
    name: row.name,
    tableName: row.table_name,
    tableSchema: row.table_schema,
  }));

  const roleByName = new Map(roleRows.map((role) => [role.rolname, role]));
  const capabilityRoles = CATALOGUE_CAPABILITY_ROLES.map((name) => {
    const role = roleByName.get(name);
    if (!role) throw new Error(`Catalogue capability role ${name} is unavailable`);
    return {
      bypassRls: role.rolbypassrls,
      canCreateDatabase: role.rolcreatedb,
      canCreateRole: role.rolcreaterole,
      canLogin: role.rolcanlogin,
      incomingMemberships: membershipRows
        .filter((membership) => membership.role === name)
        .map(toMembershipEvidence),
      name,
      outgoingMemberships: membershipRows
        .filter((membership) => membership.member === name)
        .map((membership) => membership.role),
      ownedObjectCount: role.owned_object_count,
      replication: role.rolreplication,
      superuser: role.rolsuper,
    };
  });

  const logins = loginNames.map((name) => {
    const role = roleByName.get(name);
    if (!role) throw new Error(`Catalogue deployment login ${name} is unavailable`);
    return {
      approvalFunctionExecute: role.approval_function_execute,
      bypassRls: role.rolbypassrls,
      canCreateDatabase: role.rolcreatedb,
      canCreateRole: role.rolcreaterole,
      canLogin: role.rolcanlogin,
      effectiveColumnPrivileges: columnPrivileges
        .filter((entry) => entry.login === name)
        .map((entry) => `${entry.object_name}:${entry.privilege}`),
      effectiveSequencePrivileges: sequencePrivileges
        .filter((entry) => entry.login === name)
        .map((entry) => `${entry.object_name}:${entry.privilege}`),
      effectiveTablePrivileges: tablePrivileges
        .filter((entry) => entry.login === name)
        .map((entry) => `${entry.object_name}:${entry.privilege}`),
      inherit: role.rolinherit,
      memberships: membershipRows
        .filter((membership) => membership.member === name)
        .map(toMembershipEvidence),
      name,
      ownedObjectCount: role.owned_object_count,
      replication: role.rolreplication,
      schemaCreate: role.schema_create,
      schemaUsage: role.schema_usage,
      superuser: role.rolsuper,
    };
  });

  return {
    applicationSchema: {
      acl: schemaAcl,
      name: schemaRow.name,
      owner: schemaRow.owner,
      publicCreate: schemaRow.public_create,
    },
    authorityConstraints,
    authorityFrozenColumns,
    authorityIndexes,
    capabilityRoles,
    columnAcls,
    database: {
      acl: databaseAcl,
      effectiveLoginAllowlist,
      name: databaseRow.name,
      owner: databaseRow.owner,
      publicConnect: databaseRow.public_connect,
      unexpectedClientSessionCount,
      verifierSessions,
    },
    defaultAcls,
    explicitColumnAclAttributeCount,
    functions,
    logins,
    memberships: membershipRows.map(toMembershipEvidence),
    nonSystemSchemas,
    policySha256: catalogueAuthorityDeploymentPolicySha256(policy),
    relations,
    schemaVersion: 4,
    triggers,
    types,
  };
}

export async function runCatalogueReviewerCanaries(
  connections: CatalogueAuthorityCanaryConnections,
  policy: CatalogueAuthorityDeploymentPolicy,
): Promise<CatalogueAuthorityCanaryEvidence> {
  const verifierSessions = await assertSessionIdentities(connections, policy);
  const before = await collectCatalogueAuthorityDeploymentEvidence(
    connections.owner,
    policy,
    verifierSessions,
  );
  assertCatalogueAuthorityDeploymentEvidence(policy, before);
  const beforeApprovalRowCount = await approvalRowCount(
    connections.owner,
    policy.applicationSchema,
  );
  const batchId = randomUUID();
  const exists = (
    await sql<{ readonly exists: boolean }>`
      select exists (
        select 1
        from ${sql.id(policy.applicationSchema, "food_import_batch")}
        where id = ${batchId}::uuid
      ) as exists
    `.execute(connections.owner)
  ).rows[0]?.exists;
  if (exists !== false) throw new Error("Catalogue canary batch UUID is not absent");

  const results: Array<{
    readonly canary: CatalogueAuthorityCanaryName;
    readonly sqlstate: "23503" | "42501";
  }> = [];
  for (const reviewerClass of REVIEWER_CLASSES) {
    results.push(
      await approvalCanary(
        `${reviewerClass}-matching` as CatalogueAuthorityCanaryName,
        connections.reviewers[reviewerClass],
        policy.applicationSchema,
        reviewerClass,
        batchId,
        "23503",
      ),
    );
  }
  results.push(
    await approvalCanary(
      "data-requesting-quality",
      connections.reviewers.data,
      policy.applicationSchema,
      "quality",
      batchId,
      "42501",
    ),
  );
  for (const nonReviewerClass of NON_REVIEWER_CLASSES) {
    results.push(
      await approvalCanary(
        `${nonReviewerClass}-execute` as CatalogueAuthorityCanaryName,
        connections.nonReviewers[nonReviewerClass],
        policy.applicationSchema,
        "data",
        batchId,
        "42501",
      ),
    );
  }
  results.push(
    await expectSqlstate(
      "data-direct-dml",
      sql`
        explain (costs false)
        insert into ${sql.id(policy.applicationSchema, "food_import_approval")} (
          approval_reference,
          approval_role,
          batch_id,
          principal_id,
          rights_manifest_sha256,
          validation_digest
        ) values (
          'canary://catalogue-authority/direct-dml',
          'data',
          ${batchId}::uuid,
          'canary:catalogue-authority',
          ${"b".repeat(64)},
          ${"d".repeat(64)}
        )
      `.execute(connections.reviewers.data),
      "42501",
    ),
  );

  const afterApprovalRowCount = await approvalRowCount(connections.owner, policy.applicationSchema);
  const after = await collectCatalogueAuthorityDeploymentEvidence(
    connections.owner,
    policy,
    verifierSessions,
  );
  assertCatalogueAuthorityDeploymentEvidence(policy, after);
  const structure = catalogueAuthorityDeploymentStructure(before);
  const evidence: CatalogueAuthorityCanaryEvidence = {
    afterApprovalRowCount,
    afterStructureSha256: catalogueAuthorityDeploymentStructureSha256(after),
    beforeApprovalRowCount,
    beforeStructureSha256: catalogueAuthorityDeploymentStructureSha256(before),
    policySha256: catalogueAuthorityDeploymentPolicySha256(policy),
    results,
    schemaVersion: 4,
    structure,
  };
  assertCatalogueAuthorityCanaryEvidence(policy, evidence);
  return evidence;
}

async function approvalCanary(
  canary: CatalogueAuthorityCanaryName,
  database: Kysely<Database>,
  schema: string,
  approvalRole: "data" | "quality" | "rights",
  batchId: string,
  expectedSqlstate: "23503" | "42501",
): Promise<{
  readonly canary: CatalogueAuthorityCanaryName;
  readonly sqlstate: "23503" | "42501";
}> {
  return expectSqlstate(
    canary,
    sql`
      select ${sql.id(schema, "catalogue_record_import_approval")}(
        p_batch_id => ${batchId}::uuid,
        p_requested_approval_role => ${approvalRole}::text,
        p_validation_digest => ${"d".repeat(64)}::text,
        p_rights_digest => ${"b".repeat(64)}::text,
        p_external_principal_id => 'canary:catalogue-authority'::text,
        p_approval_reference => 'canary://catalogue-authority/zero-write'::text
      )
    `.execute(database),
    expectedSqlstate,
  );
}

async function expectSqlstate(
  canary: CatalogueAuthorityCanaryName,
  operation: Promise<unknown>,
  expected: "23503" | "42501",
): Promise<{
  readonly canary: CatalogueAuthorityCanaryName;
  readonly sqlstate: "23503" | "42501";
}> {
  try {
    await operation;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === expected) return { canary, sqlstate: expected };
    throw new Error(`Catalogue authority canary ${canary} returned an unexpected SQLSTATE`);
  }
  throw new Error(`Catalogue authority canary ${canary} unexpectedly succeeded`);
}

async function assertSessionIdentities(
  connections: CatalogueAuthorityCanaryConnections,
  policy: CatalogueAuthorityDeploymentPolicy,
): Promise<CatalogueAuthorityDeploymentEvidence["database"]["verifierSessions"]> {
  const pairs: Array<{
    readonly applicationName: string;
    readonly database: Kysely<Database>;
    readonly expectedLogin: string;
  }> = [
    {
      applicationName: "catalogue-authority-deploy-zero-owner",
      database: connections.owner,
      expectedLogin: policy.databaseOwner,
    },
    ...REVIEWER_CLASSES.map(
      (role) =>
        ({
          applicationName: `catalogue-authority-deploy-zero-${role}`,
          database: connections.reviewers[role],
          expectedLogin: policy.reviewerLogins[role],
        }) as const,
    ),
    ...NON_REVIEWER_CLASSES.map(
      (role) =>
        ({
          applicationName: `catalogue-authority-deploy-zero-${role}`,
          database: connections.nonReviewers[role],
          expectedLogin: policy.nonReviewerLogins[role],
        }) as const,
    ),
  ];
  const sessions: Array<{
    readonly applicationName: string;
    readonly login: string;
    readonly pid: number;
  }> = [];
  for (const pair of pairs) {
    const actual = (
      await sql<{
        readonly application_name: string;
        readonly current_principal: string;
        readonly database_name: string;
        readonly pid: number;
        readonly server_version_num: number;
        readonly session_principal: string;
      }>`
        select
          pg_catalog.current_database() as database_name,
          current_user::text as current_principal,
          session_user::text as session_principal,
          pg_catalog.pg_backend_pid() as pid,
          pg_catalog.current_setting('application_name') as application_name,
          pg_catalog.current_setting('server_version_num')::integer as server_version_num
      `.execute(pair.database)
    ).rows[0];
    if (
      !actual ||
      actual.session_principal !== pair.expectedLogin ||
      actual.current_principal !== pair.expectedLogin ||
      actual.database_name !== policy.databaseName ||
      actual.application_name !== pair.applicationName ||
      actual.server_version_num < 170_000 ||
      actual.server_version_num >= 180_000 ||
      !Number.isSafeInteger(actual.pid) ||
      actual.pid <= 0
    ) {
      throw new Error("Catalogue authority database connection identity differs from policy");
    }
    sessions.push({
      applicationName: actual.application_name,
      login: actual.session_principal,
      pid: actual.pid,
    });
  }
  if (new Set(sessions.map((session) => session.pid)).size !== sessions.length) {
    throw new Error("Catalogue authority verifier database sessions are not isolated");
  }
  return sessions;
}

async function approvalRowCount(database: Kysely<Database>, schema: string): Promise<string> {
  const value = (
    await sql<{ readonly count: string }>`
      select pg_catalog.count(*)::text as count
      from ${sql.id(schema, "food_import_approval")}
    `.execute(database)
  ).rows[0]?.count;
  if (value === undefined) throw new Error("Catalogue approval row count is unavailable");
  return value;
}

function toMembershipEvidence(row: MembershipRow): CatalogueRoleMembershipEvidence {
  return {
    adminOption: row.admin_option,
    grantor: row.grantor,
    inheritOption: row.inherit_option,
    member: row.member,
    role: row.role,
    setOption: row.set_option,
  };
}

function toAclEvidence(row: AclRow): AclRow {
  return {
    grantable: row.grantable,
    grantee: row.grantee,
    grantor: row.grantor,
    privilege: row.privilege,
  };
}
