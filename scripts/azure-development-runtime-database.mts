/** Exact privileges for the finite synthetic custom-food journey, not general runtime isolation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import {
  assertDatabaseMigrationLedgerReady,
  type createDatabase,
} from "../packages/db/dist/index.js";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { sql } =
  require("kysely") as typeof import("../packages/db/node_modules/kysely/dist/index.js");
const PROFILE = "synthetic-private-custom-food-journey-v1";
const rights = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const;
const groups = {
  api: [
    [
      "SELECT",
      "app_schema_migration database_restore_attestation nutrient food_source food_source_release food_barcode promoted_food_search_catalogue_v1 food_search_projection_revision",
    ],
    [
      "SELECT,INSERT,UPDATE",
      "app_user user_password_credential user_profile user_session user_data_watermark diary diary_entry",
    ],
    ["SELECT,INSERT,UPDATE,DELETE", "auth_action_token"],
    ["SELECT,UPDATE", "reauthentication_proof"],
    ["INSERT", "audit_log outbox_event"],
    [
      "SELECT,INSERT",
      "food food_version food_nutrient_value food_serving custom_food custom_food_version custom_food_version_nutrient retention_operation diary_operation diary_entry_revision diary_entry_revision_nutrient",
    ],
  ],
  worker: [
    [
      "SELECT",
      "app_schema_migration database_restore_attestation privacy_export_artifact promoted_food_search_catalogue_v1 food_barcode food_serving",
    ],
    [
      "SELECT,UPDATE",
      "privacy_export_job privacy_export_upload_artifact privacy_export_artifact_deletion account_erasure_job retention_dead_letter_event outbox_event food_search_projection_revision",
    ],
    ["SELECT,DELETE", "privacy_export_record privacy_export_entity_snapshot"],
    ["INSERT", "retention_dead_letter_event"],
  ],
} as const;
const columns = {
  food: ["current_version_id"],
  food_version: ["id"],
  custom_food: ["current_revision"],
};
const policySha256 = createHash("sha256")
  .update(canonicalJson({ profile: PROFILE, groups, columns }))
  .digest("hex");
type Principals = { readonly api: string; readonly worker: string };
interface Target {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly expectedOwner: string;
}
function identifiers(databaseName: string, owner: string, input: Principals) {
  const principals = Object.freeze({ ...input });
  assert(Object.keys(principals).sort().join(",") === "api,worker");
  assert(/^nourishing_development_[a-z0-9]{8,24}$/u.test(databaseName));
  for (const value of [owner, ...Object.values(principals)])
    assert(/^[a-z][a-z0-9_]{0,62}$/u.test(value));
  assert(new Set([owner, ...Object.values(principals)]).size === 3);
  assert(
    ![owner, ...Object.values(principals)].some(
      (value) => value.startsWith("pg_") || value.startsWith("catalogue_"),
    ),
  );
  return principals;
}

/** Exact protected init-file content. The separately supplied POSTGRES_USER owns this fresh cluster. */
export function renderDevelopmentRuntimeDatabaseBootstrap(input: {
  readonly databaseName: string;
  readonly owner: string;
  readonly principals: Principals;
  readonly passwords: { readonly api: string; readonly worker: string };
}) {
  const { databaseName, owner } = input,
    principals = identifiers(databaseName, owner, input.principals);
  const passwords = { ...input.passwords };
  assert(Object.keys(passwords).sort().join(",") === "api,worker");
  assert(
    Object.values(passwords).every(
      (value) => typeof value === "string" && /^[a-f0-9]{64,128}$/u.test(value),
    ),
  );
  assert(passwords.api !== passwords.worker);
  const lines = [
    "-- Owned fresh-cluster initialization; apply the finite relation profile after migrations.",
    `REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC;`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
    `ALTER DATABASE "${databaseName}" SET search_path TO public;`,
  ];
  for (const role of ["api", "worker"] as const) {
    const name = principals[role];
    lines.push(
      `CREATE ROLE "${name}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16 PASSWORD '${passwords[role]}';`,
      `ALTER ROLE "${name}" SET search_path TO public;`,
      `GRANT CONNECT ON DATABASE "${databaseName}" TO "${name}";`,
    );
  }
  return `${lines.join("\n")}\n`;
}

type Database = ReturnType<typeof createDatabase>;
/** No credentials are created here. Call once, with a durable mutation claim, after exact migrations. */
export async function applyDevelopmentRuntimeDatabaseGrants(input: {
  readonly database: Database;
  readonly expectedTarget: Target;
  readonly principals: Principals;
  readonly notAfterUtc: string;
  readonly signal: AbortSignal;
  readonly onMutationStart: () => Promise<void>;
}) {
  const target = Object.freeze({ ...input.expectedTarget });
  assert(Object.keys(target).sort().join(",") === "databaseName,databaseOid,expectedOwner");
  assert(
    /^[1-9][0-9]{0,9}$/u.test(target.databaseOid) && BigInt(target.databaseOid) <= 4294967295n,
  );
  const principals = identifiers(target.databaseName, target.expectedOwner, input.principals);
  const { database, signal, onMutationStart } = input;
  assert(signal instanceof AbortSignal && typeof onMutationStart === "function");
  const start = Date.now(),
    mono = performance.now(),
    stop = Date.parse(input.notAfterUtc);
  assert(
    new Date(stop).toISOString() === input.notAfterUtc && stop > start && stop - start <= 1_800_000,
  );
  const guard = () => {
    signal.throwIfAborted();
    assert(Date.now() >= start && Date.now() < stop && performance.now() - mono < stop - start);
  };
  guard();
  const expected = (role: keyof Principals, relation: string) =>
    new Set(
      groups[role]
        .filter(([, names]) => names.split(" ").includes(relation))
        .flatMap(([values]) => values.split(",")),
    );
  return database.connection().execute(async (owned) => {
    await assertDatabaseMigrationLedgerReady(owned);
    guard();
    return owned.transaction().execute(async (transaction) => {
      const observe = async () => {
        guard();
        const result = await sql<{
          databaseName: string;
          databaseOid: string;
          owner: string;
          principal: string;
          schema: string;
          tls: boolean;
          tlsVersion: string;
        }>`select current_database() as "databaseName", d.oid::text as "databaseOid", pg_get_userbyid(d.datdba) as owner,
        current_user as principal, current_schema() as schema, s.ssl as tls, s.version as "tlsVersion"
        from pg_database d join pg_stat_ssl s on s.pid = pg_backend_pid() where d.datname = current_database()`.execute(
          transaction,
        );
        guard();
        assert(result.rows.length === 1);
        const row = result.rows[0];
        assert(
          row?.databaseName === target.databaseName &&
            row.databaseOid === target.databaseOid &&
            row.owner === target.expectedOwner &&
            row.principal === target.expectedOwner &&
            row.schema === "public" &&
            row.tls &&
            ["TLSv1.2", "TLSv1.3"].includes(row.tlsVersion),
        );
        const roles = await sql<{
          name: string;
          oid: string;
          login: boolean;
          superuser: boolean;
          createDb: boolean;
          createRole: boolean;
          replication: boolean;
          bypassRls: boolean;
          inherit: boolean;
          connectionLimit: number;
          configuration: string[];
          memberships: string;
          connect: boolean;
          create: boolean;
          temporary: boolean;
          usage: boolean;
          schemaCreate: boolean;
        }>`select r.rolname as name, r.oid::text as oid, r.rolcanlogin as login, r.rolsuper as superuser,
          r.rolcreatedb as "createDb", r.rolcreaterole as "createRole", r.rolreplication as replication,
          r.rolbypassrls as "bypassRls", r.rolinherit as inherit, r.rolconnlimit as "connectionLimit", r.rolconfig as configuration,
          (select count(*)::text from pg_auth_members m where m.member = r.oid or m.roleid = r.oid) as memberships,
          has_database_privilege(r.oid, current_database(), 'CONNECT') as connect,
          has_database_privilege(r.oid, current_database(), 'CREATE') as create,
          has_database_privilege(r.oid, current_database(), 'TEMPORARY') as temporary,
          has_schema_privilege(r.oid, 'public', 'USAGE') as usage, has_schema_privilege(r.oid, 'public', 'CREATE') as "schemaCreate"
        from pg_roles r where r.rolname in (${principals.api}, ${principals.worker}) order by r.rolname`.execute(
          transaction,
        );
        guard();
        assert(roles.rows.length === 2);
        for (const name of Object.values(principals)) {
          const matches = roles.rows.filter((row) => row.name === name);
          assert(matches.length === 1);
          const role = matches[0];
          assert(
            role &&
              /^[1-9][0-9]{0,9}$/u.test(role.oid) &&
              role.login &&
              !role.superuser &&
              !role.createDb &&
              !role.createRole &&
              !role.replication &&
              !role.bypassRls &&
              !role.inherit &&
              role.connectionLimit === 16 &&
              role.memberships === "0" &&
              role.connect &&
              role.usage &&
              !role.create &&
              !role.temporary &&
              !role.schemaCreate,
          );
          assert.deepEqual(role.configuration, ["search_path=public"]);
        }
        assert(roles.rows[0]?.oid !== roles.rows[1]?.oid);
        return roles.rows.map(({ name, oid }) => ({ name, oid }));
      };
      const permissions = async (empty: boolean) => {
        const observations = await sql<{
          role: string;
          relation: string;
          privileges: boolean[];
          columnUpdates: string[];
          columnSelect: boolean;
          columnInsert: boolean;
          columnReferences: boolean;
        }>`select r.rolname as role, c.relname as relation,
        array[has_table_privilege(r.oid,c.oid,'SELECT'),has_table_privilege(r.oid,c.oid,'INSERT'),has_table_privilege(r.oid,c.oid,'UPDATE'),has_table_privilege(r.oid,c.oid,'DELETE'),
              has_table_privilege(r.oid,c.oid,'TRUNCATE'),has_table_privilege(r.oid,c.oid,'REFERENCES'),has_table_privilege(r.oid,c.oid,'TRIGGER'),has_table_privilege(r.oid,c.oid,'MAINTAIN')] as privileges,
        array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE') order by a.attname) as "columnUpdates",
        has_any_column_privilege(r.oid,c.oid,'SELECT') as "columnSelect", has_any_column_privilege(r.oid,c.oid,'INSERT') as "columnInsert", has_any_column_privilege(r.oid,c.oid,'REFERENCES') as "columnReferences"
        from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
        where r.rolname in (${principals.api}, ${principals.worker}) and n.nspname='public' and c.relkind in ('r','p','v','m','f')
        order by r.rolname,c.relname limit 1025`.execute(transaction);
        guard();
        assert(observations.rows.length > 0 && observations.rows.length <= 1024);
        for (const role of ["api", "worker"] as const) {
          const rows = observations.rows.filter((row) => row.role === principals[role]);
          assert(rows.length > 0 && new Set(rows.map((row) => row.relation)).size === rows.length);
          for (const [, names] of groups[role])
            for (const name of names.split(" "))
              assert(
                rows.some((row) => row.relation === name),
                `Missing runtime profile relation ${name}`,
              );
          for (const row of rows) {
            assert(/^[a-z][a-z0-9_]{0,62}$/u.test(row.relation));
            const allowed = empty ? new Set<string>() : expected(role, row.relation);
            assert.deepEqual(
              row.privileges,
              rights.map((right) => allowed.has(right)),
              `Unexpected runtime relation rights: ${row.relation}`,
            );
            assert.equal(row.columnSelect, allowed.has("SELECT"));
            assert.equal(row.columnInsert, allowed.has("INSERT"));
            assert.equal(row.columnReferences, false);
            const selected =
              !empty && role === "api" ? (columns[row.relation as keyof typeof columns] ?? []) : [];
            if (!allowed.has("UPDATE"))
              assert.deepEqual(
                row.columnUpdates,
                selected,
                `Unexpected runtime column rights: ${row.relation}`,
              );
            else assert(row.columnUpdates.length > 0);
          }
        }
      };
      const initial = await observe();
      await permissions(true);
      await onMutationStart();
      guard();
      assert.deepEqual(await observe(), initial);
      for (const role of ["api", "worker"] as const)
        for (const [privileges, names] of groups[role])
          for (const name of names.split(" ")) {
            guard();
            await sql`grant ${sql.raw(privileges)} on table ${sql.id("public", name)} to ${sql.id(principals[role])}`.execute(
              transaction,
            );
            guard();
          }
      for (const [table, names] of Object.entries(columns)) {
        guard();
        await sql`grant update (${sql.join(names.map((name) => sql.id(name)))}) on table ${sql.id("public", table)} to ${sql.id(principals.api)}`.execute(
          transaction,
        );
        guard();
      }
      await permissions(false);
      assert.deepEqual(await observe(), initial);
      return Object.freeze({
        kind: "nutrition-development-database-grants-v1",
        profile: PROFILE,
        policySha256,
        target,
        principals: initial,
      });
    });
  });
}
