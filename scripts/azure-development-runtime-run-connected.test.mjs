import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, readdir as realReaddir, statfs as realStatfs } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { kill as realKill } from "node:process";
import test from "node:test";
import { setTimeout as realDelay } from "node:timers/promises";
import { parseEnv } from "node:util";

import { runtimeClockFixture } from "./azure-development-runtime-clock-fixture.mjs";

let active;
const nativePerformance = globalThis.performance;
const nativeMonotonic = nativePerformance.now.bind(nativePerformance);
let holdOffset = 0;
let clientOffset = 0;
const restoreSourceClock = runtimeClockFixture({ offset: () => clientOffset });
test.after(restoreSourceClock);
globalThis.runtimeControllerHoldDelay = async (milliseconds, value, options) => {
  if (active?.options.clientAccess) {
    options.signal.throwIfAborted();
    assert(Number.isInteger(milliseconds) && milliseconds > 0 && milliseconds <= 30_000);
    const journal = await active.journal();
    assert(
      journal.complete && journal.records.some((row) => row.event.phase === "journey-readback"),
    );
    active.clientDelays ??= [];
    active.clientDelays.push(milliseconds);
    clientOffset += milliseconds;
    await realDelay(0, undefined, options);
    return value;
  }
  if (!active?.options.maximumHold) return realDelay(milliseconds, value, options);
  options.signal.throwIfAborted();
  assert(Number.isInteger(milliseconds) && milliseconds > 0 && milliseconds <= 15_000);
  const journal = await active.journal();
  assert(journal.complete);
  assert(journal.records.some((row) => row.event.phase === "journey-readback"));
  active.hold ??= { delays: [], firstSequence: journal.records.length };
  active.hold.delays.push(milliseconds);
  holdOffset += milliseconds;
  await realDelay(0, undefined, options);
  return value;
};
globalThis.runtimeRunPool = class {
  constructor(options) {
    this.options = options;
    this.principal = new URL(options.connectionString).username;
    this.closed = false;
    active.pools.push(this);
  }
  async connect() {
    const pool = this;
    active.nextConnectionId = (active.nextConnectionId ?? 0) + 1;
    const connectionId = active.nextConnectionId;
    return {
      async query(sql, values = []) {
        assert(!pool.closed);
        active.queries.push({ sql, values, principal: pool.principal, connectionId });
        if (active.options.seedUntilAssembly) {
          if (
            sql.startsWith("insert into ") &&
            !sql.startsWith('insert into "database_restore_attestation"') &&
            !active.seedClaimed
          ) {
            const journal = await active.journal();
            assert(
              journal.complete &&
                journal.records.some((row) => row.event.phase === "catalogue-seed-intent"),
            );
            active.seedClaimed = true;
          }
          if (sql.startsWith("grant ") && !active.grantsClaimed) {
            const journal = await active.journal();
            assert(
              journal.complete &&
                journal.records.some((r) => r.event.phase === "database-grants-intent"),
            );
            active.grantsClaimed = true;
          }
          try {
            return await active.sql.query(sql, values, pool.principal, connectionId);
          } catch (error) {
            active.queryFailures ??= [];
            active.queryFailures.push({ sql, error: error.message });
            throw error;
          }
        }
        assert(sql.includes("pg_stat_ssl"), `Unexpected SQL: ${sql}`);
        return {
          rows: [
            {
              databaseName: active.options.missingIssuerGrant
                ? active.input.database.databaseName
                : "unrelated_database",
              databaseOid: "12345",
              owner: active.input.database.owner,
              principal: active.input.database.owner,
              schema: "public",
              tls: true,
              tlsVersion: "TLSv1.3",
            },
          ],
          rowCount: 1,
          command: "SELECT",
        };
      },
      release() {},
    };
  }
  async end() {
    this.closed = true;
  }
};
globalThis.runtimeOperatorClient = class extends EventEmitter {
  constructor(config) {
    super();
    active.operator.makeClient(config, this);
  }
};
globalThis.runtimeApiHttpsRequest = (...args) => active.api.sendMail(...args);
globalThis.runtimeOperatorQuery = class extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
  }
};
globalThis.runtimeOperatorSpawn = (exe, args, options) =>
  active?.operator?.owns(args)
    ? active.operator.spawn(exe, args, options)
    : realSpawn(exe, args, options);
globalThis.runtimeOperatorKill = (pid, signal) =>
  active?.operator?.children.some((c) => c.pid === -pid)
    ? active.operator.kill(pid, signal)
    : realKill(pid, signal);
globalThis.runtimeOperatorRead = (...args) =>
  active?.operator ? active.operator.processFile(...args) : readFile(...args);
globalThis.runtimeOperatorDirectory = (...args) =>
  active?.operator ? active.operator.processDirectory(...args) : realReaddir(...args);
globalThis.runtimeOperatorStatfs = async (path, ...args) => {
  const actual = await realStatfs(path, ...args);
  if (
    active?.operator &&
    (path === join(active.input.root, "tmpfs") ||
      path.startsWith(join(active.input.root, "tmpfs") + "/nutrition-pg-"))
  )
    return { ...actual, type: typeof actual.type === "bigint" ? 0x01021994n : 0x01021994 };
  return actual;
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "node:timers/promises" &&
      context.parentURL?.endsWith("/azure-development-runtime-run.mjs")
    )
      return {
        url: `data:text/javascript,${encodeURIComponent('export * from "node:timers/promises";export const setTimeout=(...args)=>globalThis.runtimeControllerHoldDelay(...args);')}`,
        shortCircuit: true,
      };
    if (
      specifier === "node:https" &&
      context.parentURL?.endsWith("/apps/api/dist/modules/auth/email-delivery.js")
    )
      return {
        url: `data:text/javascript,${encodeURIComponent('export * from "node:https";export const request=(...args)=>globalThis.runtimeApiHttpsRequest(...args);')}`,
        shortCircuit: true,
      };
    if (
      specifier === "node:fs/promises" &&
      ["/postgres-backup.mjs", "/postgres-restore.mjs"].some((name) =>
        context.parentURL?.endsWith(name),
      )
    )
      return {
        url: `data:text/javascript,${encodeURIComponent('export * from "node:fs/promises";export const statfs=(...args)=>globalThis.runtimeOperatorStatfs(...args);')}`,
        shortCircuit: true,
      };
    if (
      specifier === "pg" &&
      context.parentURL?.endsWith("/packages/db/dist/owned-postgres-owner.js")
    )
      return {
        url: "data:text/javascript,export const Client=globalThis.runtimeOperatorClient;export const Query=globalThis.runtimeOperatorQuery;",
        shortCircuit: true,
      };
    if (context.parentURL?.endsWith("/postgres-operator-process.mjs")) {
      const source =
        specifier === "node:child_process"
          ? "export const spawn=globalThis.runtimeOperatorSpawn;"
          : specifier === "node:process"
            ? "export const kill=globalThis.runtimeOperatorKill;"
            : specifier === "node:fs/promises"
              ? 'export * from "node:fs/promises";export const readFile=(...args)=>globalThis.runtimeOperatorRead(...args);export const readdir=(...args)=>globalThis.runtimeOperatorDirectory(...args);'
              : null;
      if (source)
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    if (specifier === "pg" && context.parentURL?.endsWith("/packages/db/dist/client.js"))
      return {
        url: "data:text/javascript,export const Pool = globalThis.runtimeRunPool;",
        shortCircuit: true,
      };
    if (specifier === "@azure/core-rest-pipeline") {
      const real = next(specifier, context);
      globalThis.runtimeRunAzureCoreUrl = real.url;
      return {
        url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real.url)}; export const createDefaultHttpClient=()=>({sendRequest:request=>globalThis.runtimeRunAzureSend(request)});`)}`,
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
globalThis.runtimeRunAzureSend = async (request) => {
  if (
    active.operator &&
    new URL(request.url).origin ===
      new URL(active.operator.storage.storage("rl").containerUrl).origin &&
    new URL(request.url).pathname.startsWith("/nourishing-development-backup")
  ) {
    const { createHttpHeaders } = await import(globalThis.runtimeRunAzureCoreUrl);
    return active.operator.storage.send(request, createHttpHeaders);
  }
  return active.wire.sendRequest(request);
};
const { runtimeRunFixture } = await import("./azure-development-runtime-run-fixture.mjs");
const { runPreparedDevelopmentRuntime } = await import("./azure-development-runtime-run.mjs");
test.after(() => {
  hook.deregister();
  delete globalThis.runtimeControllerHoldDelay;
  delete globalThis.runtimeRunPool;
  delete globalThis.runtimeApiHttpsRequest;
  delete globalThis.runtimeRunAzureSend;
  delete globalThis.runtimeRunAzureCoreUrl;
  for (const name of [
    "runtimeOperatorClient",
    "runtimeOperatorQuery",
    "runtimeOperatorSpawn",
    "runtimeOperatorKill",
    "runtimeOperatorRead",
    "runtimeOperatorDirectory",
    "runtimeOperatorStatfs",
  ])
    delete globalThis[name];
});

test("connected controller admits actual prepared inputs and current validators, migrates twice, rejects wrong SQL target and stops all durable owned IDs", async (t) => {
  const f = await runtimeRunFixture(t);
  active = f;
  assert.deepEqual(
    { ...parseEnv(await readFile(join(f.input.root, "config/maintenance.env"), "utf8")) },
    f.config.ownerEnvironment,
  );
  let failure;
  try {
    await runPreparedDevelopmentRuntime(f.args, f.execution);
  } catch (error) {
    failure = error;
  }
  assert(failure);
  assert.equal(
    f.queries.length,
    1,
    JSON.stringify(
      failure.errors?.map((error) => ({ message: error.message, stack: error.stack })),
    ),
  );
  assert.deepEqual(f.starts, [
    "postgres",
    "meilisearch",
    "internal-tls",
    "capture",
    "migrate",
    "migrate",
  ]);
  assert(!f.starts.includes("api") && !f.starts.includes("worker"));
  assert.deepEqual(f.stops, ["capture", "internal-tls", "meilisearch", "postgres"]);
  assert(Object.values(f.observed.containers).every((row) => row.State.Running === false));
  assert(f.pools.every((pool) => pool.closed));
  assert(f.prepared.opened.every((fd) => fd.closed));
  const journal = await f.journal();
  assert(journal.complete);
  assert.equal(journal.records.at(-1).event.phase, "native-resources-stopped");
  assert.equal(journal.records.at(-1).event.nativeStopSucceeded, true);
  assert.equal(journal.records.at(-1).event.runtimeAcceptanceRecorded, false);
  assert(!journal.records.some((row) => row.event.phase === "database-target-bound"));
});

for (const option of ["wrongSource", "dirtySource", "unknownCreate"])
  test(`connected controller ${option} cannot start an application or invent cleanup ownership`, async (t) => {
    const f = await runtimeRunFixture(t, { [option]: true });
    active = f;
    await assert.rejects(runPreparedDevelopmentRuntime(f.args, f.execution));
    assert.equal(f.starts.length, 0);
    assert.equal(f.stops.length, 0);
    assert.equal(f.queries.length, 0);
    assert(f.prepared.opened.every((fd) => fd.closed));
    if (option === "unknownCreate")
      assert(f.created(), "Test must reach the actual controlled create boundary");
    const journal = await f.journal();
    assert(journal.complete);
    assert(!journal.records.some((row) => row.event.phase === "native-resources-stopped"));
  });

test("one refused owned stop cannot skip other durable IDs or produce native-stop success", async (t) => {
  const f = await runtimeRunFixture(t, { stopFailure: "capture" });
  active = f;
  await assert.rejects(runPreparedDevelopmentRuntime(f.args, f.execution));
  assert.equal(f.queries.length, 1);
  assert.deepEqual(f.stops, ["capture", "internal-tls", "meilisearch", "postgres"]);
  const journal = await f.journal();
  assert(journal.complete);
  assert.equal(journal.records.at(-1).event.nativeStopSucceeded, false);
  assert(journal.records.at(-1).event.cleanupErrorCount > 0);
  assert(f.prepared.opened.every((fd) => fd.closed));
});

test("connected actual SDK canary passes before unchanged issuer rejects a missing worker grant", async (t) => {
  const f = await runtimeRunFixture(t, { missingIssuerGrant: true });
  active = f;
  await assert.rejects(runPreparedDevelopmentRuntime(f.args, f.execution));
  assert.deepEqual(
    f.starts,
    [
      "postgres",
      "meilisearch",
      "internal-tls",
      "capture",
      "migrate",
      "migrate",
      "azure-canary",
      "search-bootstrap",
    ],
    JSON.stringify(f.serviceErrors.map((e) => ({ message: e.message, stack: e.stack }))),
  );
  const canary = f.serviceOutputs.get("azure-canary");
  assert(canary, "Actual canary must complete before the issuer rejection");
  const events = canary
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  assert.equal(events.length, 2);
  assert.equal(events[0].canaryId, events[1].canaryId);
  assert(
    events[1].exportCleanupVerified &&
      events[1].ledgerVersionVerified &&
      events[1].ledgerCanaryRetained,
  );
  assert(f.wire.requests.length > 20);
  assert.equal(f.wire.objects.size, 1);
  assert([...f.wire.objects.keys()][0].includes("nourishingledger."));
  assert(f.wire.issuerRequests.some(([method, path]) => method === "GET" && path === "/indexes"));
  assert(f.serviceErrors.some((error) => error.name === "ScopedMeiliKeysError"));
  assert.deepEqual(f.stops, ["capture", "internal-tls", "meilisearch", "postgres"]);
  assert(f.pools.every((pool) => pool.closed));
  assert(f.prepared.opened.every((fd) => fd.closed));
  const journal = await f.journal();
  assert(journal.complete);
  assert(
    !journal.records.some((row) =>
      ["database-grants-intent", "catalogue-ready", "journey-written"].includes(row.event.phase),
    ),
  );
  assert.equal(journal.records.at(-1).event.nativeStopSucceeded, true);
});

test("raw synthetic wire supports actual SDK canary and complete current issuer canaries", async (t) => {
  const f = await runtimeRunFixture(t);
  active = f;
  const result = await f.wire.run("azure-canary", new AbortController().signal);
  assert.equal(JSON.parse(result.trim().split("\n").at(-1)).exportCleanupVerified, true);
  assert.equal(f.wire.objects.size, 1);
  assert.equal(await f.wire.run("search-bootstrap", new AbortController().signal), "");
  assert(f.wire.issuerRequests.length >= 9);
  assert.equal(f.calls.length, 0);
});

test("connected owner seed and TLS transport rebuild finish before wrong assembly source refuses recovery", async (t) => {
  const f = await runtimeRunFixture(t, { seedUntilAssembly: true });
  active = f;
  let failure;
  try {
    await runPreparedDevelopmentRuntime(f.args, f.execution);
  } catch (error) {
    failure = error;
  }
  assert(failure);
  const journal = await f.journal();
  assert(journal.complete);
  const ready = journal.records.find((row) => row.event.phase === "catalogue-ready");
  assert(
    ready,
    JSON.stringify({
      errors: failure.errors?.map((error) => ({ message: error.message, stack: error.stack })),
      lastQuery: f.queries.at(-1),
      lastHttp: f.meili.requests.at(-1),
    }),
  );
  assert.equal(ready.event.catalogue.coreNutrients.length, 15);
  assert.equal(ready.event.catalogue.servings.length, 2);
  assert(f.sql.eligible() && f.sql.acknowledged());
  assert.equal(f.sql.tables.get("nutrient").length, 15);
  assert.equal(f.meili.indexes.size, 1);
  assert.equal(f.meili.indexes.get("foods").length, 1);
  assert.equal(f.meili.indexes.get("foods")[0].name, "Blueberries (synthetic sample)");
  assert(f.meili.requests.some(([method, path]) => method === "POST" && path === "/swap-indexes"));
  assert(
    journal.records.some(
      (row) => row.event.phase === "assembly-source" && row.event.completed === true,
    ),
  );
  assert(
    !journal.records.some((row) =>
      ["assembly-prepare", "backup-intent", "database-grants-intent", "journey-written"].includes(
        row.event.phase,
      ),
    ),
  );
  assert(!f.starts.includes("api") && !f.starts.includes("worker"));
  assert.deepEqual(f.stops, ["capture", "internal-tls", "meilisearch", "postgres"]);
  assert(f.pools.every((pool) => pool.closed));
  assert(f.prepared.opened.every((fd) => fd.closed));
  assert.equal(journal.records.at(-1).event.nativeStopSucceeded, true);
});

test("raw SQL and Node HTTP wire supports the actual complete owner seed and rebuild", async (t) => {
  const f = await runtimeRunFixture(t, { seedUntilAssembly: true });
  active = f;
  const { createDatabase } = await import("../packages/db/dist/index.js");
  const { seedDevelopmentRuntimeCatalogue } = await import(
    "./azure-development-runtime-maintenance.mts"
  );
  const { createDevelopmentRuntimeHttp } = await import("./azure-development-runtime-http.mjs");
  const signal = new AbortController().signal;
  const database = createDatabase({
    connectionString: f.config.ownerEnvironment.DATABASE_URL,
    applicationName: "synthetic-controller-seed-wire",
    maxConnections: 1,
    ssl: { ca: f.config.input.caCertificate, rejectUnauthorized: true, minVersion: "TLSv1.2" },
  });
  const http = createDevelopmentRuntimeHttp(
    {
      ca: f.config.input.caCertificate,
      addresses: { api: "172.28.0.5", capture: "172.29.0.2", meili: "172.28.0.4" },
      notAfterUtc: new Date(Date.now() + 60000).toISOString(),
      signal,
      assertOwnership: async () => {},
    },
    f.execution.http,
  );
  try {
    const result = await seedDevelopmentRuntimeCatalogue({
      database,
      expectedTarget: {
        databaseName: f.input.database.databaseName,
        databaseOid: "12345",
        expectedOwner: f.input.database.owner,
      },
      searchKeys: { search: "a".repeat(64), worker: "b".repeat(64), observer: "c".repeat(64) },
      http,
      spoolDirectory: join(f.input.root, "data/erasure-replay-spool"),
      notAfterUtc: new Date(Date.now() + 60000).toISOString(),
      signal,
      onMutationStart: async () => {
        assert(!f.seedClaimed);
        f.seedClaimed = true;
      },
    });
    assert.equal(result.coreNutrients.length, 15);
    assert.equal(result.servings.length, 2);
    assert(f.sql.eligible() && f.sql.acknowledged());
    assert.equal(f.meili.indexes.get("foods").length, 1);
    assert.equal(f.calls.length, 0);
  } finally {
    await database.destroy();
  }
});

test("raw acquisition observations feed actual current assembly prepare and independent qualify", async (t) => {
  const { runtimeDockerFixture } = await import("./azure-development-runtime-fixture.mjs");
  const { runtimeAssemblyFixture } = await import(
    "./azure-development-runtime-assembly-fixture.mjs"
  );
  const { createHash } = await import("node:crypto");
  const { homedir } = await import("node:os");
  const base = await runtimeDockerFixture(t, { parent: homedir() }),
    assembly = await runtimeAssemblyFixture(base.root);
  const output = join(base.root, "recovery/prepared-bundle.json"),
    now = new Date().toISOString();
  const args = [
    assembly.assemblyInput.path,
    assembly.assemblyInput.sha256,
    assembly.contextSource,
    assembly.assemblySource,
    now,
    new Date(Date.now() + 900000).toISOString(),
    output,
  ];
  const prepared = JSON.parse(await assembly.command(["prepare", ...args]));
  const bytes = await readFile(output),
    digest = createHash("sha256").update(bytes).digest("hex");
  const qualified = JSON.parse(await assembly.command(["qualify", ...args, digest]));
  assert.deepEqual(qualified, prepared);
  assert.equal(qualified.bundle_sha256, digest);
  assert.equal(qualified.operationalAcceptance, false);
  assert.equal(qualified.component_count, 0);
  assert.equal(assembly.applies(), 1);
  const bundle = JSON.parse(bytes);
  assert.equal(bundle.source_revision, "a".repeat(40));
  assert.equal(bundle.kind, "nutrition-storage-recovery-assembly-v1");
  assert.equal(bundle.admitted_components.length, 0);
});

test("connected seed and regenerated assembly reach the actual protected operator before invalid native tools refuse backup", async (t) => {
  const f = await runtimeRunFixture(t, { seedUntilAssembly: true, validAssembly: true });
  active = f;
  await assert.rejects(runPreparedDevelopmentRuntime(f.args, f.execution));
  const journal = await f.journal();
  assert(journal.complete);
  assert(journal.records.some((row) => row.event.phase === "catalogue-ready"));
  const qualified = journal.records.find(
    (row) => row.event.phase === "assembly-qualify" && row.event.completed === true,
  );
  assert(
    qualified,
    JSON.stringify(
      journal.records
        .filter((row) =>
          ["runtime-command-unconfirmed", "assembly-source", "assembly-prepare"].includes(
            row.event.phase,
          ),
        )
        .map((row) => row.event),
    ),
  );
  assert.equal(JSON.parse(qualified.event.stdout).component_count, 0);
  assert(journal.records.some((row) => row.event.phase === "backup-intent"));
  const failure = journal.records.find(
    (row) =>
      row.event.phase === "runtime-command-unconfirmed" &&
      row.event.attemptedPhase === "postgres-backup",
  );
  assert(failure, "Actual protected Node operator command must reject the invalid native-tool set");
  assert(
    Buffer.from(failure.event.stderr, "base64")
      .toString()
      .includes("PostgreSQL operator failed; publication or a fenced target may remain"),
  );
  assert(
    !journal.records.some((row) =>
      ["database-grants-intent", "journey-written"].includes(row.event.phase),
    ),
  );
  assert(!f.starts.includes("api") && !f.starts.includes("worker"));
  assert.deepEqual(f.stops, ["capture", "internal-tls", "meilisearch", "postgres"]);
  assert(f.pools.every((pool) => pool.closed));
  assert(f.prepared.opened.every((fd) => fd.closed));
  assert.equal(journal.records.at(-1).event.nativeStopSucceeded, true);
});

test("connected protected recovery encrypts seeded observations and restores authenticated bytes before runtime grants", async (t) => {
  const f = await runtimeRunFixture(t, {
    seedUntilAssembly: true,
    validAssembly: true,
    validOperator: true,
  });
  active = f;
  let failure;
  try {
    await runPreparedDevelopmentRuntime(f.args, f.execution);
  } catch (error) {
    failure = error;
  }
  const journal = await f.journal();
  assert(
    journal.records.some((r) => r.event.phase === "postgres-backup" && r.event.completed === true),
    JSON.stringify({
      errors: f.operator.errors.map((e) => e.message),
      last: journal.records
        .filter((r) =>
          [
            "runtime-command-unconfirmed",
            "postgres-backup",
            "postgres-restore",
            "backup-intent",
            "restore-intent",
          ].includes(r.event.phase),
        )
        .map((r) => ({
          phase: r.event.phase,
          completed: r.event.completed,
          attemptedPhase: r.event.attemptedPhase,
        })),
      native: f.operator.native.map((c) => ({ file: c.file, args: c.args })),
      children: f.operator.children.map((c) => ({
        pid: c.pid,
        closed: c.closed,
        exited: c.exited,
      })),
      queries: f.operator.queries.slice(-5),
      failure: failure?.errors?.map((e) => e.message) ?? failure?.message,
    }),
  );
  const restored = journal.records.find(
    (r) => r.event.phase === "postgres-restore" && r.event.completed === true,
  );
  assert(
    restored,
    JSON.stringify({
      errors: f.operator.errors.map((e) => e.message),
      native: f.operator.native.map((c) => ({ file: c.file, args: c.args })),
      targetQueries: f.operator.queries
        .filter((q) => q.database.startsWith("nutrition_restore_"))
        .slice(-12)
        .map((q) => ({ text: q.text.slice(0, 130), values: q.values })),
      clients: f.operator.clients.map((c) => ({
        database: c.config.database,
        application: c.config.application_name,
        closed: c.closed,
      })),
      queries: f.operator.queries.slice(-5),
      failure:
        failure?.errors?.map((e) => ({ message: e.message, stack: e.stack })) ?? failure?.message,
      receipts: journal.records
        .filter((r) => r.event.phase === "postgres-backup" && r.event.completed)
        .map((r) => JSON.parse(r.event.stdout)),
      unconfirmed: journal.records
        .filter((r) => r.event.phase === "runtime-command-unconfirmed")
        .map((r) => ({ phase: r.event.attemptedPhase })),
    }),
  );
  assert(!journal.records.some((r) => r.event.phase === "runtime-command-unconfirmed"));
  const receipt = JSON.parse(restored.event.stdout);
  assert.equal(receipt.result.status, "local-restore-replayed");
  assert.equal(receipt.result.applicationTrafficBlocked, true);
  assert.equal(receipt.result.operationalRecoveryAccepted, false);
  const { heldOperatorInput } = await import("./postgres-operator-input.mjs");
  for (const ref of [receipt.handoff, receipt.evidence]) {
    const held = await heldOperatorInput(ref.path, ref.sha256, {
      privateFile: true,
      maximum: 1572864,
    });
    try {
      assert((await held.conserve()).length > 0);
    } finally {
      held.raw.fill(0);
      await held.fd.close();
    }
  }
  f.operator.verify();
});

async function fastProtectedRecovery(t, options = {}) {
  const f = await runtimeRunFixture(t, {
    seedUntilAssembly: true,
    validAssembly: true,
    validOperator: true,
    restoreCountDrift: options.countDrift ?? false,
  });
  active = f;
  const { createDatabase } = await import("../packages/db/dist/index.js");
  const { seedDevelopmentRuntimeCatalogue } = await import(
    "./azure-development-runtime-maintenance.mts"
  );
  const { createDevelopmentRuntimeHttp } = await import("./azure-development-runtime-http.mjs");
  const { writeFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { runPostgresOperator } = await import("./postgres-operator.mjs");
  const { withOperatorTestEnvironment } = await import("./postgres-operator-fixture.mjs");
  const signal = new AbortController().signal;
  const database = createDatabase({
    connectionString: f.config.ownerEnvironment.DATABASE_URL,
    applicationName: "synthetic-controller-recovery-wire",
    maxConnections: 1,
    ssl: { ca: f.config.input.caCertificate, rejectUnauthorized: true, minVersion: "TLSv1.2" },
  });
  const http = createDevelopmentRuntimeHttp(
    {
      ca: f.config.input.caCertificate,
      addresses: { api: "172.28.0.5", capture: "172.29.0.2", meili: "172.28.0.4" },
      notAfterUtc: new Date(Date.now() + 60000).toISOString(),
      signal,
      assertOwnership: async () => {},
    },
    f.execution.http,
  );
  try {
    await seedDevelopmentRuntimeCatalogue({
      database,
      expectedTarget: {
        databaseName: f.input.database.databaseName,
        databaseOid: "12345",
        expectedOwner: f.input.database.owner,
      },
      searchKeys: { search: "a".repeat(64), worker: "b".repeat(64), observer: "c".repeat(64) },
      http,
      spoolDirectory: join(f.input.root, "data/erasure-replay-spool"),
      notAfterUtc: new Date(Date.now() + 60000).toISOString(),
      signal,
      onMutationStart: async () => {
        f.seedClaimed = true;
      },
    });
    if (options.earlyGrants) {
      const { applyDevelopmentRuntimeDatabaseGrants } = await import(
        "./azure-development-runtime-database.mts"
      );
      await applyDevelopmentRuntimeDatabaseGrants({
        database,
        expectedTarget: {
          databaseName: f.input.database.databaseName,
          databaseOid: "12345",
          expectedOwner: f.input.database.owner,
        },
        principals: { api: f.input.database.api, worker: f.input.database.worker },
        notAfterUtc: new Date(Date.now() + 60000).toISOString(),
        signal,
        onMutationStart: async () => {
          f.grantsClaimed = true;
        },
      });
    }
  } finally {
    await database.destroy();
  }
  if (options.recoverRuntimeGrants)
    f.sql.tables.set("database_restore_attestation", [
      {
        singleton: true,
        restore_epoch_hash: "0".repeat(64),
        database_oid: "12345",
        database_name: f.input.database.databaseName,
        replayed_subject_count: "0",
        reconciliation_digest: "1".repeat(64),
        completed_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  const bundlePath = join(f.input.root, "recovery/fast-bundle.json"),
    now = new Date().toISOString();
  const args = [
    f.assembly.assemblyInput.path,
    f.assembly.assemblyInput.sha256,
    f.assembly.contextSource,
    f.assembly.assemblySource,
    now,
    new Date(Date.now() + 900000).toISOString(),
    bundlePath,
  ];
  const assembly = JSON.parse(await f.assembly.command(["prepare", ...args]));
  await f.assembly.command(["qualify", ...args, assembly.bundle_sha256]);
  const recovery = JSON.parse(await readFile(f.input.recovery.path, "utf8"));
  const call = async (operation, settings) => {
    const path = join(f.input.root, "recovery", `fast-${operation}-input.json`);
    const input = {
      schemaVersion: 1,
      operation,
      notAfterUtc: new Date(Date.now() + 135000).toISOString(),
      assembly: { path: bundlePath, sha256: assembly.bundle_sha256 },
      settings: {
        ...settings,
        ...(options.recoverRuntimeGrants
          ? { runtimePrincipals: { api: f.input.database.api, worker: f.input.database.worker } }
          : {}),
        tmpfsRoot: join(f.input.root, "tmpfs"),
        expectedOwner: f.input.database.owner,
      },
      ...(operation === "restore"
        ? {
            restoreHandoffPath: join(f.input.root, "recovery/fast-handoff.json"),
            restoreEvidencePath: join(f.input.root, "recovery/fast-evidence.json"),
          }
        : {}),
    };
    const raw = JSON.stringify(input);
    await writeFile(path, raw, { flag: "wx", mode: 0o600 });
    return withOperatorTestEnvironment(() =>
      runPostgresOperator(
        [
          operation,
          "--input",
          path,
          "--input-sha256",
          createHash("sha256").update(raw).digest("hex"),
        ],
        { signal },
      ),
    );
  };
  const backupSettings = {
    ...recovery.backup,
    sourceRevision: f.input.sourceRevision,
    deploymentTarget: "development",
    backupId: f.input.owner,
  };
  if (options.earlyGrants && !options.recoverRuntimeGrants) {
    const observed = f.operator.snapshot().authority;
    assert.equal(observed.explicitColumnAclAttributeCount, "3");
    assert(
      observed.relations.some((r) => r.acl.some((acl) => acl.grantee === f.input.database.api)),
    );
    await assert.rejects(() => call("backup", backupSettings), /PostgreSQL operator failed/);
    assert(!f.operator.storage.ciphertext);
    assert(f.operator.children.every((c) => c.closed) && f.operator.clients.every((c) => c.closed));
    return;
  }
  try {
    const backed = await call("backup", {
      ...recovery.backup,
      sourceRevision: f.input.sourceRevision,
      deploymentTarget: "development",
      backupId: f.input.owner,
    });
    assert.equal(backed.result.localOnly, false);
    const restore = () =>
      call("restore", {
        ...recovery.restore,
        targetDatabase: `nutrition_restore_${f.input.owner.replaceAll("-", "")}`,
        expectedBackup: backed.expectedBackup,
      });
    if (options.countDrift) {
      await assert.rejects(restore, /PostgreSQL operator failed/);
      assert(f.restoreCountDriftObserved);
      assert(f.operator.restored && f.operator.policyApplied);
      assert.equal(f.operator.target.allowConnections, false);
      assert.equal(f.operator.target.publicConnect, false);
      assert(
        f.operator.children.every((c) => c.closed) && f.operator.clients.every((c) => c.closed),
      );
      assert.equal(f.operator.errors.length, 0);
      for (const name of ["fast-handoff.json", "fast-evidence.json"])
        assert.equal((await readFile(join(f.input.root, "recovery", name))).length, 0);
      return;
    }
    const restored = await restore();
    assert.equal(restored.result.status, "local-restore-replayed");
    f.operator.verify();
  } catch (error) {
    assert.fail(
      JSON.stringify({
        error: error.message,
        observed: f.operator.errors.map((e) => ({
          phase: e.phase,
          message: e.message,
          stack: e.stack,
        })),
        queries: f.operator.queries
          .filter((q) => q.database.startsWith("nutrition_restore_"))
          .slice(-8),
        clients: f.operator.clients.map((c) => ({
          database: c.config.database,
          application: c.config.application_name,
          closed: c.closed,
        })),
      }),
    );
  }
}
test("fast protected recovery wire uses actual seed assembly collector crypto and fenced replay", (t) =>
  fastProtectedRecovery(t));
test("protected recovery rejects a changed restored nutrient count, refences the target and publishes no accepted handoff", (t) =>
  fastProtectedRecovery(t, { countDrift: true }));

test("protected backup without an independently selected runtime profile refuses runtime ACL drift", (t) =>
  fastProtectedRecovery(t, { earlyGrants: true }));

test("protected encrypted backup restores exact selected runtime grants and replays while application traffic stays fenced", (t) =>
  fastProtectedRecovery(t, { earlyGrants: true, recoverRuntimeGrants: true }));

test("actual controller process remains visible through the synthetic native process seam", async (t) => {
  const f = await runtimeRunFixture(t, { validOperator: true });
  active = f;
  assert(
    (await f.operator.processDirectory("/proc")).includes(String(process.pid)),
    "Real process entries must remain visible to native group cleanup",
  );
});

async function sourceReadinessChild(t, mode) {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { rootCertificates } = await import("node:tls");
  const { X509Certificate, createHash } = await import("node:crypto");
  const { fileURLToPath } = await import("node:url");
  const { runTool } = await import("./postgres-operator-process.mjs");
  const directory = await mkdtemp(join(homedir(), "nutrition-source-readiness-")),
    root = join(directory, "runtime");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "pki"), { mode: 0o700 });
  const ca = rootCertificates.find((value) =>
    new X509Certificate(value).subject.split("\n").includes("CN=ISRG Root X1"),
  );
  assert(ca);
  const path = join(root, "pki/ca.crt");
  await writeFile(path, ca, { mode: 0o600, flag: "wx" });
  const childEnvironment = { ...process.env, NODE_EXTRA_CA_CERTS: path };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const controller = new AbortController(),
    signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        mode === "connected-journey-hold" || mode.startsWith("connected-client")
          ? 1_200_000
          : mode.startsWith("connected-journey")
            ? 600_000
            : 240_000,
      ),
    ]);
  let diagnostic = "",
    ownedPython,
    failure;
  const outputPath = join(directory, "child-output.log");
  try {
    await runTool(
      {
        path: process.execPath,
        sha256: createHash("sha256")
          .update(await readFile(process.execPath))
          .digest("hex"),
      },
      [
        "--test-name-pattern=^original-source readiness child$",
        fileURLToPath(import.meta.url),
        "--runtime-source-child",
        mode,
        root,
      ],
      {
        signal,
        env: childEnvironment,
        directory: fileURLToPath(new URL("../", import.meta.url)),
        limit: 2_097_152,
        outputPath,
        onStderr(raw) {
          diagnostic += raw.toString();
          const pid = /runtime-owned-python=([1-9][0-9]*)/u.exec(diagnostic)?.[1];
          if (pid) {
            ownedPython = pid;
            if (mode === "process-cancel") controller.abort();
          }
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  if (mode.startsWith("process-")) {
    assert(failure, "Cancellation/output overflow must not report child success");
    assert(ownedPython);
    try {
      const raw = await readFile(`/proc/${ownedPython}/stat`, "utf8");
      assert(
        ["Z", "X"].includes(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0]),
        "Owned Python must stop before temporary-root cleanup",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }
  const output = await readFile(outputPath, "utf8");
  if (failure) process.stdout.write(output);
  assert(!failure, JSON.stringify({ error: failure?.message, output, diagnostic }));
  if (
    [
      "connected-journey-hold",
      "connected-journey-stop-refused",
      "connected-client",
      "connected-client-readiness",
    ].includes(mode)
  )
    process.stdout.write(output);
}

test("owned startup-CA child cancellation and output overflow stop its real Python descendant before cleanup", async (t) => {
  for (const mode of ["process-cancel", "process-overflow"]) await sourceReadinessChild(t, mode);
});

test("actual API repositories and HTTPS capture complete the private persisted journey across factory recreation", async (t) => {
  await sourceReadinessChild(t, "api-journey");
});

test("actual worker factory polls all idle queues and recreates over the persisted API journey", async (t) => {
  await sourceReadinessChild(t, "api-journey-worker");
});

test("a swallowed actual retention SQL failure cannot qualify worker readiness and later slices still run", async (t) => {
  await sourceReadinessChild(t, "api-journey-worker-failure");
});

test("actual API readback rejects a changed committed diary revision after factory recreation", async (t) => {
  await sourceReadinessChild(t, "api-journey-drift");
});

test("actual maintained API factory reads persisted source readiness after close and recreation", async (t) => {
  await sourceReadinessChild(t, "api-factory");
});

test("actual source replay and distinct runtime readiness consume the startup public CA and emitted grants", async (t) => {
  await sourceReadinessChild(t, "positive");
});
test("changed source epoch and persisted readback refuse readiness after actual replay", async (t) => {
  for (const mode of ["worker-epoch", "readback"]) await sourceReadinessChild(t, mode);
});
test("omitted runtime table and locking-column grants cannot reach source readiness", async (t) => {
  for (const options of [
    { omitRuntimeTableGrant: "outbox_event" },
    { omitRuntimeColumnGrant: true },
  ]) {
    const f = await runtimeRunFixture(t, { seedUntilAssembly: true, ...options });
    active = f;
    const { createDatabase } = await import("../packages/db/dist/index.js");
    const { applyDevelopmentRuntimeDatabaseGrants } = await import(
      "./azure-development-runtime-database.mts"
    );
    const db = createDatabase({
      connectionString: f.config.ownerEnvironment.DATABASE_URL,
      applicationName: "synthetic-grant-omission",
      maxConnections: 1,
    });
    try {
      await assert.rejects(
        applyDevelopmentRuntimeDatabaseGrants({
          database: db,
          expectedTarget: {
            databaseName: f.input.database.databaseName,
            databaseOid: "12345",
            expectedOwner: f.input.database.owner,
          },
          principals: { api: f.input.database.api, worker: f.input.database.worker },
          notAfterUtc: new Date(Date.now() + 60000).toISOString(),
          signal: new AbortController().signal,
          onMutationStart: async () => {
            f.grantsClaimed = true;
          },
        }),
        (error) =>
          error.message.startsWith(
            options.omitRuntimeColumnGrant
              ? "Unexpected runtime column rights:"
              : "Unexpected runtime relation rights: outbox_event",
          ),
      );
      assert(!f.sql.persisted());
      assert.equal(
        f.sql.grants.size,
        0,
        "Rejected grant transaction must roll back raw privilege state",
      );
      assert.equal(f.sql.columnGrants.size, 0);
      assert(f.queries.some(({ sql }) => sql.startsWith("grant ")));
    } finally {
      await db.destroy();
    }
    assert(f.pools.every((pool) => pool.closed));
  }
});

test("connected controller reaches original-source readiness after protected restore and before application requests", async (t) => {
  await sourceReadinessChild(t, "connected");
});

test("connected controller completes the actual API journey and persisted readback across owned restart", async (t) => {
  await sourceReadinessChild(t, "connected-journey");
});

test("maximum controller hold conserves the complete journal and stops all owned resources", async (t) => {
  await sourceReadinessChild(t, "connected-journey-hold");
});

test("a final owned API stop refusal retains the persisted journey and cannot report runtime success", async (t) => {
  await sourceReadinessChild(t, "connected-journey-stop-refused");
});

test("public edge opens after the actual persisted restart journey and closes at the original finite window", async (t) => {
  await sourceReadinessChild(t, "connected-client");
});
test("lost worker readiness closes the admitted public edge before every remaining owned service", async (t) => {
  await sourceReadinessChild(t, "connected-client-readiness");
});

if (process.argv[2] === "--runtime-source-child")
  test("original-source readiness child", async (t) => {
    const mode = process.argv[3];
    assert(
      [
        "connected",
        "connected-client",
        "connected-client-readiness",
        "connected-journey",
        "connected-journey-hold",
        "connected-journey-stop-refused",
        "positive",
        "worker-epoch",
        "readback",
        "process-cancel",
        "process-overflow",
        "api-factory",
        "api-journey",
        "api-journey-drift",
        "api-journey-worker",
        "api-journey-worker-failure",
      ].includes(mode),
    );
    if (mode.startsWith("process-")) {
      const child = realSpawn("/usr/bin/python3.12", ["-c", "import time; time.sleep(60)"], {
        stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      process.stderr.write(`runtime-owned-python=${child.pid}\n`);
      if (mode === "process-overflow") process.stdout.write(Buffer.alloc(2_097_153, 120));
      await new Promise((resolve) => child.once("close", resolve));
      return;
    }
    const clientStart = Math.ceil(Date.now() / 1000) * 1000 + 600_000;
    const clientAccess = mode.startsWith("connected-client")
      ? {
          adminIpv4Cidr: "8.8.8.8/32",
          notBeforeUtc: new Date(clientStart).toISOString(),
          notAfterUtc: new Date(clientStart + 900_000).toISOString(),
        }
      : null;
    const f = await runtimeRunFixture(t, {
      clientAccess,
      apiDeadlineNs: clientAccess
        ? (process.hrtime.bigint() + 1_485_000_000_000n).toString()
        : undefined,
      clientReadinessFailure: mode === "connected-client-readiness",
      root: process.argv[4],
      seedUntilAssembly: true,
      realApi:
        mode.startsWith("api-journey") ||
        mode.startsWith("connected-journey") ||
        mode.startsWith("connected-client"),
      realWorker: mode.startsWith("connected-journey") || mode.startsWith("connected-client"),
      maximumHold: mode === "connected-journey-hold",
      holdSeconds: mode === "connected-journey-hold" ? 900 : 0,
      stopAfterReadback: mode === "connected-journey-stop-refused" ? "api" : undefined,
      workerPollSqlFailure: undefined,
      validAssembly: mode.startsWith("connected"),
      validOperator: mode.startsWith("connected"),
      wrongSourceWorkerEpoch: mode === "worker-epoch",
      changedSourceReadback: mode === "readback",
    });
    active = f;
    if (f.options.maximumHold) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
      const monotonicStart = nativeMonotonic();
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: new Proxy(nativePerformance, {
          get(target, key) {
            if (key === "now") return () => monotonicStart + holdOffset;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      });
      t.after(() => Object.defineProperty(globalThis, "performance", descriptor));
    }
    if (mode.startsWith("connected")) {
      let failure, completed;
      try {
        completed = await runPreparedDevelopmentRuntime(f.args, f.execution);
      } catch (error) {
        failure = error;
      }
      const journal = await f.journal();
      assert(journal.complete);
      const ready = journal.records.find((r) => r.event.phase === "source-replay-ready");
      assert(
        ready,
        JSON.stringify({
          failure:
            failure?.errors?.map((e) => ({ message: e.message, stack: e.stack })) ?? failure?.stack,
          queries: f.queries.slice(-5),
        }),
      );
      assert.equal(ready.event.attestation.target.databaseOid, "12345");
      const restoredAt = journal.records.findIndex(
        (r) => r.event.phase === "postgres-restore" && r.event.completed,
      );
      const grantsAt = journal.records.findIndex((r) => r.event.phase === "database-grants-intent");
      assert(restoredAt >= 0 && grantsAt > restoredAt);
      assert(
        f.starts.includes("api") && f.starts.includes("worker"),
        JSON.stringify({
          starts: f.starts,
          failure:
            failure?.errors?.map((e) => ({ message: e.message, stack: e.stack })) ?? failure?.stack,
        }),
      );
      assert(f.sql.persisted());
      if (!f.options.stopAfterReadback)
        assert(
          f.pools.every((pool) => pool.closed),
          JSON.stringify({
            starts: f.starts,
            stops: f.stops,
            failure:
              failure?.errors?.map((e) => ({ message: e.message, stack: e.stack })) ??
              failure?.stack,
          }),
        );
      assert(f.prepared.opened.every((fd) => fd.closed));
      assert.equal(journal.records.at(-1).event.nativeStopSucceeded, !f.options.stopAfterReadback);
      f.operator.verify();
      if (mode.startsWith("connected-client")) {
        assert.equal(f.api.applications.length, 2);
        assert.equal(f.worker.applications.length, 2);
        assert.deepEqual(f.apiDeadlineBindings[0], f.apiDeadlineBindings[1]);
        const readbackAt = journal.records.findIndex(
          (row) => row.event.phase === "journey-readback",
        );
        const admittedAt = journal.records.findIndex(
          (row) => row.event.phase === "client-admitted",
        );
        assert(readbackAt >= 0 && admittedAt > readbackAt);
        const firstEdgeStop = f.stops.indexOf("client-edge");
        assert(
          firstEdgeStop >= 0 &&
            f.stops.slice(firstEdgeStop + 1).includes("api") &&
            f.stops.slice(firstEdgeStop + 1).includes("worker"),
        );
        assert(Object.values(f.observed.containers).every((row) => !row.State.Running));
        assert.equal(journal.records.at(-1).event.nativeStopSucceeded, true);
        if (f.options.clientReadinessFailure) {
          assert(failure instanceof AggregateError && completed === undefined);
          assert(!journal.records.some((row) => row.event.phase === "client-admission-closed"));
        } else {
          if (failure)
            process.stdout.write(
              JSON.stringify({
                publicClientFailure: true,
                errors: failure.errors?.map((error) => ({
                  message: error.message,
                  stack: error.stack,
                })),
                journalRecords: journal.records.length,
                nativeStopSucceeded: journal.records.at(-1).event.nativeStopSucceeded,
                clientOffset,
                lastPhases: journal.records.slice(-12).map((row) => row.event.phase),
              }) + "\n",
            );
          assert.ifError(failure);
          assert(completed.persisted && completed.operationalAcceptance === false);
          assert(journal.records.some((row) => row.event.phase === "client-admission-closed"));
          assert(f.clientDelays.length > 0);
        }
        process.stdout.write(
          JSON.stringify({
            publicClient: true,
            readinessFailure: f.options.clientReadinessFailure,
            controlledAdvanceMs: clientOffset,
            journalRecords: journal.records.length,
            sameApiDeadlineAcrossRestart: true,
            nativeStopSucceeded: true,
            operationalAcceptance: false,
          }) + "\n",
        );
      }
      if (mode.startsWith("connected-journey")) {
        const stopped = journal.records.at(-1).event;
        if (f.options.stopAfterReadback) {
          assert(failure instanceof AggregateError);
          assert.equal(completed, undefined);
          assert(stopped.cleanupErrorCount > 0);
          assert.equal(stopped.runtimeAcceptanceRecorded, false);
          assert.equal(stopped.observedJourney.persisted, true);
          assert.equal(stopped.observedJourney.operationalAcceptance, false);
          assert(
            f.stops.includes("postgres") &&
              f.stops.includes("capture") &&
              f.stops.includes("worker"),
          );
          assert.equal(f.stops.filter((name) => name === "api").length, 2);
          assert.equal(f.api.applications.length, 2);
          assert.equal(f.worker.applications.length, 2);
          assert.equal(f.observed.containers.api.State.Running, true);
          assert(
            Object.entries(f.observed.containers)
              .filter(([name]) => name !== "api")
              .every(([, row]) => !row.State.Running),
          );
          assert(f.pools.some((pool) => !pool.closed));
          await f.api.close();
          assert(f.pools.every((pool) => pool.closed));
          assert.equal(f.observed.containers.api.State.Running, true);
          assert.equal(stopped.nativeStopSucceeded, false);
          assert.equal(stopped.runtimeAcceptanceRecorded, false);
          process.stdout.write(
            JSON.stringify({
              finalStopRefused: true,
              journalRecords: journal.records.length,
              nativeStopSucceeded: stopped.nativeStopSucceeded,
              persisted: stopped.observedJourney.persisted,
            }) + "\n",
          );
          return;
        }
        assert(
          !failure,
          JSON.stringify({
            error: failure?.stack,
            nested: failure?.errors?.map((e) => e.stack),
            queries: f.queryFailures,
            requests: f.api.requests.slice(-5),
          }),
        );
        assert.equal(completed.persisted, true);
        assert.equal(completed.operationalAcceptance, false);
        assert.equal(completed.applicationTrafficBlocked, true);
        assert.equal(f.api.applications.length, 2);
        assert.equal(f.worker.applications.length, 2);
        assert.equal(f.worker.polls.length, 2);
        assert.deepEqual(
          f.worker.polls.map((row) => row.mode),
          ["rebuilt", "idle"],
        );
        assert.equal(f.worker.events.length, 1);
        assert.equal(f.worker.events[0].event, "search.rebuild.completed");
        assert.equal(f.worker.events[0].eventCount, 2);
        assert.equal(f.worker.events[0].includedCount, 1);
        assert(
          journal.records.some(
            (r) => r.event.phase === "journey-readback" && r.event.readback.persisted,
          ),
        );
        assert.equal(f.starts.filter((n) => n === "api").length, 2);
        assert.equal(f.stops.filter((n) => n === "api").length, 2);
        if (f.options.maximumHold) {
          assert.equal(f.hold.delays.length, 60);
          assert.equal(holdOffset, 900_000);
          const names = await realReaddir(join(f.input.root, "journal"));
          const sizes = await Promise.all(
            names.map(async (name) => (await readFile(join(f.input.root, "journal", name))).length),
          );
          const bytes = sizes.reduce((sum, size) => sum + size, 0);
          assert.equal(names.length, journal.records.length);
          assert(
            names.length <= 1024 && sizes.every((size) => size <= 1_048_576) && bytes <= 67_108_864,
          );
          const holdRecords = journal.records.slice(f.hold.firstSequence - 4, -1);
          assert(
            holdRecords.filter((row) => row.event.phase === "source-head").length >=
              f.hold.delays.length - 1,
          );
          assert(
            holdRecords.filter((row) => row.event.phase === "source-clean").length >=
              f.hold.delays.length - 1,
          );
          assert(
            holdRecords.filter((row) => row.event.phase === "runtime-read-only-observations")
              .length >=
              2 * (f.hold.delays.length - 1),
          );
          process.stdout.write(
            JSON.stringify({
              maximumHold: true,
              monotonicAdvanceMs: holdOffset,
              delayCount: f.hold.delays.length,
              journalRecords: names.length,
              journalBytes: bytes,
              largestRecordBytes: Math.max(...sizes),
              nativeStopSucceeded: stopped.nativeStopSucceeded,
            }) + "\n",
          );
        }
      }
      return;
    }
    const { createDatabase } = await import("../packages/db/dist/index.js");
    const { applyDevelopmentRuntimeDatabaseGrants } = await import(
      "./azure-development-runtime-database.mts"
    );
    const { attestDevelopmentRuntimeSource } = await import(
      "./azure-development-runtime-maintenance.mts"
    );
    const target = {
      databaseName: f.input.database.databaseName,
      databaseOid: "12345",
      expectedOwner: f.input.database.owner,
    };
    const db = createDatabase({
      connectionString: f.config.ownerEnvironment.DATABASE_URL,
      applicationName: "synthetic-source-ready-grants",
      maxConnections: 1,
    });
    let catalogue;
    const { createDevelopmentRuntimeHttp } = await import("./azure-development-runtime-http.mjs");
    const transport = () =>
      createDevelopmentRuntimeHttp(
        {
          ca: f.config.input.caCertificate,
          addresses: { api: "172.28.0.5", capture: "172.29.0.2", meili: "172.28.0.4" },
          notAfterUtc: new Date(Date.now() + 120000).toISOString(),
          signal: new AbortController().signal,
          assertOwnership: async () => {},
        },
        f.execution.http,
      );
    try {
      if (mode.startsWith("api-journey")) {
        const { seedDevelopmentRuntimeCatalogue } = await import(
          "./azure-development-runtime-maintenance.mts"
        );
        catalogue = await seedDevelopmentRuntimeCatalogue({
          database: db,
          expectedTarget: target,
          searchKeys: { search: "a".repeat(64), worker: "b".repeat(64), observer: "c".repeat(64) },
          http: transport(),
          spoolDirectory: join(f.input.root, "data/erasure-replay-spool"),
          notAfterUtc: new Date(Date.now() + 60000).toISOString(),
          signal: new AbortController().signal,
          onMutationStart: async () => {
            f.seedClaimed = true;
          },
        });
      }
      await applyDevelopmentRuntimeDatabaseGrants({
        database: db,
        expectedTarget: target,
        principals: { api: f.input.database.api, worker: f.input.database.worker },
        notAfterUtc: new Date(Date.now() + 60000).toISOString(),
        signal: new AbortController().signal,
        onMutationStart: async () => {
          f.grantsClaimed = true;
        },
      });
    } finally {
      await db.destroy();
    }
    const ownerEnvironment = f.config.ownerEnvironment;
    const runtimeEnvironments = ["api", "worker"].map((role) => ({
      ...f.config.model.services[role].environment,
      NODE_EXTRA_CA_CERTS: join(f.input.root, "pki/ca.crt"),
    }));
    let result, failure;
    try {
      result = await attestDevelopmentRuntimeSource({
        expectedTarget: target,
        caCertificate: f.config.input.caCertificate,
        ownerEnvironment,
        runtimeEnvironments,
        notAfterUtc: new Date(Date.now() + 60000).toISOString(),
        signal: new AbortController().signal,
      });
    } catch (error) {
      failure = error;
    }
    if (["positive", "api-factory"].includes(mode) || mode.startsWith("api-journey")) {
      assert.ifError(failure);
      assert.deepEqual(result.target, target);
      assert.equal(result.kind, "nutrition-development-source-ready-v1");
      assert.equal(result.attestation.replayedSubjectCount, "0");
      assert.deepEqual(
        f.pools.slice(-3).map((pool) => pool.principal),
        [target.expectedOwner, f.input.database.api, f.input.database.worker],
      );
    } else {
      assert(failure);
      assert.equal(
        failure.message,
        mode === "worker-epoch"
          ? "Database restore replay attestation is not current"
          : "Restore attestation changed after readiness",
      );
    }

    if (mode === "api-factory") {
      const { createApiApplicationRuntime } = await import("../apps/api/dist/server.js");
      const environment = {
        ...f.config.model.services.api.environment,
        NODE_EXTRA_CA_CERTS: join(f.input.root, "pki/ca.crt"),
        EXPORT_ARTIFACT_READ_SPOOL_DIR: join(f.input.root, "data/api/export-read-spool"),
      };
      const stored = structuredClone(f.sql.persisted());
      const poolsBefore = f.pools.length,
        applications = [];
      for (let restart = 0; restart < 2; restart++) {
        const runtime = await createApiApplicationRuntime(environment, { logger: false });
        applications.push(runtime);
        try {
          const response = await runtime.app.inject({ method: "GET", url: "/ready" });
          assert.equal(response.statusCode, 200, response.body);
          assert.deepEqual(response.json(), { status: "ok" });
        } finally {
          await runtime.close();
        }
        assert(f.pools.every((pool) => pool.closed));
      }
      assert.notEqual(applications[0], applications[1]);
      assert.deepEqual(
        f.pools.slice(poolsBefore).map((pool) => pool.principal),
        [f.input.database.api, f.input.database.api],
      );
      assert.deepEqual(f.sql.persisted(), stored);
    }

    if (mode.startsWith("api-journey")) {
      const { initializeDevelopmentRuntimeJourney, readBackDevelopmentRuntimeJourney } =
        await import("./azure-development-runtime-probe.mjs");
      const claims = [];
      const input = () => ({
        configuration: {
          ...f.input.journey,
          runId: f.input.owner,
          nodeEnv: "development",
          profile: "hosted-development",
          syntheticOnly: true,
          catalogue,
          captureSend: f.input.mail.send,
          captureReview: f.input.mail.review,
          notAfterUtc: new Date(Date.now() + 120000).toISOString(),
        },
        http: transport(),
        signal: new AbortController().signal,
        onMutationStart: async (stage) => {
          claims.push(stage);
        },
      });
      try {
        await f.api.start();
        const journey = await initializeDevelopmentRuntimeJourney(input());
        await f.api.close();
        if (mode.startsWith("api-journey-worker")) {
          const poolsAt = f.pools.length;
          const failed = mode === "api-journey-worker-failure";
          for (let restart = 0; restart < (failed ? 1 : 2); restart++) {
            await f.worker.start();
            try {
              if (failed) {
                await f.worker.poll();
                f.options.workerPollSqlFailure = "exports-expired-upload";
                const beforeFailure = structuredClone(f.sql.tables);
                const networksBefore = [
                  f.api.requests.length,
                  f.meili.requests.length,
                  f.wire.requests.length,
                  f.wire.issuerRequests.length,
                ];
                await assert.rejects(f.worker.poll(), { code: "ERR_ASSERTION" });
                assert.deepEqual(f.sql.tables, beforeFailure);
                assert.deepEqual(
                  [
                    f.api.requests.length,
                    f.meili.requests.length,
                    f.wire.requests.length,
                    f.wire.issuerRequests.length,
                  ],
                  networksBefore,
                );
                assert.deepEqual(f.worker.polls.at(-1).events, [
                  {
                    errorCode: "RETENTION_POLL_FAILED",
                    event: "retention.poll.slice_failed",
                    level: "warn",
                    operation: "exports",
                  },
                ]);
                const observed = f.sql.workerIdle.observations();
                assert.equal(
                  observed.find((r) => r.stage === "exports-expired-upload").completed,
                  false,
                );
                assert.equal(observed.filter((r) => r.stage === "rollback").length, 1);
                assert.equal(observed.filter((r) => r.stage === "commit").length, 4);
                assert(observed.find((r) => r.stage === "dead-letter-claim").completed);
                assert.equal(f.worker.polls.at(-1).failures.length, 1);
                assert.equal(
                  f.worker.polls.at(-1).failures[0].error,
                  "Controlled worker retention SQL failure",
                );
                assert.throws(() => f.sql.workerIdle.assertComplete(), { code: "ERR_ASSERTION" });
              } else await f.worker.poll();
            } finally {
              await f.worker.close();
            }
          }
          assert.equal(f.worker.applications.length, failed ? 1 : 2);
          if (!failed) assert.notEqual(f.worker.applications[0], f.worker.applications[1]);
          assert.deepEqual(
            f.pools.slice(poolsAt).map((p) => p.principal),
            Array(failed ? 1 : 2).fill(f.input.database.worker),
          );
          assert(f.pools.slice(poolsAt).every((p) => p.closed));
        }
        if (mode === "api-journey-drift") {
          const revisions = f.sql.tables.get("diary_entry_revision");
          assert.equal(revisions.length, 2);
          assert.equal(revisions[1].note, "Synthetic persistent diary");
          revisions[1].note = "Controlled unexpected persisted note";
        }
        await f.api.start();
        if (mode === "api-journey-drift") {
          await assert.rejects(readBackDevelopmentRuntimeJourney(input(), journey), {
            code: "ERR_ASSERTION",
          });
        } else {
          const observed = await readBackDevelopmentRuntimeJourney(input(), journey);
          assert.equal(observed.persisted, true);
        }
        assert.equal(f.api.applications.length, 2);
        assert(f.api.messages.length >= 3 && claims.length > 0);
      } catch (error) {
        assert.fail(
          JSON.stringify({
            error: error.stack,
            queries: f.queryFailures,
            requests: f.api.requests.slice(-5),
          }),
        );
      } finally {
        await f.api.close();
      }
    }

    assert(f.sql.persisted());
    assert(f.pools.every((pool) => pool.closed));
    assert.equal(f.calls.length, 0);
  });
