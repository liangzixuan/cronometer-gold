import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const mode of [
  "positive",
  "wrong-target",
  "stale-migration",
  "wrong-runtime-epoch",
  "changed-readback",
])
  test(`actual original-database replay and both runtime readiness consumers: ${mode}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "nutrition-runtime-replay-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = await readFile(
      new URL("../apps/api/test/hosted-mailpit-email-delivery.test.ts", import.meta.url),
      "utf8",
    );
    const ca = JSON.parse(/const ca =\s*("(?:[^"\\]|\\.)*")/u.exec(source)[1]);
    const path = join(root, "public-synthetic-ca.crt"),
      spool = join(root, "spool");
    await writeFile(path, ca, { mode: 0o600, flag: "wx" });
    await mkdir(spool, { mode: 0o700 });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./azure-development-runtime-replay-fixture.mjs", import.meta.url)),
        mode,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          NODE_EXTRA_CA_CERTS: path,
          RUNTIME_REPLAY_SPOOL: spool,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = [],
      errors = [];
    let bytes = 0,
      timedOut = false;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 65_536) child.kill("SIGKILL");
      else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(output));
    child.stderr.on("data", collect(errors));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert(!timedOut);
      assert.equal(status.signal, null);
      assert.equal(status.code, 0, Buffer.concat(errors).toString());
      const result = JSON.parse(Buffer.concat(output).toString());
      assert.equal(result.mode, mode);
      assert.equal(result.ready, mode === "positive");
      assert(result.pools >= 1);
    } finally {
      clearTimeout(timeout);
    }
  });
