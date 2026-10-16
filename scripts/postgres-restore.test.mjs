import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kill as realKill } from "node:process";
import { PassThrough, Readable } from "node:stream";
import test, { mock } from "node:test";
import { rootCertificates } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  azureBackupFixture,
  azureLedgerSettings,
  syntheticOperatorAssemblyFixture,
} from "./postgres-backup-azure-fixture.mjs";

const stateKey = Symbol.for("nutrition.test.localRestore");
const state = { registrations: 0 };
globalThis[stateKey] = state;
const root = fileURLToPath(new URL("../", import.meta.url));
const source = (name) => pathToFileURL(join(root, name)).href;
const dump = Buffer.from("PGDMP synthetic restore only");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:perf_hooks" && context.parentURL?.endsWith("/postgres-restore.mjs"))
      return { url: "nutrition-test:clock", shortCircuit: true };
    if (specifier === "@nutrition-tracker/domain" && context.parentURL?.includes("/packages/db/"))
      return { url: source("packages/domain/src/index.ts"), shortCircuit: true };
    if (specifier === "../apps/worker/dist/erasure-ledger-restore.js")
      return { url: source("apps/worker/src/erasure-ledger-restore.ts"), shortCircuit: true };
    if (specifier === "@nutrition-tracker/db" && context.parentURL?.includes("/apps/worker/"))
      return { url: "nutrition-test:db", shortCircuit: true };
    if (
      specifier === "@nutrition-tracker/artifact-store" &&
      context.parentURL?.includes("/apps/worker/")
    )
      return { url: "nutrition-test:artifact", shortCircuit: true };
    if (
      specifier === "@azure/core-rest-pipeline" &&
      context.parentURL?.endsWith("/azure-blob-http-client.ts")
    ) {
      state.azurePipelineURL = next(specifier, context).url;
      return { url: "nutrition-test:azure-wire", shortCircuit: true };
    }
    if (
      specifier === "node:test" &&
      context.parentURL?.endsWith("/postgres-restore-drill.test.mjs")
    )
      return { url: "nutrition-test:skip-fixture-tests", shortCircuit: true };
    if (
      specifier === "node:child_process" &&
      context.parentURL?.endsWith("/postgres-operator-process.mjs")
    )
      return { url: "nutrition-test:child", shortCircuit: true };
    if (
      specifier === "node:process" &&
      context.parentURL?.endsWith("/postgres-operator-process.mjs")
    )
      return { url: "nutrition-test:process", shortCircuit: true };
    if (
      specifier === "node:fs/promises" &&
      (context.parentURL?.endsWith("/postgres-restore.mjs") ||
        context.parentURL?.endsWith("/postgres-operator-process.mjs"))
    )
      return { url: "nutrition-test:fs", shortCircuit: true };
    if (
      specifier === "node:fs/promises" &&
      context.parentURL?.endsWith("/artifact-store/src/postgres-backup.ts")
    )
      return { url: "nutrition-test:artifact-fs", shortCircuit: true };
    if (specifier === "node:fs/promises" && context.parentURL?.endsWith("/postgres-operator.mjs"))
      return { url: "nutrition-test:operator-fs", shortCircuit: true };
    if (specifier === "pg" && context.parentURL?.endsWith("/owned-postgres-owner.ts"))
      return { url: "nutrition-test:pg", shortCircuit: true };
    if (
      specifier === "../packages/db/dist/index.js" &&
      context.parentURL?.includes("/scripts/postgres-restore")
    )
      return { url: "nutrition-test:db", shortCircuit: true };
    if (
      specifier === "../packages/artifact-store/dist/index.js" &&
      (context.parentURL?.endsWith("/postgres-restore.mjs") ||
        context.parentURL?.endsWith("/postgres-backup-storage.mjs") ||
        context.parentURL?.endsWith("/postgres-operator.mjs"))
    )
      return { url: "nutrition-test:artifact", shortCircuit: true };
    if (
      (context.parentURL?.includes("/packages/") || context.parentURL?.includes("/apps/worker/")) &&
      specifier.startsWith(".") &&
      specifier.endsWith(".js")
    ) {
      const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const prefix = 'const state = globalThis[Symbol.for("nutrition.test.localRestore")];';
    const modules = {
      "nutrition-test:clock":
        prefix +
        'import {performance as original} from "node:perf_hooks"; export const performance={now:()=>original.now()+(state.performanceOffset??0)};',
      "nutrition-test:skip-fixture-tests":
        prefix +
        "function skip(){ state.registrations++; } skip.skip=skip; skip.only=skip; skip.todo=skip; export default skip;",
      "nutrition-test:child": prefix + "export const spawn=(...args)=>state.spawn(...args);",
      "nutrition-test:process": prefix + "export const kill=(...args)=>state.kill(...args);",
      "nutrition-test:fs":
        prefix +
        'export * from "node:fs/promises"; export const rm=(...args)=>state.rm(...args); export const readFile=(...args)=>state.readFile(...args); export const readdir=(...args)=>state.readdir(...args);',
      "nutrition-test:artifact-fs":
        prefix +
        'export * from "node:fs/promises"; export const open=(...args)=>state.open(...args);',
      "nutrition-test:operator-fs":
        prefix +
        `
        import {open as original} from "node:fs/promises";export {lstat} from "node:fs/promises";
        export async function open(...args){const h=await original(...args);return new Proxy(h,{get(target,name){
          if(name==="write") return async(...values)=>{state.outputWrites++;if((state.publicationFault==="evidence"&&state.outputWrites===1)||(state.publicationFault==="handoff"&&state.outputWrites===2))return h.write(values[0],0,1,0);return h.write(...values);};
          if(name==="close")return async()=>{await h.close();if(state.publicationFault==="late-close"&&state.outputWrites===2){state.publicationFault="observed";throw new Error("PRIVATE-PUBLICATION-CLOSE");}};
          const value=Reflect.get(target,name,target);return typeof value==="function"?value.bind(target):value;
        }});}`,
      "nutrition-test:db":
        "export * from " +
        JSON.stringify(source("packages/db/src/postgres-backup-connection.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/owned-postgres-session.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/restore.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/client.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/retention.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/owned-postgres-database.ts")) +
        ";",
      "nutrition-test:artifact":
        "export * from " + JSON.stringify(source("packages/artifact-store/src/index.ts")) + ";",
      "nutrition-test:pg":
        prefix +
        String.raw`
        import { EventEmitter } from "node:events";
        export class Query extends EventEmitter { constructor(config){ super(); this.config=config; } }
        export class Client extends EventEmitter {
          constructor(config) {
            super(); this.config=config; this.socket=config.stream(); this.adapter=state.fixture();
            this.transaction=false; this.closed=false; state.clients.push(this);
            this.socket.once("close",()=>{ this.closed=true; this.active?.emit("error",new Error("synthetic closed")); this.emit("end"); });
          }
          connect(){ return state.onConnect?.(this) ?? Promise.resolve(this); }
          query(query){
            this.active=query;
            (async()=>{
              const input=query.config; let result;
              result=await state.database(this,input);
              if(this.closed) return;
              const metadata=input.rowMode === "array" ? {} : {rows:[],fields:Object.keys(result.rows[0] ?? {}).map(name=>({name})),command: result.command ?? "SELECT", rowCount: Object.hasOwn(result,"rowCount") ? result.rowCount : result.rows.length};
              for(const row of result.rows) query.emit("row",row,metadata);
              this.active=undefined; query.emit("end",metadata);
            })().catch((error)=>{state.pgErrors.push(error);query.emit("error",error);});
            return query;
          }
          end(){
            if(this.closed) return Promise.resolve();
            const ended=new Promise(r=>this.once("end",r)); this.socket.destroy();
            return ended.then(async()=>{ await state.onEnd?.(this); if(state.mode==="target-close" && this.config.database!=="postgres") throw undefined; });
          }
        }`,
    };
    if (url === "nutrition-test:azure-wire")
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export * from " +
          JSON.stringify(state.azurePipelineURL) +
          "; import {createHttpHeaders} from " +
          JSON.stringify(state.azurePipelineURL) +
          "; const state=globalThis[Symbol.for('nutrition.test.localRestore')]; " +
          "export const createDefaultHttpClient=()=>({sendRequest:request=>state.azure.send(request,createHttpHeaders)});",
      };
    if (modules[url]) return { format: "module", source: modules[url], shortCircuit: true };
    if (url.endsWith("/scripts/postgres-restore.mjs"))
      return {
        format: "module",
        source: readFileSync(fileURLToPath(url), "utf8").replace(
          "primary = error instanceof ChildCleanupError ? error : failed(phase);",
          "globalThis[Symbol.for('nutrition.test.localRestore')].restoreFailure = error; primary = error instanceof ChildCleanupError ? error : failed(phase);",
        ),
        shortCircuit: true,
      };
    if (url.endsWith("/scripts/postgres-restore-drill.test.mjs")) {
      return {
        format: "module",
        source: readFileSync(fileURLToPath(url), "utf8") + "\nexport { sharedCollectorAdapter };",
        shortCircuit: true,
      };
    }
    if (
      url.startsWith("file:") &&
      url.endsWith(".ts") &&
      (url.includes("/packages/") || url.includes("/apps/worker/"))
    ) {
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
          mode: "transform",
          sourceUrl: url,
        }),
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});
const { sharedCollectorAdapter } = await import("./postgres-restore-drill.test.mjs");
state.fixture = () => {
  const adapter = sharedCollectorAdapter();
  for (const name of adapter.source.tableCounts.keys())
    adapter.source.tableCounts.set(name, name === "app_user" ? "2" : "0");
  return adapter;
};
const { runPostgresRestore } = await import("./postgres-restore.mjs");
const { runTool } = await import("./postgres-operator-process.mjs");
const {
  EncryptedPostgresBackupStore,
  FileRawArtifactStore,
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  parseArtifactEncryptionKeyRing,
  parseErasureLedgerLocatorKeyRing,
} = await import("nutrition-test:artifact");
const { serializePostgresBackupEvidence } = await import("./postgres-backup-evidence.mjs");
const { discoverMigrations } = await import("../packages/db/src/migrator.ts");
const { EXPORT_ENTITY_SPECS, USER_LINKED_EXPORT_EXCLUSIONS, ERASURE_TABLE_SPECS } = await import(
  "../packages/db/src/retention-privacy-policy.ts"
);
const { runPostgresOperator } = await import("./postgres-operator.mjs");
hooks.deregister();

function close(child) {
  if (child.closed) return;
  child.exited = true;
  child.emit("exit", null, "SIGKILL");
  child.closed = true;
  child.stdin?.destroy();
  child.stdout.end();
  child.stderr.end();
  queueMicrotask(() => child.emit("close", null, "SIGKILL"));
}
state.spawn = (executable, supervisorArgs, options) => {
  if (state.real) {
    const child = realSpawn(executable, supervisorArgs, options);
    state.children.push(child);
    child.stdout.on("data", () => state.onOutput?.());
    child.once("exit", () => {
      child.exited = true;
    });
    child.once("close", () => {
      child.closed = true;
    });
    return child;
  }
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 810000 + state.children.length,
    stdin: options.stdio[0] === "pipe" ? new PassThrough() : undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    closed: false,
    exited: false,
  });
  const file = supervisorArgs[2],
    args = supervisorArgs.slice(3);
  state.children.push(child);
  state.calls.push({ file, args, options });
  const status = (code = 0) =>
    queueMicrotask(() =>
      child.emit("message", { type: "status", exitCode: code, signal: null, spawnFailed: false }),
    );
  child.send = (message, done) => {
    assert.deepEqual(message, { type: "start" });
    done();
    if (args[0] === "--version") {
      const kind = file.endsWith("psql") ? "psql" : "pg_restore";
      child.stdout.write((state.versionOutputs?.[kind] ?? kind + " (PostgreSQL) 17.6") + "\n");
      status();
      return;
    }
    if (state.mode === "hold") return;
    if (state.mode === "premature-input") {
      child.stdin.destroy();
      status();
      return;
    }
    const chunks = [];
    child.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stdin.on("end", () =>
      setImmediate(() => {
        state.inputs.push({ file, bytes: Buffer.concat(chunks) });
        if (file.endsWith("psql")) state.policyApplied = true;
        if (state.mode === "output-overflow") child.stdout.write(Buffer.alloc(65_537));
        status(
          state.mode === "restore-failure" && !file.endsWith("psql")
            ? 1
            : state.mode === "policy-failure" && file.endsWith("psql")
              ? 1
              : 0,
        );
      }),
    );
  };
  queueMicrotask(() => child.emit("message", { type: "ready" }));
  return child;
};
state.kill = (pid, signal) => {
  state.signals.push({ pid, signal });
  const child = state.children.find((entry) => entry.pid === -pid);
  assert.ok(child && !child.exited && !child.closed);
  if (state.real) return realKill(pid, signal);
  if (signal === "SIGKILL") close(child);
  return true;
};
state.readFile = async (path, ...args) => {
  const match = /^\/proc\/([0-9]+)\/stat$/u.exec(String(path));
  if (!state.real && match) {
    const child = state.children.find((entry) => entry.pid === Number(match[1]) && !entry.closed);
    if (!child) throw Object.assign(new Error("synthetic absent"), { code: "ENOENT" });
    return (
      child.pid +
      " (synthetic) " +
      [
        "S",
        "1",
        String(child.pid),
        String(child.pid),
        ...Array(15).fill("0"),
        String(child.pid),
      ].join(" ")
    );
  }
  return fs.readFile(path, ...args);
};
state.readdir = async (path, ...args) =>
  !state.real && path === "/proc"
    ? state.children.filter((entry) => !entry.closed).map((entry) => String(entry.pid))
    : fs.readdir(path, ...args);
state.open = async (...args) => {
  const handle = await fs.open(...args);
  if (state.mode !== "spool-close" || !String(args[0]).endsWith("/artifact.plaintext"))
    return handle;
  return new Proxy(handle, {
    get(target, key) {
      if (key === "close")
        return async () => {
          await target.close();
          state.spoolCloseFailed = true;
          throw undefined;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
state.rm = async (...args) => {
  if (state.mode === "plaintext-cleanup" && String(args[0]).includes("nutrition-pg-restore-"))
    throw undefined;
  return fs.rm(...args);
};
const acl = () => [
  { grantee: "PUBLIC", grantor: "nutrition_owner", privilege: "TEMPORARY", grantable: false },
  ...["CONNECT", "CREATE", "TEMPORARY"].map((privilege) => ({
    grantee: "nutrition_owner",
    grantor: "nutrition_owner",
    privilege,
    grantable: false,
  })),
];
state.database = async (client, input) => {
  const text = input.text,
    values = input.values;
  state.sql.push({ text, values, database: client.config.database });
  if (client.config.application_name === "nutrition-postgres-replay")
    return replayQuery(client, input);
  const one = (value) => ({ rows: [[typeof value === "string" ? value : JSON.stringify(value)]] });
  if (client.config.database === "postgres") {
    if (text.startsWith("select coalesce((select pg_catalog.json_build_object('name'"))
      return one(state.target);
    if (text.startsWith("create database")) {
      assert.equal(state.target, null);
      assert.equal(state.inputs.length, 0);
      assert.ok(text.includes("template template0") && text.endsWith("allow_connections false"));
      state.target = { name: "nutrition_restore_test", oid: "98765", allowConnections: false };
      if (state.mode === "create-uncertain") throw null;
      return { rows: [] };
    }
    if (text.startsWith("revoke connect")) return { rows: [] };
    if (text.startsWith("alter database")) {
      if (
        state.mode === "refence-failure" &&
        state.target.allowConnections &&
        text.endsWith("false")
      )
        throw 0;
      state.target.allowConnections = text.endsWith("true");
      return { rows: [] };
    }
    if (text.startsWith("select pg_catalog.set_config('nutrition.restore_target'"))
      return one(values[0]);
    if (text.includes("row_to_json(database_acl)")) {
      if (state.publicationFault === "final-fence" && state.persistedReplay) {
        state.publicationFault = "observed";
        throw new Error("PRIVATE-FINAL-FENCE");
      }
      const rows = acl();
      if (state.mode === "acl") rows.push({ ...rows[0], privilege: "CONNECT" });
      return one(rows);
    }
    if (text.includes("json_agg(role_policy.name"))
      return one(
        state.mode === "effective-connect"
          ? ["nutrition_api", "nutrition_owner"]
          : ["nutrition_owner"],
      );
    if (text.includes("from pg_catalog.pg_stat_activity")) {
      assert.ok(
        state.clients
          .filter((entry) => entry.config.database !== "postgres")
          .every((entry) => entry.closed),
      );
      return one(state.mode === "session" ? "1" : "0");
    }
    if (text.includes("pg_get_userbyid"))
      return one(state.mode === "owner" ? "wrong_owner" : "nutrition_owner");
    if (text.includes("pg_catalog.unnest"))
      return one(
        ["nutrition_api", "nutrition_worker"].map((name) => ({
          name,
          connect:
            state.mode === "runtime-connect" ? true : state.mode === "missing-role" ? null : false,
        })),
      );
    throw new Error("unexpected synthetic admin statement");
  }
  assert.ok(state.policyApplied, "target evidence starts only after policy");
  if (text.startsWith('set role "')) return { rows: [] };
  if (text === "begin isolation level repeatable read read only") {
    client.adapter.snapshot();
    client.transaction = true;
    return { rows: [] };
  }
  if (text.startsWith("select pg_catalog.json_build_object('databaseName'"))
    return one({
      databaseName: "nutrition_restore_test",
      databaseOid: state.mode === "identity" ? "0" : "98765",
    });
  if (text.includes("from public.database_restore_attestation")) {
    if (state.mode === "readiness-query") throw new Error("private raw schema problem");
    return one(
      state.mode === "attestation-shape"
        ? [{ database_name: {} }]
        : [{ restore_epoch_hash: "0".repeat(64), database_oid: "123", database_name: "nutrition" }],
    );
  }
  if (state.mode === "count" && text.startsWith('select count(*) from public."'))
    return one("99999");
  if (state.mode === "ledger" && text.includes("json_agg(row_to_json(m)")) return one("[]");
  if (state.mode === "replacement" && text.startsWith("begin read write")) {
    state.target.oid = "54321";
    throw null;
  }
  if (state.mode === "refence-failure" && text.startsWith("begin read write")) throw null;
  const result = await client.adapter.query(input);
  if (text === "rollback") client.transaction = false;
  return result;
};

const replayFirst = "10000000-0000-4000-8000-000000000001";
const replaySecond = "20000000-0000-4000-8000-000000000002";
let migrationFixture;
async function replayQuery(client, input) {
  const text = input.text.replace(/\s+/gu, " ").trim(),
    values = input.values;
  await state.beforeReplayQuery?.(text, values, client);
  const done = (rows = [], command = "SELECT", rowCount = rows.length) => ({
    rows,
    command,
    rowCount,
  });
  if (["begin", "commit", "rollback"].includes(text)) {
    assert.equal(
      client.transaction,
      text !== "begin",
      "helper transactions are serial, never nested",
    );
    if (text === "begin") {
      client.savedRows = new Set(state.replayRows);
      client.savedAttestation = state.persistedReplay;
    }
    if (text === "rollback") {
      state.replayRows = client.savedRows;
      state.persistedReplay = client.savedAttestation;
    }
    client.transaction = text === "begin";
    client.localPath = undefined;
    return done([], text.toUpperCase(), null);
  }
  if (text === 'set role "nutrition_owner"') {
    client.role = "nutrition_owner";
    return done([], "SET", null);
  }
  if (text === "select current_user::pg_catalog.text as role")
    return done([{ role: state.replayFault === "role" ? "wrong_owner" : client.role }]);
  assert.equal(client.role, "nutrition_owner");
  if (text.startsWith("select pg_catalog.current_database() database_name,"))
    return done([
      {
        database_name: "nutrition_restore_test",
        database_oid: state.replayFault === "identity" ? "1111" : state.target.oid,
      },
    ]);
  if (text.includes("from pg_catalog.pg_settings"))
    return done([
      {
        setting: client.localPath ?? client.config.options.replace("-c search_path=", ""),
        source: "client",
      },
    ]);
  if (text.startsWith("select pg_catalog.set_config(")) {
    assert.equal(client.transaction, true);
    assert.equal(values[0].replaceAll(" ", ""), "public,pg_catalog,pg_temp");
    client.localPath = values[0];
    return done([{ set_config: values[0] }]);
  }
  if (text.includes('from "public".app_schema_migration')) {
    migrationFixture ??= discoverMigrations();
    return done((await migrationFixture).map(({ name, checksum }) => ({ name, checksum })));
  }
  if (text.startsWith("select pg_advisory_xact_lock(") || text.startsWith("select set_config(")) {
    assert.equal(client.transaction, true);
    return done([]);
  }
  if (text.startsWith("with recursive linked(oid)"))
    return done(
      [
        ...new Set([...EXPORT_ENTITY_SPECS.map((s) => s.table), ...USER_LINKED_EXPORT_EXCLUSIONS]),
      ].map((table_name) => ({ table_name })),
    );
  if (text.includes("from pg_constraint edge"))
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
  if (text.startsWith('select "id" from "app_user"')) {
    const limit = values.at(-1),
      cursor = values.length > 1 ? values[0] : "";
    if (["oversized-page", "sql-result", "http-budget"].includes(state.replayFault)) {
      const total =
        state.replayFault === "oversized-page"
          ? 501
          : state.replayFault === "sql-result"
            ? 1025
            : 2049;
      const rows = Array.from(
        { length: total },
        (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      ).filter((id) => id > cursor);
      return done(
        (state.replayFault === "http-budget" ? rows.slice(0, limit) : rows).map((id) => ({ id })),
      );
    }
    return done(
      [...state.replayRows]
        .sort()
        .filter((id) => id > cursor)
        .slice(0, limit)
        .map((id) => ({ id })),
    );
  }
  if (text.startsWith('select "id" from "account_erasure_job"')) return done([]);
  if (text.startsWith('insert into "database_restore_attestation"')) {
    assert.equal(client.transaction, true);
    const columns = text
      .match(/^insert into "database_restore_attestation" \(([^)]+)\)/u)[1]
      .split(", ")
      .map((c) => c.slice(1, -1));
    state.persistedReplay = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
    state.persistedReplay.replayed_subject_count = String(
      state.persistedReplay.replayed_subject_count,
    );
    return done([{ ...state.persistedReplay }], "INSERT", 1);
  }
  if (
    text.includes('from "database_restore_attestation"') ||
    text.includes('from "public"."database_restore_attestation"')
  ) {
    const row = state.persistedReplay;
    if (!row) return done([]);
    if (!text.includes(' as "databaseName"'))
      return done([
        {
          restore_epoch_hash: row.restore_epoch_hash,
          database_name: row.database_name,
          database_oid: row.database_oid,
        },
      ]);
    const observed = {
      databaseName: row.database_name,
      databaseOid: row.database_oid,
      restoreEpochHash: row.restore_epoch_hash,
      reconciliationDigest: row.reconciliation_digest,
      replayedSubjectCount: row.replayed_subject_count,
      completedAt: row.completed_at,
    };
    if (state.replayDrift) Object.assign(observed, state.replayDrift);
    return done([observed]);
  }
  if (text.startsWith("create temporary table erasure_retention_target_v3"))
    return done([], "CREATE", null);
  if (text.startsWith("insert into erasure_retention_target_v3")) return done([], "INSERT", 0);
  if (text.startsWith("delete from ")) {
    assert.equal(client.transaction, true);
    if (text.startsWith('delete from "app_user"')) {
      assert.equal(values.length, 1);
      return done([], "DELETE", state.replayRows.delete(values[0]) ? 1 : 0);
    }
    const table = text.match(/^delete from "?([a-z0-9_]+)"?/u)[1];
    assert.ok(
      [
        "retention_dead_letter_event",
        "retention_job_recovery_audit",
        ...ERASURE_TABLE_SPECS.filter((s) => s.strategy === "delete").map((s) => s.table),
      ].includes(table),
    );
    return done([], "DELETE", 0);
  }
  if (text.startsWith("select count(*)::text count")) {
    // Only app_user has rows in this synthetic backup. All other fixture tables are empty.
    const isSubject = /^select count\(\*\)::text count from app_user(?:\s|$)/u.test(text);
    return done([{ count: isSubject && state.replayRows.has(values[0]) ? "1" : "0" }]);
  }
  throw new Error("Unhandled injected replay SQL: " + text);
}

async function configureLedger(
  fixture,
  azure,
  config = azureLedgerSettings(),
  { entry = false, conflict = false, tamper = false } = {},
) {
  fixture.options.erasureReplay = config;
  const directory = join(fixture.local, "ledger-fixture");
  await fs.mkdir(directory, { mode: 0o700 });
  const rawStore = new FileRawArtifactStore(directory);
  const encryption = parseArtifactEncryptionKeyRing({
    purpose: "erasure_replay_ledger",
    currentKeyId: "ledger-old",
    serializedKeys: JSON.stringify(config.encryptionKeyRing.keys),
  });
  const locator = parseErasureLedgerLocatorKeyRing({
    currentKeyId: "locator-old",
    serializedKeys: JSON.stringify(config.locatorKeyRing.keys),
  });
  const ledger = new EncryptedErasureReplayLedger({
    artifactStore: new EncryptedArtifactStore({
      rawStore,
      keyRing: encryption,
      maxPlaintextBytes: 16384,
      temporaryDirectory: fixture.temporary,
    }),
    locatorKeyRing: locator,
  });
  const objects = new Map();
  try {
    if (entry) {
      const receipt = await ledger.append({
        subjectUserId: replayFirst,
        jobId: "30000000-0000-4000-8000-000000000003",
        recordedAt: "2026-10-01T12:00:00.000Z",
        restoreLocator: ledger.locatorForSubject(replayFirst),
      });
      const bytes = await fs.readFile(join(directory, receipt.reference));
      if (tamper) bytes[bytes.length - 1] ^= 1;
      objects.set(config.prefix + receipt.reference, bytes);
    }
  } finally {
    for (const ring of [encryption, locator]) for (const key of ring.keys.values()) key.fill(0);
  }
  const backupSend = azure.send;
  azure.ledgerRequests = [];
  azure.send = async (request, headers) => {
    if (
      !request.url.startsWith(config.containerUrl + "?") &&
      !request.url.startsWith(config.containerUrl + "/")
    )
      return backupSend(request, headers);
    azure.ledgerRequests.push(request);
    await state.beforeLedgerRequest?.(request);
    const url = new URL(request.url),
      listing = url.searchParams.get("comp") === "list";
    const name = listing
      ? url.searchParams.get("prefix")
      : decodeURIComponent(url.pathname.slice(new URL(config.containerUrl).pathname.length + 1));
    const bytes = objects.get(name),
      version = "retained-ledger-version";
    let body, extra;
    if (listing) {
      const item = bytes
        ? `<Blob><Name>${name}</Name><Deleted>false</Deleted><Snapshot/><VersionId>${version}</VersionId><IsCurrentVersion>true</IsCurrentVersion><Properties><Content-Length>${bytes.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`
        : "";
      body = Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="${url.origin}/" ContainerName="${new URL(config.containerUrl).pathname.slice(1)}"><Prefix>${name}</Prefix><MaxResults>16</MaxResults><Blobs>${item}${conflict ? item.replace(version, "conflict-version") : ""}</Blobs><NextMarker/></EnumerationResults>`,
      );
      extra = { "content-type": "application/xml" };
    } else {
      assert.ok(bytes);
      assert.equal(url.searchParams.get("versionid"), version);
      body = bytes;
      extra = { "content-length": String(bytes.length), "x-ms-version-id": version };
    }
    const stream = Readable.from([body]);
    azure.bodies.push(stream);
    return {
      request,
      status: 200,
      headers: headers({ etag: '"ledger"', ...extra }),
      readableStreamBody: stream,
    };
  };
  return { objects };
}

async function setup(deploymentTarget = "staging", evidenceOverride) {
  Object.assign(state, {
    children: [],
    clients: [],
    calls: [],
    inputs: [],
    sql: [],
    signals: [],
    real: false,
    target: null,
    policyApplied: false,
    mode: "success",
    versionOutputs: undefined,
    spoolCloseFailed: false,
    replayRows: new Set([
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ]),
    persistedReplay: undefined,
    pgErrors: [],
    restoreFailure: undefined,
    replayFault: undefined,
    replayDrift: undefined,
    beforeReplayQuery: undefined,
    beforeLedgerRequest: undefined,
    onConnect: undefined,
    onEnd: undefined,
    performanceOffset: 0,
  });
  const temporary = await fs.mkdtemp("/dev/shm/nutrition-restore-test-");
  const local = await fs.mkdtemp(join(tmpdir(), "nutrition-restore-test-"));
  await fs.chmod(temporary, 0o700);
  await fs.chmod(local, 0o700);
  const tools = {};
  for (const name of ["pg_restore", "psql"]) {
    const path = join(local, name),
      bytes = Buffer.from("synthetic " + name);
    await fs.writeFile(path, bytes, { flag: "wx", mode: 0o700 });
    tools[name === "psql" ? "psql" : "pgRestore"] = {
      path,
      sha256: hash(bytes),
      version: name + " (PostgreSQL) 17.6",
    };
  }
  const artifactDirectory = join(local, "encrypted");
  await fs.mkdir(artifactDirectory, { mode: 0o700 });
  const keyRing = {
    purpose: "postgres_backup",
    currentKeyId: "synthetic",
    keys: new Map([["synthetic", Buffer.alloc(32, 7)]]),
  };
  const evidence =
    evidenceOverride ?? serializePostgresBackupEvidence(state.fixture().source, "nutrition_owner");
  const manifest = {
    backupId: "a0000000-0000-4000-8000-000000000001",
    capturedAt: "2026-09-30T00:00:00.000Z",
    databaseName: "nutrition",
    deploymentTarget,
    dumpBytes: dump.byteLength,
    dumpSha256: hash(dump),
    formatVersion: "nutrition-postgres-backup-v2",
    snapshotId: "00000003-000000A1-1",
    sourceEvidenceBytes: evidence.byteLength,
    sourceEvidenceSha256: hash(evidence),
    sourceRevision: "a".repeat(40),
  };
  const store = new EncryptedPostgresBackupStore({
    rawStore: new FileRawArtifactStore(artifactDirectory),
    keyRing,
    temporaryDirectory: temporary,
    maxDumpBytes: 1024,
  });
  const metadata = await store
    .publish({
      manifest: Buffer.from(JSON.stringify(manifest)),
      sourceEvidence: evidence,
      dump: Readable.from([dump]),
    })
    .catch(async (error) => {
      await fs.rm(temporary, { recursive: true, force: true });
      await fs.rm(local, { recursive: true, force: true });
      throw error;
    });
  const ciphertext = join(artifactDirectory, metadata.objectKey);
  const cipherBytes = await fs.readFile(ciphertext);
  const connection = (database) => ({
    connectionString: "postgresql://nutrition_owner:synthetic-secret@database.test/" + database,
    caCertificate: rootCertificates[0],
  });
  const options = {
    expectedBackup: {
      backupId: manifest.backupId,
      databaseName: manifest.databaseName,
      deploymentTarget: manifest.deploymentTarget,
      manifestSha256: hash(Buffer.from(JSON.stringify(manifest))),
      snapshotId: manifest.snapshotId,
      sourceRevision: manifest.sourceRevision,
    },
    expectedOwner: "nutrition_owner",
    keyRing,
    storage: { kind: "file", directory: artifactDirectory },
    erasureReplay: null,
    tmpfsRoot: temporary,
    maintenanceConnection: connection("postgres"),
    targetConnection: connection("nutrition_restore_test"),
    targetDatabase: "nutrition_restore_test",
    connectAllowlist: ["nutrition_owner"],
    deniedRuntimePrincipals: ["nutrition_api", "nutrition_worker"],
    tools,
    maxDumpBytes: 1024,
    timeoutMs: 10_000,
  };
  return {
    options,
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    evidence,
    metadata,
    temporary,
    local,
    ciphertext,
    cipherBytes,
    async dispose() {
      state.mode = "success";
      await fs.rm(temporary, { recursive: true, force: true });
      await fs.rm(local, { recursive: true, force: true });
    },
  };
}
async function settled(fixture) {
  assert.ok(state.children.every((entry) => entry.closed));
  assert.ok(state.clients.every((entry) => entry.closed));
  assert.equal(
    state.sql.some((entry) => /^\s*drop database|pg_terminate_backend|grant\s/iu.test(entry.text)),
    false,
  );
  assert.deepEqual(await fs.readFile(fixture.ciphertext), fixture.cipherBytes);
  assert.deepEqual(await fs.readdir(fixture.temporary), []);
}
test("fixture import registers tests without executing their bodies", () => {
  assert.ok(state.registrations >= 350);
});
test("authenticated dump stdin, exact policy, evidence and fresh readiness denial complete locally", async () => {
  const fixture = await setup();
  try {
    const result = await runPostgresRestore(fixture.options);
    assert.equal(result.localOnly, true);
    assert.equal(result.erasureReplayRequired, true);
    assert.equal(result.applicationTrafficBlocked, true);
    assert.equal(result.status, "local-restore-verified");
    assert.match(result.restoreEpoch, /^[0-9a-f]{64}$/u);
    assert.equal(result.databaseOid, "98765");
    assert.deepEqual(result.authenticatedBackup, {
      manifestBytes: fixture.manifestBytes,
      sourceEvidence: fixture.evidence,
      metadata: fixture.metadata,
      readSource: { kind: "unqualified" },
    });
    assert.equal(hash(result.authenticatedBackup.manifestBytes), result.manifestSha256);
    assert.equal(hash(result.authenticatedBackup.sourceEvidence), result.sourceEvidenceSha256);
    assert.deepEqual(state.inputs[0].bytes, dump, "only dump bytes, never authenticated frame");
    const { AUTHORITY_POLICY_SQL } = await import("./postgres-restore-drill.mjs");
    assert.equal(
      state.inputs[1].bytes.toString(),
      'set role "nutrition_owner";\n' + AUTHORITY_POLICY_SQL,
    );
    const restore = state.calls.find((entry) => entry.args.includes("--single-transaction"));
    assert.deepEqual(restore.args, [
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--no-password",
      "--role=nutrition_owner",
      "--dbname=nutrition_restore_test",
    ]);
    assert.equal(restore.options.env.PGDATABASE, "nutrition_restore_test");
    const policy = state.calls.find(
      (entry) => entry.file.endsWith("psql") && entry.args[0] === "-X",
    );
    assert.deepEqual(policy.args, ["-X", "--no-password", "--set=ON_ERROR_STOP=1", "--file=-"]);
    assert.equal(state.target.allowConnections, true);
    assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
    assert.equal(
      state.sql.some((entry) => /insert into.*attestation/iu.test(entry.text)),
      false,
    );
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
test("authenticated evidence snapshots survive mutation, disposal and exclude private extras", async () => {
  const fixture = await setup();
  const recover = EncryptedPostgresBackupStore.prototype.recover;
  let observed,
    disposed = false;
  try {
    mock.method(EncryptedPostgresBackupStore.prototype, "recover", async function (input) {
      const original = await recover.call(this, input);
      observed = {
        ...original,
        readSource: { ...original.readSource },
        metadata: { ...original.metadata, secret: "PRIVATE-METADATA" },
      };
      observed.dispose = async () => {
        await original.dispose();
        observed.manifestBytes.fill(0);
        observed.sourceEvidence.fill(0);
        observed.metadata.plaintextSha256 = "0".repeat(64);
        observed.metadata.objectKey = "PRIVATE-REPLACED-KEY";
        observed.readSource.kind = "PRIVATE-REPLACED-SOURCE";
        disposed = true;
      };
      return observed;
    });
    const result = await runPostgresRestore(fixture.options);
    assert.equal(disposed, true);
    assert.deepEqual(result.authenticatedBackup, {
      manifestBytes: fixture.manifestBytes,
      sourceEvidence: fixture.evidence,
      metadata: fixture.metadata,
      readSource: { kind: "unqualified" },
    });
    assert.notEqual(result.authenticatedBackup.manifestBytes, observed.manifestBytes);
    assert.notEqual(result.authenticatedBackup.sourceEvidence, observed.sourceEvidence);
    assert.ok(Object.isFrozen(result.authenticatedBackup));
    assert.ok(Object.isFrozen(result.authenticatedBackup.metadata));
    assert.ok(Object.isFrozen(result.authenticatedBackup.readSource));
    assert.notEqual(result.authenticatedBackup.readSource, observed.readSource);
    assert.equal(JSON.stringify(result).includes("PRIVATE-"), false);
    // The caller owns mutable Buffer copies, even though their container is frozen.
    result.authenticatedBackup.manifestBytes[0] ^= 1;
    assert.equal(fixture.manifestBytes[0], "{".charCodeAt(0));
    await settled(fixture);
  } finally {
    mock.restoreAll();
    await fixture.dispose();
  }
});

const evidenceMutations = {
  "source-missing": (r) => {
    delete r.readSource;
  },
  "source-current": (r) => {
    r.readSource = { kind: "azure-blob-current" };
  },
  "source-extra": (r) => {
    r.readSource = { kind: "unqualified", path: "PRIVATE-PATH" };
  },
  "source-accessor": (r) => {
    r.readSource = Object.defineProperty({}, "kind", {
      get() {
        throw new Error("PRIVATE-SOURCE");
      },
    });
  },
  "missing-manifest": (r) => {
    r.manifestBytes = undefined;
  },
  "manifest-type": (r) => {
    r.manifestBytes = new Uint8Array(r.manifestBytes);
  },
  "manifest-empty": (r) => {
    r.manifestBytes = Buffer.alloc(0);
  },
  "manifest-overflow": (r) => {
    r.manifestBytes = Buffer.alloc(16_385);
  },
  "manifest-hash": (r) => {
    r.manifestBytes = Buffer.from("PRIVATE-MANIFEST");
  },
  "missing-claims": (r) => {
    r.manifest = undefined;
  },
  "manifest-identity": (r) => {
    r.manifest = { ...r.manifest, databaseName: "different" };
  },
  "manifest-count": (r) => {
    r.manifest = { ...r.manifest, sourceEvidenceBytes: 0 };
  },
  "missing-evidence": (r) => {
    r.sourceEvidence = undefined;
  },
  "evidence-type": (r) => {
    r.sourceEvidence = "PRIVATE-EVIDENCE";
  },
  "evidence-empty": (r) => {
    r.sourceEvidence = Buffer.alloc(0);
  },
  "evidence-overflow": (r) => {
    r.sourceEvidence = Buffer.alloc(1_048_577);
  },
  "evidence-length": (r) => {
    r.sourceEvidence = r.sourceEvidence.subarray(1);
  },
  "evidence-hash": (r) => {
    r.sourceEvidence = Buffer.from(r.sourceEvidence);
    r.sourceEvidence[0] ^= 1;
  },
  "missing-metadata": (r) => {
    r.metadata = undefined;
  },
};
for (const [name, field, value] of [
  ["envelope-version", "envelopeVersion", 2],
  ["key-missing", "encryptionKeyId", undefined],
  ["key-malformed", "encryptionKeyId", "PRIVATE KEY"],
  ["key-overflow", "encryptionKeyId", "a".repeat(65)],
  ["key-unknown", "encryptionKeyId", "unknown"],
  ["object-key", "objectKey", "PRIVATE-OBJECT"],
  ["media-type", "mediaType", "application/json"],
  ["plaintext-type", "plaintextBytes", "1"],
  ["plaintext-count", "plaintextBytes", 1],
  ["plaintext-unsafe", "plaintextBytes", Number.MAX_SAFE_INTEGER + 1],
  ["plaintext-hash", "plaintextSha256", "PRIVATE-HASH"],
  ["plaintext-nested", "plaintextSha256", { secret: "PRIVATE-NESTED" }],
  ["ciphertext-type", "ciphertextBytes", "1"],
  ["ciphertext-count", "ciphertextBytes", 1],
  ["ciphertext-unsafe", "ciphertextBytes", Number.MAX_SAFE_INTEGER + 1],
])
  evidenceMutations[name] = (r) => {
    r.metadata = { ...r.metadata, [field]: value };
  };
for (const [name, mutate] of Object.entries(evidenceMutations)) {
  test("authenticated evidence refuses " + name + " before target creation", async () => {
    const fixture = await setup();
    const recover = EncryptedPostgresBackupStore.prototype.recover;
    try {
      mock.method(EncryptedPostgresBackupStore.prototype, "recover", async function (input) {
        const recovered = { ...(await recover.call(this, input)) };
        mutate(recovered);
        return recovered;
      });
      await assert.rejects(runPostgresRestore(fixture.options), (error) => {
        assert.equal(error.phase, "authentication");
        assert.equal(error.targetOutcome, "not-created");
        assert.equal((String(error) + JSON.stringify(error)).includes("PRIVATE-"), false);
        return true;
      });
      assert.equal(state.calls.length, 0);
      assert.equal(state.clients.length, 0);
      await settled(fixture);
    } finally {
      mock.restoreAll();
      await fixture.dispose();
    }
  });
}
test("actual authenticated malformed source evidence is rejected", async () => {
  const fixture = await setup("staging", Buffer.from('{"private":"PRIVATE-INVALID-EVIDENCE"}'));
  try {
    await assert.rejects(runPostgresRestore(fixture.options), (error) => {
      assert.equal(error.phase, "authentication");
      assert.equal(String(error).includes("PRIVATE-"), false);
      return true;
    });
    assert.equal(state.calls.length, 0);
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
test("external cancellation during final cleanup refuses evidence and re-fences the retained target", async () => {
  const fixture = await setup();
  const controller = new AbortController();
  const remove = state.rm;
  try {
    fixture.options.signal = controller.signal;
    mock.method(state, "rm", async (...args) => {
      await remove(...args);
      controller.abort(new Error("PRIVATE-CLEANUP-CANCEL"));
    });
    await assert.rejects(runPostgresRestore(fixture.options), (error) => {
      assert.equal(error.targetOutcome, "retained");
      assert.equal(String(error).includes("PRIVATE-"), false);
      return true;
    });
    assert.equal(state.target.allowConnections, false);
    await settled(fixture);
  } finally {
    mock.restoreAll();
    await fixture.dispose();
  }
});
for (const mode of ["tampered", "missing", "identity-binding", "existing", "source-target"]) {
  test(mode + " is refused before target creation", async () => {
    const fixture = await setup();
    try {
      if (mode === "tampered") {
        const changed = Buffer.from(fixture.cipherBytes);
        changed[changed.length - 1] ^= 1;
        await fs.writeFile(fixture.ciphertext, changed);
      }
      if (mode === "missing") await fs.unlink(fixture.ciphertext);
      if (mode === "identity-binding")
        fixture.options.expectedBackup.manifestSha256 = "0".repeat(64);
      if (mode === "existing")
        state.target = { name: "nutrition_restore_test", oid: "12", allowConnections: true };
      if (mode === "source-target") fixture.options.targetDatabase = "nutrition";
      await assert.rejects(runPostgresRestore(fixture.options), /PostgreSQL local restore/u);
      assert.equal(
        state.sql.some((entry) => entry.text.startsWith("create database")),
        false,
      );
      assert.equal(state.inputs.length, 0);
      if (["tampered", "missing", "identity-binding"].includes(mode))
        assert.equal(state.clients.length, 0);
      assert.ok(state.clients.every((entry) => entry.closed));
      assert.deepEqual(await fs.readdir(fixture.temporary), []);
    } finally {
      await fixture.dispose();
    }
  });
}
for (const mode of [
  "acl",
  "effective-connect",
  "runtime-connect",
  "missing-role",
  "session",
  "owner",
  "restore-failure",
  "policy-failure",
  "count",
  "ledger",
  "identity",
  "readiness-query",
  "attestation-shape",
  "output-overflow",
  "premature-input",
]) {
  test(mode + " fails, retains target, and restores its connection fence", async () => {
    const fixture = await setup();
    try {
      state.mode = mode;
      await assert.rejects(runPostgresRestore(fixture.options), (error) => {
        assert.equal(error.targetOutcome, "retained");
        assert.equal(JSON.stringify(error).includes("synthetic-secret"), false);
        assert.equal(error.message.includes("private raw"), false);
        return true;
      });
      assert.equal(state.target.allowConnections, false);
      await settled(fixture);
    } finally {
      await fixture.dispose();
    }
  });
}
test("inability to re-fence is a separate cleanup failure, not a safe-fence claim", async () => {
  const fixture = await setup();
  try {
    state.mode = "refence-failure";
    await assert.rejects(
      runPostgresRestore(fixture.options),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => /retained target fence/u.test(entry.message)),
    );
    assert.equal(state.target.allowConnections, true);
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
test("timeout cancels owned input/process and re-fences using a separate bounded cleanup session", async () => {
  const fixture = await setup();
  try {
    state.mode = "hold";
    fixture.options.timeoutMs = 150;
    await assert.rejects(runPostgresRestore(fixture.options));
    assert.equal(state.target.allowConnections, false);
    assert.deepEqual(
      state.signals.slice(-2).map((entry) => entry.signal),
      ["SIGTERM", "SIGKILL"],
    );
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
for (const size of [dump.length - 1, dump.length + 1]) {
  test("input requires exact expected byte count " + size, async () => {
    const fixture = await setup();
    try {
      await assert.rejects(
        runTool(fixture.options.tools.pgRestore, [], {
          signal: AbortSignal.timeout(5_000),
          env: {},
          directory: fixture.local,
          limit: 1024,
          input: Readable.from([dump]),
          inputBytes: size,
        }),
      );
      assert.ok(state.children.every((entry) => entry.closed));
    } finally {
      await fixture.dispose();
    }
  });
}
test("actual fixed supervisor forwards bounded synthetic stdin and awaits its process group", async () => {
  const fixture = await setup();
  try {
    state.real = true;
    const script = Buffer.from(
      "#!" +
        process.execPath +
        "\nlet n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>process.stdout.write(String(n)));\n",
    );
    const path = join(fixture.local, "synthetic-stdin");
    await fs.writeFile(path, script, { flag: "wx", mode: 0o700 });
    const bytes = Buffer.alloc(262144, 7);
    const result = await runTool({ path, sha256: hash(script) }, [], {
      signal: AbortSignal.timeout(8_000),
      env: { PATH: "/usr/bin:/bin" },
      directory: fixture.local,
      limit: 1024,
      input: Readable.from([bytes]),
      inputBytes: bytes.length,
    });
    assert.equal(result.text, String(bytes.length));
    assert.ok(state.children.every((entry) => entry.closed));
  } finally {
    await fixture.dispose();
  }
});

test("awaited authenticated spool close failure prevents acceptance and re-fences the target", async () => {
  const fixture = await setup();
  try {
    state.mode = "spool-close";
    await assert.rejects(runPostgresRestore(fixture.options));
    assert.equal(state.spoolCloseFailed, true);
    assert.equal(state.target.allowConnections, false);
    assert.equal(state.policyApplied, false);
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
test("late owned directory cleanup failure triggers target re-fencing", async () => {
  const fixture = await setup();
  try {
    state.mode = "plaintext-cleanup";
    await assert.rejects(
      runPostgresRestore(fixture.options),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => /plaintext cleanup/u.test(entry.message)),
    );
    assert.equal(state.target.allowConnections, false);
    assert.ok(state.clients.every((entry) => entry.closed));
    assert.deepEqual(await fs.readFile(fixture.ciphertext), fixture.cipherBytes);
  } finally {
    await fixture.dispose();
  }
});
test("target session closure failure cannot be mistaken for stale readiness denial", async () => {
  const fixture = await setup();
  try {
    state.mode = "target-close";
    await assert.rejects(runPostgresRestore(fixture.options), AggregateError);
    assert.equal(state.target.allowConnections, false);
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
test("uncertain CREATE outcome is retained without assuming identity or mutating another target", async () => {
  const fixture = await setup();
  try {
    state.mode = "create-uncertain";
    await assert.rejects(
      runPostgresRestore(fixture.options),
      (error) => error instanceof AggregateError && error.targetOutcome === "unknown",
    );
    assert.equal(state.target.allowConnections, false);
    assert.equal(
      state.sql.some((entry) => entry.text.startsWith("alter database")),
      false,
    );
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
test("replacement target OID prevents failure-cleanup mutation", async () => {
  const fixture = await setup();
  try {
    state.mode = "replacement";
    await assert.rejects(
      runPostgresRestore(fixture.options),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => /retained target fence/u.test(entry.message)),
    );
    assert.equal(state.target.oid, "54321");
    assert.equal(state.target.allowConnections, true);
    assert.equal(
      state.sql.some(
        (entry) => entry.text.startsWith("alter database") && entry.text.endsWith("false"),
      ),
      false,
    );
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
test("input stream failure remains sanitized and all owned child streams settle", async () => {
  const fixture = await setup();
  try {
    const input = Readable.from(
      (async function* () {
        yield dump.subarray(0, 5);
        throw new Error("private raw source");
      })(),
    );
    await assert.rejects(
      runTool(fixture.options.tools.pgRestore, [], {
        signal: AbortSignal.timeout(5_000),
        env: {},
        directory: fixture.local,
        limit: 1024,
        input,
        inputBytes: dump.length,
      }),
      (error) => !error.message.includes("private raw"),
    );
    assert.ok(input.destroyed);
    assert.ok(state.children.every((entry) => entry.closed));
  } finally {
    await fixture.dispose();
  }
});
for (const change of [
  "host",
  "port",
  "ca",
  "maintenance-database",
  "runtime-overlap",
  "target-binding",
]) {
  test(
    "rejects ambiguous connection boundary " + change + " before any child or database",
    async () => {
      const fixture = await setup();
      try {
        if (change === "host")
          fixture.options.targetConnection.connectionString =
            fixture.options.targetConnection.connectionString.replace(
              "database.test",
              "different.test",
            );
        if (change === "port")
          fixture.options.targetConnection.connectionString =
            fixture.options.targetConnection.connectionString.replace(
              "database.test",
              "database.test:5433",
            );
        if (change === "ca") fixture.options.targetConnection.caCertificate = rootCertificates[1];
        if (change === "maintenance-database")
          fixture.options.maintenanceConnection = fixture.options.targetConnection;
        if (change === "runtime-overlap")
          fixture.options.deniedRuntimePrincipals.push("nutrition_owner");
        if (change === "target-binding")
          fixture.options.targetConnection.connectionString =
            fixture.options.targetConnection.connectionString.replace(
              "nutrition_restore_test",
              "other_database",
            );
        await assert.rejects(runPostgresRestore(fixture.options));
        assert.equal(state.children.length, 0);
        assert.equal(state.clients.length, 0);
        await settled(fixture);
      } finally {
        await fixture.dispose();
      }
    },
  );
}

for (const mode of ["early-close", "cancel"]) {
  test("actual supervisor stdin " + mode + " rejects and settles owned streams", {
    timeout: 12_000,
  }, async () => {
    const fixture = await setup();
    try {
      state.real = true;
      const path = join(fixture.local, "synthetic-input-" + mode);
      const script = Buffer.from(
        "#!" +
          process.execPath +
          "\n" +
          (mode === "early-close"
            ? "process.exit(0);\n"
            : "process.on('SIGTERM',()=>{});process.stdout.write('READY');setInterval(()=>{},1000);\n"),
      );
      await fs.writeFile(path, script, { flag: "wx", mode: 0o700 });
      const controller = new AbortController();
      state.onOutput = () => {
        if (mode === "cancel") controller.abort();
      };
      const input = Readable.from([Buffer.alloc(2_097_152, 3)]);
      await assert.rejects(
        runTool({ path, sha256: hash(script) }, [], {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
          env: { PATH: "/usr/bin:/bin" },
          directory: fixture.local,
          limit: 1024,
          input,
          inputBytes: 2_097_152,
        }),
      );
      assert.ok(input.destroyed);
      assert.ok(state.children.every((entry) => entry.closed));
      if (mode === "cancel")
        assert.deepEqual(
          state.signals.map((entry) => entry.signal),
          ["SIGTERM", "SIGKILL"],
        );
    } finally {
      state.onOutput = undefined;
      for (const child of state.children)
        if (!child.closed && !child.exited) {
          realKill(-child.pid, "SIGKILL");
          await new Promise((done) => child.once("close", done));
        }
      await fixture.dispose();
    }
  });
}

test("development restore remains local, fenced and dependent on erasure replay", async () => {
  const fixture = await setup("development");
  try {
    const result = await runPostgresRestore(fixture.options);
    assert.equal(result.localOnly, true);
    assert.equal(result.erasureReplayRequired, true);
    assert.equal(result.applicationTrafficBlocked, true);
    assert.equal(result.status, "local-restore-verified");
    assert.deepEqual(state.inputs[0].bytes, dump);
    assert.equal(
      state.sql.some((entry) => /insert into.*attestation/iu.test(entry.text)),
      false,
    );
    await settled(fixture);
  } finally {
    await fixture.dispose();
  }
});
for (const storedTarget of ["development", "staging", "production"]) {
  for (const expectedTarget of ["development", "staging", "production"].filter(
    (target) => target !== storedTarget,
  )) {
    test(
      "restore refuses authenticated " +
        storedTarget +
        " when independently expected as " +
        expectedTarget,
      async () => {
        const fixture = await setup(storedTarget);
        try {
          fixture.options.expectedBackup.deploymentTarget = expectedTarget;
          await assert.rejects(runPostgresRestore(fixture.options), /PostgreSQL local restore/u);
          assert.equal(state.calls.length, 0);
          assert.equal(state.clients.length, 0);
          assert.equal(state.sql.length, 0);
          assert.equal(state.inputs.length, 0);
          assert.equal(state.target, null);
          await settled(fixture);
        } finally {
          await fixture.dispose();
        }
      },
    );
  }
}

function pending() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function observed(promise) {
  let settled = false;
  const result = promise.then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  return { result, settled: () => settled };
}

for (const fault of [
  "missing",
  "null",
  "file-config",
  "extra",
  "symbol",
  "accessor",
  "nested-accessor",
  "key-extra",
  "key-symbol",
  "noncanonical-key",
  "missing-current",
  "too-many-keys",
  "wrong-kind",
  "same-location",
  "wrong-sas",
  "nonplain",
  "oversize",
]) {
  test("fresh replay strict admission refuses " + fault + " before restore effects", async () => {
    const fixture = await setup(),
      azure = azureBackupFixture();
    state.azure = azure;
    try {
      azure.ciphertext = Buffer.from(fixture.cipherBytes);
      fixture.options.storage = azure.storage("rl");
      const config = azureLedgerSettings();
      fixture.options.erasureReplay = config;
      if (fault === "missing") delete fixture.options.erasureReplay;
      if (fault === "null") fixture.options.erasureReplay = null;
      if (fault === "file-config")
        fixture.options.storage = { kind: "file", directory: join(fixture.local, "encrypted") };
      if (fault === "extra") config.extra = true;
      if (fault === "symbol") config[Symbol("private")] = true;
      if (fault === "accessor")
        Object.defineProperty(config, "prefix", {
          get() {
            assert.fail("getter invoked");
          },
        });
      if (fault === "nested-accessor")
        Object.defineProperty(config.encryptionKeyRing.keys, "ledger-old", {
          get() {
            assert.fail("key getter invoked");
          },
        });
      if (fault === "key-extra") config.encryptionKeyRing.extra = true;
      if (fault === "key-symbol") config.locatorKeyRing.keys[Symbol("private")] = true;
      if (fault === "noncanonical-key")
        config.encryptionKeyRing.keys["ledger-old"] = "x".repeat(44);
      if (fault === "missing-current") config.locatorKeyRing.currentKeyId = "absent";
      if (fault === "too-many-keys")
        config.locatorKeyRing.keys = Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => ["key" + i, Buffer.alloc(32, i).toString("base64")]),
        );
      if (fault === "wrong-kind") config.kind = "file";
      if (fault === "same-location") {
        config.containerUrl = fixture.options.storage.containerUrl;
        config.prefix = fixture.options.storage.prefix;
      }
      if (fault === "wrong-sas") config.sasToken = azure.storage("c").sasToken;
      if (fault === "nonplain") Object.setPrototypeOf(config, {});
      if (fault === "oversize") config.prefix = "a".repeat(98305);
      await assert.rejects(runPostgresRestore(fixture.options));
      assert.equal(state.clients.length, 0);
      assert.equal(state.calls.length, 0);
      assert.equal(azure.requests.length, 0);
      assert.ok([...fixture.options.keyRing.keys.values()].every((b) => b.every((x) => x === 7)));
    } finally {
      azure.dispose();
      state.azure = undefined;
      await fixture.dispose();
    }
  });
}

for (const fault of [
  "role",
  "identity",
  "tamper",
  "conflict",
  "oversized-page",
  "sql-result",
  "http-budget",
  "databaseName",
  "databaseOid",
  "restoreEpochHash",
  "reconciliationDigest",
  "replayedSubjectCount",
  "completedAt",
  "extra",
  "close",
]) {
  test("fresh replay refuses " + fault + " and retains a fenced target", async () => {
    const fixture = await setup(),
      azure = azureBackupFixture();
    state.azure = azure;
    try {
      azure.ciphertext = Buffer.from(fixture.cipherBytes);
      fixture.options.storage = azure.storage("rl");
      await configureLedger(fixture, azure, azureLedgerSettings(), {
        entry: !["oversized-page", "sql-result", "http-budget"].includes(fault),
        tamper: fault === "tamper",
        conflict: fault === "conflict",
      });
      if (["role", "identity", "oversized-page", "sql-result", "http-budget"].includes(fault))
        state.replayFault = fault;
      if (
        [
          "databaseName",
          "databaseOid",
          "restoreEpochHash",
          "reconciliationDigest",
          "replayedSubjectCount",
          "completedAt",
          "extra",
        ].includes(fault)
      ) {
        const values = {
          databaseName: "wrong_database",
          databaseOid: "777",
          restoreEpochHash: "0".repeat(64),
          reconciliationDigest: "0".repeat(64),
          replayedSubjectCount: "2",
          completedAt: new Date("2026-10-01T00:00:00.000Z"),
          extra: "PRIVATE-DRIFT",
        };
        state.replayDrift = { [fault]: values[fault] };
      }
      if (fault === "close")
        state.onEnd = async (client) => {
          if (client.config.application_name === "nutrition-postgres-replay")
            throw new Error("PRIVATE-CLOSE");
        };
      await assert.rejects(runPostgresRestore(fixture.options), (error) => {
        assert.ok(!String(error).includes("PRIVATE"));
        return true;
      });
      assert.equal(state.target.allowConnections, false);
      if (
        [
          "role",
          "identity",
          "tamper",
          "conflict",
          "oversized-page",
          "sql-result",
          "http-budget",
        ].includes(fault)
      ) {
        assert.deepEqual([...state.replayRows], [replayFirst, replaySecond]);
        assert.equal(state.persistedReplay, undefined);
      } else {
        assert.deepEqual([...state.replayRows], [replaySecond]);
        assert.ok(state.persistedReplay);
      }
      assert.ok(state.clients.every((c) => c.closed));
      assert.deepEqual(await fs.readdir(fixture.temporary), []);
      if (fault === "http-budget") assert.equal(azure.ledgerRequests.length, 4096);
      if (["role", "identity", "oversized-page", "sql-result"].includes(fault))
        assert.equal(azure.ledgerRequests.length, 0);
    } finally {
      azure.dispose();
      state.azure = undefined;
      await fixture.dispose();
    }
  });
}

test("fresh replay refuses exhausted shared work time before opening its owner", async () => {
  const fixture = await setup(),
    azure = azureBackupFixture();
  state.azure = azure;
  try {
    azure.ciphertext = Buffer.from(fixture.cipherBytes);
    fixture.options.storage = azure.storage("rl");
    await configureLedger(fixture, azure);
    state.onEnd = async (client) => {
      if (client.config.database !== "postgres") state.performanceOffset = 20000;
    };
    await assert.rejects(runPostgresRestore(fixture.options));
    assert.equal(
      state.clients.filter((c) => c.config.application_name === "nutrition-postgres-replay").length,
      0,
    );
    assert.equal(azure.ledgerRequests.length, 0);
    assert.equal(state.target.allowConnections, false);
  } finally {
    azure.dispose();
    state.azure = undefined;
    await fixture.dispose();
  }
});

test("fresh replay captures separate ledger settings and never clears caller strings", async () => {
  const fixture = await setup(),
    azure = azureBackupFixture();
  state.azure = azure;
  try {
    azure.ciphertext = Buffer.from(fixture.cipherBytes);
    fixture.options.storage = azure.storage("rl");
    const config = azureLedgerSettings(),
      before = JSON.stringify(config);
    await configureLedger(fixture, azure, config, { entry: true });
    let changed = false;
    state.beforeReplayQuery = async (text) => {
      if (!changed && text.startsWith("set role")) {
        changed = true;
        config.encryptionKeyRing.keys["ledger-old"] = "invalid";
        config.locatorKeyRing.keys["locator-old"] = "invalid";
        fixture.options.erasureReplay = null;
      }
    };
    const result = await runPostgresRestore(fixture.options);
    assert.equal(result.erasureReplay.replayedTombstones, 1);
    assert.equal(changed, true);
    assert.equal(config.sasToken, JSON.parse(before).sasToken);
    assert.equal(config.encryptionKeyRing.keys["ledger-old"], "invalid");
    assert.ok([...fixture.options.keyRing.keys.values()].every((b) => b.every((x) => x === 7)));
  } finally {
    azure.dispose();
    state.azure = undefined;
    await fixture.dispose();
  }
});

for (const phase of ["connect", "http", "readback", "close"])
  test("fresh replay cancellation awaits owned " + phase + " before refusal", async () => {
    const fixture = await setup(),
      azure = azureBackupFixture();
    state.azure = azure;
    const entered = pending(),
      gate = pending(),
      controller = new AbortController();
    let work;
    try {
      azure.ciphertext = Buffer.from(fixture.cipherBytes);
      fixture.options.storage = azure.storage("rl");
      await configureLedger(fixture, azure, azureLedgerSettings(), { entry: true });
      fixture.options.signal = controller.signal;
      if (phase === "connect")
        state.onConnect = (client) => {
          if (client.config.application_name === "nutrition-postgres-replay") {
            entered.resolve();
            return gate.promise.then(() => client);
          }
          return Promise.resolve(client);
        };
      if (phase === "http")
        state.beforeLedgerRequest = async () => {
          entered.resolve();
          await gate.promise;
        };
      if (phase === "readback")
        state.beforeReplayQuery = async (text) => {
          if (text.includes(' as "databaseName"')) {
            entered.resolve();
            await gate.promise;
          }
        };
      if (phase === "close")
        state.onEnd = async (client) => {
          if (client.config.application_name === "nutrition-postgres-replay") {
            entered.resolve();
            await gate.promise;
          }
        };
      work = observed(runPostgresRestore(fixture.options));
      await entered.promise;
      assert.equal(work.settled(), false);
      controller.abort(new Error("PRIVATE-CANCEL"));
      if (phase !== "readback") {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(work.settled(), false);
      }
      assert.equal(work.settled(), false);
      gate.resolve();
      const outcome = await work.result;
      assert.ok(outcome.error);
      assert.ok(!String(outcome.error).includes("PRIVATE-CANCEL"));
      assert.equal(state.target.allowConnections, false);
      assert.ok(state.clients.every((c) => c.closed));
      assert.deepEqual(await fs.readdir(fixture.temporary), []);
      if (["readback", "close"].includes(phase)) assert.ok(state.persistedReplay);
    } finally {
      gate.resolve();
      if (work) await work.result;
      azure.dispose();
      state.azure = undefined;
      await fixture.dispose();
    }
  });

test("Azure restore authenticates exact version then preserves fresh epoch and runtime fencing", async () => {
  const fixture = await setup("development");
  const azure = azureBackupFixture();
  state.azure = azure;
  try {
    azure.ciphertext = Buffer.from(fixture.cipherBytes);
    fixture.options.storage = azure.storage("rl");
    await configureLedger(fixture, azure);
    const result = await runPostgresRestore(fixture.options).catch((error) => {
      assert.deepEqual(state.pgErrors, []);
      throw state.restoreFailure ?? error;
    });
    assert.equal(result.sourceStorage, "azure-blob");
    assert.equal(result.operationalRecoveryAccepted, false);
    assert.equal(result.erasureReplayRequired, false);
    assert.deepEqual(
      [result.erasureReplay.scannedSubjects, result.erasureReplay.replayedTombstones],
      [2, 0],
    );
    assert.equal(result.applicationTrafficBlocked, true);
    assert.match(result.restoreEpoch, /^[0-9a-f]{64}$/u);
    assert.ok(
      azure.requests.some((r) => new URL(r.url).searchParams.get("versionid") === azure.version),
    );
    assert.ok(state.calls.every((c) => !JSON.stringify(c).includes("synthetic-backup-sas")));
    assert.equal(JSON.stringify(result).includes("synthetic-backup-sas"), false);
    assert.deepEqual(result.authenticatedBackup.metadata, fixture.metadata);
    assert.deepEqual(result.authenticatedBackup.readSource, {
      kind: "azure-blob-version",
      containerUrl: fixture.options.storage.containerUrl,
      prefix: fixture.options.storage.prefix,
      objectKey: fixture.metadata.objectKey,
      blobName: fixture.options.storage.prefix + fixture.metadata.objectKey,
      versionId: azure.version,
      contentLength: fixture.cipherBytes.length,
    });
    assert.ok(Object.isFrozen(result.authenticatedBackup.readSource));
    await settled(fixture);
  } finally {
    azure.dispose();
    state.azure = undefined;
    await fixture.dispose();
  }
});
for (const mode of [
  "tampered",
  "ambiguous",
  "denied",
  "wrong-target",
  "writer",
  "mixed",
  "timeout",
]) {
  test("Azure restore " + mode + " is rejected before native tools and SQL", async () => {
    const fixture = await setup();
    const azure = azureBackupFixture();
    state.azure = azure;
    try {
      azure.ciphertext = Buffer.from(fixture.cipherBytes);
      fixture.options.storage = azure.storage(mode === "writer" ? "c" : "rl");
      fixture.options.erasureReplay = azureLedgerSettings();
      if (mode === "tampered") azure.ciphertext[azure.ciphertext.length - 1] ^= 1;
      if (mode === "ambiguous") azure.ambiguous = true;
      if (mode === "denied") azure.denied = true;
      if (mode === "wrong-target") fixture.options.expectedBackup.deploymentTarget = "production";
      if (mode === "mixed") fixture.options.storage.directory = fixture.local;
      if (mode === "timeout") {
        azure.stalled = true;
        fixture.options.timeoutMs = 50;
      }
      await assert.rejects(runPostgresRestore(fixture.options), (error) => {
        assert.equal(String(error).includes("synthetic-backup-sas"), false);
        return true;
      });
      assert.equal(state.calls.length, 0);
      assert.equal(state.sql.length, 0);
      assert.equal(state.clients.length, 0);
      assert.deepEqual(await fs.readdir(fixture.temporary), []);
    } finally {
      azure.dispose();
      state.azure = undefined;
      await fixture.dispose();
    }
  });
}

for (const publicationFault of ["none", "evidence", "handoff", "late-close", "final-fence"])
  test(
    "protected CLI dispatch connects to actual Azure restore workflow: " + publicationFault,
    async () => {
      const fixture = await setup();
      const azure = azureBackupFixture({ hosted: true });
      state.azure = azure;
      try {
        const assembly = await syntheticOperatorAssemblyFixture(fixture.local);
        await configureLedger(fixture, azure, assembly.erasureReplay, { entry: true });
        state.publicationFault = publicationFault;
        state.outputWrites = 0;
        azure.ciphertext = Buffer.from(fixture.cipherBytes);
        const settings = {
          ...fixture.options,
          storage: azure.storage("rl"),
          keyRing: {
            currentKeyId: fixture.options.keyRing.currentKeyId,
            keys: Object.fromEntries(
              [...fixture.options.keyRing.keys].map(([id, value]) => [
                id,
                Buffer.from(value).toString("base64"),
              ]),
            ),
          },
        };
        const document = {
          schemaVersion: 1,
          assembly: assembly.binding,
          operation: "restore",
          restoreHandoffPath: join(fixture.local, "restore-handoff.json"),
          restoreEvidencePath: join(fixture.local, "restore-evidence.json"),
          notAfterUtc: new Date(Date.now() + 120000).toISOString(),
          settings,
        };
        const raw = JSON.stringify(document);
        const path = join(fixture.local, "operator.json");
        await fs.writeFile(path, raw, { mode: 0o600, flag: "wx" });
        const dispatched = runPostgresOperator([
          "restore",
          "--input",
          path,
          "--input-sha256",
          hash(raw),
        ]);
        if (publicationFault !== "none") {
          await assert.rejects(dispatched, (error) => {
            assert.ok(!String(error).includes("PRIVATE"));
            return true;
          });
          assert.ok(state.persistedReplay);
          assert.deepEqual([...state.replayRows], [replaySecond]);
          assert.equal(state.target.allowConnections, publicationFault !== "final-fence");
          // Completed restore permits its owner while denying runtime CONNECT.
          // Publication failure retains that fence; restore failure re-fences all connections.
          assert.ok(state.sql.some((entry) => entry.text.includes("pg_catalog.unnest")));
          assert.equal(
            state.sql.some((entry) => /^grant /iu.test(entry.text)),
            false,
          );
          assert.ok(state.clients.every((c) => c.closed));
          const evidence = await fs.readFile(document.restoreEvidencePath),
            handoff = await fs.readFile(document.restoreHandoffPath);
          if (publicationFault === "evidence") {
            assert.equal(evidence.length, 1);
            assert.equal(handoff.length, 0);
          }
          if (publicationFault === "handoff") {
            assert.equal(JSON.parse(evidence).result.erasureReplay.replayedTombstones, 1);
            assert.equal(handoff.length, 1);
          }
          if (publicationFault === "late-close") {
            assert.equal(JSON.parse(evidence).result.erasureReplay.replayedTombstones, 1);
            assert.equal(JSON.parse(handoff).result.erasureReplay.replayedTombstones, 1);
          }
          if (publicationFault === "final-fence") {
            assert.equal(evidence.length, 0);
            assert.equal(handoff.length, 0);
          }
          return;
        }
        const result = await dispatched.catch((error) => {
          assert.deepEqual(state.pgErrors, []);
          throw state.restoreFailure ?? error;
        });
        assert.equal(result.operation, "restore");
        assert.equal(result.result.sourceStorage, "azure-blob");
        assert.equal(result.result.operationalRecoveryAccepted, false);
        const handoffBytes = await fs.readFile(document.restoreHandoffPath);
        const handoff = JSON.parse(handoffBytes);
        const evidenceBytes = await fs.readFile(document.restoreEvidencePath);
        const retained = JSON.parse(evidenceBytes);
        assert.deepEqual(result.evidence, {
          path: document.restoreEvidencePath,
          bytes: evidenceBytes.length,
          sha256: hash(evidenceBytes),
        });
        assert.deepEqual(handoff.evidence, result.evidence);
        assert.equal(evidenceBytes.toString(), JSON.stringify(retained));
        assert.deepEqual(
          Buffer.from(retained.authenticatedBackup.manifestBase64, "base64"),
          fixture.manifestBytes,
        );
        assert.deepEqual(
          Buffer.from(retained.authenticatedBackup.sourceEvidenceBase64, "base64"),
          fixture.evidence,
        );
        assert.deepEqual(retained.authenticatedBackup.metadata, fixture.metadata);
        assert.deepEqual(retained.authenticatedBackup.readSource, {
          kind: "azure-blob-version",
          containerUrl: settings.storage.containerUrl,
          prefix: settings.storage.prefix,
          objectKey: fixture.metadata.objectKey,
          blobName: settings.storage.prefix + fixture.metadata.objectKey,
          versionId: azure.version,
          contentLength: fixture.cipherBytes.length,
        });
        assert.deepEqual(
          retained.result,
          Object.fromEntries(
            [
              "targetDatabase",
              "databaseOid",
              "restoreEpochHash",
              "erasureReplay",
              "sourceRevision",
              "manifestSha256",
              "sourceEvidenceSha256",
            ].map((k) => [k, result.result[k]]),
          ),
        );
        assert.equal(retained.inputSha256, hash(raw));
        assert.equal(retained.assemblySha256, assembly.binding.sha256);
        assert.equal(result.handoff.sha256, hash(handoffBytes));
        assert.equal(result.handoff.bytes, handoffBytes.length);
        assert.equal(result.result.restoreEpochHash, hash(handoff.result.restoreEpoch));
        assert.equal(result.result.status, "local-restore-replayed");
        assert.equal(result.result.erasureReplayRequired, false);
        assert.deepEqual(
          [
            result.result.erasureReplay.scannedSubjects,
            result.result.erasureReplay.replayedTombstones,
          ],
          [2, 1],
        );
        assert.deepEqual([...state.replayRows], [replaySecond]);
        assert.equal(state.persistedReplay.restore_epoch_hash, result.result.restoreEpochHash);
        assert.equal(
          state.persistedReplay.reconciliation_digest,
          result.result.erasureReplay.reconciliationDigest,
        );
        assert.equal(
          state.clients.filter((c) => c.config.application_name === "nutrition-postgres-replay")
            .length,
          1,
        );
        assert.ok(state.clients.every((c) => c.closed));
        assert.equal(
          azure.ledgerRequests.filter((r) => new URL(r.url).searchParams.get("comp") === "list")
            .length,
          4,
        );
        assert.equal(
          azure.ledgerRequests.filter((r) => new URL(r.url).searchParams.has("versionid")).length,
          1,
        );
        assert.equal(handoff.result.databaseOid, result.result.databaseOid);
        assert.equal(handoff.result.manifestSha256, settings.expectedBackup.manifestSha256);
        assert.equal(Object.hasOwn(result.result, "authenticatedBackup"), false);
        assert.equal(Object.hasOwn(handoff.result, "authenticatedBackup"), false);
        for (const forbidden of [
          "manifestBytes",
          "sourceEvidence",
          "metadata",
          "readSource",
          "synthetic-secret",
        ])
          assert.equal(Object.hasOwn(handoff.result, forbidden), false);
        assert.equal(JSON.stringify(result).includes(handoff.result.restoreEpoch), false);
        assert.equal(JSON.stringify(result).includes("synthetic-backup-sas"), false);
        assert.deepEqual(await fs.readdir(fixture.temporary), []);
      } finally {
        azure.dispose();
        state.azure = undefined;
        await fixture.dispose();
      }
    },
  );
