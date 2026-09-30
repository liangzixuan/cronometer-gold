import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
// Reuse the lock-pinned parser already present through the workspace dependencies.
import { parseDocument } from "../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const [name, path] of [
  ["Azure credential installation and recovery", "infra/azure/files/tests/test_credentials.py"],
  ["Azure preflight contracts", "infra/azure/files/tests/static-contracts.py"],
  ["Azure storage egress enforcement", "infra/azure/files/tests/test_object_egress.py"],
]) {
  test(name, { timeout: 60_000 }, () => {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync("python3", ["-B", path, "-v"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 50_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Ran [1-9][0-9]* tests in /);
    assert.match(result.stderr, /\nOK\n$/);
    assert.doesNotMatch(result.stderr, /skipped=/);
  });
}

test("checked-in Azure Compose merge preserves the enforced network contract", () => {
  const document = parseDocument(
    readFileSync(new URL("../infra/azure/files/compose.yaml", import.meta.url), "utf8"),
    { merge: true, uniqueKeys: true },
  );
  assert.deepEqual(document.errors, []);
  const config = document.toJS({ maxAliasCount: 100 });
  // Model only Compose's array-to-map network normalization. This checks the real
  // YAML merge/anchor seam; actual Docker rendering remains a host qualification.
  for (const service of Object.values(config.services)) {
    if (Array.isArray(service.networks)) {
      service.networks = Object.fromEntries(service.networks.map((name) => [name, {}]));
    }
  }
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      "import importlib.util,sys; s=importlib.util.spec_from_file_location('preflight','infra/azure/files/deployment-preflight.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.assert_compose_object_egress(sys.stdin.read())",
    ],
    {
      cwd: root,
      input: JSON.stringify(config),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 65536,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
