import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { WindowsOwnedProcessError } from "../../../scripts/windows-owned-process.mjs";

import {
  ExpoProcessError,
  prepareWindowsExpo,
  readExpoNativeConfig,
  resolveExpoCli,
  runExpo,
} from "./run-expo.mjs";

let nextFakePid = 30_000;

function fakeChild({ signal = null, status = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  queueMicrotask(() => child.emit("exit", status, signal));
  return child;
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

function readJsonLine(stream, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const dispose = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onFailure);
      stream.removeListener("end", onFailure);
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
    const onFailure = () => {
      dispose();
      reject(new Error("Bounded Expo fixture failed before reporting its process tree"));
    };
    const timer = setTimeout(onFailure, timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.once("error", onFailure);
    stream.once("end", onFailure);
  });
}

test("starts Expo detached with private home and telemetry disabled", async () => {
  const calls = [];
  const directories = [];
  await runExpo(["start", "--localhost"], {
    platform: "linux",
    groupExists: () => false,
    environment: {
      PATH: "/usr/bin",
      UNRELATED: "kept-for-compatible-direct-invocation",
    },
    mkdir: (path, options) => directories.push({ options, path }),
    spawn: (command, arguments_, options) => {
      calls.push({ arguments_, command, options });
      return fakeChild();
    },
  });

  assert.equal(directories.length, 1);
  assert.deepEqual(directories[0].options, { recursive: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].arguments_[0], resolveExpoCli());
  assert.deepEqual(calls[0].arguments_.slice(1), ["start", "--localhost"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[0].options.env.EXPO_NO_TELEMETRY, "1");
  assert.equal(calls[0].options.env.UNRELATED, "kept-for-compatible-direct-invocation");
  assert.equal(typeof calls[0].options.env.__UNSAFE_EXPO_HOME_DIRECTORY, "string");
});

test("rejects every unreviewed Expo argument shape before filesystem or process access", async () => {
  const cases = [
    [],
    ["start"],
    ["start", "--lan"],
    ["start", "--tunnel"],
    ["start", "--localhost", "--host", "lan"],
    ["start", "--localhost", "--clear"],
    ["install"],
    ["export", "--platform", "all", "--output-dir", "other"],
  ];
  for (const arguments_ of cases) {
    let touched = false;
    await assert.rejects(
      runExpo(arguments_, {
        mkdir: () => {
          touched = true;
        },
        spawn: () => {
          touched = true;
          return fakeChild();
        },
      }),
      /not reviewed for this repository/u,
    );
    assert.equal(touched, false);
  }
});

test("accepts the exact dependency-check Expo invocation", async () => {
  const calls = [];
  await runExpo(["install", "--check"], {
    platform: "linux",
    groupExists: () => false,
    mkdir: () => undefined,
    spawn: (command, arguments_) => {
      calls.push({ arguments_, command });
      return fakeChild();
    },
  });
  assert.deepEqual(calls, [
    { arguments_: [resolveExpoCli(), "install", "--check"], command: process.execPath },
  ]);
});

test("preserves child exit status and forwards supported signals to the child group", async () => {
  await assert.rejects(
    runExpo(["export", "--platform", "all", "--output-dir", "dist"], {
      platform: "linux",
      groupExists: () => false,
      mkdir: () => undefined,
      spawn: () => fakeChild({ status: 9 }),
    }),
    (error) => error instanceof ExpoProcessError && error.exitCode === 9,
  );

  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  const kills = [];
  let groupAlive = true;
  const signalRuntime = new EventEmitter();
  const launched = runExpo(["start", "--localhost"], {
    groupExists: () => groupAlive,
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      if (signal === "SIGKILL") groupAlive = false;
    },
    mkdir: () => undefined,
    platform: "linux",
    signalRuntime,
    spawn: () => child,
    terminationGraceMs: 10,
  });
  await delay(0);
  signalRuntime.emit("SIGHUP");
  signalRuntime.emit("SIGTERM");
  child.emit("exit", null, "SIGHUP");
  await assert.rejects(
    launched,
    (error) => error instanceof ExpoProcessError && error.signal === "SIGHUP",
  );
  await delay(20);
  assert.deepEqual(kills, [
    { pid: -child.pid, signal: "SIGHUP" },
    { pid: -child.pid, signal: "SIGKILL" },
  ]);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(signalRuntime.listenerCount(signal), 0);
  }
});

test("fails closed when an Expo group survives the post-kill verification deadline", async () => {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  const kills = [];
  const launched = runExpo(["start", "--localhost"], {
    groupExists: () => true,
    kill: (pid, signal) => kills.push({ pid, signal }),
    mkdir: () => undefined,
    platform: "linux",
    spawn: () => child,
    terminationGraceMs: 1,
  });
  child.emit("exit", 0, null);

  await assert.rejects(launched, /Unable to start Expo/u);
  assert.deepEqual(kills, [
    { pid: -child.pid, signal: "SIGTERM" },
    { pid: -child.pid, signal: "SIGKILL" },
  ]);
});

test("bounds Expo cleanup when a killed child omits its terminal event", async () => {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  const kills = [];
  let groupAlive = true;
  const signalRuntime = new EventEmitter();
  const launched = runExpo(["start", "--localhost"], {
    groupExists: () => groupAlive,
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      if (signal === "SIGKILL") groupAlive = false;
    },
    mkdir: () => undefined,
    platform: "linux",
    signalRuntime,
    spawn: () => child,
    terminationGraceMs: 1,
  });
  await delay(0);
  signalRuntime.emit("SIGTERM");

  await assert.rejects(launched, /Unable to start Expo/u);
  assert.deepEqual(kills, [
    { pid: -child.pid, signal: "SIGTERM" },
    { pid: -child.pid, signal: "SIGKILL" },
  ]);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(signalRuntime.listenerCount(signal), 0);
  }
});

test("settles immediately after a signaled Expo process group is empty", async () => {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  const kills = [];
  const signalRuntime = new EventEmitter();
  const launched = runExpo(["start", "--localhost"], {
    groupExists: () => false,
    kill: (pid, signal) => kills.push({ pid, signal }),
    mkdir: () => undefined,
    platform: "linux",
    signalRuntime,
    spawn: () => child,
    terminationGraceMs: 60_000,
  });
  await delay(0);
  signalRuntime.emit("SIGTERM");
  child.emit("exit", null, "SIGTERM");

  await assert.rejects(
    launched,
    (error) => error instanceof ExpoProcessError && error.signal === "SIGTERM",
  );
  assert.deepEqual(kills, [{ pid: -child.pid, signal: "SIGTERM" }]);
});

test("polls an autonomous failed Expo group to empty without a delayed SIGKILL", async () => {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.kill = () => true;
  const kills = [];
  let groupChecks = 0;
  const signalRuntime = new EventEmitter();
  const launched = runExpo(["start", "--localhost"], {
    groupExists: () => {
      groupChecks += 1;
      return groupChecks === 1;
    },
    kill: (pid, signal) => kills.push({ pid, signal }),
    mkdir: () => undefined,
    platform: "linux",
    signalRuntime,
    spawn: () => child,
    terminationGraceMs: 1_000,
  });
  child.emit("exit", 9, null);

  await assert.rejects(
    launched,
    (error) => error instanceof ExpoProcessError && error.exitCode === 9,
  );
  assert.deepEqual(kills, [{ pid: -child.pid, signal: "SIGTERM" }]);
  assert.equal(groupChecks >= 2, true);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(signalRuntime.listenerCount(signal), 0);
  }
});

test("cleans a lingering descendant after autonomous Expo success", {
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
  const launched = runExpo(["start", "--localhost"], {
    mkdir: () => undefined,
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

test("escalates after Expo exits and terminates a signal-ignoring descendant", {
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
  const launched = runExpo(["start", "--localhost"], {
    mkdir: () => undefined,
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
    processTree = await readJsonLine(actualChild.stdout);
    assert.equal(Number.isInteger(processTree.leader), true);
    assert.equal(Number.isInteger(processTree.descendant), true);
    signalRuntime.emit("SIGTERM");
    await assert.rejects(
      launched,
      (error) => error instanceof ExpoProcessError && error.signal === "SIGTERM",
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

function windowsDependencies(extra = {}) {
  return {
    platform: "win32",
    execPath: "C:\\Node\\node.exe",
    environment: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Node;C:\\Tools",
      EXPO_PUBLIC_API_URL: "https://native-qualification.invalid",
    },
    readdir: () => [".env.example"],
    ...extra,
  };
}

test("Windows projects only reviewed frontend settings and retains online headless validation", () => {
  const dependencies = windowsDependencies();
  Object.assign(dependencies.environment, {
    DATABASE_URL: "database-canary",
    DOPPLER_TOKEN: "doppler-canary",
    AWS_SECRET_ACCESS_KEY: "aws-canary",
    SMTP_PASS: "mail-canary",
    EXPO_PUBLIC_UNREVIEWED: "public-canary",
    NODE_ENV: "unreviewed-mode",
    BABEL_ENV: "unreviewed-mode",
    NOURISHING_POWERSHELL: "C:\\Tools\\pwsh.exe",
  });
  const plan = prepareWindowsExpo(["install", "--check"], dependencies);
  assert.equal(plan.executable, "C:\\Node\\node.exe");
  assert.deepEqual(plan.arguments, [resolveExpoCli(), "install", "--check"]);
  assert.equal(plan.powershellPath, "C:\\Tools\\pwsh.exe");
  assert.equal(plan.environment.PATH, "C:\\Node;C:\\Windows\\System32");
  assert.equal(plan.environment.EXPO_PUBLIC_API_URL, "https://native-qualification.invalid");
  assert.equal(plan.environment.NODE_ENV, "development");
  assert.equal(plan.environment.BABEL_ENV, "development");
  assert.equal(plan.environment.CI, "1");
  assert.equal(plan.environment.EXPO_UNSTABLE_HEADLESS, "1");
  assert.equal(plan.environment.EXPO_NO_DEPENDENCY_VALIDATION, "0");
  assert.equal(plan.environment.EXPO_NO_NEW_ARCH_COMPAT_CHECK, "0");
  assert.equal(plan.environment.EXPO_NO_DOTENV, "1");
  assert.equal(Object.hasOwn(plan.environment, "EXPO_OFFLINE"), false);
  assert.equal(
    Object.values(plan.environment).some((value) => value.includes("canary")),
    false,
  );
  assert.equal(Object.hasOwn(plan.environment, "NOURISHING_POWERSHELL"), false);
});

test("Windows refuses case collisions, inherited fields, injection, bypasses and private dotenv", () => {
  for (const extra of [
    { systemroot: "C:\\Other" },
    { NODE_OPTIONS: "--import=untrusted" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { NODE_EXTRA_CA_CERTS: "other.pem" },
    { EXPO_OFFLINE: "0" },
    { EXPO_NO_DEPENDENCY_VALIDATION: "1" },
    { EXPO_NO_NEW_ARCH_COMPAT_CHECK: "1" },
    { EXPO_NO_DOTENV: "0" },
    { npm_config_strict_ssl: "false" },
    { npm_config_offline: "true" },
  ]) {
    const dependencies = windowsDependencies();
    Object.assign(dependencies.environment, extra);
    assert.throws(() => prepareWindowsExpo(["install", "--check"], dependencies));
  }
  const inherited = windowsDependencies();
  Object.setPrototypeOf(inherited.environment, { DOPPLER_TOKEN: "inherited" });
  assert.throws(() => prepareWindowsExpo(["install", "--check"], inherited), /Inherited/u);
  for (const name of [".env", ".env.local", ".env.production", ".ENV"]) {
    assert.throws(
      () =>
        prepareWindowsExpo(["install", "--check"], windowsDependencies({ readdir: () => [name] })),
      /dotenv/u,
    );
  }
});

test("Windows requires an exact separate development API origin without a fallback", () => {
  for (const value of [
    undefined,
    "https://nourishing.app",
    "http://localhost:4000",
    "https://dev-api.nourishing.app/",
    "https://dev-api.nourishing.app?production=1",
  ]) {
    const dependencies = windowsDependencies();
    if (value === undefined) delete dependencies.environment.EXPO_PUBLIC_API_URL;
    else dependencies.environment.EXPO_PUBLIC_API_URL = value;
    assert.throws(
      () => prepareWindowsExpo(["install", "--check"], dependencies),
      /exact hosted development/u,
    );
  }
});

test("Windows start rejects before any filesystem or process access", async () => {
  let touched = false;
  await assert.rejects(
    runExpo(
      ["start", "--localhost"],
      windowsDependencies({
        readdir: () => {
          touched = true;
          return [];
        },
        mkdir: () => {
          touched = true;
        },
        runWindowsOwnedProcess: () => {
          touched = true;
        },
      }),
    ),
    /only finite/u,
  );
  assert.equal(touched, false);
});

test("Windows finite export uses owned adapter and config parses its captured JSON", async () => {
  const calls = [];
  const writes = [];
  const dependencies = windowsDependencies({
    mkdir() {},
    stdout: { write: (value) => writes.push(value) },
    stderr: { write() {} },
    runWindowsOwnedProcess: async (plan) => {
      calls.push(plan);
      return {
        stdout: plan.arguments[1] === "config" ? '{"newArchEnabled":true}' : "exported",
        stderr: "",
      };
    },
  });
  await runExpo(["export", "--platform", "all", "--output-dir", "dist"], dependencies);
  assert.equal(calls[0].environment.NODE_ENV, "production");
  assert.equal(calls[0].timeoutMs, 240_000);
  assert.deepEqual(writes, ["exported"]);
  assert.deepEqual(await readExpoNativeConfig(dependencies), { newArchEnabled: true });
  assert.deepEqual(calls[1].arguments.slice(1), ["config", "--type", "introspect", "--json"]);
  assert.equal(calls[1].maxOutputBytes, 20_000_000);
});

test("installed Expo identity and exact pin are checked before launch", () => {
  for (const expoManifest of [
    { name: "other", version: "57.0.26", bin: { expo: "bin/cli" } },
    { name: "expo", version: "57.0.25", bin: { expo: "bin/cli" } },
    { name: "expo", version: "57.0.26", bin: { expo: "other" } },
  ])
    assert.throws(() => resolveExpoCli({ expoManifest }), /exact repository identity/u);
});

test("Windows failures preserve only bounded captured application diagnostics", async () => {
  for (const failure of [
    new WindowsOwnedProcessError("command did not complete naturally", {
      stdout: "dependency report\\n",
      stderr: "incompatible Expo version\\n",
      activeZero: true,
      outputDrained: true,
      status: 1,
    }),
    new Error("controller-private-detail"),
  ]) {
    const output = { stdout: [], stderr: [] };
    const dependencies = windowsDependencies({
      mkdir() {},
      stdout: {
        write(value) {
          output.stdout.push(value);
        },
      },
      stderr: {
        write(value) {
          output.stderr.push(value);
        },
      },
      runWindowsOwnedProcess: async () => {
        throw failure;
      },
    });
    await assert.rejects(
      runExpo(["install", "--check"], dependencies),
      (error) => error === failure,
    );
    if (failure instanceof WindowsOwnedProcessError) {
      assert.deepEqual(output, {
        stdout: ["dependency report\\n"],
        stderr: ["incompatible Expo version\\n"],
      });
    } else assert.deepEqual(output, { stdout: [], stderr: [] });
  }
});

test("Windows projects only the exact hosted profile and rejects development release selection", () => {
  const dependencies = windowsDependencies();
  Object.assign(dependencies.environment, {
    EXPO_PUBLIC_NOURISHING_PROFILE: "hosted-development",
    EXPO_PUBLIC_API_URL: "https://dev-api.nourishing.app",
    EXPO_PUBLIC_UNREVIEWED: "private-canary",
  });
  const plan = prepareWindowsExpo(
    ["export", "--platform", "all", "--output-dir", "dist"],
    dependencies,
  );
  assert.equal(plan.environment.EXPO_PUBLIC_NOURISHING_PROFILE, "hosted-development");
  assert.equal(plan.environment.EXPO_PUBLIC_API_URL, "https://dev-api.nourishing.app");
  assert.equal(Object.hasOwn(plan.environment, "EXPO_PUBLIC_UNREVIEWED"), false);
  for (const invalid of [
    undefined,
    "",
    "https://api.nourishing.app",
    "http://127.0.0.1:4000",
    "https://native-qualification.invalid",
  ]) {
    const environment = { ...dependencies.environment };
    if (invalid === undefined) delete environment.EXPO_PUBLIC_API_URL;
    else environment.EXPO_PUBLIC_API_URL = invalid;
    assert.throws(
      () => prepareWindowsExpo(["install", "--check"], { ...dependencies, environment }),
      /exact selector and API origin/u,
    );
  }
  for (const [name, value] of [
    ["EAS_BUILD_PROFILE", "production"],
    ["EAS_BUILD_PROFILE", "physical-device"],
    ["EAS_ENVIRONMENT", "preview"],
    ["EAS_ENVIRONMENT", "production"],
    ["EAS_BUILD", "true"],
  ]) {
    assert.throws(
      () =>
        prepareWindowsExpo(["install", "--check"], {
          ...dependencies,
          environment: { ...dependencies.environment, [name]: value },
        }),
      /not an approved native build or release/u,
    );
  }
});

test("POSIX rejects development release intent before config or Expo process creation", async () => {
  for (const [name, value] of [
    ["EAS_BUILD_PROFILE", "production"],
    ["EAS_BUILD_PROFILE", "physical-device"],
    ["EAS_ENVIRONMENT", "preview"],
    ["EAS_ENVIRONMENT", "production"],
    ["EAS_BUILD", "true"],
  ]) {
    const dependencies = {
      platform: "linux",
      environment: {
        EXPO_PUBLIC_NOURISHING_PROFILE: "hosted-development",
        EXPO_PUBLIC_API_URL: "https://dev-api.nourishing.app",
        [name]: value,
      },
      mkdir: () => assert.fail("no directory before validation"),
      spawn: () => assert.fail("no child before validation"),
      spawnSync: () => assert.fail("no config child before validation"),
    };
    await assert.rejects(
      runExpo(["export", "--platform", "all", "--output-dir", "dist"], dependencies),
      /not an approved native build or release/u,
    );
    await assert.rejects(
      readExpoNativeConfig(dependencies),
      /not an approved native build or release/u,
    );
  }
});

test("all maintained mobile request consumers use the bound native transport", () => {
  const files = [
    "App.tsx",
    "src/auth/AuthScreen.tsx",
    "src/search/FoodSearchScreen.tsx",
    "src/diary/DiaryDayNote.tsx",
    "src/diary/DiaryScreen.tsx",
    "src/reports/ReportsScreen.tsx",
    "src/recipes/RecipesScreen.tsx",
    "src/recipes/GoalsScreen.tsx",
    "src/recipes/PastedIngredientReview.tsx",
    "src/activity/ActivityScreen.tsx",
    "src/retention/RetentionScreen.tsx",
    "src/retention/ErasureStatusScreen.tsx",
    "src/retention/erasure-recovery.ts",
    "src/hydration/HydrationScreen.tsx",
  ];
  for (const path of files) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /import \{ mobileFetch \}/u);
    assert.doesNotMatch(source, /\bfetch\s*\(/u);
  }
});
