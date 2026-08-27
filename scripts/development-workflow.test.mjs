import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8"));
}

function readWorkspacePatterns() {
  const source = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const lines = source.split(/\r?\n/u);
  const packagesIndex = lines.indexOf("packages:");
  assert.notEqual(packagesIndex, -1, "pnpm-workspace.yaml must define packages");

  const patterns = [];
  for (const line of lines.slice(packagesIndex + 1)) {
    if (line.length === 0 || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;

    const match = /^ {2}- ([A-Za-z0-9_./*-]+)$/u.exec(line);
    assert.ok(match, `Unsupported workspace package entry: ${line}`);
    patterns.push(match[1]);
  }

  assert.ok(patterns.length > 0, "pnpm-workspace.yaml must include workspace patterns");
  return patterns;
}

test("keeps root development concurrency one slot above persistent workspace tasks", () => {
  const rootPackage = readJson("package.json");
  const turbo = readJson("turbo.json");
  const devCommand = rootPackage.scripts?.dev;
  assert.equal(typeof devCommand, "string", "root package must define the dev script");

  const commandMatch =
    /^dotenv -e \.env -- turbo run dev --concurrency=(?<concurrency>[1-9]\d*)$/u.exec(devCommand);
  assert.ok(
    commandMatch?.groups?.concurrency,
    "root dev must use dotenv and one explicit numeric Turbo concurrency",
  );

  const genericDevTask = turbo.tasks?.dev;
  assert.equal(genericDevTask?.persistent, true, "Turbo's generic dev task must be persistent");

  const manifestPaths = [
    ...new Set(
      readWorkspacePatterns().flatMap((pattern) =>
        globSync(`${pattern}/package.json`, { cwd: repositoryRoot }),
      ),
    ),
  ].sort();
  assert.ok(manifestPaths.length > 0, "workspace patterns must resolve package manifests");

  const persistentDevPackages = manifestPaths.flatMap((manifestPath) => {
    const manifest = readJson(manifestPath);
    if (!Object.hasOwn(manifest.scripts ?? {}, "dev")) return [];
    assert.equal(typeof manifest.scripts.dev, "string", `${manifestPath} dev must be a string`);
    assert.equal(typeof manifest.name, "string", `${manifestPath} must define a package name`);

    const task = turbo.tasks?.[`${manifest.name}#dev`];
    const persistent = task?.persistent ?? genericDevTask.persistent;
    return persistent === true ? [manifest.name] : [];
  });

  assert.ok(persistentDevPackages.length > 0, "workspace must define persistent dev tasks");

  const persistentDevPackageNames = new Set(persistentDevPackages);
  for (const [taskName, taskDefinition] of Object.entries(turbo.tasks ?? {})) {
    if (taskName !== "dev" && !taskName.endsWith("#dev")) continue;

    assert.ok(
      taskDefinition !== null &&
        typeof taskDefinition === "object" &&
        !Array.isArray(taskDefinition),
      `${taskName} task definition must be an object`,
    );
    if (!Object.hasOwn(taskDefinition, "with")) continue;

    assert.ok(Array.isArray(taskDefinition.with), `${taskName} with must be an array`);
    for (const target of taskDefinition.with) {
      assert.equal(typeof target, "string", `${taskName} with targets must be strings`);
      const targetMatch = /^(?<packageName>[^#]+)#dev$/u.exec(target);
      assert.ok(
        targetMatch?.groups?.packageName,
        `${taskName} with target must be a package-qualified dev task: ${target}`,
      );
      assert.ok(
        persistentDevPackageNames.has(targetMatch.groups.packageName),
        `${taskName} with target must name a discovered persistent dev package: ${target}`,
      );
    }
  }

  assert.equal(
    Number(commandMatch.groups.concurrency),
    persistentDevPackages.length + 1,
    `root dev must reserve one slot above: ${persistentDevPackages.join(", ")}`,
  );
});
