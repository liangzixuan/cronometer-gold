import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Appwrite deployment contracts and types", { timeout: 180_000 }, () => {
  const env = { ...process.env };
  // Nested node:test runs must not inherit the parent's child protocol.
  delete env.NODE_TEST_CONTEXT;
  const contracts = spawnSync("pnpm", ["--filter", "@nutrition-tracker/contracts", "build"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(contracts.error);
  assert.equal(contracts.status, 0, `${contracts.stdout}\n${contracts.stderr}`);

  const cases = [
    "scripts/appwrite/source-artifact.test.ts",
    "scripts/appwrite/site-release.test.ts",
    "scripts/appwrite/qualification.test.ts",
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

  const artifact = spawnSync("python3", ["scripts/appwrite/review-artifact.test.py"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(artifact.error);
  assert.equal(artifact.status, 0, `${artifact.stdout}\n${artifact.stderr}`);

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
