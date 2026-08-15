import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  forbiddenDomainGlobals,
  importedSpecifiers,
  isNodeBuiltin,
} from "./workspace-boundaries.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  ".next",
  ".expo",
  ".turbo",
  "dist",
  "coverage",
]);
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
    } else if (sourceExtensions.has(extname(entry.name))) {
      await inspect(path);
    }
  }
}

async function inspect(path) {
  const content = await readFile(path, "utf8");
  const workspacePath = relative(root, path).split(sep).join("/");
  const imports = importedSpecifiers(content, path);

  for (const specifier of imports) {
    const targetsPackage = (packageName) =>
      specifier === packageName || specifier.startsWith(`${packageName}/`);
    const relativeTarget = specifier.startsWith(".")
      ? relative(root, resolve(dirname(path), specifier))
          .split(sep)
          .join("/")
      : null;

    if (workspacePath.startsWith("packages/domain/")) {
      const forbiddenDomainImport =
        isNodeBuiltin(specifier) ||
        targetsPackage("@nutrition-tracker/db") ||
        targetsPackage("@nutrition-tracker/api") ||
        targetsPackage("@nutrition-tracker/web") ||
        targetsPackage("@nutrition-tracker/mobile") ||
        targetsPackage("@nutrition-tracker/worker") ||
        targetsPackage("fastify") ||
        targetsPackage("kysely") ||
        targetsPackage("pg") ||
        targetsPackage("undici") ||
        targetsPackage("axios") ||
        relativeTarget?.startsWith("apps/") ||
        relativeTarget?.startsWith("packages/db/") ||
        relativeTarget?.startsWith("../");
      if (forbiddenDomainImport) {
        violations.push(`${workspacePath}: domain cannot import ${specifier}`);
      }
    }

    if (
      workspacePath.startsWith("packages/") &&
      (targetsPackage("@nutrition-tracker/api") ||
        targetsPackage("@nutrition-tracker/web") ||
        targetsPackage("@nutrition-tracker/mobile") ||
        targetsPackage("@nutrition-tracker/worker") ||
        relativeTarget?.startsWith("apps/"))
    ) {
      violations.push(`${workspacePath}: packages cannot import application package ${specifier}`);
    }
  }

  if (workspacePath.startsWith("packages/domain/")) {
    for (const globalName of forbiddenDomainGlobals(content, path)) {
      violations.push(`${workspacePath}: domain cannot access ${globalName}`);
    }
  }
}

await visit(root);

if (violations.length > 0) {
  console.error(
    `Workspace boundary violations:\n${violations.map((violation) => `- ${violation}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log("Workspace boundaries are valid.");
}
