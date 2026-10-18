import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./azure-development-runtime-prepared-fixture.mjs";

const closed = (f) =>
  assert(
    f.opened.every((value) => value.closed),
    "Every opened descriptor must close on refusal or settlement",
  );
test("actual held prepared files and directory identities admit only the fixed set and permitted text", async (t) => {
  const f = await fixture(t),
    held = await f.open();
  try {
    assert.equal(held.snapshot.fileCount, 20);
    assert.equal(held.snapshot.operationalAcceptance, false);
    assert.equal(Object.keys(held.snapshot.directories).length, 18);
    assert.equal(
      await held.text("config/maintenance.env"),
      "synthetic-public-source-fixture:config/maintenance.env\n",
    );
    await assert.rejects(held.text("pki/postgres.key"));
    await held.conserve();
    assert.equal(f.opened.length, 38);
  } finally {
    await held.close();
  }
  closed(f);
  await assert.rejects(held.conserve());
});
test("unknown, missing, wrong-size and wrong-hash file references close all admitted handles", async (t) => {
  for (const change of [
    (f) => {
      f.files.extra = { bytes: 1, sha256: "a".repeat(64) };
    },
    (f) => {
      delete f.files["config/maintenance.env"];
    },
    (f) => {
      f.files["pki/postgres.key"].bytes++;
    },
    (f) => {
      f.files["mail/send.htpasswd"].sha256 = "b".repeat(64);
    },
  ]) {
    const f = await fixture(t);
    change(f);
    await assert.rejects(f.open());
    closed(f);
  }
});
test("role UID/GID/mode, one-link regular files and canonical parents are required", async (t) => {
  for (const change of [
    (f) => f.override("pki/postgres.key", { uid: 71n }),
    (f) => f.override("data/meili", { gid: 1001n }),
    (f) => fs.chmod(join(f.root, "mail/send.htpasswd"), 0o444),
    (f) => fs.link(join(f.root, "pki/postgres.key"), join(f.root, "preserved-key-link")),
    async (f) => {
      await fs.rename(join(f.root, "pki/postgres.key"), join(f.root, "preserved-original-key"));
      await fs.symlink(join(f.root, "preserved-original-key"), join(f.root, "pki/postgres.key"));
    },
  ]) {
    const f = await fixture(t);
    await change(f);
    await assert.rejects(f.open());
    closed(f);
  }
});
test("unlisted managed inputs and preexisting data/spool/journal outcomes are retained and refused", async (t) => {
  for (const name of [
    "config/unlisted.env",
    "data/postgres/PG_VERSION",
    "data/erasure-replay-spool/orphan",
    "journal/prior.json",
    "recovery-stop-journal/prior.json",
    "docker-config/config.json",
    "tmpfs/plaintext",
  ]) {
    const f = await fixture(t),
      path = join(f.root, name);
    await fs.writeFile(path, "preserve-this-existing-outcome\n", { mode: 0o600, flag: "wx" });
    await assert.rejects(f.open());
    closed(f);
    assert.equal(await fs.readFile(path, "utf8"), "preserve-this-existing-outcome\n");
  }
});
test("held immutable bytes, named inode, parent identity and managed inventory must survive later work", async (t) => {
  for (const change of [
    (f) => fs.writeFile(join(f.root, "config/maintenance.env"), "changed-after-admission\n"),
    async (f) => {
      const path = join(f.root, "config/api.env"),
        raw = await fs.readFile(path);
      await fs.rename(path, join(f.root, "preserved-api.env"));
      await fs.writeFile(path, raw, { mode: 0o600, flag: "wx" });
    },
    async (f) => {
      await fs.rename(join(f.root, "mail"), join(f.root, "preserved-mail"));
      await fs.mkdir(join(f.root, "mail"), { mode: 0o700 });
    },
    (f) =>
      fs.writeFile(join(f.root, "config/unlisted.env"), "new-undocumented-input", {
        mode: 0o600,
        flag: "wx",
      }),
    (f) => f.override("pki/capture.key", { gid: 1001n }),
  ]) {
    const f = await fixture(t),
      held = await f.open();
    try {
      await change(f);
      await assert.rejects(held.conserve());
    } finally {
      await held.close();
    }
    closed(f);
  }
});
test("expected owned data and journal growth preserves their original directory bindings", async (t) => {
  const f = await fixture(t),
    held = await f.open();
  try {
    await fs.mkdir(join(f.root, "data/postgres/base"), { mode: 0o700 });
    await fs.writeFile(join(f.root, "journal/000-owned.json"), "synthetic-owned-journal", {
      mode: 0o600,
    });
    await fs.writeFile(
      join(f.root, "data/erasure-replay-spool/current-owned"),
      "synthetic-owned-spool",
      { mode: 0o600 },
    );
    await held.conserve();
  } finally {
    await held.close();
  }
  closed(f);
});
test("descriptor opening failure or cancellation cannot leak handles or change prepared inputs", async (t) => {
  const f = await fixture(t, { failOpenAfter: 21 });
  await assert.rejects(f.open());
  closed(f);
  assert.equal(
    await fs.readFile(join(f.root, "config/maintenance.env"), "utf8"),
    "synthetic-public-source-fixture:config/maintenance.env\n",
  );
  const cancelled = await fixture(t);
  cancelled.controller.abort();
  await assert.rejects(cancelled.open());
  closed(cancelled);
  assert.equal(cancelled.opened.length, 0);
});

test("an outcome inserted after its early empty check refuses final admission and remains preserved", async (t) => {
  const f = await fixture(t, { populateDuringFileOpen: true });
  let unexpected;
  try {
    await assert.rejects(async () => {
      unexpected = await f.open();
    });
    closed(f);
    assert.equal(
      await fs.readFile(join(f.root, "data/postgres/PG_VERSION"), "utf8"),
      "preserved-late-existing-outcome\n",
    );
  } finally {
    if (unexpected) await unexpected.close();
  }
});
