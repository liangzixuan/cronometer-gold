import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { discoverMigrations } from "../packages/db/dist/migrator.js";
import {
  applyDevelopmentRuntimeDatabaseGrants,
  renderDevelopmentRuntimeDatabaseBootstrap,
} from "./azure-development-runtime-database.mts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = require("kysely");
const target = {
  databaseName: "nourishing_development_12345678",
  databaseOid: "12345",
  expectedOwner: "development_owner",
};
const principals = { api: "development_api", worker: "development_worker" };
const names =
  `app_schema_migration database_restore_attestation nutrient food_source food_source_release food_barcode promoted_food_search_catalogue_v1 food_search_projection_revision
app_user user_password_credential user_profile user_session user_data_watermark diary diary_entry auth_action_token reauthentication_proof audit_log outbox_event
food food_version food_nutrient_value food_serving custom_food custom_food_version custom_food_version_nutrient retention_operation diary_operation diary_entry_revision diary_entry_revision_nutrient
privacy_export_job privacy_export_upload_artifact privacy_export_artifact_deletion account_erasure_job retention_dead_letter_event privacy_export_record privacy_export_entity_snapshot privacy_export_artifact unrelated_history`.split(
    /\s+/u,
  );
const rights = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];
async function fixture(t, options = {}) {
  const migrations = await discoverMigrations(),
    commands = [],
    events = [],
    grants = new Map(),
    columnGrants = new Map();
  let claimed = false;
  const key = (role, table) => `${role}:${table}`;
  const connection = {
    async executeQuery(query) {
      const text = query.sql;
      commands.push(text);
      if (text.includes("pg_catalog.pg_settings"))
        return { rows: [{ setting: "public", source: "default" }] };
      if (text.includes("app_schema_migration") && text.includes("select name, checksum"))
        return {
          rows: (options.staleMigrations ? migrations.slice(0, -1) : migrations).map(
            ({ name, checksum }) => ({ name, checksum }),
          ),
        };
      if (text.includes("pg_catalog.set_config")) return { rows: [] };
      if (text.includes("pg_stat_ssl"))
        return {
          rows: [
            {
              ...target,
              databaseOid: options.wrongTarget ? "54321" : target.databaseOid,
              owner: target.expectedOwner,
              principal: target.expectedOwner,
              schema: "public",
              tls: !options.noTls,
              tlsVersion: "TLSv1.3",
            },
          ],
        };
      if (text.includes("from pg_roles r where"))
        return {
          rows: Object.values(principals).map((name, index) => ({
            name,
            oid: String(200 + index),
            login: true,
            superuser: options.superuser ?? false,
            createDb: false,
            createRole: false,
            replication: false,
            bypassRls: false,
            inherit: false,
            connectionLimit: 16,
            configuration: ["search_path=public"],
            memberships: options.member ? "1" : "0",
            connect: true,
            create: false,
            temporary: options.temporary ?? false,
            usage: true,
            schemaCreate: false,
          })),
        };
      if (text.includes("from pg_roles r cross join pg_class"))
        return {
          rows: Object.values(principals).flatMap((role) =>
            names.map((relation) => {
              const allowed = new Set(grants.get(key(role, relation)) ?? []);
              if (options.unexpectedPrivilege && relation === "unrelated_history")
                allowed.add("DELETE");
              const updates = allowed.has("UPDATE")
                ? ["id", "mutable"]
                : (columnGrants.get(key(role, relation)) ?? []);
              return {
                role,
                relation,
                privileges: rights.map((right) => allowed.has(right)),
                columnUpdates: updates,
                columnSelect: allowed.has("SELECT"),
                columnInsert: allowed.has("INSERT"),
                columnReferences: false,
              };
            }),
          ),
        };
      if (text.startsWith("grant ")) {
        assert(claimed, "Every grant requires a durable mutation claim");
        const match =
          /^grant (.+) on table "public"\."([a-z][a-z0-9_]*)" to "([a-z][a-z0-9_]*)"$/u.exec(text);
        assert(match, `Unexpected grant SQL: ${text}`);
        const [, values, table, role] = match;
        assert(names.includes(table) && Object.values(principals).includes(role));
        if (values.startsWith("update (")) {
          const column = /^update \("([a-z][a-z0-9_]*)"\)$/u.exec(values)?.[1];
          assert(column);
          if (!options.omitColumn) columnGrants.set(key(role, table), [column]);
        } else {
          const added = values.split(",");
          assert(added.every((value) => rights.includes(value)));
          if (options.omitGrant !== table)
            grants.set(
              key(role, table),
              new Set([...(grants.get(key(role, table)) ?? []), ...added]),
            );
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected controlled SQL: ${text}`);
    },
    streamQuery() {
      throw new Error("Unexpected stream");
    },
  };
  const database = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        async init() {},
        async acquireConnection() {
          return connection;
        },
        async releaseConnection() {},
        async destroy() {},
        async beginTransaction() {
          events.push("begin");
        },
        async commitTransaction() {
          events.push("commit");
        },
        async rollbackTransaction() {
          events.push("rollback");
        },
      }),
    },
  });
  t.after(() => database.destroy());
  return {
    commands,
    events,
    grants,
    columnGrants,
    run: () =>
      applyDevelopmentRuntimeDatabaseGrants({
        database,
        expectedTarget: target,
        principals,
        notAfterUtc: new Date(Date.now() + 60_000).toISOString(),
        signal: options.signal ?? new AbortController().signal,
        async onMutationStart() {
          assert(!claimed);
          claimed = true;
          if (options.claimFailure) throw new Error("Synthetic durable claim failed");
        },
      }),
  };
}
test("fixed bootstrap creates only two plain logins and exact database/schema access", () => {
  const input = {
    databaseName: target.databaseName,
    owner: target.expectedOwner,
    principals,
    passwords: { api: "a".repeat(64), worker: "b".repeat(64) },
  };
  const sql = renderDevelopmentRuntimeDatabaseBootstrap(input);
  assert.equal((sql.match(/CREATE ROLE/gu) ?? []).length, 2);
  assert.equal(
    (sql.match(/NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/gu) ?? [])
      .length,
    2,
  );
  assert(sql.includes(`REVOKE ALL ON DATABASE "${target.databaseName}" FROM PUBLIC;`));
  assert(
    !/ALL TABLES|ALL SEQUENCES|DEFAULT PRIVILEGES|GRANT .*catalogue_|GRANT .*development_owner/u.test(
      sql,
    ),
  );
  assert.throws(() =>
    renderDevelopmentRuntimeDatabaseBootstrap({
      ...input,
      principals: { ...principals, api: target.expectedOwner },
    }),
  );
  assert.throws(() =>
    renderDevelopmentRuntimeDatabaseBootstrap({
      ...input,
      passwords: { ...input.passwords, api: "quote'break" },
    }),
  );
});
test("actual Kysely grant statements and observed finite ACLs commit only after the durable claim", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.profile, "synthetic-private-custom-food-journey-v1");
  assert.deepEqual(result.target, target);
  assert.match(result.policySha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.events, ["begin", "commit", "begin", "commit"]);
  assert.deepEqual(f.columnGrants.get(`${principals.api}:food_version`), ["id"]);
  assert.deepEqual(f.columnGrants.get(`${principals.api}:food`), ["current_version_id"]);
  assert.deepEqual(f.columnGrants.get(`${principals.api}:custom_food`), ["current_revision"]);
  for (const role of Object.values(principals)) {
    assert.deepEqual([...f.grants.get(`${role}:database_restore_attestation`)], ["SELECT"]);
    assert.deepEqual([...f.grants.get(`${role}:app_schema_migration`)], ["SELECT"]);
    assert.equal(f.grants.get(`${role}:unrelated_history`), undefined);
  }
  assert(f.grants.get(`${principals.worker}:privacy_export_record`).has("DELETE"));
  assert(!f.grants.get(`${principals.worker}:privacy_export_record`).has("INSERT"));
  assert(
    f.commands
      .filter((command) => command.startsWith("grant "))
      .every((command) => !/all tables|all sequences|default privileges/iu.test(command)),
  );
});
test("wrong target, TLS, stale ledger, privilege/membership and failed claim refuse grants", async (t) => {
  for (const options of [
    { wrongTarget: true },
    { noTls: true },
    { staleMigrations: true },
    { superuser: true },
    { member: true },
    { temporary: true },
    { unexpectedPrivilege: true },
    { claimFailure: true },
    { signal: AbortSignal.abort() },
  ]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run());
    assert(!f.commands.some((command) => command.startsWith("grant ")));
  }
});
test("an omitted table or locking-column grant cannot be accepted from an empty queue", async (t) => {
  for (const options of [
    { omitGrant: "outbox_event" },
    { omitGrant: "user_data_watermark" },
    { omitGrant: "privacy_export_record" },
    { omitColumn: true },
  ]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run(), (error) =>
      error.message.startsWith(
        options.omitColumn
          ? "Unexpected runtime column rights: food"
          : `Unexpected runtime relation rights: ${options.omitGrant}`,
      ),
    );
    assert.equal(f.events.at(-1), "rollback");
    assert(f.commands.some((command) => command.startsWith("grant ")));
  }
});
