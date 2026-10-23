// Real operator/collector/crypto above raw PG, native-process and Azure HTTP seams.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { discoverMigrations } from "../packages/db/dist/migrator.js";
import {
  ERASURE_TABLE_SPECS,
  EXPORT_ENTITY_SPECS,
  USER_LINKED_EXPORT_EXCLUSIONS,
} from "../packages/db/dist/retention-privacy-policy.js";
import { DEVELOPMENT_RUNTIME_PRINCIPAL_QUERY } from "./azure-development-runtime-database-policy.mjs";
import { postgresAuthorityFixture } from "./postgres-authority-fixture.mjs";
import { canonicalizeRestoreAuthorityEvidence } from "./postgres-restore-drill.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function runtimeOperatorFiles(root) {
  const directory = join(root, "recovery/native");
  await fs.mkdir(directory, { mode: 0o700 });
  const tools = {};
  for (const [key, name] of [
    ["pgDump", "pg_dump"],
    ["pgRestore", "pg_restore"],
    ["psql", "psql"],
  ]) {
    const path = join(directory, name),
      bytes = Buffer.from("Controlled native identity " + name);
    await fs.writeFile(path, bytes, { mode: 0o700, flag: "wx" });
    tools[key] = { path, sha256: hash(bytes), version: name + " (PostgreSQL) 17.6" };
  }
  return { tools, tmpfsRoot: join(root, "tmpfs") };
}

export async function runtimeOperatorWire(state, files, storage) {
  const policy = postgresAuthorityFixture(state.input.database.owner),
    migrations = await discoverMigrations();
  const children = [],
    clients = [],
    queries = [],
    native = [],
    errors = [];
  const snapshot = () => {
    const authority = policy.validAuthorityEvidence();
    const names = new Set(["app_schema_migration"]);
    for (const migration of migrations) {
      assert(
        !/^\s*(?:drop table|alter table[^;]+rename to)/imu.test(migration.sql),
        "Controlled schema fixture needs updating for table removal/rename",
      );
      for (const match of migration.sql.matchAll(/^create table ([a-z_][a-z0-9_]*) \(/gmu))
        names.add(match[1]);
    }
    for (const name of state.sql.tables.keys())
      assert(names.has(name), `Seeded table missing from migrations: ${name}`);
    const tables = Object.fromEntries(
      [...names].map((name) => [
        name,
        structuredClone(
          name === "app_schema_migration"
            ? migrations.map(({ name, checksum }) => ({ name, checksum }))
            : (state.sql.tables.get(name) ?? []),
        ),
      ]),
    );
    // Model SQL-trigger side effects from the actual rebuild revision/acknowledgement observations.
    assert(state.sql.eligible() && state.sql.acknowledged());
    assert.equal(tables.food_search_projection_revision.length, 1);
    assert.equal(
      tables.food_search_projection_revision[0].published_revision,
      tables.food_search_projection_revision[0].current_revision,
    );
    for (const name of names)
      if (!authority.relations.some((row) => row.name === name))
        authority.relations.push({
          name,
          kind: "r",
          owner: state.input.database.owner,
          acl_is_default: true,
          acl: [policy.acl(state.input.database.owner, "SELECT")],
        });
    state.sql.applyAuthority(authority, policy.acl);
    return { authority, tables };
  };
  const fromSnapshot = (value) =>
    policy.sharedCollectorAdapter({
      observedAuthority: value.authority,
      tableCounts: new Map(
        Object.entries(value.tables).map(([name, rows]) => [name, String(rows.length)]),
      ),
    });
  let exported,
    restored,
    target = null,
    policyApplied = false,
    persisted;
  const one = (value) => ({ rows: [[typeof value === "string" ? value : JSON.stringify(value)]] });
  const database = async (client, input) => {
    const { text, values } = input;
    queries.push({ text, values, database: client.config.database });
    if (client.config.application_name === "nutrition-postgres-replay") {
      const sql = text.replace(/\s+/gu, " ").trim(),
        done = (rows = [], command = "SELECT", rowCount = rows.length) => ({
          rows,
          command,
          rowCount,
        });
      assert(target && restored && policyApplied && client.config.database === target.name);
      if (["begin", "commit", "rollback"].includes(sql)) {
        client.transaction = sql === "begin";
        return done([], sql.toUpperCase(), null);
      }
      if (sql.startsWith('set role "')) {
        assert.equal(sql, `set role "${state.input.database.owner}"`);
        client.role = state.input.database.owner;
        return done([], "SET", null);
      }
      if (sql === "select current_user::pg_catalog.text as role")
        return done([{ role: client.role }]);
      if (sql.startsWith("select pg_catalog.current_database() database_name,"))
        return done([{ database_name: target.name, database_oid: target.oid }]);
      if (sql.includes("from pg_catalog.pg_settings"))
        return done([
          {
            setting: client.localPath ?? client.config.options.replace("-c search_path=", ""),
            source: "client",
          },
        ]);
      if (sql.startsWith("select pg_catalog.set_config(")) {
        client.localPath = values[0];
        return done([{ set_config: values[0] }]);
      }
      if (sql.includes('from "public".app_schema_migration'))
        return done(restored.tables.app_schema_migration);
      if (sql.startsWith("select pg_advisory_xact_lock(") || sql.startsWith("select set_config(")) {
        assert(client.transaction);
        return done();
      }
      if (sql.startsWith("with recursive linked(oid)"))
        return done(
          [
            ...new Set([
              ...EXPORT_ENTITY_SPECS.map((s) => s.table),
              ...USER_LINKED_EXPORT_EXCLUSIONS,
            ]),
          ].map((table_name) => ({ table_name })),
        );
      if (sql.includes("from pg_constraint edge"))
        return done(
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
      if (sql.startsWith('select "id" from "app_user"')) return done(restored.tables.app_user);
      if (sql.startsWith('select "id" from "account_erasure_job"'))
        return done(restored.tables.account_erasure_job);
      if (sql.startsWith('insert into "database_restore_attestation"')) {
        assert(client.transaction);
        const columns = /^insert into "database_restore_attestation" \(([^)]+)\)/u
          .exec(sql)[1]
          .split(", ")
          .map((c) => c.slice(1, -1));
        persisted = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
        persisted.replayed_subject_count = String(persisted.replayed_subject_count);
        return done([{ ...persisted }], "INSERT", 1);
      }
      if (
        sql.includes('from "database_restore_attestation"') ||
        sql.includes('from "public"."database_restore_attestation"')
      ) {
        if (!persisted) return done();
        if (!sql.includes(' as "databaseName"'))
          return done([
            {
              restore_epoch_hash: persisted.restore_epoch_hash,
              database_oid: persisted.database_oid,
              database_name: persisted.database_name,
            },
          ]);
        assert.equal(
          sql,
          'select "database_name" as "databaseName", "database_oid" as "databaseOid", "restore_epoch_hash" as "restoreEpochHash", "replayed_subject_count" as "replayedSubjectCount", "reconciliation_digest" as "reconciliationDigest", "completed_at" as "completedAt" from "public"."database_restore_attestation" where "singleton" = $1 limit $2',
        );
        assert.deepEqual(values, [true, 2]);
        return done([
          {
            databaseName: persisted.database_name,
            databaseOid: persisted.database_oid,
            restoreEpochHash: persisted.restore_epoch_hash,
            reconciliationDigest: persisted.reconciliation_digest,
            replayedSubjectCount: persisted.replayed_subject_count,
            completedAt: persisted.completed_at,
          },
        ]);
      }
      assert.fail("Unmodeled restored replay SQL: " + sql);
    }
    if (text === DEVELOPMENT_RUNTIME_PRINCIPAL_QUERY) {
      assert.deepEqual(values, [state.input.database.api, state.input.database.worker]);
      return one(
        [state.input.database.api, state.input.database.worker].sort().map((name) => ({
          name,
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
        })),
      );
    }
    if (client.config.database === state.input.database.databaseName) {
      if (text === "begin isolation level repeatable read read only") {
        assert(!exported);
        exported = snapshot();
        client.adapter = fromSnapshot(exported);
        client.adapter.identity.database = client.config.database;
        client.adapter.snapshot();
        client.transaction = true;
        return { rows: [] };
      }
      if (text === "select pg_catalog.pg_export_snapshot()") {
        assert(exported && client.transaction);
        return one("00000003-000000A1-1");
      }
      client.adapter ??= fromSnapshot(snapshot());
      client.adapter.identity.database = client.config.database;
      if (text === "rollback") client.transaction = false;
      return client.adapter.query(input);
    }
    if (client.config.database === "postgres") {
      if (text.startsWith("select coalesce((select pg_catalog.json_build_object('name'"))
        return one(
          target === null
            ? null
            : { name: target.name, oid: target.oid, allowConnections: target.allowConnections },
        );
      if (text.startsWith("create database")) {
        assert.equal(target, null);
        assert(text.includes("template template0") && text.endsWith("allow_connections false"));
        const name = /^create database "([a-z0-9_]+)"/u.exec(text)?.[1];
        assert(name?.startsWith("nutrition_restore_"));
        target = { name, oid: "98765", allowConnections: false, publicConnect: true };
        return { rows: [] };
      }
      if (text.startsWith("revoke connect")) {
        target.publicConnect = false;
        return { rows: [] };
      }
      if (text.startsWith("alter database")) {
        assert(target);
        target.allowConnections = text.endsWith("true");
        return { rows: [] };
      }
      if (text.startsWith("select pg_catalog.set_config('nutrition.restore_target'"))
        return one(values[0]);
      if (text.includes("row_to_json(database_acl)"))
        return one([
          policy.acl("PUBLIC", "TEMPORARY"),
          ...(target.publicConnect ? [policy.acl("PUBLIC", "CONNECT")] : []),
          ...["CONNECT", "CREATE", "TEMPORARY"].map((p) =>
            policy.acl(state.input.database.owner, p),
          ),
        ]);
      if (text.includes("json_agg(role_policy.name"))
        return one(
          target.publicConnect
            ? [
                state.input.database.owner,
                state.input.database.api,
                state.input.database.worker,
              ].sort()
            : [state.input.database.owner],
        );
      if (text.includes("from pg_catalog.pg_stat_activity")) {
        assert(clients.filter((c) => c.config.database !== "postgres").every((c) => c.closed));
        return one("0");
      }
      if (text.includes("pg_get_userbyid")) return one(state.input.database.owner);
      if (text.includes("pg_catalog.unnest"))
        return one(
          [state.input.database.api, state.input.database.worker].map((name) => ({
            name,
            connect: target.publicConnect,
          })),
        );
      assert.fail("Unmodeled maintenance SQL: " + text);
    }
    assert(
      target && client.config.database === target.name && restored && policyApplied,
      "Restored evidence must follow actual decrypted stream and policy",
    );
    if (text.startsWith('set role "')) return { rows: [] };
    if (text === "begin isolation level repeatable read read only") {
      client.adapter ??= fromSnapshot(restored);
      client.adapter.snapshot();
      client.transaction = true;
      return { rows: [] };
    }
    if (text.startsWith("select pg_catalog.json_build_object('databaseName'"))
      return one({ databaseName: target.name, databaseOid: target.oid });
    if (state.options.restoreCountDrift && text === 'select count(*) from public."nutrient"') {
      state.restoreCountDriftObserved = true;
      return one(String(restored.tables.nutrient.length + 1));
    }
    if (text.includes("from public.database_restore_attestation"))
      return one(
        restored.tables.database_restore_attestation.map((row) => ({
          restore_epoch_hash: row.restore_epoch_hash,
          database_name: row.database_name,
          database_oid: text.includes("database_oid::text")
            ? String(row.database_oid)
            : Number(row.database_oid),
        })),
      );
    if (text === "rollback") client.transaction = false;
    client.adapter ??= fromSnapshot(restored);
    client.adapter.identity.database = target.name;
    return client.adapter.query(input);
  };
  const makeClient = (config, client = new EventEmitter()) => {
    Object.assign(client, { config, socket: config.stream(), closed: false, transaction: false });
    clients.push(client);
    client.socket.once("close", () => {
      client.closed = true;
      client.active?.emit("error", new Error("Controlled socket closed"));
      client.emit("end");
    });
    client.connect = () => Promise.resolve(client);
    client.query = (query) => {
      client.active = query;
      (async () => {
        const result = await database(client, query.config);
        if (client.closed) return;
        const metadata =
          query.config.rowMode === "array"
            ? {}
            : {
                rows: [],
                fields: Object.keys(result.rows[0] ?? {}).map((name) => ({ name })),
                command: result.command ?? "SELECT",
                rowCount: Object.hasOwn(result, "rowCount") ? result.rowCount : result.rows.length,
              };
        for (const row of result.rows) query.emit("row", row, metadata);
        client.active = undefined;
        query.emit("end", metadata);
      })().catch((error) => {
        errors.push(error);
        query.emit("error", error);
      });
      return query;
    };
    client.end = () => {
      if (client.closed) return Promise.resolve();
      const done = new Promise((resolve) => client.once("end", resolve));
      client.socket.destroy();
      return done;
    };
    return client;
  };
  const spawn = (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.equal(args[0], "-e");
    const file = args[2],
      argv = args.slice(3);
    assert(Object.values(files.tools).some((tool) => tool.path === file));
    const child = new EventEmitter();
    Object.assign(child, {
      pid: 820000 + children.length,
      stdin: options.stdio[0] === "pipe" ? new PassThrough() : undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      closed: false,
      exited: false,
    });
    children.push(child);
    native.push({ file, args: argv, options });
    const status = () =>
      queueMicrotask(() =>
        child.emit("message", { type: "status", exitCode: 0, signal: null, spawnFailed: false }),
      );
    child.send = (message, done) => {
      assert.deepEqual(message, { type: "start" });
      done();
      queueMicrotask(() => {
        if (argv[0] === "--version") {
          child.stdout.write(basename(file) + " (PostgreSQL) 17.6\n");
          status();
          return;
        }
        if (argv[0] === "--list") {
          assert(exported && clients.every((c) => c.closed));
          child.stdout.write("; Controlled TOC\n");
          status();
          return;
        }
        if (file === files.tools.pgDump.path) {
          assert(exported && clients.some((c) => c.transaction));
          assert(argv.includes("--snapshot=00000003-000000A1-1"));
          child.stdout.write(
            Buffer.concat([Buffer.from("PGDMP"), Buffer.from(JSON.stringify(exported))]),
          );
          status();
          return;
        }
        assert(child.stdin);
        const chunks = [];
        child.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        child.stdin.on("end", () => {
          (async () => {
            const raw = Buffer.concat(chunks);
            if (file === files.tools.pgRestore.path) {
              assert(target?.allowConnections);
              assert(raw.subarray(0, 5).equals(Buffer.from("PGDMP")));
              restored = JSON.parse(raw.subarray(5).toString());
              assert.deepEqual(restored, JSON.parse(JSON.stringify(exported)));
              // Native --no-privileges omits both runtime table and column ACLs.
              assert(argv.includes("--no-privileges"));
              const base = policy.validAuthorityEvidence();
              for (const relation of restored.authority.relations) {
                relation.acl = relation.acl.filter(
                  (row) =>
                    ![state.input.database.api, state.input.database.worker].includes(row.grantee),
                );
                relation.acl_is_default =
                  base.relations.find((row) => row.name === relation.name)?.acl_is_default ?? true;
              }
              restored.authority.columnAcls = [];
              restored.authority.explicitColumnAclAttributeCount = "0";
            } else {
              assert.equal(file, files.tools.psql.path);
              assert(restored);
              const basePolicy =
                'set role "' +
                state.input.database.owner +
                '";\n' +
                (await fs.readFile(
                  new URL(
                    "../packages/db/restore/0014_catalogue_authority_policy.sql",
                    import.meta.url,
                  ),
                  "utf8",
                ));
              assert(raw.toString().startsWith(basePolicy));
              const extra = raw.toString().slice(basePolicy.length).trim();
              if (extra) {
                const lines = extra.split("\n");
                assert.equal(lines.shift(), "BEGIN;");
                assert.equal(lines.pop(), "COMMIT;");
                for (const line of lines) {
                  const table =
                    /^GRANT ([A-Z,]+) ON TABLE public\."([a-z][a-z0-9_]*)" TO "([a-z0-9_]+)";$/u.exec(
                      line,
                    );
                  const column =
                    /^GRANT UPDATE \(([^)]+)\) ON TABLE public\."([a-z][a-z0-9_]*)" TO "([a-z0-9_]+)";$/u.exec(
                      line,
                    );
                  if (table) {
                    const relation = restored.authority.relations.find(
                      (row) => row.name === table[2],
                    );
                    assert(relation);
                    relation.acl_is_default = false;
                    for (const privilege of table[1].split(","))
                      relation.acl.push(policy.acl(table[3], privilege));
                  } else {
                    assert(column);
                    for (const name of column[1].split(",")) {
                      assert(/^"[a-z_]+"$/u.test(name));
                      restored.authority.columnAcls.push({
                        relation_name: column[2],
                        column_name: name.slice(1, -1),
                        ...policy.acl(column[3], "UPDATE"),
                      });
                    }
                  }
                }
                restored.authority.columnAcls.sort(
                  (a, b) =>
                    a.relation_name.localeCompare(b.relation_name) ||
                    a.column_name.localeCompare(b.column_name) ||
                    a.grantee.localeCompare(b.grantee),
                );
                restored.authority.explicitColumnAclAttributeCount = String(
                  restored.authority.columnAcls.length,
                );
              }
              policyApplied = true;
            }
            status();
          })().catch((error) => {
            errors.push(error);
            child.stderr.write(error.message);
            queueMicrotask(() =>
              child.emit("message", {
                type: "status",
                exitCode: 1,
                signal: null,
                spawnFailed: false,
              }),
            );
          });
        });
      });
    };
    queueMicrotask(() => child.emit("message", { type: "ready" }));
    return child;
  };
  const kill = (pid, signal) => {
    const child = children.find((c) => c.pid === -pid && !c.closed);
    assert(child && !child.exited);
    assert.equal(signal, "SIGKILL");
    child.exited = true;
    child.emit("exit", null, signal);
    child.closed = true;
    child.stdin?.destroy();
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  return {
    files,
    storage,
    children,
    clients,
    queries,
    native,
    errors,
    makeClient,
    spawn,
    kill,
    owns: (args) => Object.values(files.tools).some((tool) => tool.path === args[2]),
    processFile: async (path, ...args) => {
      const match = /^\/proc\/([0-9]+)\/stat$/u.exec(String(path));
      if (match && children.some((child) => child.pid === Number(match[1]))) {
        const c = children.find((c) => c.pid === Number(match[1]) && !c.closed);
        if (!c) throw Object.assign(new Error("Controlled missing process"), { code: "ENOENT" });
        return (
          c.pid +
          " (controlled-native) " +
          ["S", "1", String(c.pid), String(c.pid), ...Array(15).fill("0"), String(c.pid)].join(" ")
        );
      }
      return fs.readFile(path, ...args);
    },
    processDirectory: async (path, ...args) =>
      path === "/proc"
        ? [
            ...new Set([
              ...(await fs.readdir(path, ...args)),
              ...children.filter((c) => !c.closed).map((c) => String(c.pid)),
            ]),
          ]
        : fs.readdir(path, ...args),
    snapshot,
    get restored() {
      return restored;
    },
    get target() {
      return target;
    },
    get policyApplied() {
      return policyApplied;
    },
    verify() {
      assert(
        exported && restored && target?.allowConnections && !target.publicConnect && policyApplied,
      );
      assert(children.every((c) => c.closed) && clients.every((c) => c.closed));
      assert(storage.ciphertext && !storage.ciphertext.includes(Buffer.from("PGDMP")));
      assert.equal(
        canonicalizeRestoreAuthorityEvidence(restored.authority),
        canonicalizeRestoreAuthorityEvidence(exported.authority),
      );
    },
  };
}
