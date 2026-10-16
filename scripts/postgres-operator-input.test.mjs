import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { heldOperatorInput } from "./postgres-operator-input.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
async function fixture() {
  const parent = await fs.mkdtemp(join(tmpdir(), "nutrition-operator-input-"));
  await fs.chmod(parent, 0o700);
  const path = join(parent, "input.json"),
    raw = Buffer.from('{"synthetic":true}');
  await fs.writeFile(path, raw, { mode: 0o600, flag: "wx" });
  return {
    parent,
    path,
    raw,
    async dispose() {
      await fs.rm(parent, { recursive: true, force: true });
    },
  };
}
test("held private input conserves exact bytes and descriptor identity", async () => {
  const f = await fixture();
  let h;
  try {
    h = await heldOperatorInput(f.path, sha(f.raw), { privateFile: true, maximum: 1024 });
    assert.deepEqual(h.raw, f.raw);
    assert.deepEqual(await h.conserve(), f.raw);
    assert.match(h.path, /^\/proc\/[0-9]+\/fd\/[0-9]+$/u);
  } finally {
    h?.raw.fill(0);
    await h?.fd.close();
    await f.dispose();
  }
});
for (const fault of ["digest", "mode", "parent", "size", "symlink", "hardlink", "nonprivate"])
  test("private input refuses " + fault, async () => {
    const f = await fixture();
    try {
      let path = f.path;
      if (fault === "mode") await fs.chmod(path, 0o644);
      if (fault === "parent") await fs.chmod(f.parent, 0o755);
      if (fault === "symlink") {
        path = join(f.parent, "link");
        await fs.symlink(f.path, path);
      }
      if (fault === "hardlink") await fs.link(path, join(f.parent, "extra"));
      await assert.rejects(
        heldOperatorInput(path, fault === "digest" ? "0".repeat(64) : sha(f.raw), {
          privateFile: fault !== "nonprivate",
          maximum: fault === "size" ? 1 : 1024,
        }),
      );
    } finally {
      await f.dispose();
    }
  });
for (const fault of ["bytes", "replacement", "parent"])
  test("held input refuses later " + fault, async () => {
    const f = await fixture();
    let h;
    try {
      h = await heldOperatorInput(f.path, sha(f.raw), { privateFile: true, maximum: 1024 });
      if (fault === "bytes") await fs.writeFile(f.path, Buffer.alloc(f.raw.length, 120));
      if (fault === "replacement") {
        await fs.rename(f.path, f.path + ".old");
        await fs.writeFile(f.path, f.raw, { mode: 0o600, flag: "wx" });
      }
      if (fault === "parent") await fs.chmod(f.parent, 0o755);
      await assert.rejects(h.conserve());
    } finally {
      h?.raw.fill(0);
      await h?.fd.close();
      await f.dispose();
    }
  });
test("failed held read clears allocated bytes and closes the owned descriptor", async () => {
  const f = await fixture();
  let allocated,
    closed = false;
  try {
    await assert.rejects(
      heldOperatorInput(
        f.path,
        sha(f.raw),
        { privateFile: true, maximum: 1024 },
        async (...args) => {
          const h = await fs.open(...args);
          return {
            stat: (...a) => h.stat(...a),
            async read(buffer) {
              allocated = buffer;
              buffer.fill(7);
              throw new Error("synthetic read failure");
            },
            async close() {
              await h.close();
              closed = true;
            },
          };
        },
      ),
    );
    assert.ok(allocated.every((b) => b === 0));
    assert.equal(closed, true);
  } finally {
    await f.dispose();
  }
});
