// Destination: scripts/browserstack.test.mjs; selected by the existing root lint command.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = new URL("./browserstack/", import.meta.url);
for (const [name, executable, args] of [
  [
    "service image admission contracts",
    "python3",
    ["-B", fileURLToPath(new URL("tests/test_admission.py", directory)), "-v"],
  ],
  [
    "pinned Trivy workflow workspace contracts",
    "python3",
    ["-B", fileURLToPath(new URL("tests/test_trivy_workflow.py", directory)), "-v"],
  ],
  [
    "pinned vendor artifact contracts",
    "python3",
    ["-B", fileURLToPath(new URL("tests/test_vendor.py", directory)), "-v"],
  ],
  [
    "offline browser lifecycle contracts",
    "python3",
    ["-B", fileURLToPath(new URL("tests/test_ci_run.py", directory)), "-v"],
  ],
  [
    "browser journey control contracts",
    process.execPath,
    [
      "--experimental-vm-modules",
      "--test",
      "--test-reporter=tap",
      fileURLToPath(new URL("tests/smoke-control.test.mjs", directory)),
    ],
  ],
]) {
  test(name, { timeout: 60_000 }, () => {
    const env = { ...process.env };
    // A fresh runner must not inherit the parent's node:test child protocol.
    // Otherwise Node suppresses the nested file run and can still exit zero.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(executable, args, {
      env,
      encoding: "utf8",
      timeout: 50_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    if (executable === "python3") {
      assert.match(result.stderr, /Ran [1-9][0-9]* tests in /);
      assert.match(result.stderr, /\nOK\n$/);
      assert.doesNotMatch(result.stderr, /skipped=/);
    } else {
      assert.match(result.stdout, /# tests [1-9][0-9]*\n/);
      assert.match(result.stdout, /# fail 0\n/);
      assert.match(result.stdout, /# skipped 0\n/);
      assert.doesNotMatch(result.stderr, /skipping running files/);
    }
  });
}
