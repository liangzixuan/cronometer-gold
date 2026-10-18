import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimePreparedInputs } from "./azure-development-runtime-prepared.mjs";

const uid = BigInt(process.getuid()),
  gid = BigInt(process.getgid()),
  sha = (value) => createHash("sha256").update(value).digest("hex");
const roleDirectories = {
  "data/postgres": 70,
  "data/meili": 1000,
  "data/capture": 1000,
  "data/export-read-spool": 1000,
  "data/export-spool": 1000,
  "data/search-spool": 1000,
};
const names = [
  "config",
  "pki",
  "mail",
  "data",
  ...Object.keys(roleDirectories),
  "data/erasure-replay-spool",
  "docker-config",
  "journal",
  "recovery-stop-journal",
  "supervision",
  "recovery",
  "tmpfs",
];
const policy = {
  ...Object.fromEntries(
    [
      "runtime",
      "postgres",
      "migrate",
      "database",
      "api",
      "worker",
      "canary",
      "meili",
      "scoped-meili",
      "maintenance",
    ].map((name) => [`config/${name}.env`, { uid, gid, mode: 0o600 }]),
  ),
  "config/database-bootstrap.sql": { uid: 70n, gid: 70n, mode: 0o400 },
  ...Object.fromEntries(
    ["ca", "postgres", "meili", "capture"].map((name) => [
      `pki/${name}.crt`,
      { uid, gid, mode: 0o444 },
    ]),
  ),
  "pki/postgres.key": { uid: 70n, gid: 70n, mode: 0o400 },
  "pki/meili.key": { uid: 1000n, gid: 1000n, mode: 0o400 },
  "pki/capture.key": { uid: 1000n, gid: 1000n, mode: 0o400 },
  "mail/review.htpasswd": { uid: 1000n, gid: 1000n, mode: 0o400 },
  "mail/send.htpasswd": { uid: 1000n, gid: 1000n, mode: 0o400 },
};

export async function fixture(t, options = {}) {
  const root = options.root ?? (await fs.mkdtemp(join(tmpdir(), "nutrition-runtime-prepared-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const overrides = new Map(),
    files = {},
    opened = [];
  const inode = (row) => `${row.dev}:${row.ino}`;
  for (const name of names) {
    await fs.mkdir(join(root, name), { mode: 0o700, recursive: true });
    if (Object.hasOwn(roleDirectories, name)) {
      const owner = BigInt(roleDirectories[name]),
        row = await fs.lstat(join(root, name), { bigint: true });
      overrides.set(inode(row), { uid: owner, gid: owner });
    }
  }
  for (const [name, meta] of Object.entries(policy)) {
    // These are plain synthetic labels, never actual TLS keys, passwords or mail verifiers.
    const raw = Buffer.from(options.values?.[name] ?? `synthetic-public-source-fixture:${name}\n`),
      path = join(root, name);
    await fs.writeFile(path, raw, { mode: meta.mode, flag: options.root ? "w" : "wx" });
    await fs.chmod(path, meta.mode);
    const row = await fs.lstat(path, { bigint: true });
    overrides.set(inode(row), { uid: meta.uid, gid: meta.gid });
    files[name] = { bytes: raw.length, sha256: sha(raw) };
  }
  const metadata = (row) =>
    Object.assign(Object.create(Object.getPrototypeOf(row)), row, overrides.get(inode(row)));
  const io = {
    lstat: async (path, configuration) => metadata(await fs.lstat(path, configuration)),
    open: async (path, flags) => {
      if (options.populateDuringFileOpen && opened.length === 19)
        await fs.writeFile(
          join(root, "data/postgres/PG_VERSION"),
          "preserved-late-existing-outcome\n",
          { mode: 0o600, flag: "wx" },
        );
      if (options.failOpenAfter === opened.length) throw new Error("Synthetic descriptor refusal");
      const fd = await fs.open(path, flags),
        record = { closed: false };
      opened.push(record);
      return {
        fd: fd.fd,
        stat: async (configuration) => metadata(await fd.stat(configuration)),
        read: fd.read.bind(fd),
        close: async () => {
          assert(!record.closed);
          record.closed = true;
          await fd.close();
        },
      };
    },
  };
  const controller = new AbortController(),
    input = { root, files, signal: controller.signal };
  const open = () => openRuntimePreparedInputs(input, io);
  const override = async (name, value) => {
    const row = await fs.lstat(join(root, name), { bigint: true });
    overrides.set(inode(row), { ...overrides.get(inode(row)), ...value });
  };
  return { root, files, input, open, controller, opened, override, io };
}
