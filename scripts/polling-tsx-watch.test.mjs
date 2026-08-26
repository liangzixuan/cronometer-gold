import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { FSEVENTS_GUARD, POLLING_ENVIRONMENT, runWatcher, TSX_CLI } from "./polling-tsx-watch.mjs";

const WRAPPER = fileURLToPath(new URL("./polling-tsx-watch.mjs", import.meta.url));

async function waitForRuns(path, minimum) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const runs = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      if (runs.length >= minimum) {
        return runs;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(100);
  }
  assert.fail(`polling watcher did not reach ${minimum} runs`);
}

async function stopProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  const target = process.platform === "win32" ? child.pid : -child.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(target, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

test("starts the pinned watcher with polling and no shell", () => {
  let observed;
  const status = runWatcher(
    ["--include", "src/**/*.ts", "script.mjs"],
    (executable, arguments_, options) => {
      observed = { arguments_, executable, options };
      return { error: undefined, signal: null, status: 0 };
    },
    { PATH: "/bin" },
  );

  assert.equal(status, 0);
  assert.deepEqual(observed, {
    arguments_: [
      "--require",
      FSEVENTS_GUARD,
      TSX_CLI,
      "watch",
      "--include",
      "src/**/*.ts",
      "script.mjs",
    ],
    executable: process.execPath,
    options: {
      env: { PATH: "/bin", ...POLLING_ENVIRONMENT },
      shell: false,
      stdio: "inherit",
    },
  });
});

test("the scoped preload rejects a resolvable fsevents module", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "nutrition-fsevents-guard-"));
  const moduleDirectory = join(directory, "node_modules", "fsevents");
  mkdirSync(moduleDirectory, { recursive: true });
  writeFileSync(join(moduleDirectory, "index.js"), "module.exports = { marker: true };\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const baseline = spawnSync(
    process.execPath,
    ["--eval", "process.exit(require('fsevents').marker === true ? 0 : 7)"],
    { cwd: directory, shell: false, stdio: "pipe" },
  );
  assert.equal(baseline.status, 0);

  const guarded = spawnSync(
    process.execPath,
    [
      "--require",
      FSEVENTS_GUARD,
      "--eval",
      "try { require('fsevents'); process.exit(9); } catch (error) { process.exit(error.code === 'MODULE_NOT_FOUND' ? 0 : 8); }",
    ],
    { cwd: directory, shell: false, stdio: "pipe" },
  );
  assert.equal(guarded.status, 0);
  assert.equal(guarded.stdout.toString(), "");
  assert.equal(guarded.stderr.toString(), "");
});

test("remains armed and reruns after a polled source edit", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "nutrition-polling-watch-"));
  const log = join(directory, "runs.log");
  const source = join(directory, "source.txt");
  const runner = join(directory, "runner.mjs");
  writeFileSync(source, "first\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    runner,
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.POLLING_WATCH_TEST_LOG, String(Date.now()) + "\\n");\n',
    { encoding: "utf8", mode: 0o600 },
  );

  const child = spawn(process.execPath, [WRAPPER, "--include", source, runner], {
    cwd: directory,
    detached: process.platform !== "win32",
    env: { ...process.env, POLLING_WATCH_TEST_LOG: log },
    stdio: "ignore",
  });
  context.after(async () => {
    await stopProcessGroup(child);
    rmSync(directory, { force: true, recursive: true });
  });

  await waitForRuns(log, 1);
  writeFileSync(source, "second\n", { encoding: "utf8", mode: 0o600 });
  const runs = await waitForRuns(log, 2);
  assert.equal(runs.length, 2);
});

test("sanitizes watcher launch failures", (context) => {
  const messages = [];
  context.mock.method(console, "error", (message) => messages.push(message));
  assert.equal(
    runWatcher([], () => ({ error: new Error("private path"), status: null })),
    1,
  );
  assert.equal(
    runWatcher([], () => {
      throw new Error("private path");
    }),
    1,
  );
  assert.deepEqual(messages, [
    "[polling-watch] Could not start the pinned TSX watcher.",
    "[polling-watch] Could not start the pinned TSX watcher.",
  ]);
  assert.doesNotMatch(messages.join("\n"), /private path/);
});
