import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LIMITS, packSite } from "./pack-site.mjs";
import { validateStartup } from "./start-site.cjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceScript = fileURLToPath(new URL("./start-site.cjs", import.meta.url));
const server = `const dependency = require('example-dependency'); console.log(JSON.stringify({dependency, port:process.env.PORT, hostname:process.env.HOSTNAME, nodeOptions:process.env.NODE_OPTIONS}));`;
async function put(root, path, value, mode = 0o644) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value, { mode });
  await chmod(target, mode);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nourishing-appwrite-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "package.json", JSON.stringify({ packageManager: "pnpm@11.19.0" }));
  await put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await put(root, "scripts/appwrite/start-site.cjs", await readFile(sourceScript));
  await put(root, "apps/web/public/fonts/example.woff2", Buffer.from([0, 1, 2, 255]));
  await put(root, "apps/web/.next/BUILD_ID", "synthetic-build\n");
  await put(root, "apps/web/.next/standalone/apps/web/.next/BUILD_ID", "synthetic-build\n");
  await put(root, "apps/web/.next/standalone/apps/web/package.json", "{}\n");
  await put(root, "apps/web/.next/standalone/apps/web/server.js", server);
  await put(
    root,
    "apps/web/.next/standalone/node_modules/.pnpm/example/index.js",
    "module.exports='complete-standalone';\n",
    0o664,
  );
  await symlink(
    ".pnpm/example",
    join(root, "apps/web/.next/standalone/node_modules/example-dependency"),
  );
  await put(root, "apps/web/.next/static/chunks/app.js", "static-chunk\n");
  const paths = [
    "apps/web/public/fonts/example.woff2",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/appwrite/start-site.cjs",
  ];
  const files = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(join(root, path));
      return { path, mode: "100644", size: bytes.length, sha256: digest(bytes) };
    }),
  );
  const source = { schemaVersion: 1, revision: "a".repeat(40), tree: "b".repeat(40), files };
  await writeFile(join(root, ".nourishing-source.json"), `${JSON.stringify(source)}\n`);
  return { root, source, output: join(root, "appwrite-output") };
}
async function changeManifest(root, transform) {
  const path = join(root, ".nourishing-source.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  transform(value);
  await writeFile(path, `${JSON.stringify(value)}\n`);
}
async function changeOutput(root, transform) {
  const path = join(root, "appwrite-output/output-manifest.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  transform(value);
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("packages the entire standalone tree, public assets, static files and internal imports", async (t) => {
  const { root, output, source } = await fixture(t);
  const manifest = await packSite({ sourceRoot: root });
  assert.equal(manifest.revision, source.revision);
  assert.equal(manifest.tree, source.tree);
  assert.equal(
    manifest.sourceManifestSha256,
    digest(await readFile(join(root, ".nourishing-source.json"))),
  );
  assert.equal(manifest.outputTreeSha256, digest(Buffer.from(JSON.stringify(manifest.files))));
  assert.equal(manifest.buildId, "synthetic-build");
  assert.deepEqual(
    await readFile(join(output, "payload/apps/web/public/fonts/example.woff2")),
    Buffer.from([0, 1, 2, 255]),
  );
  assert.equal(
    await readFile(join(output, "payload/apps/web/.next/static/chunks/app.js"), "utf8"),
    "static-chunk\n",
  );
  assert.equal(
    await readlink(join(output, "payload/node_modules/example-dependency")),
    ".pnpm/example",
  );
  await assert.rejects(lstat(join(output, "node_modules")), { code: "ENOENT" });
  for (const entry of manifest.files) {
    const path = join(output, entry.path);
    const bytes =
      entry.type === "symlink" ? Buffer.from(await readlink(path)) : await readFile(path);
    assert.equal(digest(bytes), entry.sha256);
    assert.equal(bytes.length, entry.size);
    if (entry.type === "file")
      assert.equal((await lstat(path)).mode & 0o777, entry.mode === "100755" ? 0o755 : 0o644);
  }
});

test("the actual startup script loads the nested standalone dependency and retains provider NODE_OPTIONS", async (t) => {
  const { root, output } = await fixture(t);
  await packSite({ sourceRoot: root });
  const result = spawnSync(process.execPath, [join(output, "start-site.cjs")], {
    env: { PORT: "8080", HOSTNAME: "untrusted-container-host", NODE_OPTIONS: "--no-warnings" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    dependency: "complete-standalone",
    port: "8080",
    hostname: "0.0.0.0",
    nodeOptions: "--no-warnings",
  });
});

for (const [name, prepare] of [
  ["source bytes", async ({ root }) => put(root, "pnpm-lock.yaml", "tampered")],
  ["source mode", async ({ root }) => chmod(join(root, "pnpm-lock.yaml"), 0o755)],
  [
    "source path escape",
    async ({ root }) =>
      changeManifest(root, (m) => {
        m.files[0].path = "../escape";
      }),
  ],
  [
    "absolute source path",
    async ({ root }) =>
      changeManifest(root, (m) => {
        m.files[0].path = "/escape";
      }),
  ],
  [
    "duplicate source path",
    async ({ root }) =>
      changeManifest(root, (m) => {
        m.files.push(m.files[0]);
      }),
  ],
  [
    "malformed revision",
    async ({ root }) =>
      changeManifest(root, (m) => {
        m.revision = [m.revision];
      }),
  ],
  [
    "missing lockfile identity",
    async ({ root }) =>
      changeManifest(root, (m) => {
        m.files = m.files.filter((file) => file.path !== "pnpm-lock.yaml");
      }),
  ],
  [
    "missing public assets",
    async ({ root }) => rm(join(root, "apps/web/public"), { recursive: true }),
  ],
  [
    "missing static assets",
    async ({ root }) => rm(join(root, "apps/web/.next/static"), { recursive: true }),
  ],
  [
    "empty static assets",
    async ({ root }) => rm(join(root, "apps/web/.next/static/chunks/app.js")),
  ],
  [
    "missing server",
    async ({ root }) => rm(join(root, "apps/web/.next/standalone/apps/web/server.js")),
  ],
  [
    "missing dependencies",
    async ({ root }) =>
      rm(join(root, "apps/web/.next/standalone/node_modules"), { recursive: true }),
  ],
  ["mismatched build", async ({ root }) => put(root, "apps/web/.next/BUILD_ID", "other-build")],
  [
    "private environment",
    async ({ root }) => put(root, "apps/web/.next/standalone/.env.production", "private"),
  ],
  [
    "private key",
    async ({ root }) => put(root, "apps/web/.next/standalone/private.pem", "private"),
  ],
  [
    "private directory",
    async ({ root }) => put(root, "apps/web/.next/standalone/.local-data/record", "private"),
  ],
  ["unlisted public input", async ({ root }) => put(root, "apps/web/public/extra.txt", "unlisted")],
  [
    "world writable file",
    async ({ root }) => chmod(join(root, "apps/web/.next/standalone/apps/web/server.js"), 0o666),
  ],
  [
    "escaping link",
    async ({ root }) =>
      symlink("../../../../package.json", join(root, "apps/web/.next/standalone/escape")),
  ],
  [
    "absolute internal link",
    async ({ root }) =>
      symlink(
        join(root, "apps/web/.next/standalone/apps/web/server.js"),
        join(root, "apps/web/.next/standalone/absolute"),
      ),
  ],
  [
    "broken link",
    async ({ root }) => symlink("missing", join(root, "apps/web/.next/standalone/broken")),
  ],
  [
    "linked source",
    async ({ root }) => {
      await rm(join(root, "pnpm-lock.yaml"));
      await symlink("package.json", join(root, "pnpm-lock.yaml"));
    },
  ],
  ["existing output", async ({ output }) => mkdir(output)],
]) {
  test(`rejects ${name} before output publication`, async (t) => {
    const current = await fixture(t);
    await prepare(current);
    await assert.rejects(packSite({ sourceRoot: current.root }));
    await assert.rejects(lstat(join(current.output, "output-manifest.json")), { code: "ENOENT" });
  });
}

for (const [key, value] of [
  ["entries", 1],
  ["bytes", 100],
  ["fileBytes", 10],
  ["manifestBytes", 10],
]) {
  test(`enforces finite ${key}`, async (t) => {
    const { root, output } = await fixture(t);
    await assert.rejects(packSite({ sourceRoot: root, limits: { ...LIMITS, [key]: value } }));
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });
}

test("rejects raised limits and alternate output destinations", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    packSite({ sourceRoot: root, limits: { ...LIMITS, bytes: LIMITS.bytes + 1 } }),
  );
  await assert.rejects(packSite({ sourceRoot: root, output: "../escaped-output" }));
});

for (const port of [undefined, "", "0", "65536", "08080", "-1", "8080tail", " 8080", 8080]) {
  test(`rejects invalid provider port ${String(port)}`, async (t) => {
    const { root, output } = await fixture(t);
    await packSite({ sourceRoot: root });
    assert.throws(() => validateStartup(output, { PORT: port }));
  });
}

for (const [name, mutate] of [
  [
    "server bytes",
    async (root) => put(root, "appwrite-output/payload/apps/web/server.js", "tampered"),
  ],
  [
    "server permissions",
    async (root) => chmod(join(root, "appwrite-output/payload/apps/web/server.js"), 0o755),
  ],
  [
    "build id",
    async (root) => put(root, "appwrite-output/payload/apps/web/.next/BUILD_ID", "tampered"),
  ],
  [
    "entrypoint",
    async (root) =>
      changeOutput(root, (m) => {
        m.payloadEntrypoint = "elsewhere.js";
      }),
  ],
  [
    "manifest revision",
    async (root) =>
      changeOutput(root, (m) => {
        m.revision = "missing";
      }),
  ],
  [
    "manifest tree",
    async (root) =>
      changeOutput(root, (m) => {
        m.outputTreeSha256 = "0".repeat(64);
      }),
  ],
]) {
  test(`startup rejects altered ${name}`, async (t) => {
    const { root, output } = await fixture(t);
    await packSite({ sourceRoot: root });
    await mutate(root);
    assert.throws(() => validateStartup(output, { PORT: "8080" }));
  });
}

test("startup failure stays bounded and does not load a server", async (t) => {
  const { root, output } = await fixture(t);
  await packSite({ sourceRoot: root });
  const result = spawnSync(process.execPath, [join(output, "start-site.cjs")], {
    env: { PORT: "private-hostile-input" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Appwrite application startup rejected its output contract.");
});

test("preserves empty structural directories and their internal links", async (t) => {
  const { root, output } = await fixture(t);
  await mkdir(join(root, "apps/web/.next/standalone/node_modules/empty"));
  await symlink("empty", join(root, "apps/web/.next/standalone/node_modules/empty-link"));
  await packSite({ sourceRoot: root });
  assert((await lstat(join(output, "payload/node_modules/empty"))).isDirectory());
  assert.equal(await readlink(join(output, "payload/node_modules/empty-link")), "empty");
});

test("rejects an existing standalone link at the added public tree", async (t) => {
  const { root, output } = await fixture(t);
  await mkdir(join(root, "apps/web/.next/standalone/other-public"));
  await symlink("../../other-public", join(root, "apps/web/.next/standalone/apps/web/public"));
  await assert.rejects(packSite({ sourceRoot: root }), /collision/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("rejects a standalone file where the static overlay needs a directory", async (t) => {
  const { root, output } = await fixture(t);
  await put(root, "apps/web/.next/standalone/apps/web/.next/static", "file");
  await assert.rejects(packSite({ sourceRoot: root }), /collision/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});
