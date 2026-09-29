import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = Object.freeze({
  entries: 20_000,
  bytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  manifestBytes: 32 * 1024 * 1024,
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const within = (root, path) => path === root || path.startsWith(root + sep);
const sha = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const unsafeCharacters = (value) =>
  value.includes("\\") ||
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

function safePath(path) {
  assert(
    typeof path === "string" &&
      path.length > 0 &&
      path.length <= 1024 &&
      !unsafeCharacters(path) &&
      !isAbsolute(path),
    "Invalid package path",
  );
  assert(
    path.split("/").every((part) => part && part !== "." && part !== ".."),
    "Invalid package path",
  );
}

function publicPath(path) {
  safePath(path);
  assert(
    !path
      .split("/")
      .some(
        (part) =>
          [
            ".git",
            ".local-data",
            ".ssh",
            ".aws",
            ".azure",
            ".npmrc",
            ".netrc",
            "credentials.json",
            "service-account.json",
          ].includes(part) ||
          /^\.env(?:\.|$)/u.test(part) ||
          /\.(?:pem|key|p12|pfx)$/iu.test(part),
      ),
    "Private artifact in package",
  );
}

async function regularBytes(path, limit) {
  assert((await realpath(path)) === path, "File path contains a link");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assert(
      before.isFile() && before.size <= limit && (before.mode & 0o7002) === 0,
      "Invalid package file",
    );
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assert(
      bytes.length === before.size &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs,
      "Package file changed while reading",
    );
    return { bytes, mode: before.mode & 0o111 ? "100755" : "100644" };
  } finally {
    await handle.close();
  }
}

async function directory(path) {
  const state = await lstat(path);
  assert(
    state.isDirectory() &&
      !state.isSymbolicLink() &&
      (state.mode & 0o7002) === 0 &&
      (await realpath(path)) === path,
    "Invalid package directory",
  );
}

export async function verifySource(sourceRoot) {
  const path = join(sourceRoot, ".nourishing-source.json");
  const { bytes } = await regularBytes(path, LIMITS.manifestBytes);
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert(
    manifest.schemaVersion === 1 &&
      typeof manifest.revision === "string" &&
      revision.test(manifest.revision) &&
      typeof manifest.tree === "string" &&
      revision.test(manifest.tree) &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= LIMITS.entries,
    "Invalid source manifest",
  );
  const seen = new Set();
  let sourceBytes = 0;
  for (const file of manifest.files) {
    safePath(file.path);
    assert(
      !seen.has(file.path) &&
        file.path !== ".nourishing-source.json" &&
        ["100644", "100755"].includes(file.mode) &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        file.size <= LIMITS.fileBytes &&
        typeof file.sha256 === "string" &&
        sha.test(file.sha256),
      "Invalid source entry",
    );
    seen.add(file.path);
    sourceBytes += file.size;
    assert(sourceBytes <= LIMITS.bytes, "Source byte limit exceeded");
    const absolute = join(sourceRoot, file.path);
    assert((await realpath(absolute)) === absolute, "Source link is forbidden");
    const actual = await regularBytes(absolute, LIMITS.fileBytes);
    assert(
      actual.bytes.length === file.size &&
        digest(actual.bytes) === file.sha256 &&
        actual.mode === file.mode,
      "Source identity mismatch",
    );
  }
  assert(
    seen.has("pnpm-lock.yaml") &&
      seen.has("package.json") &&
      seen.has("scripts/appwrite/start-site.cjs"),
    "Required source input is missing",
  );
  const packageJson = JSON.parse(
    (await regularBytes(join(sourceRoot, "package.json"), LIMITS.fileBytes)).bytes.toString("utf8"),
  );
  assert(packageJson.packageManager === "pnpm@11.19.0", "Unexpected package manager");
  return { manifest, manifestSha256: digest(bytes), sourcePaths: seen };
}

export async function packSite({ sourceRoot, output = "appwrite-output", limits = LIMITS }) {
  for (const key of Object.keys(LIMITS))
    assert(
      Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= LIMITS[key],
      "Invalid package limit",
    );
  const root = resolve(sourceRoot);
  await directory(root);
  const destination = resolve(root, output);
  assert(
    destination === join(root, "appwrite-output"),
    "Output must be the fixed package directory",
  );
  await assert.rejects(lstat(destination), { code: "ENOENT" }, "Output already exists");
  const source = await verifySource(root);
  const entries = [];
  const origins = new Map();
  const directories = new Set();
  let total = 0;
  let visited = 0;
  async function add(path, origin, treeRoot) {
    publicPath(path);
    assert(!origins.has(path) && !directories.has(path), "Package path collision");
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      assert(!origins.has(parent), "Package ancestor collision");
      directories.add(parent);
    }
    const state = await lstat(origin);
    let entry;
    if (state.isSymbolicLink()) {
      const target = await readlink(origin);
      assert(
        !isAbsolute(target) &&
          !unsafeCharacters(target) &&
          within(treeRoot, await realpath(origin)),
        "Package link escapes its tree",
      );
      const targetState = await lstat(await realpath(origin));
      assert(targetState.isFile() || targetState.isDirectory(), "Invalid package link target");
      const relocated = resolve(dirname(join(destination, path)), target);
      assert(within(join(destination, "payload"), relocated), "Relocated link escapes payload");
      const bytes = Buffer.from(target);
      entry = {
        path,
        type: "symlink",
        mode: "120000",
        size: bytes.length,
        sha256: digest(bytes),
        target,
      };
    } else {
      const file = await regularBytes(origin, limits.fileBytes);
      entry = {
        path,
        type: "file",
        mode: file.mode,
        size: file.bytes.length,
        sha256: digest(file.bytes),
      };
    }
    total += entry.size;
    assert(entries.length < limits.entries && total <= limits.bytes, "Package limit exceeded");
    entries.push(entry);
    origins.set(path, origin);
  }
  async function walk(treeRoot, prefix) {
    await directory(treeRoot);
    const before = entries.length;
    assert(!origins.has(prefix), "Package tree collision");
    directories.add(prefix);
    async function visit(current, suffix = "") {
      for (const name of (await readdir(current)).sort(compare)) {
        assert(++visited <= limits.entries, "Package traversal limit exceeded");
        const relativePath = suffix ? `${suffix}/${name}` : name;
        const path = `${prefix}/${relativePath}`;
        publicPath(path);
        const origin = join(current, name);
        const state = await lstat(origin);
        if (state.isDirectory() && !state.isSymbolicLink()) {
          assert(
            (state.mode & 0o7002) === 0 && (await realpath(origin)) === origin,
            "Invalid package directory",
          );
          assert(!origins.has(path), "Package directory collision");
          directories.add(path);
          await visit(origin, relativePath);
        } else {
          await add(path, origin, treeRoot);
        }
      }
    }
    await visit(treeRoot);
    assert(entries.length > before, "Required assets are empty");
  }
  const standalone = join(root, "apps/web/.next/standalone");
  await walk(standalone, "payload");
  await walk(join(root, "apps/web/.next/static"), "payload/apps/web/.next/static");
  await walk(join(root, "apps/web/public"), "payload/apps/web/public");
  await add("start-site.cjs", join(root, "scripts/appwrite/start-site.cjs"), root);
  for (const path of [
    "payload/apps/web/server.js",
    "payload/apps/web/package.json",
    "payload/apps/web/.next/BUILD_ID",
  ])
    assert(
      entries.some((entry) => entry.path === path && entry.type === "file" && entry.size > 0),
      "Required standalone input is missing",
    );
  assert(
    entries.some(
      (entry) => entry.path.startsWith("payload/node_modules/") && entry.type === "file",
    ),
    "Standalone dependencies are missing",
  );
  const buildId = (await regularBytes(join(standalone, "apps/web/.next/BUILD_ID"), 128)).bytes
    .toString("utf8")
    .trim();
  assert(/^[A-Za-z0-9_-]{1,100}$/u.test(buildId), "Invalid build identity");
  assert(
    (await regularBytes(join(root, "apps/web/.next/BUILD_ID"), 128)).bytes
      .toString("utf8")
      .trim() === buildId,
    "Build identity mismatch",
  );
  // Public assets are source inputs, so generated or unlisted additions cannot be published.
  for (const entry of entries.filter((item) => item.path.startsWith("payload/apps/web/public/")))
    assert(source.sourcePaths.has(entry.path.slice("payload/".length)), "Unlisted public asset");
  entries.sort((a, b) => compare(a.path, b.path));
  const manifest = {
    schemaVersion: 1,
    revision: source.manifest.revision,
    tree: source.manifest.tree,
    sourceManifestSha256: source.manifestSha256,
    buildId,
    entrypoint: "start-site.cjs",
    payloadEntrypoint: "payload/apps/web/server.js",
    files: entries,
    outputTreeSha256: digest(Buffer.from(JSON.stringify(entries))),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  assert(
    manifestBytes.length <= limits.manifestBytes && total + manifestBytes.length <= limits.bytes,
    "Package manifest limit exceeded",
  );
  await mkdir(destination, { mode: 0o755 });
  await chmod(destination, 0o755);
  for (const path of [...directories].sort(compare)) {
    await mkdir(join(destination, path), { recursive: true, mode: 0o755 });
    await chmod(join(destination, path), 0o755);
  }
  for (const entry of entries) {
    const target = join(destination, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    let parent = dirname(target);
    while (parent !== destination) {
      await chmod(parent, 0o755);
      parent = dirname(parent);
    }
    const origin = origins.get(entry.path);
    if (entry.type === "symlink") {
      assert((await readlink(origin)) === entry.target, "Package link changed");
      await symlink(entry.target, target);
    } else {
      const file = await regularBytes(origin, limits.fileBytes);
      assert(
        digest(file.bytes) === entry.sha256 &&
          file.bytes.length === entry.size &&
          file.mode === entry.mode,
        "Package input changed",
      );
      await writeFile(target, file.bytes, {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
      await chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
  for (const entry of entries.filter((item) => item.type === "symlink"))
    assert(
      within(join(destination, "payload"), await realpath(join(destination, entry.path))),
      "Output link escapes payload",
    );
  await writeFile(join(destination, "output-manifest.json"), manifestBytes, {
    flag: "wx",
    mode: 0o644,
  });
  await chmod(join(destination, "output-manifest.json"), 0o644);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(
      process.argv.length === 6 &&
        process.argv[2] === "--source-root" &&
        process.argv[4] === "--output",
      "Invalid packaging arguments",
    );
    const result = await packSite({ sourceRoot: process.argv[3], output: process.argv[5] });
    console.log(
      JSON.stringify({
        status: "packaged",
        revision: result.revision,
        sourceManifestSha256: result.sourceManifestSha256,
        outputTreeSha256: result.outputTreeSha256,
        buildId: result.buildId,
        fileCount: result.files.length,
      }),
    );
  } catch {
    console.error("Appwrite output packaging failed; no deployment acceptance.");
    process.exitCode = 1;
  }
}
