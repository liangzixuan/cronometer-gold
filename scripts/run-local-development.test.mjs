import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  localDevelopmentSupervisorGraceMs,
  nestedProcessTerminationGraceMs,
  supervisorTerminationMarginMs,
} from "./local-development-shutdown-budget.mjs";
import {
  apiOnlyApplicationRuntimeEnvironmentFields,
  applicationRuntimeEnvironmentFields,
  assertLocalDevelopmentEnvironment,
  LocalDevelopmentProcessError,
  localDevelopmentChildEnvironment,
  localDevelopmentProfiles,
  runLocalDevelopment,
  runLocalDevelopmentWithPrivateEnv,
} from "./run-local-development.mjs";

const masterKey = "local-bootstrap-master-key-for-tests";
const searchKey = "a".repeat(64);
const adminKey = "b".repeat(64);
const taskObserverKey = "c".repeat(64);
let nextFakePid = 20_000;

function environment(overrides = {}) {
  return {
    API_HOST: "127.0.0.1",
    API_INTERNAL_URL: "http://127.0.0.1:4000",
    API_PORT: "4000",
    DATABASE_APPLICATION_NAME: "nutrition-tracker-local",
    DATABASE_SSL_MODE: "disable",
    DATABASE_URL:
      "postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker",
    ERASURE_REPLAY_LEDGER_ENDPOINT: "http://127.0.0.1:9000",
    ERASURE_REPLAY_LEDGER_STORE: "filesystem",
    ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID: "restore-only-id",
    ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE: "/private/restore.pem",
    ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY: "restore-only-secret",
    ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: "ledger-writer-id",
    ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: "ledger-writer-secret",
    EXPORT_ARTIFACT_ENDPOINT: "http://127.0.0.1:9000",
    EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "export-reader-id",
    EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "export-reader-secret",
    EXPORT_ARTIFACT_STORE: "filesystem",
    EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: "export-writer-id",
    EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: "export-writer-secret",
    HEALTH_REVIEWER_PRIVATE_KEY_FILE: "/private/health-reviewer.pem",
    MEILI_ADMIN_KEY: "unprovisioned-admin-placeholder",
    MEILI_MASTER_KEY: masterKey,
    MEILI_PORT: "7700",
    MEILI_SEARCH_KEY: "unprovisioned-search-placeholder",
    MEILI_TASK_OBSERVER_KEY: "unprovisioned-task-observer-placeholder",
    MEILI_URL: "http://127.0.0.1:7700",
    OBJECT_STORE_PORT: "9000",
    ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY: "root-password-must-not-reach-runtime",
    ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID: "root-user-must-not-reach-runtime",
    NODE_ENV: "development",
    PATH: "/home/test/.local/bin:/usr/bin",
    POSTGRES_DB: "nutrition_tracker",
    POSTGRES_PASSWORD: "nutrition_local_only",
    POSTGRES_PORT: "5432",
    POSTGRES_USER: "nutrition_local",
    S3_ACCESS_KEY_ID: "root-user-must-not-reach-runtime",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_SECRET_ACCESS_KEY: "root-password-must-not-reach-runtime",
    SHUTDOWN_GRACE_MS: "10000",
    VAULT_TOKEN: "unknown-ambient-secret-must-not-reach-runtime",
    ...overrides,
  };
}

function scopedKeys() {
  return {
    MEILI_ADMIN_KEY: adminKey,
    MEILI_SEARCH_KEY: searchKey,
    MEILI_TASK_OBSERVER_KEY: taskObserverKey,
  };
}

function completedChild(options = {}) {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  queueMicrotask(() => {
    if (options.error) {
      child.emit("error", options.error);
      return;
    }
    child.exitCode = options.status ?? 0;
    child.signalCode = options.signal ?? null;
    child.emit("exit", options.status ?? 0, options.signal ?? null);
  });
  return child;
}

function pendingChild() {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  return child;
}

function parseExampleEnvironment() {
  const source = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const parsed = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = /^(?<field>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u.exec(line);
    if (match?.groups?.field !== undefined && match.groups.value !== undefined) {
      parsed[match.groups.field] = match.groups.value;
    }
  }
  return parsed;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGone(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) await delay(25);
  assert.equal(processExists(pid), false, `test process ${pid} must terminate`);
}

function readJsonLine(stream, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("Timed out waiting for the bounded process fixture"));
    }, timeoutMs);
    const dispose = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      dispose();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = () => {
      dispose();
      reject(new Error("Bounded process fixture output failed"));
    };
    const onEnd = () => {
      dispose();
      reject(new Error("Bounded process fixture exited before reporting its process tree"));
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

test("bootstraps fixed scoped keys and launches the full graph with an exact projection", async () => {
  const bootstrapCalls = [];
  const spawnCalls = [];
  const sourceEnvironment = environment();
  await runLocalDevelopment([], {
    bootstrap: async (options) => {
      bootstrapCalls.push(options);
      return scopedKeys();
    },
    environment: sourceEnvironment,
    spawn: (command, arguments_, options) => {
      spawnCalls.push({ arguments_, command, options });
      return completedChild();
    },
  });

  assert.deepEqual(bootstrapCalls, [
    { endpoint: "http://127.0.0.1:7700", masterKey, port: "7700" },
  ]);
  assert.equal(spawnCalls.length, 1);
  const launch = spawnCalls[0];
  assert.equal(launch.command, "pnpm");
  assert.deepEqual(launch.arguments_, localDevelopmentProfiles.full.turboArguments);
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.stdio, "inherit");
  const expectedKeys = [
    ...new Set([
      ...applicationRuntimeEnvironmentFields.filter(
        (field) => sourceEnvironment[field] !== undefined,
      ),
      "MEILI_ADMIN_KEY",
      "MEILI_SEARCH_KEY",
      "MEILI_TASK_OBSERVER_KEY",
      "PATH",
    ]),
  ].sort();
  assert.deepEqual(Object.keys(launch.options.env).sort(), expectedKeys);
  assert.equal(launch.options.env.MEILI_ADMIN_KEY, adminKey);
  assert.equal(launch.options.env.MEILI_SEARCH_KEY, searchKey);
  assert.equal(launch.options.env.MEILI_TASK_OBSERVER_KEY, taskObserverKey);
});

test("projects the real example through an explicit application allowlist without values", () => {
  const sourceEnvironment = {
    ...parseExampleEnvironment(),
    ANDROID_KEYSTORE_PASSWORD: "excluded",
    AWS_ACCESS_KEY_ID: "excluded",
    AWS_SECRET_ACCESS_KEY: "excluded",
    ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE: "/excluded",
    EXPO_TOKEN: "excluded",
    HEALTH_REVIEWER_PRIVATE_KEY_FILE: "/excluded",
    PATH: "/usr/bin",
    VAULT_TOKEN: "excluded",
  };
  const projected = localDevelopmentChildEnvironment(sourceEnvironment, scopedKeys());
  const expectedKeys = [
    ...new Set([
      ...applicationRuntimeEnvironmentFields.filter(
        (field) => sourceEnvironment[field] !== undefined,
      ),
      "MEILI_ADMIN_KEY",
      "MEILI_SEARCH_KEY",
      "MEILI_TASK_OBSERVER_KEY",
      "PATH",
    ]),
  ].sort();
  assert.deepEqual(Object.keys(projected).sort(), expectedKeys);

  for (const field of [
    "ANDROID_KEYSTORE_PASSWORD",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE",
    "ERASURE_REPLAY_LEDGER_RESTORE_REQUEST_TIMEOUT_MS",
    "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR",
    "ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER",
    "EXPO_TOKEN",
    "HEALTH_REVIEWER_PRIVATE_KEY_FILE",
    "MEILI_MASTER_KEY",
    "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY",
    "ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID",
    "POSTGRES_DB",
    "POSTGRES_PASSWORD",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "S3_ACCESS_KEY_ID",
    "S3_ENDPOINT",
    "S3_SECRET_ACCESS_KEY",
    "VAULT_TOKEN",
  ]) {
    assert.equal(Object.hasOwn(projected, field), false, `${field} must not be projected`);
  }
  const projectedValues = Object.values(projected);
  assert.equal(
    projectedValues.includes(sourceEnvironment.ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID),
    false,
  );
  assert.equal(
    projectedValues.includes(sourceEnvironment.ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY),
    false,
  );
});

test("selects only the exact API-only profile and rejects arbitrary forwarding", async () => {
  const calls = [];
  let childEnvironment;
  const sourceEnvironment = environment({
    SEARCH_TASK_TIMEOUT_MS: "120000",
  });
  await runLocalDevelopment(["--api-only"], {
    bootstrap: async () => scopedKeys(),
    environment: sourceEnvironment,
    spawn: (_command, arguments_, options) => {
      calls.push(arguments_);
      childEnvironment = options.env;
      return completedChild();
    },
  });
  assert.deepEqual(calls, [localDevelopmentProfiles.apiOnly.turboArguments]);
  const expectedKeys = [
    ...new Set([
      ...apiOnlyApplicationRuntimeEnvironmentFields.filter(
        (field) => sourceEnvironment[field] !== undefined,
      ),
      "PATH",
    ]),
  ].sort();
  assert.deepEqual(Object.keys(childEnvironment).sort(), expectedKeys);
  assert.equal(childEnvironment.MEILI_SEARCH_KEY, searchKey);
  for (const field of [
    "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
    "MEILI_ADMIN_KEY",
    "POLL_INTERVAL_MS",
    "SEARCH_TASK_TIMEOUT_MS",
  ]) {
    assert.equal(Object.hasOwn(childEnvironment, field), false);
  }

  let bootstrapped = false;
  await assert.rejects(
    runLocalDevelopment(["--filter=unreviewed"], {
      bootstrap: async () => {
        bootstrapped = true;
        return scopedKeys();
      },
      environment: environment(),
      spawn: () => completedChild(),
    }),
    /Unsupported local development invocation/u,
  );
  assert.equal(bootstrapped, false);
});

test("rejects listener, dependency, credential, and TLS drift before key bootstrap", async () => {
  const cases = [
    { API_HOST: "0.0.0.0" },
    { API_INTERNAL_URL: "http://127.0.0.1:4001" },
    { API_PORT: "04000" },
    { DATABASE_SSL_MODE: "verify-full" },
    {
      DATABASE_URL:
        "postgresql://nutrition_local:nutrition_local_only@192.0.2.1:5432/nutrition_tracker",
    },
    {
      DATABASE_URL:
        "postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker?host=remote.invalid",
    },
    { ERASURE_REPLAY_LEDGER_ENDPOINT: "http://192.0.2.1:9000" },
    { ERASURE_REPLAY_LEDGER_STORE: "oci" },
    { EXPO_PUBLIC_API_URL: "http://192.0.2.1:4000" },
    { EXPORT_ARTIFACT_ENDPOINT: "https://127.0.0.1:9000" },
    { EXPORT_ARTIFACT_STORE: "oci" },
    { MEILI_PORT: "07700" },
    { MEILI_URL: "http://localhost:7700" },
    { MEILI_URL: "https://127.0.0.1:7700" },
    { OBJECT_STORE_PORT: "09000" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { POSTGRES_PORT: "05432" },
    { S3_ENDPOINT: "http://192.0.2.1:9000" },
    { SHUTDOWN_GRACE_MS: "99" },
    { SHUTDOWN_GRACE_MS: "010000" },
    { SHUTDOWN_GRACE_MS: "300001" },
    { WEB_PUBLIC_ORIGIN: "http://192.0.2.1:3000" },
    { npm_config_strict_ssl: "false" },
    { EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "root-user-must-not-reach-runtime" },
    { EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: "ledger-writer-secret" },
  ];
  for (const override of cases) {
    let bootstrapped = false;
    await assert.rejects(
      runLocalDevelopment([], {
        bootstrap: async () => {
          bootstrapped = true;
          return scopedKeys();
        },
        environment: environment(override),
        spawn: () => completedChild(),
      }),
    );
    assert.equal(bootstrapped, false);
  }
});

test("rejects malformed, master-equivalent, or collapsed scoped keys before launch", async () => {
  for (const keys of [
    {
      MEILI_ADMIN_KEY: adminKey,
      MEILI_SEARCH_KEY: "short",
      MEILI_TASK_OBSERVER_KEY: taskObserverKey,
    },
    {
      MEILI_ADMIN_KEY: adminKey,
      MEILI_SEARCH_KEY: adminKey,
      MEILI_TASK_OBSERVER_KEY: taskObserverKey,
    },
    {
      MEILI_ADMIN_KEY: masterKey,
      MEILI_SEARCH_KEY: searchKey,
      MEILI_TASK_OBSERVER_KEY: taskObserverKey,
    },
    {
      MEILI_ADMIN_KEY: adminKey,
      MEILI_SEARCH_KEY: searchKey,
      MEILI_TASK_OBSERVER_KEY: adminKey,
    },
  ]) {
    let launched = false;
    await assert.rejects(
      runLocalDevelopment([], {
        bootstrap: async () => keys,
        environment: environment(),
        spawn: () => {
          launched = true;
          return completedChild();
        },
      }),
      /split scoped Meilisearch keys/u,
    );
    assert.equal(launched, false);
  }
});

test("reports asynchronous child launch, exit, and signal failures", async () => {
  const cases = [
    {
      assertError: (error) => /Unable to start local development/u.test(error.message),
      spawn: () => {
        throw new Error(`${masterKey} must not leak`);
      },
    },
    {
      assertError: (error) => /Unable to start local development/u.test(error.message),
      spawn: () => completedChild({ error: new Error(`${masterKey} must not leak`) }),
    },
    {
      assertError: (error) => error instanceof LocalDevelopmentProcessError && error.exitCode === 7,
      spawn: () => completedChild({ status: 7 }),
    },
    {
      assertError: (error) =>
        error instanceof LocalDevelopmentProcessError && error.signal === "SIGTERM",
      spawn: () => completedChild({ signal: "SIGTERM", status: null }),
    },
  ];
  for (const testCase of cases) {
    await assert.rejects(
      runLocalDevelopment([], {
        bootstrap: async () => scopedKeys(),
        environment: environment(),
        spawn: testCase.spawn,
      }),
      testCase.assertError,
    );
  }
});

test("forwards supported signals to the child group and disposes every listener", async () => {
  const child = pendingChild();
  const signalRuntime = new EventEmitter();
  const kills = [];
  let groupAlive = true;
  const launched = runLocalDevelopment([], {
    bootstrap: async () => scopedKeys(),
    environment: environment(),
    groupExists: () => groupAlive,
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      if (signal === "SIGKILL") groupAlive = false;
    },
    platform: "linux",
    signalRuntime,
    spawn: () => child,
    terminationGraceMs: 10,
  });
  await delay(0);
  signalRuntime.emit("SIGINT");
  signalRuntime.emit("SIGTERM");
  child.emit("exit", null, "SIGINT");

  await assert.rejects(
    launched,
    (error) => error instanceof LocalDevelopmentProcessError && error.signal === "SIGINT",
  );
  await delay(20);
  assert.deepEqual(kills, [
    { pid: -child.pid, signal: "SIGINT" },
    { pid: -child.pid, signal: "SIGKILL" },
  ]);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(signalRuntime.listenerCount(signal), 0);
  }
});

test("fails closed when a development group survives the post-kill verification deadline", async () => {
  const child = pendingChild();
  const kills = [];
  const launched = runLocalDevelopment([], {
    bootstrap: async () => scopedKeys(),
    environment: environment(),
    groupExists: () => true,
    kill: (pid, signal) => kills.push({ pid, signal }),
    platform: "linux",
    spawn: () => child,
    terminationGraceMs: 1,
  });
  await delay(0);
  child.emit("exit", 0, null);

  await assert.rejects(launched, /Unable to start local development/u);
  assert.deepEqual(kills, [
    { pid: -child.pid, signal: "SIGTERM" },
    { pid: -child.pid, signal: "SIGKILL" },
  ]);
});

test("bounds development cleanup when a killed child omits its terminal event", async () => {
  const child = pendingChild();
  const kills = [];
  let groupAlive = true;
  const signalRuntime = new EventEmitter();
  const launched = runLocalDevelopment([], {
    bootstrap: async () => scopedKeys(),
    environment: environment(),
    groupExists: () => groupAlive,
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      if (signal === "SIGKILL") groupAlive = false;
    },
    platform: "linux",
    signalRuntime,
    spawn: () => child,
    terminationGraceMs: 1,
  });
  await delay(0);
  signalRuntime.emit("SIGTERM");

  await assert.rejects(launched, /Unable to start local development/u);
  assert.deepEqual(kills, [
    { pid: -child.pid, signal: "SIGTERM" },
    { pid: -child.pid, signal: "SIGKILL" },
  ]);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(signalRuntime.listenerCount(signal), 0);
  }
});

test("polls an autonomous failed development group to empty without a delayed SIGKILL", async () => {
  const child = pendingChild();
  const kills = [];
  let groupChecks = 0;
  const signalRuntime = new EventEmitter();
  const launched = runLocalDevelopment([], {
    bootstrap: async () => scopedKeys(),
    environment: environment(),
    groupExists: () => {
      groupChecks += 1;
      return groupChecks === 1;
    },
    kill: (pid, signal) => kills.push({ pid, signal }),
    platform: "linux",
    signalRuntime,
    spawn: () => child,
    terminationGraceMs: 1_000,
  });
  await delay(0);
  child.emit("exit", 7, null);

  await assert.rejects(
    launched,
    (error) => error instanceof LocalDevelopmentProcessError && error.exitCode === 7,
  );
  assert.deepEqual(kills, [{ pid: -child.pid, signal: "SIGTERM" }]);
  assert.equal(groupChecks >= 2, true);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(signalRuntime.listenerCount(signal), 0);
  }
});

test("reads one validated private descriptor and launches without a loader subprocess", async () => {
  const calls = [];
  const closed = [];
  const order = [];
  const unexpandedHome = "$" + "{HOME}";
  const source = `SERVICE_VERSION=${unexpandedHome}\n`;
  await runLocalDevelopmentWithPrivateEnv(["--api-only"], {
    readObjectStoreEnvironment: () => ({
      EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "generated-reader-id",
      EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "generated-reader-secret",
      EXPORT_ARTIFACT_STORE: "s3",
    }),
    bootstrap: async () => scopedKeys(),
    close: (descriptor) => {
      order.push("close");
      closed.push(descriptor);
    },
    environment: environment(),
    fstat: () => ({
      isFile: () => true,
      mode: 0o100600,
      nlink: 1,
      size: Buffer.byteLength(source),
      uid: 1_000,
    }),
    getuid: () => 1_000,
    open: (_path, flags) => {
      if (constants.O_NOFOLLOW !== undefined) {
        assert.equal((flags & constants.O_NOFOLLOW) !== 0, true);
      }
      return 47;
    },
    read: (descriptor) => {
      assert.equal(descriptor, 47);
      order.push("read");
      return source;
    },
    spawn: (command, arguments_, options) => {
      order.push("spawn");
      calls.push({ arguments_, command, options });
      return completedChild();
    },
  });

  assert.deepEqual(closed, [47]);
  assert.deepEqual(order, ["read", "close", "spawn"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].arguments_, localDevelopmentProfiles.apiOnly.turboArguments);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.SERVICE_VERSION, unexpandedHome);
  assert.equal(calls[0].options.env.EXPORT_ARTIFACT_READ_ACCESS_KEY_ID, "generated-reader-id");
  assert.equal(calls[0].options.env.EXPORT_ARTIFACT_STORE, "s3");
  assert.equal(
    Object.hasOwn(calls[0].options.env, "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY"),
    false,
  );
  assert.equal(
    Object.hasOwn(calls[0].options.env, "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY"),
    false,
  );
  assert.equal(Object.hasOwn(calls[0].options.env, "MEILI_MASTER_KEY"), false);
});

test("closes a descriptor and refuses to launch when private metadata is invalid", async () => {
  const closed = [];
  let launched = false;
  await assert.rejects(
    runLocalDevelopmentWithPrivateEnv([], {
      close: (descriptor) => closed.push(descriptor),
      fstat: () => ({
        isFile: () => true,
        mode: 0o100644,
        nlink: 1,
        uid: 1_000,
      }),
      getuid: () => 1_000,
      open: () => 48,
      spawn: () => {
        launched = true;
        return completedChild();
      },
    }),
    /owner-only regular .env file/u,
  );
  assert.deepEqual(closed, [48]);
  assert.equal(launched, false);
});

test("rejects empty, oversized, or concurrently changed private environment content", async () => {
  const cases = [
    { metadataSize: 0, source: "" },
    { metadataSize: 1_048_577, source: "" },
    { metadataSize: 32, source: "SHUTDOWN_GRACE_MS=10000\n" },
  ];
  for (const [index, testCase] of cases.entries()) {
    const closed = [];
    let launched = false;
    await assert.rejects(
      runLocalDevelopmentWithPrivateEnv([], {
        close: (descriptor) => closed.push(descriptor),
        fstat: () => ({
          isFile: () => true,
          mode: 0o100600,
          nlink: 1,
          size: testCase.metadataSize,
          uid: 1_000,
        }),
        getuid: () => 1_000,
        open: () => 60 + index,
        read: () => testCase.source,
        spawn: () => {
          launched = true;
          return completedChild();
        },
      }),
      /owner-only regular .env file/u,
    );
    assert.deepEqual(closed, [60 + index]);
    assert.equal(launched, false);
  }
});

test("refuses to launch when the validated private descriptor cannot be closed", async () => {
  let launched = false;
  const source = "SHUTDOWN_GRACE_MS=10000\n";
  const attempt = runLocalDevelopmentWithPrivateEnv([], {
    close: () => {
      throw new Error("close failed");
    },
    fstat: () => ({
      isFile: () => true,
      mode: 0o100600,
      nlink: 1,
      size: Buffer.byteLength(source),
      uid: 1_000,
    }),
    getuid: () => 1_000,
    open: () => 49,
    read: () => source,
    spawn: () => {
      launched = true;
      return completedChild();
    },
  });
  await assert.rejects(attempt, /Unable to close the private local development environment/u);
  assert.equal(launched, false);
});

test("cleans a lingering descendant after autonomous development success", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  const descendantSource = [
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const leaderSource = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {`,
    '  stdio: ["ignore", "pipe", "ignore"],',
    "});",
    'let ready = "";',
    'child.stdout.setEncoding("utf8");',
    'child.stdout.on("data", (chunk) => {',
    "  ready += chunk;",
    '  if (ready.includes("\\n")) {',
    '    process.stdout.write(JSON.stringify({ leader: process.pid, descendant: child.pid }) + "\\n", () => process.exit(0));',
    "  }",
    "});",
  ].join("\n");
  let actualChild;
  let processTree;
  const launched = runLocalDevelopment([], {
    bootstrap: async () => scopedKeys(),
    environment: environment(),
    spawn: (_command, _arguments, options) => {
      actualChild = spawnProcess(process.execPath, ["-e", leaderSource], {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return actualChild;
    },
    terminationGraceMs: 100,
  });

  try {
    const spawnDeadline = Date.now() + 3_000;
    while (!actualChild && Date.now() < spawnDeadline) await delay(5);
    assert.ok(actualChild, "bounded process fixture must be spawned");
    processTree = await readJsonLine(actualChild.stdout);
    await launched;
    assert.equal(processExists(processTree.leader), false);
    assert.equal(processExists(processTree.descendant), false);
  } finally {
    if (actualChild?.pid) {
      try {
        process.kill(-actualChild.pid, "SIGKILL");
      } catch {
        // The bounded assertions remain authoritative after best-effort fixture cleanup.
      }
    }
    await Promise.race([launched.catch(() => undefined), delay(1_000)]);
  }
});

test("escalates after the leader exits and terminates a signal-ignoring descendant", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  const descendantSource = [
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const leaderSource = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {`,
    '  stdio: ["ignore", "pipe", "ignore"],',
    "});",
    'let ready = "";',
    'child.stdout.setEncoding("utf8");',
    'child.stdout.on("data", (chunk) => {',
    "  ready += chunk;",
    '  if (ready.includes("\\n")) {',
    '    process.stdout.write(JSON.stringify({ leader: process.pid, descendant: child.pid }) + "\\n");',
    "  }",
    "});",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const signalRuntime = new EventEmitter();
  let actualChild;
  let processTree;
  const launched = runLocalDevelopment([], {
    bootstrap: async () => scopedKeys(),
    environment: environment(),
    signalRuntime,
    spawn: (_command, _arguments, options) => {
      actualChild = spawnProcess(process.execPath, ["-e", leaderSource], {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return actualChild;
    },
    terminationGraceMs: 100,
  });
  launched.catch(() => undefined);

  try {
    const spawnDeadline = Date.now() + 3_000;
    while (!actualChild && Date.now() < spawnDeadline) await delay(5);
    assert.ok(actualChild, "bounded process fixture must be spawned");
    processTree = await readJsonLine(actualChild.stdout);
    assert.equal(Number.isInteger(processTree.leader), true);
    assert.equal(Number.isInteger(processTree.descendant), true);
    signalRuntime.emit("SIGTERM");
    await assert.rejects(
      launched,
      (error) => error instanceof LocalDevelopmentProcessError && error.signal === "SIGTERM",
    );
    assert.equal(processExists(processTree.leader), false);
    assert.equal(processExists(processTree.descendant), false);
  } finally {
    if (actualChild?.pid) {
      try {
        process.kill(-actualChild.pid, "SIGKILL");
      } catch {
        // The bounded assertions remain authoritative after best-effort fixture cleanup.
      }
    }
    await Promise.race([launched.catch(() => undefined), delay(1_000)]);
  }
});

test("lets a nested Expo wrapper clear its detached group before parent escalation", {
  skip: process.platform === "win32",
  timeout: 12_000,
}, async () => {
  const descendantSource = [
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const expoLeaderSource = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {`,
    '  stdio: ["ignore", "pipe", "ignore"],',
    "});",
    'let ready = "";',
    'child.stdout.setEncoding("utf8");',
    'child.stdout.on("data", (chunk) => {',
    "  ready += chunk;",
    '  if (ready.includes("\\n")) {',
    '    process.stdout.write(JSON.stringify({ leafLeader: process.pid, descendant: child.pid }) + "\\n");',
    "  }",
    "});",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const expoModuleUrl = new URL("../apps/mobile/scripts/run-expo.mjs", import.meta.url).href;
  const wrapperSource = [
    'import { spawn } from "node:child_process";',
    `import { runExpo } from ${JSON.stringify(expoModuleUrl)};`,
    `const leaderSource = ${JSON.stringify(expoLeaderSource)};`,
    "try {",
    '  await runExpo(["start", "--localhost"], {',
    "    mkdir: () => undefined,",
    "    spawn: (_command, _arguments, options) => {",
    '      const child = spawn(process.execPath, ["-e", leaderSource], {',
    "        ...options,",
    '        stdio: ["ignore", "pipe", "pipe"],',
    "      });",
    "      child.stdout.pipe(process.stdout);",
    "      return child;",
    "    },",
    "  });",
    "} catch {}",
  ].join("\n");
  const signalRuntime = new EventEmitter();
  let actualChild;
  let processTree;
  let launched;
  const startedAt = Date.now();
  launched = runLocalDevelopment([], {
    bootstrap: async () => scopedKeys(),
    environment: environment(),
    signalRuntime,
    spawn: (_command, _arguments, options) => {
      actualChild = spawnProcess(process.execPath, ["--input-type=module", "-e", wrapperSource], {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return actualChild;
    },
  });
  launched.catch(() => undefined);

  try {
    const spawnDeadline = Date.now() + 3_000;
    while (!actualChild && Date.now() < spawnDeadline) await delay(5);
    assert.ok(actualChild, "nested wrapper fixture must be spawned");
    processTree = await readJsonLine(actualChild.stdout);
    assert.equal(Number.isInteger(processTree.leafLeader), true);
    assert.equal(Number.isInteger(processTree.descendant), true);
    signalRuntime.emit("SIGTERM");
    await assert.rejects(
      launched,
      (error) => error instanceof LocalDevelopmentProcessError && error.signal === "SIGTERM",
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs >= nestedProcessTerminationGraceMs - 500,
      `parent returned before the nested ${nestedProcessTerminationGraceMs}ms escalation`,
    );
    assert.ok(
      elapsedMs < localDevelopmentSupervisorGraceMs(10_000),
      "parent should settle as soon as its process group is empty",
    );
    await Promise.all([
      waitForProcessGone(actualChild.pid),
      waitForProcessGone(processTree.leafLeader),
      waitForProcessGone(processTree.descendant),
    ]);
  } finally {
    for (const pid of [actualChild?.pid, processTree?.leafLeader]) {
      if (!pid) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The bounded assertions remain authoritative after best-effort fixture cleanup.
      }
    }
    await Promise.race([launched?.catch(() => undefined), delay(1_000)]);
  }
});

test("derives an explicit leaf-service-supervisor shutdown hierarchy", () => {
  assert.equal(localDevelopmentProfiles.apiOnly.serviceShutdownPhases, 1);
  assert.equal(localDevelopmentProfiles.full.serviceShutdownPhases, 2);
  assert.equal(localDevelopmentSupervisorGraceMs(10_000, 1), 15_000);
  assert.equal(localDevelopmentSupervisorGraceMs(10_000, 2), 25_000);
  assert.equal(
    localDevelopmentSupervisorGraceMs(100, 1),
    nestedProcessTerminationGraceMs + supervisorTerminationMarginMs,
  );
  assert.ok(localDevelopmentSupervisorGraceMs(10_000, 2) > 20_000);
  assert.ok(localDevelopmentSupervisorGraceMs(10_000, 1) > nestedProcessTerminationGraceMs);
});

test("accepts the exact synthetic loopback fixture", () => {
  assert.doesNotThrow(() => assertLocalDevelopmentEnvironment(environment()));
});

test("permits only exact loopback Mailpit settings in the guarded runtime", () => {
  const mailpit = {
    EMAIL_VERIFICATION_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    PASSWORD_RECOVERY_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    MAILPIT_SMTP_PORT: "1025",
    SMTP_FROM: "Nutrition Tracker Local <no-reply@nutrition.local>",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1025",
  };
  assert.doesNotThrow(() => assertLocalDevelopmentEnvironment(environment(mailpit)));
  for (const override of [
    { SMTP_HOST: "localhost" },
    { SMTP_PORT: "2525" },
    { MAILPIT_SMTP_PORT: "2525" },
    { EMAIL_VERIFICATION_PUBLIC_ORIGIN: "https://example.invalid" },
    { PASSWORD_RECOVERY_PUBLIC_ORIGIN: "http://localhost:3000" },
    { SMTP_FROM: "safe@nutrition.local\r\nBcc: private@example.com" },
  ]) {
    assert.throws(
      () => assertLocalDevelopmentEnvironment(environment({ ...mailpit, ...override })),
      /loopback Mailpit SMTP|loopback (?:email-verification|password-recovery) web origin fixture/u,
    );
  }
});

test("refuses an invalid generated object-store overlay before bootstrap or launch", async () => {
  const source = "SHUTDOWN_GRACE_MS=10000\n";
  let launched = false;
  await assert.rejects(
    runLocalDevelopmentWithPrivateEnv([], {
      open: () => 77,
      close: () => {},
      getuid: () => 1000,
      fstat: () => ({
        isFile: () => true,
        mode: 0o100600,
        nlink: 1,
        size: Buffer.byteLength(source),
        uid: 1000,
      }),
      read: () => source,
      readObjectStoreEnvironment: () => {
        throw new Error("protected-input");
      },
      bootstrap: () => {
        launched = true;
      },
      spawn: () => {
        launched = true;
      },
    }),
    { message: "Unable to load the private local development environment" },
  );
  assert.equal(launched, false);
});

function privateEnvironmentFixture(privateEnvironment, overrides = {}) {
  const source = Object.entries(privateEnvironment)
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
    .join("\n");
  return {
    close: () => {},
    fstat: () => ({
      isFile: () => true,
      mode: 0o100600,
      nlink: 1,
      size: Buffer.byteLength(source),
      uid: 1000,
    }),
    getuid: () => 1000,
    open: () => 81,
    read: () => source,
    readObjectStoreEnvironment: () => ({}),
    ...overrides,
  };
}

for (const arguments_ of [
  ["--doppler"],
  ["--doppler", "--api-only"],
  ["--api-only", "--doppler"],
]) {
  test(`uses only selected Doppler inputs after protected loaders: ${arguments_.join(" ")}`, async () => {
    const profile = arguments_.includes("--api-only")
      ? localDevelopmentProfiles.apiOnly
      : localDevelopmentProfiles.full;
    const privateEnvironment = Object.freeze(
      environment({
        POSTGRES_PASSWORD: "doppler-synthetic-password",
        SEARCH_CURSOR_SECRET: "file-cursor-secret",
        SERVICE_VERSION: "file-version",
      }),
    );
    const injected = Object.freeze({
      API_HOST: "192.0.2.1",
      DATABASE_URL:
        "postgresql://nutrition_local:doppler-synthetic-password@127.0.0.1:5432/nutrition_tracker",
      DOPPLER_CONFIG: "dev",
      DOPPLER_PROJECT: "nourishing",
      DOPPLER_TOKEN: "synthetic-token-excluded",
      EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "ambient-reader-secret-excluded",
      SEARCH_CURSOR_SECRET: "  injected-cursor-secret  ",
      SERVICE_VERSION: "ambient-version-excluded",
      VAULT_TOKEN: "synthetic-vault-token-excluded",
    });
    const objectStore = Object.freeze({
      DATABASE_URL: "postgresql://overlay.invalid/must-not-win",
      EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "generated-reader-id",
      EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "generated-reader-secret",
      EXPORT_ARTIFACT_STORE: "s3",
      SEARCH_CURSOR_SECRET: "overlay-cursor-secret-excluded",
    });
    const order = [];
    const calls = [];
    const fixture = privateEnvironmentFixture(privateEnvironment);
    await runLocalDevelopmentWithPrivateEnv(arguments_, {
      ...fixture,
      environment: injected,
      open: (path, flags) => {
        order.push("open");
        assert.equal(path.endsWith("/.env"), true);
        assert.equal((flags & constants.O_NOFOLLOW) !== 0, true);
        return 81;
      },
      read: (descriptor) => {
        order.push("read");
        assert.equal(descriptor, 81);
        return fixture.read();
      },
      close: (descriptor) => {
        order.push("close");
        assert.equal(descriptor, 81);
      },
      readObjectStoreEnvironment: () => {
        order.push("object-store");
        return objectStore;
      },
      bootstrap: async (options) => {
        order.push("bootstrap");
        assert.deepEqual(options, { endpoint: "http://127.0.0.1:7700", masterKey, port: "7700" });
        return scopedKeys();
      },
      spawn: (command, childArguments, options) => {
        order.push("spawn");
        calls.push({ command, childArguments, options });
        return completedChild();
      },
    });
    assert.deepEqual(order, ["open", "read", "close", "object-store", "bootstrap", "spawn"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "pnpm");
    assert.deepEqual(calls[0].childArguments, profile.turboArguments);
    const childEnvironment = calls[0].options.env;
    assert.deepEqual(
      childEnvironment,
      localDevelopmentChildEnvironment(
        {
          ...privateEnvironment,
          ...objectStore,
          DATABASE_URL: injected.DATABASE_URL,
          SEARCH_CURSOR_SECRET: injected.SEARCH_CURSOR_SECRET,
        },
        scopedKeys(),
        profile,
      ),
    );
    assert.equal(childEnvironment.DATABASE_URL, injected.DATABASE_URL);
    assert.equal(childEnvironment.SEARCH_CURSOR_SECRET, injected.SEARCH_CURSOR_SECRET);
    assert.equal(childEnvironment.SERVICE_VERSION, "file-version");
    assert.equal(
      childEnvironment.EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY,
      "generated-reader-secret",
    );
    for (const field of [
      "DOPPLER_TOKEN",
      "DOPPLER_CONFIG",
      "DOPPLER_PROJECT",
      "VAULT_TOKEN",
      "MEILI_MASTER_KEY",
      "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY",
      "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    ]) {
      assert.equal(Object.hasOwn(childEnvironment, field), false, `${field} must be excluded`);
    }
    assert.equal(privateEnvironment.SEARCH_CURSOR_SECRET, "file-cursor-secret");
    assert.equal(objectStore.SEARCH_CURSOR_SECRET, "overlay-cursor-secret-excluded");
    assert.equal(injected.API_HOST, "192.0.2.1");
  });
}

for (const arguments_ of [["--doppler"], ["--api-only", "--doppler"]]) {
  for (const field of ["DATABASE_URL", "SEARCH_CURSOR_SECRET"]) {
    for (const value of [undefined, "", " \t "]) {
      test(`refuses ${field} ${value === undefined ? "missing" : value === "" ? "empty" : "blank"} before private loading: ${arguments_.join(" ")}`, async () => {
        let sideEffects = 0;
        const privateEnvironment = environment({ SEARCH_CURSOR_SECRET: "file-fallback-forbidden" });
        await assert.rejects(
          runLocalDevelopmentWithPrivateEnv(
            arguments_,
            privateEnvironmentFixture(privateEnvironment, {
              environment: { ...privateEnvironment, [field]: value },
              open: () => {
                sideEffects += 1;
                return 81;
              },
              readObjectStoreEnvironment: () => {
                sideEffects += 1;
                return {};
              },
              bootstrap: async () => {
                sideEffects += 1;
                return scopedKeys();
              },
              spawn: () => {
                sideEffects += 1;
                return completedChild();
              },
            }),
          ),
          { message: `Local development Doppler mode requires injected ${field}` },
        );
        assert.equal(sideEffects, 0);
      });
    }
  }
}

for (const arguments_ of [[], ["--api-only"]]) {
  test(`keeps the private file source without Doppler selection: ${arguments_.join(" ") || "full"}`, async () => {
    const privateEnvironment = Object.freeze(
      environment({ SEARCH_CURSOR_SECRET: "file-cursor-secret" }),
    );
    let childEnvironment;
    await runLocalDevelopmentWithPrivateEnv(
      arguments_,
      privateEnvironmentFixture(privateEnvironment, {
        environment: {
          DATABASE_URL: "postgresql://ambient.invalid/excluded",
          SEARCH_CURSOR_SECRET: "",
        },
        bootstrap: async () => scopedKeys(),
        spawn: (_command, _arguments, options) => {
          childEnvironment = options.env;
          return completedChild();
        },
      }),
    );
    assert.equal(childEnvironment.DATABASE_URL, privateEnvironment.DATABASE_URL);
    assert.equal(childEnvironment.SEARCH_CURSOR_SECRET, privateEnvironment.SEARCH_CURSOR_SECRET);
  });
}

test("rejects duplicate and unsupported Doppler arguments before private loading", async () => {
  let opened = false;
  for (const arguments_ of [
    ["--doppler", "--doppler"],
    ["--api-only", "--api-only", "--doppler"],
    ["--doppler", "--api-only", "--other"],
    ["--doppler=dev"],
  ]) {
    await assert.rejects(
      runLocalDevelopmentWithPrivateEnv(arguments_, {
        open: () => {
          opened = true;
        },
      }),
      /Unsupported local development invocation/u,
    );
  }
  assert.equal(opened, false);
});

test("Doppler selection retains private descriptor and object-store failures", async () => {
  const privateEnvironment = environment({ SEARCH_CURSOR_SECRET: "synthetic-cursor-secret" });
  let bootstrapped = false;
  let launched = false;
  let closed = 0;
  for (const failure of ["metadata", "close", "object-store"]) {
    const fixture = privateEnvironmentFixture(privateEnvironment);
    await assert.rejects(
      runLocalDevelopmentWithPrivateEnv(["--doppler"], {
        ...fixture,
        environment: privateEnvironment,
        fstat: () => ({
          ...fixture.fstat(),
          ...(failure === "metadata" ? { mode: 0o100644 } : {}),
        }),
        close: () => {
          closed += 1;
          if (failure === "close") throw new Error("synthetic-close-failure");
        },
        readObjectStoreEnvironment: () => {
          throw new Error("synthetic-object-store-failure");
        },
        bootstrap: async () => {
          bootstrapped = true;
          return scopedKeys();
        },
        spawn: () => {
          launched = true;
          return completedChild();
        },
      }),
      {
        message:
          failure === "metadata"
            ? "Local development requires an owner-only regular .env file"
            : failure === "close"
              ? "Unable to close the private local development environment"
              : "Unable to load the private local development environment",
      },
    );
  }
  assert.equal(closed, 3);
  assert.equal(bootstrapped, false);
  assert.equal(launched, false);
});

test("validates the selected Doppler database before bootstrap without a private fallback", async () => {
  let bootstrapped = false;
  let launched = false;
  const privateEnvironment = environment({ SEARCH_CURSOR_SECRET: "synthetic-cursor-secret" });
  await assert.rejects(
    runLocalDevelopmentWithPrivateEnv(
      ["--doppler"],
      privateEnvironmentFixture(privateEnvironment, {
        environment: {
          DATABASE_URL:
            "postgresql://nutrition_local:nutrition_local_only@192.0.2.1:5432/nutrition_tracker",
          SEARCH_CURSOR_SECRET: "synthetic-injected-cursor-secret",
        },
        bootstrap: async () => {
          bootstrapped = true;
          return scopedKeys();
        },
        spawn: () => {
          launched = true;
          return completedChild();
        },
      }),
    ),
    /loopback PostgreSQL fixture/u,
  );
  assert.equal(bootstrapped, false);
  assert.equal(launched, false);
});

test("the runtime seam also rejects missing Doppler inputs before bootstrap", async () => {
  let bootstrapped = false;
  let launched = false;
  await assert.rejects(
    runLocalDevelopment(["--doppler"], {
      environment: environment({ SEARCH_CURSOR_SECRET: " \t" }),
      bootstrap: async () => {
        bootstrapped = true;
        return scopedKeys();
      },
      spawn: () => {
        launched = true;
        return completedChild();
      },
    }),
    { message: "Local development Doppler mode requires injected SEARCH_CURSOR_SECRET" },
  );
  assert.equal(bootstrapped, false);
  assert.equal(launched, false);
});

for (const field of ["DATABASE_URL", "SEARCH_CURSOR_SECRET"]) {
  test(`rejects inherited Doppler ${field} before private loading`, async () => {
    const privateEnvironment = environment({
      SEARCH_CURSOR_SECRET: "synthetic-file-cursor-secret",
    });
    const injected = {
      DATABASE_URL: privateEnvironment.DATABASE_URL,
      SEARCH_CURSOR_SECRET: "synthetic-injected-cursor-secret",
    };
    const suppliedEnvironment = Object.assign(
      Object.create({ [field]: injected[field] }),
      injected,
    );
    delete suppliedEnvironment[field];
    assert.equal(Object.hasOwn(suppliedEnvironment, field), false);
    let sideEffects = 0;
    await assert.rejects(
      runLocalDevelopmentWithPrivateEnv(
        ["--doppler"],
        privateEnvironmentFixture(privateEnvironment, {
          environment: suppliedEnvironment,
          open: () => {
            sideEffects += 1;
            return 81;
          },
          readObjectStoreEnvironment: () => {
            sideEffects += 1;
            return {};
          },
          bootstrap: async () => {
            sideEffects += 1;
            return scopedKeys();
          },
          spawn: () => {
            sideEffects += 1;
            return completedChild();
          },
        }),
      ),
      { message: `Local development Doppler mode requires injected ${field}` },
    );
    assert.equal(sideEffects, 0);
  });
}
