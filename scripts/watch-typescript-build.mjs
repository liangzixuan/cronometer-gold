#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const compilerPackage = require.resolve("typescript/package.json");

export const COMPILER_SCRIPT = resolve(dirname(compilerPackage), "bin", "tsc");
export const COMPILER_ARGUMENTS = Object.freeze([COMPILER_SCRIPT, "-p", "tsconfig.build.json"]);

export function runBuild(spawnCompiler = spawnSync) {
  let result;
  try {
    result = spawnCompiler(process.execPath, COMPILER_ARGUMENTS, {
      shell: false,
      stdio: "inherit",
    });
  } catch {
    console.error("[package-watch] Could not start the pinned TypeScript compiler.");
    return 1;
  }
  if (result.error) {
    console.error("[package-watch] Could not start the pinned TypeScript compiler.");
    return 1;
  }
  if (result.signal) {
    console.error("[package-watch] The pinned TypeScript compiler was interrupted.");
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runBuild();
}
