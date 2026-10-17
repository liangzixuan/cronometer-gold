import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as processTools from "./postgres-operator-process.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const tool = { path: process.execPath, sha256: hash(await readFile(process.execPath)) };

async function fixture(work) {
  const directory = await mkdtemp(join(homedir(), "nourishing-stderr-test-"));
  await chmod(directory, 0o700);
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function options(directory, extra = {}) {
  return {
    signal: AbortSignal.timeout(10000),
    directory,
    env: { PATH: "/usr/bin:/bin" },
    limit: 4096,
    ...extra,
  };
}

test("diagnostic callback shares the existing fixed byte ceiling", () => {
  assert.equal(processTools.MAX_STDERR_BYTES, 65536);
});

test("diagnostic callback receives exact isolated bytes while the receipt retains their hash", () =>
  fixture(async (directory) => {
    const chunks = [];
    const result = await processTools.runTool(
      tool,
      [
        "-e",
        'process.stderr.write(Buffer.from([0,255,65])); setTimeout(() => process.stderr.write("tail"), 20)',
      ],
      options(directory, {
        onStderr(chunk) {
          assert.ok(Buffer.isBuffer(chunk));
          chunks.push(Buffer.from(chunk));
          chunk.fill(42);
        },
      }),
    );
    const expected = Buffer.concat([Buffer.from([0, 255, 65]), Buffer.from("tail")]);
    assert.deepEqual(Buffer.concat(chunks), expected);
    assert.equal(result.stderrBytes, expected.length);
    assert.equal(result.stderrSha256, hash(expected));
    assert.equal(result.text, "");
    assert.equal("stderr" in result, false);
  }));

test("empty diagnostics make no callback and retain the empty digest", () =>
  fixture(async (directory) => {
    let calls = 0;
    const result = await processTools.runTool(
      tool,
      ["-e", 'process.stdout.write("ok")'],
      options(directory, {
        onStderr() {
          calls++;
        },
      }),
    );
    assert.equal(calls, 0);
    assert.equal(result.stderrBytes, 0);
    assert.equal(result.stderrSha256, hash(""));
    assert.equal(result.text, "ok");
  }));

test("omitting the callback preserves diagnostic counts without returning raw bytes", () =>
  fixture(async (directory) => {
    const result = await processTools.runTool(
      tool,
      ["-e", 'process.stderr.write("private synthetic diagnostic"); process.stdout.write("ok")'],
      options(directory),
    );
    assert.deepEqual(result, {
      bytes: 2,
      sha256: hash("ok"),
      stderrBytes: 28,
      stderrSha256: hash("private synthetic diagnostic"),
      text: "ok",
    });
  }));

test("failed child diagnostics reach the callback while the public error stays redacted", () =>
  fixture(async (directory) => {
    const chunks = [];
    await assert.rejects(
      processTools.runTool(
        tool,
        ["-e", 'process.stderr.write("synthetic-failure-private"); process.exitCode = 7'],
        options(directory, {
          onStderr(chunk) {
            chunks.push(Buffer.from(chunk));
          },
        }),
      ),
      (error) => {
        assert.doesNotMatch(String(error), /synthetic-failure-private/);
        return true;
      },
    );
    assert.equal(Buffer.concat(chunks).toString(), "synthetic-failure-private");
  }));

test("invalid diagnostic callbacks refuse before child dispatch or output creation", () =>
  fixture(async (directory) => {
    const outputPath = join(directory, "output");
    const started = join(directory, "started");
    for (const onStderr of [null, 42, {}, "callback"]) {
      await assert.rejects(
        processTools.runTool(
          tool,
          ["-e", 'require("node:fs").writeFileSync(process.argv[1], "started")', started],
          options(directory, { onStderr, outputPath }),
        ),
      );
      await assert.rejects(readFile(outputPath), { code: "ENOENT" });
      await assert.rejects(readFile(started), { code: "ENOENT" });
    }
  }));

test("callback failure rejects after the owned child group has terminated", () =>
  fixture(async (directory) => {
    const pidPath = join(directory, "descendant-pid");
    const program = `
      const {spawn} = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"});
      require("node:fs").writeFileSync(process.argv[1], String(descendant.pid));
      process.stderr.write("owned synthetic diagnostic");
      setTimeout(() => process.exit(0), 30);
    `;
    let calls = 0;
    await assert.rejects(
      processTools.runTool(
        tool,
        ["-e", program, pidPath],
        options(directory, {
          onStderr() {
            calls++;
            throw new Error("synthetic callback failed");
          },
        }),
      ),
    );
    assert.ok(calls > 0);
    const pid = (await readFile(pidPath, "utf8")).trim();
    assert.match(pid, /^[1-9][0-9]*$/u);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      assert.ok(["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
  }));

test("diagnostics at the exact existing ceiling are fully delivered and hashed", () =>
  fixture(async (directory) => {
    const chunks = [];
    const result = await processTools.runTool(
      tool,
      ["-e", "process.stderr.write(Buffer.alloc(65536, 65))"],
      options(directory, {
        onStderr(chunk) {
          chunks.push(Buffer.from(chunk));
        },
      }),
    );
    const expected = Buffer.alloc(65536, 65);
    assert.deepEqual(Buffer.concat(chunks), expected);
    assert.equal(result.stderrBytes, expected.length);
    assert.equal(result.stderrSha256, hash(expected));
  }));

test("diagnostic overflow still fails and forwards no bytes above the existing ceiling", () =>
  fixture(async (directory) => {
    let received = 0;
    await assert.rejects(
      processTools.runTool(
        tool,
        ["-e", "process.stderr.write(Buffer.alloc(65537, 65))"],
        options(directory, {
          onStderr(chunk) {
            received += chunk.length;
          },
        }),
      ),
    );
    assert.ok(received <= 65536);
  }));
