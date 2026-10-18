import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { trustedPath } from "./postgres-operator-process.mjs";

// setup-node's shared cache is not a private native-tool location. Keep its bytes and metadata intact.
assert(process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true");
for (const field of ["GITHUB_PATH", "GITHUB_ENV"]) {
  const path = process.env[field];
  assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
  const row = await lstat(path);
  assert(row.isFile() && !row.isSymbolicLink() && row.uid === process.getuid());
}
const home = homedir();
assert((await realpath(home)) === home);
await trustedPath(home, { directory: true });
const source = process.execPath,
  before = await lstat(source, { bigint: true });
assert(
  before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= 134_217_728n,
);
let originalPathQualified = true;
try {
  await trustedPath(source);
} catch {
  originalPathQualified = false;
}
const bytes = await readFile(source);
const directory = await mkdtemp(join(home, "nourishing-ci-node-"));
await chmod(directory, 0o700);
const path = join(directory, "node");
await writeFile(path, bytes, { flag: "wx", mode: 0o700 });
await chmod(path, 0o700);
const copied = await readFile(path),
  after = await lstat(source, { bigint: true });
for (const field of ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs"])
  assert(before[field] === after[field]);
assert(bytes.equals(copied) && bytes.equals(await readFile(source)));
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
assert(sha(bytes) === sha(copied));
await trustedPath(path);
const version = await promisify(execFile)(path, ["--version"], {
  env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  timeout: 5000,
  maxBuffer: 1024,
});
assert(version.stdout === `${process.version}\n` && version.stderr === "");
await appendFile(process.env.GITHUB_PATH, `${directory}\n`);
await appendFile(process.env.GITHUB_ENV, `NOURISHING_CI_NODE=${path}\n`);
process.stdout.write(
  `${JSON.stringify({ nodeVersion: process.version, sha256: sha(copied), originalPathQualified, qualifiedPath: path })}\n`,
);
