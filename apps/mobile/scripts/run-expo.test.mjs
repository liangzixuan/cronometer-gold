import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ExpoProcessError, runExpo } from "./run-expo.mjs";

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
  assert.equal(calls[0].command, "expo");
  assert.deepEqual(calls[0].arguments_, ["start", "--localhost"]);
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
    mkdir: () => undefined,
    spawn: (command, arguments_) => {
      calls.push({ arguments_, command });
      return fakeChild();
    },
  });
  assert.deepEqual(calls, [{ arguments_: ["install", "--check"], command: "expo" }]);
});

test("preserves child exit status and forwards supported signals to the child group", async () => {
  await assert.rejects(
    runExpo(["export", "--platform", "all", "--output-dir", "dist"], {
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
