/** Held prepared inputs for one fresh private runtime. This consumer never creates or changes paths. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { trustedPath } from "./postgres-operator-process.mjs";

const sha = (raw) => createHash("sha256").update(raw).digest("hex");
const failure = () => new Error("Prepared runtime inputs changed or do not meet the fixed profile");
const controller = "controller";
const directories = {
  "": controller,
  config: controller,
  pki: controller,
  mail: controller,
  data: controller,
  "data/postgres": 70,
  "data/meili": 1000,
  "data/capture": 1000,
  "data/export-read-spool": 1000,
  "data/export-spool": 1000,
  "data/search-spool": 1000,
  "data/erasure-replay-spool": controller,
  "docker-config": controller,
  journal: controller,
  "recovery-stop-journal": controller,
  supervision: controller,
  recovery: controller,
  tmpfs: controller,
};
const emptyAtAdmission = new Set([
  "data/postgres",
  "data/meili",
  "data/capture",
  "data/export-read-spool",
  "data/export-spool",
  "data/search-spool",
  "data/erasure-replay-spool",
  "docker-config",
  "journal",
  "recovery-stop-journal",
  "tmpfs",
]);
const privateFiles = Object.fromEntries([
  ...[
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
  ].map((name) => [`config/${name}.env`, { owner: controller, mode: 0o600, maximum: 262_144 }]),
  ["config/database-bootstrap.sql", { owner: 70, mode: 0o400, maximum: 65_536 }],
  ...["ca", "postgres", "meili", "capture"].map((name) => [
    `pki/${name}.crt`,
    { owner: controller, mode: 0o444, maximum: 65_536 },
  ]),
  ...[
    ["postgres", 70],
    ["meili", 1000],
    ["capture", 1000],
  ].map(([name, owner]) => [`pki/${name}.key`, { owner, mode: 0o400, maximum: 65_536 }]),
  ...["review", "send"].map((name) => [
    `mail/${name}.htpasswd`,
    { owner: 1000, mode: 0o400, maximum: 8192 },
  ]),
]);
const textInputs = new Set([
  "config/maintenance.env",
  "pki/ca.crt",
  "pki/client.crt",
  "config/database-bootstrap.sql",
]);
const dirIdentity = (row) => [row.dev, row.ino, row.mode, row.uid, row.gid].join(":");
const fileIdentity = (row) =>
  [
    row.dev,
    row.ino,
    row.mode,
    row.uid,
    row.gid,
    row.nlink,
    row.size,
    row.mtimeNs,
    row.ctimeNs,
  ].join(":");

/** Reference names and role ownership come from source, never caller-provided path or chmod rules. */
export async function openRuntimePreparedInputs(input, execution = {}) {
  const root = input.root,
    files = input.clientAccess
      ? {
          ...privateFiles,
          "pki/client.crt": { owner: controller, mode: 0o444, maximum: 65_536 },
          "pki/client.key": { owner: 1000, mode: 0o400, maximum: 65_536 },
        }
      : privateFiles,
    references = structuredClone(input.files),
    signal = input.signal;
  assert(typeof root === "string" && isAbsolute(root) && resolve(root) === root && root !== "/");
  assert(signal instanceof AbortSignal);
  const io = { lstat, open, readdir, realpath, ...execution };
  const uid = process.getuid(),
    gid = process.getgid();
  assert(Number.isSafeInteger(uid) && Number.isSafeInteger(gid));
  const owned = (value) =>
    value === controller ? [BigInt(uid), BigInt(gid)] : [BigInt(value), BigInt(value)];
  const heldDirectories = new Map(),
    heldFiles = new Map();
  let closed = false,
    total = 0;
  const guard = () => {
    signal.throwIfAborted();
    assert(!closed);
  };
  const close = async () => {
    assert(!closed);
    closed = true;
    const failures = [];
    for (const value of [...heldFiles.values(), ...[...heldDirectories.values()].reverse()]) {
      try {
        await value.fd.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failure();
  };
  const directoryCheck = async (name) => {
    guard();
    const value = heldDirectories.get(name);
    assert(value);
    assert((await io.realpath(value.path)) === value.path);
    assert(dirIdentity(await io.lstat(value.path, { bigint: true })) === value.identity);
    assert(dirIdentity(await value.fd.stat({ bigint: true })) === value.identity);
  };
  async function allDirectories() {
    guard();
    await trustedPath(root, { directory: true, privateLeaf: true });
    for (const name of heldDirectories.keys()) await directoryCheck(name);
    guard();
  }
  const inventories = Object.fromEntries(
    ["config", "pki", "mail"].map((directory) => [
      directory,
      Object.keys(files)
        .filter((name) => dirname(name) === directory)
        .map((name) => name.slice(directory.length + 1))
        .sort(),
    ]),
  );
  const checkInventories = async () => {
    for (const [directory, names] of Object.entries(inventories)) {
      guard();
      assert.deepEqual((await io.readdir(join(root, directory))).sort(), names);
    }
  };
  const readHeld = async (name) => {
    guard();
    const value = heldFiles.get(name);
    assert(value);
    await directoryCheck(dirname(name));
    assert(fileIdentity(await io.lstat(value.path, { bigint: true })) === value.identity);
    assert(fileIdentity(await value.fd.stat({ bigint: true })) === value.identity);
    const raw = Buffer.alloc(value.bytes);
    try {
      let offset = 0;
      while (offset < raw.length) {
        guard();
        const { bytesRead } = await value.fd.read(raw, offset, raw.length - offset, offset);
        assert(bytesRead > 0);
        offset += bytesRead;
      }
      guard();
      assert(sha(raw) === value.sha256);
      assert(fileIdentity(await value.fd.stat({ bigint: true })) === value.identity);
      assert(fileIdentity(await io.lstat(value.path, { bigint: true })) === value.identity);
      await directoryCheck(dirname(name));
      return raw;
    } catch (error) {
      raw.fill(0);
      throw error;
    }
  };
  const conserve = async () => {
    try {
      await allDirectories();
      await checkInventories();
      for (const name of heldFiles.keys()) (await readHeld(name)).fill(0);
      await checkInventories();
      await allDirectories();
    } catch {
      throw failure();
    }
  };
  try {
    guard();
    assert(references && Object.getPrototypeOf(references) === Object.prototype);
    assert.deepEqual(Object.keys(references).sort(), Object.keys(files).sort());
    await trustedPath(root, { directory: true, privateLeaf: true });
    for (const [name, owner] of Object.entries(directories)) {
      guard();
      const path = join(root, name),
        named = await io.lstat(path, { bigint: true });
      assert(named.isDirectory() && !named.isSymbolicLink() && (named.mode & 0o7777n) === 0o700n);
      const [user, group] = owned(owner);
      assert(named.uid === user && named.gid === group);
      assert((await io.realpath(path)) === path);
      if (name) await directoryCheck(dirname(name) === "." ? "" : dirname(name));
      const parent = name
        ? heldDirectories.get(dirname(name) === "." ? "" : dirname(name))
        : undefined;
      const pathInParent = parent
        ? `/proc/self/fd/${parent.fd.fd}/${name.slice(name.lastIndexOf("/") + 1)}`
        : path;
      const fd = await io.open(
        pathInParent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      heldDirectories.set(name, { fd, path, identity: dirIdentity(named) });
      assert(dirIdentity(await fd.stat({ bigint: true })) === dirIdentity(named));
      if (emptyAtAdmission.has(name)) assert((await io.readdir(path)).length === 0);
    }
    for (const [name, policy] of Object.entries(files)) {
      guard();
      const reference = references[name];
      assert(
        reference &&
          Object.keys(reference).sort().join(",") === "bytes,sha256" &&
          /^[a-f0-9]{64}$/u.test(reference.sha256),
      );
      assert(
        Number.isSafeInteger(reference.bytes) &&
          reference.bytes > 0 &&
          reference.bytes <= policy.maximum,
      );
      total += reference.bytes;
      assert(total <= 2_097_152);
      const path = join(root, name),
        named = await io.lstat(path, { bigint: true }),
        [user, group] = owned(policy.owner);
      assert(
        named.isFile() &&
          !named.isSymbolicLink() &&
          named.nlink === 1n &&
          named.size === BigInt(reference.bytes) &&
          named.uid === user &&
          named.gid === group &&
          (named.mode & 0o7777n) === BigInt(policy.mode),
      );
      const parent = heldDirectories.get(dirname(name));
      assert(parent);
      const fd = await io.open(
        `/proc/self/fd/${parent.fd.fd}/${name.slice(name.lastIndexOf("/") + 1)}`,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      heldFiles.set(name, {
        fd,
        path,
        identity: fileIdentity(named),
        bytes: reference.bytes,
        sha256: reference.sha256,
      });
      assert(fileIdentity(await fd.stat({ bigint: true })) === fileIdentity(named));
      (await readHeld(name)).fill(0);
    }
    await conserve();
    for (const name of emptyAtAdmission) {
      await directoryCheck(name);
      const directory = heldDirectories.get(name);
      assert((await io.readdir(`/proc/self/fd/${directory.fd.fd}`)).length === 0);
      await directoryCheck(name);
    }
    const snapshot = Object.freeze({
      kind: "nutrition-development-prepared-inputs-v1",
      root,
      fileCount: heldFiles.size,
      directories: Object.freeze(
        Object.fromEntries([...heldDirectories].map(([name, value]) => [name, value.identity])),
      ),
      fileReferences: Object.freeze(
        Object.fromEntries(
          Object.entries(references).map(([name, value]) => [name, Object.freeze(value)]),
        ),
      ),
      operationalAcceptance: false,
    });
    return Object.freeze({
      snapshot,
      conserve,
      close,
      async text(name) {
        assert(textInputs.has(name));
        await allDirectories();
        const raw = await readHeld(name);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(raw);
        } finally {
          raw.fill(0);
        }
      },
    });
  } catch {
    try {
      await close();
    } catch {
      throw failure();
    }
    throw failure();
  }
}
