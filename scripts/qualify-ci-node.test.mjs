import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runTool, trustedPath } from "./postgres-operator-process.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
test("shared writable Node ancestry refuses native launch, then the byte-identical private copy runs with unchanged gates", async (t) => {
  const root = await mkdtemp(join(homedir(), "nutrition-ci-node-proof-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = join(root, "shared"),
    pathFile = join(root, "github-path"),
    envFile = join(root, "github-env");
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o775);
  const original = join(shared, "node");
  await copyFile(process.execPath, original);
  await chmod(original, 0o700);
  const raw = await readFile(original),
    digest = sha(raw);
  const refusedOutput = join(root, "refused-output");
  await assert.rejects(
    runTool({ path: original, sha256: digest }, ["--version"], {
      signal: AbortSignal.timeout(10_000),
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      directory: root,
      limit: 1024,
      outputPath: refusedOutput,
    }),
    /configuration failed/u,
  );
  await assert.rejects(lstat(refusedOutput), { code: "ENOENT" });
  await writeFile(pathFile, "", { mode: 0o600, flag: "wx" });
  await writeFile(envFile, "", { mode: 0o600, flag: "wx" });
  const result = await promisify(execFile)(
    original,
    [fileURLToPath(new URL("./qualify-ci-node.mjs", import.meta.url))],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: homedir(),
        LANG: "C.UTF-8",
        CI: "true",
        GITHUB_ACTIONS: "true",
        GITHUB_PATH: pathFile,
        GITHUB_ENV: envFile,
      },
      timeout: 20_000,
      maxBuffer: 8192,
    },
  );
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.originalPathQualified, false);
  assert.equal(receipt.sha256, digest);
  assert.equal(receipt.nodeVersion, process.version);
  const destination = receipt.qualifiedPath,
    directory = resolve(destination, "..");
  assert(
    directory.startsWith(join(homedir(), "nourishing-ci-node-")) &&
      destination === join(directory, "node"),
  );
  t.after(async () => {
    assert.deepEqual(await readdir(directory), ["node"]);
    assert.equal(sha(await readFile(destination)), digest);
    await rm(directory, { recursive: true });
  });
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(destination)).mode & 0o777, 0o700);
  assert.equal((await lstat(shared)).mode & 0o777, 0o775);
  assert.deepEqual(await readFile(original), raw);
  assert.deepEqual(await readFile(destination), raw);
  await trustedPath(destination);
  assert.equal(await readFile(pathFile, "utf8"), `${directory}\n`);
  assert.equal(await readFile(envFile, "utf8"), `NOURISHING_CI_NODE=${destination}\n`);
  const launched = await runTool({ path: destination, sha256: digest }, ["--version"], {
    signal: AbortSignal.timeout(10_000),
    env: { PATH: directory + ":/usr/bin:/bin", LANG: "C.UTF-8" },
    directory: root,
    limit: 1024,
  });
  assert.equal(launched.text, `${process.version}\n`);
  assert.equal(launched.stderrBytes, 0);
});
