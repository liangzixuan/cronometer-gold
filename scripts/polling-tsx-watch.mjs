#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxPackage = require.resolve("tsx/package.json");

export const FSEVENTS_GUARD = fileURLToPath(new URL("./disable-fsevents.cjs", import.meta.url));
export const TSX_CLI = resolve(dirname(tsxPackage), "dist", "cli.mjs");
export const POLLING_ENVIRONMENT = Object.freeze({
  CHOKIDAR_INTERVAL: "250",
  CHOKIDAR_USEPOLLING: "1",
});

export function runWatcher(
  arguments_,
  spawnWatcher = spawnSync,
  inheritedEnvironment = process.env,
) {
  let result;
  try {
    result = spawnWatcher(
      process.execPath,
      ["--require", FSEVENTS_GUARD, TSX_CLI, "watch", ...arguments_],
      {
        env: { ...inheritedEnvironment, ...POLLING_ENVIRONMENT },
        shell: false,
        stdio: "inherit",
      },
    );
  } catch {
    console.error("[polling-watch] Could not start the pinned TSX watcher.");
    return 1;
  }
  if (result.error) {
    console.error("[polling-watch] Could not start the pinned TSX watcher.");
    return 1;
  }
  if (result.signal) {
    return 128;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runWatcher(process.argv.slice(2));
}
