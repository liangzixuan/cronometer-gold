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
import { PassThrough } from "node:stream";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const stateKey = Symbol.for("nutrition.test.localBackup");
const state = {
  children: [],
  clients: [],
  calls: [],
  signals: [],
  mode: "success",
  cleanupFailure: false,
  registrations: 0,
  fixture: undefined,
};
globalThis[stateKey] = state;
const root = fileURLToPath(new URL("../", import.meta.url));
const source = (name) => pathToFileURL(join(root, name)).href;
const dump = Buffer.from("PGDMP\x01\x10\x00\x04\x08\x01synthetic-dump-only");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function finishChild(child, code = 0) {
  if (child.nativeClosed) return;
  child.nativeClosed = true;
  if (state.mode === "missing-status") return;
  const message = { type: "status", exitCode: code, signal: null, spawnFailed: false };
  if (state.mode === "malformed-status") message.exitCode = "0";
  queueMicrotask(() => {
    child.emit("message", message);
    if (state.mode === "duplicate-status") child.emit("message", message);
  });
}
function closeSupervisor(child) {
  if (child.closed) return;
  if (!child.exited) {
    child.exited = true;
    child.emit("exit", null, "SIGKILL");
  }
  child.closed = true;
  child.stdout.end();
  child.stderr.end();
  queueMicrotask(() => child.emit("close", null, "SIGKILL"));
}
state.spawn = (executable, supervisorArgs, options) => {
  if (state.real) {
    const child = realSpawn(executable, supervisorArgs, options);
    child.closed = false;
    child.exited = false;
    child.once("exit", () => {
      child.exited = true;
    });
    state.children.push(child);
    state.calls.push({ executable, supervisorArgs, options });
    child.once("close", () => {
      child.closed = true;
    });
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
      const match = /READY:([0-9]+)/u.exec(text);
      if (match) state.descendantPid = Number(match[1]);
    });
    return child;
  }
  assert.equal(executable, process.execPath);
  assert.equal(supervisorArgs[0], "-e");
  const file = supervisorArgs[2];
  const args = supervisorArgs.slice(3);
  if (state.mode === "spawn-throw") throw undefined;
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 800000 + state.children.length,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    closed: false,
    exited: false,
    nativeClosed: false,
  });
  state.children.push(child);
  state.calls.push({ file, args, options });
  child.send = (message, done) => {
    assert.deepEqual(message, { type: "start" });
    done();
    queueMicrotask(() => {
      if (state.mode === "exit-before-close") {
        child.exited = true;
        child.emit("exit", 0, null);
        state.lateAbort();
        setTimeout(() => closeSupervisor(child), 20);
        return;
      }
      if (args[0] === "--version") {
        const kind = file.endsWith("pg_dump") ? "pg_dump" : "pg_restore";
        child.stdout.write(
          kind + " (PostgreSQL) " + (state.mode === "version" ? "17.7" : "17.6") + "\n",
        );
        finishChild(child);
        return;
      }
      if (args[0] === "--list") {
        assert.ok(state.clients.every((client) => client.closed));
        child.stdout.write("; synthetic TOC\n");
        finishChild(child, state.mode === "restore-failure" ? 1 : 0);
        return;
      }
      assert.ok(state.clients.some((client) => client.transaction));
      assert.ok(args.includes("--snapshot=00000003-000000A1-1"));
      if (["hold", "ignore-term", "kill-failure"].includes(state.mode)) return;
      if (state.mode === "stream-failure") {
        child.stdout.destroy(new Error("private raw child message"));
        return;
      }
      child.stdout.write(state.mode === "overflow" ? Buffer.alloc(1025) : dump);
      if (state.mode === "stderr-overflow") child.stderr.write(Buffer.alloc(65_537));
      finishChild(child, state.mode === "dump-failure" ? 2 : 0);
    });
  };
  queueMicrotask(() => child.emit("message", { type: "ready" }));
  return child;
};
state.kill = (pid, signal) => {
  state.signals.push({ pid, signal });
  const child = state.children.find((value) => value.pid === -pid);
  assert.ok(child, "signals only target a child created by this invocation");
  assert.equal(child.closed, false, "never signal a closed supervisor identity");
  assert.equal(child.exited, false, "never signal a reaped supervisor identity");
  if (state.real) return realKill(pid, signal);
  if (
    signal === "SIGKILL" &&
    ["abort-after-final-kill", "abort-after-final-kill-error"].includes(state.mode)
  ) {
    setTimeout(() => closeSupervisor(child), 20);
    queueMicrotask(() => state.lateAbort());
    if (state.mode === "abort-after-final-kill-error")
      throw new Error("synthetic final signal failure");
  } else if (signal === "SIGKILL") closeSupervisor(child);
  else {
    if (state.mode === "kill-failure") throw new Error("synthetic denied signal");
    if (state.mode !== "ignore-term") finishChild(child, 143);
  }
  return true;
};
state.readFile = async (path, ...args) => {
  const match = /^\/proc\/([0-9]+)\/stat$/u.exec(String(path));
  if (!state.real && match) {
    const child = state.children.find((value) => value.pid === Number(match[1]) && !value.closed);
    if (!child) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
    const fields = [
      "S",
      "1",
      String(child.pid),
      String(child.pid),
      ...Array(15).fill("0"),
      String(child.pid),
    ];
    return child.pid + " (synthetic-supervisor) " + fields.join(" ");
  }
  return fs.readFile(path, ...args);
};
state.readdir = async (path, ...args) =>
  !state.real && path === "/proc"
    ? state.children.filter((child) => !child.closed).map((child) => String(child.pid))
    : fs.readdir(path, ...args);
state.rm = async (...args) => {
  if (state.cleanupFailure && String(args[0]).includes("nutrition-pg-backup-")) throw null;
  return fs.rm(...args);
};

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
      (context.parentURL?.endsWith("/postgres-backup.mjs") ||
        context.parentURL?.endsWith("/postgres-operator-process.mjs"))
    )
      return { url: "nutrition-test:fs", shortCircuit: true };
    if (specifier === "pg" && context.parentURL?.endsWith("/owned-postgres-session.ts"))
      return { url: "nutrition-test:pg", shortCircuit: true };
    if (
      specifier === "../packages/db/dist/index.js" &&
      context.parentURL?.includes("/scripts/postgres-backup")
    )
      return { url: "nutrition-test:db", shortCircuit: true };
    if (
      specifier === "../packages/artifact-store/dist/index.js" &&
      context.parentURL?.endsWith("/postgres-backup.mjs")
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
    const prefix = 'const state = globalThis[Symbol.for("nutrition.test.localBackup")];';
    const modules = {
      "nutrition-test:skip-fixture-tests":
        prefix +
        "function skip(){ state.registrations++; } skip.skip=skip; skip.only=skip; skip.todo=skip; export default skip;",
      "nutrition-test:child": prefix + "export const spawn=(...args)=>state.spawn(...args);",
      "nutrition-test:process": prefix + "export const kill=(...args)=>state.kill(...args);",
      "nutrition-test:fs":
        prefix +
        'export * from "node:fs/promises"; export const rm=(...args)=>state.rm(...args); export const readFile=(...args)=>state.readFile(...args); export const readdir=(...args)=>state.readdir(...args);',
      "nutrition-test:db":
        "export * from " +
        JSON.stringify(source("packages/db/src/postgres-backup-connection.ts")) +
        "; export * from " +
        JSON.stringify(source("packages/db/src/owned-postgres-session.ts")) +
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
              if(input.text==="begin isolation level repeatable read read only"){ this.transaction=true; this.adapter.snapshot(); result={rows:[]}; }
              else if(input.text==="select pg_catalog.pg_export_snapshot()") result={rows:[["00000003-000000A1-1"]]};
              else {
                if(input.text==="rollback") this.transaction=false;
                result=await this.adapter.query(input);
              }
              if(this.closed) return;
              for(const row of result.rows) query.emit("row",row);
              this.active=undefined; query.emit("end",{});
            })().catch((error)=>query.emit("error",error));
            return query;
          }
          end(){ if(this.closed) return Promise.resolve(); const ended=new Promise(r=>this.once("end",r)); this.socket.destroy(); return ended; }
        }`,
    };
    if (modules[url]) return { format: "module", source: modules[url], shortCircuit: true };
    if (url.endsWith("/scripts/postgres-backup.mjs"))
      return {
        format: "module",
        source: readFileSync(fileURLToPath(url), "utf8") + "\nexport {runTool as testedRunTool};",
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
const { runPostgresBackup, testedRunTool } = await import("./postgres-backup.mjs");
const { EncryptedPostgresBackupStore, FileRawArtifactStore } = await import(
  "nutrition-test:artifact"
);
const { parsePostgresBackupEvidence } = await import("./postgres-backup-evidence.mjs");
hooks.deregister();

async function setup() {
  state.real = false;
  state.descendantPid = undefined;
  state.children = [];
  state.clients = [];
  state.calls = [];
  state.signals = [];
  state.mode = "success";
  state.cleanupFailure = false;
  const temporary = await fs.mkdtemp("/dev/shm/nutrition-backup-test-");
  const local = await fs.mkdtemp(join(tmpdir(), "nutrition-backup-test-"));
  await fs.chmod(temporary, 0o700);
  await fs.chmod(local, 0o700);
  const tools = {};
  for (const name of ["pg_dump", "pg_restore"]) {
    const path = join(local, name);
    const content = Buffer.from("synthetic tool identity " + name);
    await fs.writeFile(path, content, { mode: 0o700, flag: "wx" });
    tools[name === "pg_dump" ? "pgDump" : "pgRestore"] = {
      path,
      sha256: hash(content),
      version: name + " (PostgreSQL) 17.6",
    };
  }
  const outputDirectory = join(local, "ciphertext");
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  const options = {
    connection: {
      connectionString: "postgresql://nutrition_owner:synthetic-secret@database.test/nutrition",
      caCertificate: rootCertificates[0],
    },
    expectedOwner: "nutrition_owner",
    sourceRevision: "a".repeat(40),
    deploymentTarget: "staging",
    backupId: "a0000000-0000-4000-8000-000000000001",
    tmpfsRoot: temporary,
    outputDirectory,
    tools,
    keyRing: {
      purpose: "postgres_backup",
      currentKeyId: "synthetic",
      keys: new Map([["synthetic", Buffer.alloc(32, 7)]]),
    },
    maxDumpBytes: 1024,
    timeoutMs: 10_000,
  };
  return {
    options,
    temporary,
    local,
    async dispose() {
      state.cleanupFailure = false;
      await fs.rm(temporary, { recursive: true, force: true });
      await fs.rm(local, { recursive: true, force: true });
    },
  };
}

test("fixture loader registers no existing test bodies and performs no database work", () => {
  assert.ok(state.registrations >= 350);
  assert.equal(state.clients.length, 0);
  assert.equal(state.children.length, 0);
});

test("actual collector, encryption and create-only file adapter publish and recover a local backup", async () => {
  const fixture = await setup();
  try {
    const result = await runPostgresBackup(fixture.options);
    assert.equal(result.localOnly, true);
    assert.equal(result.manifest.dumpBytes, dump.byteLength);
    assert.equal(result.manifest.dumpSha256, hash(dump));
    assert.equal(result.manifest.snapshotId, "00000003-000000A1-1");
    assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
    assert.deepEqual(await fs.readdir(fixture.temporary), []);
    assert.ok(state.children.every((child) => child.closed));
    assert.ok(state.clients.every((client) => client.closed));
    const dumpCall = state.calls.find((call) => call.args.includes("--format=custom"));
    assert.deepEqual(dumpCall.args, [
      "--format=custom",
      "--compress=9",
      "--no-owner",
      "--no-privileges",
      "--no-password",
      "--snapshot=00000003-000000A1-1",
    ]);
    assert.equal(dumpCall.options.detached, true);
    assert.equal(dumpCall.options.shell, false);
    assert.equal(dumpCall.options.env.PGHOST, state.clients[0].config.host);
    assert.equal(dumpCall.options.env.PGPORT, String(state.clients[0].config.port));
    const store = new EncryptedPostgresBackupStore({
      rawStore: new FileRawArtifactStore(fixture.options.outputDirectory),
      keyRing: fixture.options.keyRing,
      temporaryDirectory: fixture.temporary,
      maxDumpBytes: 1024,
    });
    const recovered = await store.recover({
      ...result.manifest,
      manifestSha256: result.manifestSha256,
    });
    assert.ok(recovered);
    const parts = [];
    for await (const part of recovered.dump) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), dump);
    assert.deepEqual(
      parsePostgresBackupEvidence(recovered.sourceEvidence, "nutrition_owner"),
      sharedCollectorAdapter().source,
    );
    await recovered.dispose();
    assert.deepEqual(await fs.readdir(fixture.temporary), []);
    assert.equal(fixture.options.keyRing.keys.get("synthetic")[0], 7);
  } finally {
    await fixture.dispose();
  }
});

for (const mode of [
  "version",
  "dump-failure",
  "restore-failure",
  "overflow",
  "stderr-overflow",
  "stream-failure",
  "spawn-throw",
  "malformed-status",
  "duplicate-status",
  "missing-status",
]) {
  test("rejects " + mode + " and awaits all owned cleanup", async () => {
    const fixture = await setup();
    try {
      state.mode = mode;
      if (mode === "missing-status") fixture.options.timeoutMs = 200;
      await assert.rejects(runPostgresBackup(fixture.options), /PostgreSQL local backup/u);
      assert.deepEqual(await fs.readdir(fixture.temporary), []);
      assert.ok(state.children.every((child) => child.closed));
      assert.ok(state.clients.every((client) => client.closed));
      assert.equal(
        await fs
          .stat(
            join(
              fixture.options.outputDirectory,
              "postgres-backups/v2",
              fixture.options.sourceRevision,
              fixture.options.backupId + ".pgbackup.enc",
            ),
          )
          .then(
            () => true,
            () => false,
          ),
        false,
      );
    } finally {
      await fixture.dispose();
    }
  });
}

test("cancellation terminates only the owned process group and waits through forced kill", async () => {
  const fixture = await setup();
  try {
    state.mode = "ignore-term";
    const controller = new AbortController();
    const work = runPostgresBackup({ ...fixture.options, signal: controller.signal });
    const rejected = assert.rejects(work, /PostgreSQL local backup/u);
    while (!state.calls.some((call) => call.args.includes("--format=custom")))
      await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    assert.deepEqual(
      state.signals
        .filter((entry) => entry.pid === -state.children.at(-1).pid)
        .map((entry) => entry.signal),
      ["SIGTERM", "SIGKILL"],
    );
    assert.ok(
      state.signals.every((entry) => state.children.some((child) => entry.pid === -child.pid)),
    );
    assert.ok(state.children.every((child) => child.closed));
    assert.deepEqual(await fs.readdir(fixture.temporary), []);
  } finally {
    await fixture.dispose();
  }
});

test("child cleanup failure remains explicit after snapshot rollback and close", async () => {
  const fixture = await setup();
  try {
    state.mode = "kill-failure";
    const controller = new AbortController();
    const work = runPostgresBackup({ ...fixture.options, signal: controller.signal });
    const rejected = assert.rejects(work, (error) => {
      assert.ok(error instanceof AggregateError);
      const childError = error.errors[1];
      assert.ok(childError instanceof AggregateError);
      assert.equal(childError.errors[1].message, "PostgreSQL local backup child cleanup failed");
      assert.equal(JSON.stringify(error.errors).includes("synthetic denied signal"), false);
      return true;
    });
    while (!state.calls.some((call) => call.args.includes("--format=custom")))
      await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    assert.ok(state.children.every((child) => child.closed));
    assert.ok(state.clients.every((client) => client.closed));
    assert.deepEqual(await fs.readdir(fixture.temporary), []);
  } finally {
    await fixture.dispose();
  }
});

test("existing ciphertext survives duplicate publication", async () => {
  const fixture = await setup();
  try {
    const first = await runPostgresBackup(fixture.options);
    const path = join(fixture.options.outputDirectory, first.metadata.objectKey);
    const original = await fs.readFile(path);
    await assert.rejects(runPostgresBackup(fixture.options), /publication failed/u);
    assert.deepEqual(await fs.readFile(path), original);
    assert.deepEqual(await fs.readdir(fixture.temporary), []);
  } finally {
    await fixture.dispose();
  }
});

test("cleanup failure prevents success without deleting published ciphertext", async () => {
  const fixture = await setup();
  try {
    state.cleanupFailure = true;
    await assert.rejects(
      runPostgresBackup(fixture.options),
      (error) =>
        error instanceof AggregateError &&
        error.errors[0].message === "PostgreSQL local backup plaintext cleanup failed",
    );
    const path = join(
      fixture.options.outputDirectory,
      "postgres-backups/v2",
      fixture.options.sourceRevision,
      fixture.options.backupId + ".pgbackup.enc",
    );
    assert.ok((await fs.stat(path)).isFile());
  } finally {
    await fixture.dispose();
  }
});

test("falsey primary and cleanup failures remain distinct", async () => {
  const fixture = await setup();
  try {
    state.mode = "spawn-throw";
    state.cleanupFailure = true;
    await assert.rejects(runPostgresBackup(fixture.options), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        [
          "PostgreSQL local backup setup failed",
          "PostgreSQL local backup plaintext cleanup failed",
        ],
      );
      return true;
    });
  } finally {
    await fixture.dispose();
  }
});

for (const change of ["digest", "symlink", "non-tmpfs", "public-root", "pre-abort"]) {
  test("rejects unsafe operator placement or admission " + change, async () => {
    const fixture = await setup();
    try {
      const options = { ...fixture.options };
      if (change === "digest")
        options.tools = {
          ...options.tools,
          pgDump: { ...options.tools.pgDump, sha256: "0".repeat(64) },
        };
      if (change === "symlink") {
        const link = join(fixture.local, "link");
        await fs.symlink(options.tmpfsRoot, link);
        options.tmpfsRoot = link;
      }
      if (change === "non-tmpfs") options.tmpfsRoot = fixture.local;
      if (change === "public-root") await fs.chmod(options.tmpfsRoot, 0o755);
      if (change === "pre-abort") options.signal = AbortSignal.abort();
      await assert.rejects(runPostgresBackup(options), /PostgreSQL local backup/u);
      assert.equal(state.clients.length, 0);
      assert.equal(state.children.length, 0);
    } finally {
      await fixture.dispose();
    }
  });
}

async function liveIdentity(pid) {
  try {
    const text = await fs.readFile("/proc/" + pid + "/stat", "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      group: Number(fields[2]),
      session: Number(fields[3]),
      start: fields[19],
      state: fields[0],
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    throw error;
  }
}
const running = (identity) => identity && !["Z", "X"].includes(identity.state);

for (const mode of ["cancel", "normal"]) {
  test("real owned supervisor terminates a TERM-resistant descendant after native leader " + mode, {
    timeout: 15_000,
  }, async () => {
    const fixture = await setup();
    state.real = true;
    const controller = new AbortController();
    let supervisor, descendant, work;
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      controller.abort();
      const child = state.children[0];
      if (child && !child.closed) realKill(-child.pid, "SIGKILL");
    }, 8_000);
    try {
      const nodePath = await fs.realpath(process.execPath);
      const childCode =
        "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);";
      const leaderCode = [
        "const{spawn}=require('node:child_process');",
        "const child=spawn(process.execPath,['-e'," +
          JSON.stringify(childCode) +
          "],{stdio:['ignore','ignore','ignore','ipc']});",
        "process.on('SIGTERM',()=>process.exit(0));",
        "child.once('message',()=>{console.log('READY:'+child.pid);" +
          (mode === "normal" ? "process.exit(0);" : "") +
          "});",
        "setInterval(()=>{},1000);",
      ].join("");
      let settled = false,
        rejected = false;
      work = testedRunTool(
        { path: nodePath, sha256: hash(await fs.readFile(nodePath)) },
        ["-e", leaderCode],
        {
          signal: controller.signal,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          directory: fixture.temporary,
          limit: 1024,
        },
      ).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
          rejected = true;
        },
      );
      while (!state.descendantPid && !settled)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(state.descendantPid);
      supervisor = await liveIdentity(state.children[0].pid);
      descendant = await liveIdentity(state.descendantPid);
      if (mode === "cancel") {
        assert.ok(running(supervisor) && running(descendant));
        assert.equal(descendant.group, supervisor.pid);
        assert.equal(descendant.session, supervisor.pid);
        controller.abort();
      }
      await work;
      assert.equal(watchdogFired, false, "operator cleanup completes without fallback cleanup");
      assert.equal(rejected, mode === "cancel");
      assert.equal(running(await liveIdentity(state.descendantPid)) || false, false);
      assert.ok(state.children.every((child) => child.closed));
      assert.deepEqual(
        state.signals.map((entry) => entry.signal),
        mode === "cancel" ? ["SIGTERM", "SIGKILL"] : ["SIGKILL"],
      );
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      const child = state.children[0];
      if (child && !child.closed) realKill(-child.pid, "SIGKILL");
      await work;
      const remaining = descendant && (await liveIdentity(descendant.pid));
      if (
        running(remaining) &&
        remaining.start === descendant.start &&
        remaining.group === descendant.group
      )
        realKill(descendant.pid, "SIGKILL");
      for (
        let attempt = 0;
        attempt < 100 && running(await liveIdentity(state.descendantPid));
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(running(await liveIdentity(state.descendantPid)) || false, false);
      state.real = false;
      await fixture.dispose();
    }
  });
}

for (const mode of [
  "exit-before-close",
  "abort-after-final-kill",
  "abort-after-final-kill-error",
]) {
  test("signal guard refuses late sends for " + mode, async () => {
    const fixture = await setup();
    const controller = new AbortController();
    state.mode = mode;
    state.lateAbort = () => controller.abort();
    try {
      await assert.rejects(
        testedRunTool(fixture.options.tools.pgDump, ["--version"], {
          signal: controller.signal,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          directory: fixture.temporary,
          limit: 1024,
        }),
        (error) => {
          if (mode !== "abort-after-final-kill") assert.ok(error instanceof AggregateError);
          return true;
        },
      );
      assert.deepEqual(
        state.signals.map((entry) => entry.signal),
        mode === "exit-before-close" ? [] : ["SIGKILL"],
      );
      assert.ok(state.children.every((child) => child.exited && child.closed));
    } finally {
      state.lateAbort = undefined;
      await fixture.dispose();
    }
  });
}
