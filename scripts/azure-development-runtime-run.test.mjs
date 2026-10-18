import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runPreparedDevelopmentRuntime } from "./azure-development-runtime-run.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
test("invalid run invocation refuses before any native or system observation", async () => {
  for (const args of [
    [],
    ["start"],
    ["run", "--input", "relative.json", "--input-sha256", "a".repeat(64)],
    ["run", "--input", "/tmp/runtime.json", "--input-sha256", "not-a-digest"],
  ]) {
    let reads = 0;
    await assert.rejects(
      runPreparedDevelopmentRuntime(args, {
        execute: async () => {
          reads++;
          throw new Error("Unexpected native call");
        },
        readSystem: async () => {
          reads++;
          throw new Error("Unexpected system read");
        },
      }),
    );
    assert.equal(reads, 0);
  }
});
test("noncanonical or changed private manifest cannot start a native phase and its bytes are conserved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nutrition-runtime-run-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, raw, supplied] of [
    ["pretty", Buffer.from('{ "schemaVersion": 1 }'), null],
    ["wrong-sha", Buffer.from("{}\n"), "f".repeat(64)],
    ["wrong-kind", Buffer.from('{"kind":"unrelated","schemaVersion":1}\n'), null],
  ]) {
    const path = join(root, `${name}.json`);
    await writeFile(path, raw, { flag: "wx", mode: 0o600 });
    let native = 0;
    await assert.rejects(
      runPreparedDevelopmentRuntime(
        ["run", "--input", path, "--input-sha256", supplied ?? hash(raw)],
        {
          execute: async () => {
            native++;
            throw new Error("Unexpected native phase");
          },
        },
      ),
    );
    assert.equal(native, 0);
    assert.deepEqual(await readFile(path), raw);
  }
});
test("executable dispatch reaches run validation and reports only a generic failure", async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./azure-development-runtime.mjs", import.meta.url)), "run"],
    { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(Buffer.concat(stdout).length, 0);
    assert.equal(
      Buffer.concat(stderr).toString(),
      "Development runtime failed; retained resources or evidence may remain uncertain\n",
    );
  } finally {
    clearTimeout(timer);
  }
});
