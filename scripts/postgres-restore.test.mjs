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
import test from "node:test";
import { rootCertificates } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const stateKey = Symbol.for("nutrition.test.localRestore");
const state = { registrations: 0 };
globalThis[stateKey] = state;
const root = fileURLToPath(new URL("../", import.meta.url));
const source = (name) => pathToFileURL(join(root, name)).href;
const dump = Buffer.from("PGDMP synthetic restore only");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const hooks = registerHooks({
  resolve(specifier, context, next) {
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
    if (specifier === "pg" && context.parentURL?.endsWith("/owned-postgres-session.ts"))
      return { url: "nutrition-test:pg", shortCircuit: true };
    if (
      specifier === "../packages/db/dist/index.js" &&
      context.parentURL?.includes("/scripts/postgres-restore")
    )
      return { url: "nutrition-test:db", shortCircuit: true };
    if (
      specifier === "../packages/artifact-store/dist/index.js" &&
      context.parentURL?.endsWith("/postgres-restore.mjs")
    )
      return { url: "nutrition-test:artifact", shortCircuit: true };
    if (
      context.parentURL?.includes("/packages/") &&
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
      "nutrition-test:db":
        "export * from " +
        JSON.stringify(source("packages/db/src/postgres-backup-connection.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/owned-postgres-session.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/restore.ts")) +
        ";",
      "nutrition-test:artifact":
        "export * from " +
        JSON.stringify(source("packages/artifact-store/src/artifact-encryption.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/artifact-store/src/postgres-backup.ts")) +
        ";",
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
          connect(){ return Promise.resolve(this); }
          query(query){
            this.active=query;
            (async()=>{
              const input=query.config; let result;
              result=await state.database(this,input);
              if(this.closed) return;
              for(const row of result.rows) query.emit("row",row);
              this.active=undefined; query.emit("end",{});
            })().catch((error)=>query.emit("error",error));
            return query;
          }
          end(){
            if(this.closed) return Promise.resolve();
            const ended=new Promise(r=>this.once("end",r)); this.socket.destroy();
            return ended.then(()=>{ if(state.mode==="target-close" && this.config.database!=="postgres") throw undefined; });
          }
        }`,
    };
    if (modules[url]) return { format: "module", source: modules[url], shortCircuit: true };
    if (url.endsWith("/scripts/postgres-restore.mjs"))
      return {
        format: "module",
        source: readFileSync(fileURLToPath(url), "utf8"),
        shortCircuit: true,
      };
    if (url.endsWith("/scripts/postgres-restore-drill.test.mjs")) {
      return {
        format: "module",
        source: readFileSync(fileURLToPath(url), "utf8") + "\nexport { sharedCollectorAdapter };",
        shortCircuit: true,
      };
    }
    if (url.startsWith("file:") && url.endsWith(".ts") && url.includes("/packages/")) {
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
state.fixture = sharedCollectorAdapter;
const { runPostgresRestore } = await import("./postgres-restore.mjs");
const { runTool } = await import("./postgres-operator-process.mjs");
const { EncryptedPostgresBackupStore, FileRawArtifactStore } = await import(
  "nutrition-test:artifact"
);
const { serializePostgresBackupEvidence } = await import("./postgres-backup-evidence.mjs");
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
      child.stdout.write((file.endsWith("psql") ? "psql" : "pg_restore") + " (PostgreSQL) 17.6\n");
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

async function setup() {
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
    spoolCloseFailed: false,
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
  const evidence = serializePostgresBackupEvidence(
    sharedCollectorAdapter().source,
    "nutrition_owner",
  );
  const manifest = {
    backupId: "a0000000-0000-4000-8000-000000000001",
    capturedAt: "2026-09-30T00:00:00.000Z",
    databaseName: "nutrition",
    deploymentTarget: "staging",
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
  const metadata = await store.publish({
    manifest: Buffer.from(JSON.stringify(manifest)),
    sourceEvidence: evidence,
    dump: Readable.from([dump]),
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
    artifactDirectory,
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
