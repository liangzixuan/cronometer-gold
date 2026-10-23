import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { discoverMigrations } from "../packages/db/dist/migrator.js";
import {
  ERASURE_TABLE_SPECS,
  EXPORT_ENTITY_SPECS,
  USER_LINKED_EXPORT_EXCLUSIONS,
} from "../packages/db/dist/retention-privacy-policy.js";
import { runtimeAccountSql } from "./azure-development-runtime-account-sql-fixture.mjs";
import { runtimeWorkerSql } from "./azure-development-runtime-worker-sql-fixture.mjs";

/** Finite raw PG wire model. Actual Kysely SQL and shared seed/rebuild code run above it. */
export async function runtimeSeedSql(state) {
  const migrations = await discoverMigrations(),
    tables = new Map();
  const names = new Set(["app_schema_migration", "promoted_food_search_catalogue_v1"]);
  for (const migration of migrations) {
    assert(!/^\s*(?:drop table|alter table[^;]+rename to)/imu.test(migration.sql));
    for (const match of migration.sql.matchAll(/^create table ([a-z_][a-z0-9_]*) \(/gmu))
      names.add(match[1]);
  }
  const roles = [state.input.database.api, state.input.database.worker],
    rights = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ],
    grants = new Map(),
    columnGrants = new Map(),
    key = (role, table) => `${role}:${table}`;
  let nextId = 100,
    currentRevision = "0",
    acknowledged = false,
    publishedRevision = null,
    publishedAt = null,
    persisted;
  // Selected0003 trigger observations: public food pointer and source activation updates each queue a rebuild.
  const enqueueSource = (sourceId, reason, prefix) => {
    const now = new Date(),
      rows = tables.get("outbox_event") ?? [];
    rows.push({
      id: randomUUID(),
      aggregate_type: "food_source",
      aggregate_id: sourceId,
      event_type: "catalogue.source_release_activated",
      event_version: 1,
      deduplication_key: `${prefix}:${randomUUID()}`,
      payload: { reason, sourceId },
      headers: {},
      occurred_at: now,
      available_at: now,
      published_at: null,
      attempt_count: 0,
      locked_at: null,
      locked_by: null,
      last_error: null,
      dead_lettered_at: null,
    });
    tables.set("outbox_event", rows);
    currentRevision = String(BigInt(currentRevision) + 1n);
    tables.set("food_search_projection_revision", [
      {
        singleton: true,
        current_revision: currentRevision,
        published_revision: publishedRevision,
        updated_at: now,
      },
    ]);
  };
  const applyAuthority = (authority, acl) => {
    for (const [k, allowed] of grants) {
      const [role, name] = k.split(":");
      const relation = authority.relations.find((r) => r.name === name);
      assert(relation, `Missing authority relation ${name}`);
      relation.acl_is_default = false;
      for (const right of allowed) relation.acl.push(acl(role, right));
    }
    authority.columnAcls = [...columnGrants].flatMap(([k, columns]) => {
      const [role, relation_name] = k.split(":");
      return columns.map((column_name) => ({
        relation_name,
        column_name,
        ...acl(role, "UPDATE"),
      }));
    });
    authority.columnAcls.sort(
      (a, b) =>
        a.relation_name.localeCompare(b.relation_name) ||
        a.column_name.localeCompare(b.column_name) ||
        a.grantee.localeCompare(b.grantee),
    );
    authority.explicitColumnAclAttributeCount = String(authority.columnAcls.length);
  };
  const row = (table) => {
    assert(tables.has(table), `Missing seeded relation ${table}`);
    return tables.get(table)[0];
  };
  const eligible = () => {
    if (
      !["food", "food_version", "food_source", "food_source_release"].every((table) =>
        tables.has(table),
      )
    )
      return false;
    const food = row("food"),
      version = row("food_version"),
      source = row("food_source"),
      release = row("food_source_release");
    return (
      food.current_version_id === version.id &&
      source.active_release_id === release.id &&
      release.status === "promoted" &&
      version.food_id === food.id &&
      version.source_release_id === release.id
    );
  };
  const catalogue = () => {
    const food = row("food"),
      version = row("food_version"),
      source = row("food_source"),
      release = row("food_source_release");
    return {
      food_id: food.id,
      food_version_id: version.id,
      version_number: version.version_number,
      kind: food.kind,
      source_food_key: food.source_food_key,
      ...Object.fromEntries(
        [
          "name",
          "normalized_name",
          "brand_name",
          "description",
          "language_tag",
          "market_code",
          "data_quality",
          "basis_quantity",
          "basis_unit",
        ].map((name) => [name, version[name]]),
      ),
      source_modified_at: null,
      food_source_id: source.id,
      source_code: source.code,
      source_display_name: source.display_name,
      license_expression: source.license_expression,
      attribution_required: source.attribution_required,
      attribution_text: source.attribution_text,
      source_release_id: release.id,
      source_release_key: release.release_key,
      source_artifact_sha256: release.artifact_sha256,
    };
  };
  const result = (rows = [], rowCount = rows.length, command = "SELECT") => ({
    rows,
    rowCount,
    command,
  });
  const transactions = new Map();
  const accountSql = runtimeAccountSql(state, tables);
  const workerIdle = runtimeWorkerSql(state, tables, grants, names);
  const query = async (text, values = [], principal = state.input.database.owner, connectionId) => {
    assert(typeof text === "string" && Array.isArray(values));
    assert([state.input.database.owner, ...roles].includes(principal));
    if (text === "begin" || text.startsWith("start transaction ")) {
      assert(!transactions.has(principal));
      transactions.set(
        principal,
        structuredClone({
          tables,
          grants,
          columnGrants,
          nextId,
          currentRevision,
          acknowledged,
          publishedRevision,
          publishedAt,
          persisted,
        }),
      );
    } else if (text === "commit" || text === "rollback") {
      assert(transactions.has(principal));
      const previous = transactions.get(principal);
      transactions.delete(principal);
      if (text === "rollback") {
        for (const [current, saved] of [
          [tables, previous.tables],
          [grants, previous.grants],
          [columnGrants, previous.columnGrants],
        ]) {
          current.clear();
          for (const [name, value] of saved) current.set(name, value);
        }
        nextId = previous.nextId;
        currentRevision = previous.currentRevision;
        acknowledged = previous.acknowledged;
        publishedRevision = previous.publishedRevision;
        publishedAt = previous.publishedAt;
        persisted = previous.persisted;
      }
    }
    if (
      text.replace(/\s+/gu, " ").trim() ===
      "select exists ( select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'diary_entry_revision' and column_name = 'custom_food_id' ) present"
    ) {
      const present = migrations.some((migration) =>
        /alter table diary_entry_revision[^;]+add column custom_food_id/u.test(migration.sql),
      );
      return result([{ present }]);
    }
    if (principal === state.input.database.worker && state.workerPolling) {
      const handled = workerIdle.query(text, values, principal, connectionId);
      if (handled) return handled;
    }
    if (principal === state.input.database.api) {
      const handled = accountSql(text, values);
      if (handled) return handled;
    }
    if (text.includes("from pg_roles r where")) {
      assert.deepEqual(values, roles);
      return result(
        roles.map((name, index) => ({
          name,
          oid: String(200 + index),
          login: true,
          superuser: false,
          createDb: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          inherit: false,
          connectionLimit: 16,
          configuration: ["search_path=public"],
          memberships: "0",
          connect: true,
          create: false,
          temporary: false,
          usage: true,
          schemaCreate: false,
        })),
      );
    }
    if (text.includes("from pg_roles r cross join pg_class")) {
      assert.deepEqual(values, roles);
      return result(
        roles.flatMap((role) =>
          [...names].sort().map((relation) => {
            const allowed = grants.get(key(role, relation)) ?? new Set();
            return {
              role,
              relation,
              privileges: rights.map((r) => allowed.has(r)),
              columnUpdates: allowed.has("UPDATE")
                ? ["id"]
                : (columnGrants.get(key(role, relation)) ?? []),
              columnSelect: allowed.has("SELECT"),
              columnInsert: allowed.has("INSERT"),
              columnReferences: false,
            };
          }),
        ),
      );
    }
    if (text.startsWith("grant ")) {
      assert(state.grantsClaimed, "Every runtime GRANT must follow the durable mutation claim");
      assert.equal(principal, state.input.database.owner);
      const match =
        /^grant (.+) on table "public"\."([a-z][a-z0-9_]*)" to "([a-z][a-z0-9_]*)"$/u.exec(text);
      assert(match, `Unexpected grant SQL: ${text}`);
      const [, privileges, table, role] = match;
      assert(names.has(table) && roles.includes(role));
      if (privileges.startsWith("update (")) {
        const column = /^update \("([a-z][a-z0-9_]*)"\)$/u.exec(privileges)?.[1];
        assert(column);
        if (!state.options.omitRuntimeColumnGrant) columnGrants.set(key(role, table), [column]);
      } else {
        const added = privileges.split(",");
        assert(added.every((right) => rights.includes(right)));
        if (state.options.omitRuntimeTableGrant !== table)
          grants.set(
            key(role, table),
            new Set([...(grants.get(key(role, table)) ?? []), ...added]),
          );
      }
      return result([], 0, "GRANT");
    }
    if (text.startsWith("set role ")) {
      assert.equal(principal, state.input.database.owner);
      assert.equal(text, `set role "${principal}"`);
      return result([], 0, "SET");
    }
    if (text.includes("current_user::pg_catalog.text as role"))
      return result([{ role: principal }]);
    if (text.includes("pg_catalog.current_database() database_name"))
      return result([{ database_name: state.input.database.databaseName, database_oid: "12345" }]);
    if (text.startsWith("with recursive linked(oid)"))
      return result(
        [
          ...new Set([
            ...EXPORT_ENTITY_SPECS.map((s) => s.table),
            ...USER_LINKED_EXPORT_EXCLUSIONS,
          ]),
        ].map((table_name) => ({ table_name })),
      );
    if (text.includes("from pg_constraint edge"))
      return result(
        ERASURE_TABLE_SPECS.flatMap((s) =>
          ["cascade", "empty", "retain"].includes(s.strategy)
            ? [
                {
                  table_name: s.table,
                  parent_table: s.parentTable,
                  constraint_name: s.constraintName,
                  delete_action: s.strategy === "cascade" ? "c" : s.deleteAction,
                  all_columns_not_null: s.strategy === "cascade" ? true : s.allColumnsNotNull,
                },
              ]
            : [],
        ),
      );
    if (text.startsWith('insert into "database_restore_attestation"')) {
      assert.equal(principal, state.input.database.owner);
      const columns = /^insert into "database_restore_attestation" \(([^)]+)\)/u
        .exec(text)[1]
        .split(", ")
        .map((c) => c.slice(1, -1));
      assert.equal(values.length, columns.length * 2);
      persisted = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
      persisted.replayed_subject_count = String(persisted.replayed_subject_count);
      tables.set("database_restore_attestation", [persisted]);
      return result([{ ...persisted }], 1, "INSERT");
    }
    if (
      text.includes('from "database_restore_attestation"') ||
      text.includes('from "public"."database_restore_attestation"')
    ) {
      if (roles.includes(principal))
        assert(grants.get(key(principal, "database_restore_attestation"))?.has("SELECT"));
      assert(persisted, "Source readiness must follow the persisted original-source replay");
      if (text.startsWith('select "restore_epoch_hash", "database_oid", "database_name"')) {
        const observed = { ...persisted };
        if (state.options.wrongSourceWorkerEpoch && principal === state.input.database.worker)
          observed.restore_epoch_hash = "b".repeat(64);
        return result([observed]);
      }
      assert.equal(
        text,
        'select "database_name" as "databaseName", "database_oid" as "databaseOid", "restore_epoch_hash" as "restoreEpochHash", "replayed_subject_count" as "replayedSubjectCount", "reconciliation_digest" as "reconciliationDigest", "completed_at" as "completedAt" from "public"."database_restore_attestation" where "singleton" = $1 limit $2',
      );
      assert.deepEqual(values, [true, 2]);
      return result([
        {
          databaseName: persisted.database_name,
          databaseOid: persisted.database_oid,
          restoreEpochHash: persisted.restore_epoch_hash,
          replayedSubjectCount: persisted.replayed_subject_count,
          reconciliationDigest: state.options.changedSourceReadback
            ? "b".repeat(64)
            : persisted.reconciliation_digest,
          completedAt: persisted.completed_at,
        },
      ]);
    }
    if (
      text.startsWith('select "id" from "app_user"') ||
      text.startsWith('select "id" from "account_erasure_job"')
    ) {
      if (text.includes('order by "id"')) {
        assert.equal(principal, state.input.database.owner);
        assert.equal(values[0], 500);
        assert(!tables.get("app_user")?.length && !tables.get("account_erasure_job")?.length);
        return result([]);
      }
    }
    if (text.includes("pg_stat_ssl"))
      return result([
        {
          databaseName: state.input.database.databaseName,
          databaseOid: "12345",
          owner: state.input.database.owner,
          principal: state.input.database.owner,
          schema: "public",
          tls: true,
          tlsVersion: "TLSv1.3",
        },
      ]);
    if (text.includes("pg_catalog.pg_settings"))
      return result([{ setting: "public", source: "default" }]);
    if (text.includes("app_schema_migration") && text.includes("select name, checksum"))
      return result(migrations.map(({ name, checksum }) => ({ name, checksum })));
    if (text.includes("pg_try_advisory_lock")) return result([{ acquired: true }]);
    if (text.includes("pg_advisory_unlock")) return result([{ released: true }]);
    if (text.includes("with releases as"))
      return result([
        {
          document_count: eligible() ? "1" : "0",
          generation: "f".repeat(64),
          revision: currentRevision,
        },
      ]);
    if (text.startsWith('select "current_revision"'))
      return result([
        text.includes('"published_revision"')
          ? { current_revision: currentRevision, published_revision: publishedRevision }
          : { current_revision: currentRevision },
      ]);
    if (text.startsWith('update "food_search_projection_revision"')) {
      assert(eligible());
      const set = /"published_revision" = \$([1-9][0-9]*)/u.exec(text);
      assert(set);
      publishedRevision = values[Number(set[1]) - 1];
      assert.equal(publishedRevision, currentRevision);
      publishedAt = new Date();
      tables.set("food_search_projection_revision", [
        {
          singleton: true,
          current_revision: currentRevision,
          published_revision: publishedRevision,
          updated_at: publishedAt,
        },
      ]);
      acknowledged = true;
      return result([], 1, "UPDATE");
    }
    if (text.startsWith('select * from "promoted_food_search_catalogue_v1"'))
      return result(eligible() ? [catalogue()] : []);
    if (text.includes("join food_barcode")) return result([]);
    if (text.includes("join food_serving"))
      return result(
        tables
          .get("food_serving")
          .filter((value) => value.food_version_id === row("food_version").id)
          .map((value, index) => ({
            ...value,
            food_id: row("food").id,
            ordinal: String(index + 1),
          })),
      );
    if (text.startsWith("insert into ")) {
      assert(state.seedClaimed, "Seed SQL must follow the actual durable mutation claim");
      const match = /^insert into "([a-z_]+)" \(([^)]+)\) values (.+?)(?: returning .+)?$/u.exec(
        text,
      );
      assert(match, `Unexpected insert form: ${text}`);
      const [, table, columnText, valueText] = match,
        columns = columnText.split(", ").map((name) => {
          assert(/^"[a-z_][a-z0-9_]*"$/u.test(name));
          return name.slice(1, -1);
        });
      const tuples = [...valueText.matchAll(/\(([^()]*)\)/gu)];
      assert(tuples.length > 0 && values.length === tuples.length * columns.length);
      const inserted = tuples.map((tuple) => {
        const tokens = tuple[1].split(", ");
        assert.equal(tokens.length, columns.length);
        const record = Object.fromEntries(
          tokens.map((token, index) => {
            assert(/^\$[1-9][0-9]*$/u.test(token));
            const at = Number(token.slice(1)) - 1;
            assert(at < values.length);
            return [columns[index], values[at]];
          }),
        );
        const defaults =
          table === "nutrient"
            ? {
                active: true,
                short_name: null,
                parent_nutrient_id: null,
                display_decimals: 1,
                display_order: 0,
                is_core: false,
                is_targetable: true,
                metadata: {},
              }
            : {};
        return { ...defaults, ...record, id: record.id ?? String(nextId++) };
      });
      assert(!tables.has(table), `Unexpected duplicate seed insert ${table}`);
      tables.set(table, inserted);
      return result(text.includes(" returning ") ? inserted : [], inserted.length, "INSERT");
    }
    if (
      /^update "(?:food|food_import_record|food_import_batch|food_source_release|food_source)" set /u.test(
        text,
      )
    ) {
      const table = /^update "([a-z_]+)"/u.exec(text)[1],
        stored = row(table);
      assert.equal(values.at(-1), stored.id);
      const previous = structuredClone(stored);
      for (const match of text.matchAll(/"([a-z_]+)" = \$([1-9][0-9]*)/gu)) {
        if (match[1] !== "id") stored[match[1]] = values[Number(match[2]) - 1];
      }
      if (
        table === "food" &&
        stored.food_source_id != null &&
        stored.current_version_id !== previous.current_version_id
      )
        enqueueSource(stored.food_source_id, "food_eligibility_changed", "search-food-archive");
      if (table === "food_source" && stored.active_release_id !== previous.active_release_id)
        enqueueSource(stored.id, "source_eligibility_changed", "search-source-eligibility");
      return result([], 1, "UPDATE");
    }
    const initial = /^select "id" from "(app_user|food_source|food|nutrient)" limit \$1$/u.exec(
      text,
    );
    if (initial) {
      assert.equal(values[0], 1);
      return result((tables.get(initial[1]) ?? []).map(({ id }) => ({ id })).slice(0, 1));
    }
    assert(
      [
        "begin",
        "commit",
        "rollback",
        "start transaction isolation level repeatable read read only",
        "start transaction isolation level read committed",
      ].includes(text) ||
        text === "set local statement_timeout = '2s'" ||
        text.includes("pg_catalog.set_config") ||
        text.includes("pg_advisory_xact_lock"),
      `Unexpected controlled SQL: ${text}`,
    );
    return result([], 0, text.split(" ")[0].toUpperCase());
  };
  return {
    query,
    tables,
    workerIdle,
    eligible,
    acknowledged: () => acknowledged,
    grants,
    columnGrants,
    applyAuthority,
    persisted: () => persisted,
  };
}
