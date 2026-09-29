import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Appwrite deployment contracts and types", { timeout: 120_000 }, () => {
  const env = { ...process.env };
  // Nested node:test runs must not inherit the parent's child protocol.
  delete env.NODE_TEST_CONTEXT;
  const cases = [
    "scripts/appwrite/source-artifact.test.ts",
    "scripts/appwrite/site-release.test.ts",
    "scripts/appwrite/github-checks.test.ts",
    "scripts/appwrite/pack-site.test.mjs",
  ];
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=tap", ...cases],
    { cwd: root, env, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests [1-9][0-9]*\n/);
  for (const field of ["fail", "cancelled", "skipped", "todo"])
    assert.match(result.stdout, new RegExp(`# ${field} 0\\n`));
  assert.doesNotMatch(result.stderr, /skipping running files/);

  const types = spawnSync("pnpm", ["exec", "tsc", "-p", "scripts/appwrite/tsconfig.json"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(types.error);
  assert.equal(types.status, 0, `${types.stdout}\n${types.stderr}`);
});
