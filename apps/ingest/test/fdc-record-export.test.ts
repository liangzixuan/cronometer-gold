import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  canonicalJson,
  createStagedFood,
  type StagedFoodRecord,
} from "@nutrition-tracker/ingestion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFdcRecordExport, FDC_RECORD_EXPORT_MAX_BYTES } from "../src/fdc-record-export.js";

const hooks = vi.hoisted(() => ({
  beforeLink: undefined as undefined | ((source: string, destination: string) => Promise<void>),
  afterLink: undefined as undefined | ((source: string, destination: string) => Promise<void>),
  beforeRename: undefined as undefined | ((source: string, destination: string) => Promise<void>),
  beforeUnlink: undefined as undefined | ((path: string) => Promise<void>),
  beforeWrite: undefined as undefined | ((path: string) => Promise<void>),
  beforeSync: undefined as undefined | ((path: string) => Promise<void>),
  beforeClose: undefined as undefined | ((path: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.writeFile = async (...values: Parameters<FileHandle["writeFile"]>) => {
        await hooks.beforeWrite?.(path);
        return write(...values);
      };
      handle.sync = async () => {
        await hooks.beforeSync?.(path);
        return sync();
      };
      handle.close = async () => {
        await hooks.beforeClose?.(path);
        return close();
      };
      return handle;
    },
    link: async (source: string, destination: string) => {
      await hooks.beforeLink?.(source, destination);
      await actual.link(source, destination);
      await hooks.afterLink?.(source, destination);
    },
    rename: async (source: string, destination: string) => {
      await hooks.beforeRename?.(source, destination);
      await actual.rename(source, destination);
    },
    unlink: async (path: string) => {
      await hooks.beforeUnlink?.(path);
      await actual.unlink(path);
    },
  };
});

const cleanupPaths: string[] = [];
const HEADER = { recordType: "header", authority: { activation: false }, schemaVersion: 1 };
const FOOTER = { recordType: "footer", validated: true };
const RECORD = createStagedFood({
  sourceCode: "FDC",
  releaseKey: "synthetic",
  sourceRecordId: "1",
  sourceDataType: "Foundation",
  languageTag: "en",
  marketCode: "US",
  description: "Synthetic pear é",
  rawSourceRecord: { id: 1 },
  nutrients: [],
});

afterEach(async () => {
  for (const key of Object.keys(hooks) as (keyof typeof hooks)[]) hooks[key] = undefined;
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("bounded private FDC normalized record export", () => {
  it("publishes exact canonical lines, separate digests and private modes without retaining a spool", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    const second = { ...RECORD, idempotencyKey: "second" };
    await writer.append(RECORD);
    await writer.append(second);
    await expect(lstat(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await writer.publish(expectation([RECORD, second]));
    const body = [HEADER, RECORD, second, FOOTER]
      .map((value) => `${canonicalJson(value)}\n`)
      .join("");
    expect(await readFile(fixture.outputPath, "utf8")).toBe(body);
    expect(result).toEqual({
      path: fixture.outputPath,
      byteSize: Buffer.byteLength(body),
      sha256: digest(body),
      recordCount: 2,
      recordsSha256: expectation([RECORD, second]).expectedRecordSha256,
    });
    expect((await lstat(fixture.outputPath)).mode & 0o777).toBe(0o600);
    for (const path of [
      ".local-data",
      ".local-data/evidence",
      ".local-data/evidence/fdc-csv-records",
    ]) {
      expect((await lstat(join(fixture.workspaceRoot, path))).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(fixture.parent)).toEqual(["records.ndjson"]);
    await writer.abort();
    await expect(writer.append(RECORD)).rejects.toThrow("published");
    await expect(writer.publish(expectation([]))).rejects.toThrow("published");
    expect(await readFile(fixture.outputPath, "utf8")).toBe(body);
  });

  it.each(["header", "record", "footer"])(
    "bounds %s bytes and leaves no final output",
    async (stage) => {
      const fixture = await createFixture();
      const headerBytes = Buffer.byteLength(`${canonicalJson(HEADER)}\n`);
      if (stage === "header") {
        await expect(
          createFdcRecordExport({ ...fixture, maxBytes: headerBytes - 1 }),
        ).rejects.toThrow("byte budget");
      } else {
        const writer = await createFdcRecordExport({
          ...fixture,
          maxBytes:
            headerBytes +
            (stage === "footer" ? Buffer.byteLength(`${canonicalJson(RECORD)}\n`) : 0),
        });
        if (stage === "record") await expect(writer.append(RECORD)).rejects.toThrow("byte budget");
        else {
          await writer.append(RECORD);
          await expect(writer.publish(expectation([RECORD]))).rejects.toThrow("byte budget");
        }
        await writer.abort();
      }
      expect(await readdir(fixture.parent)).toEqual([]);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, FDC_RECORD_EXPORT_MAX_BYTES + 1])(
    "rejects invalid or raised byte budgets (%s)",
    async (maxBytes) => {
      await expect(createFdcRecordExport({ ...(await createFixture()), maxBytes })).rejects.toThrow(
        "hard ceiling",
      );
    },
  );

  it.each(["count", "hash"])(
    "cannot publish a %s mismatch or reuse the failed writer",
    async (kind) => {
      const fixture = await createFixture();
      const writer = await createFdcRecordExport(fixture);
      await writer.append(RECORD);
      await expect(
        writer.publish({
          ...expectation([RECORD]),
          ...(kind === "count"
            ? { expectedRecordCount: 2 }
            : { expectedRecordSha256: "0".repeat(64) }),
        }),
      ).rejects.toThrow("count or digest");
      await expect(writer.publish(expectation([RECORD]))).rejects.toThrow("failed");
      await writer.abort();
      await writer.abort();
      expect(await readdir(fixture.parent)).toEqual([]);
    },
  );

  it("preserves existing and concurrently created destinations", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    await writeFile(fixture.outputPath, "unrelated", { mode: 0o600 });
    await expect(writer.publish(expectation([]))).rejects.toThrow("refusing to overwrite");
    expect(await readFile(fixture.outputPath, "utf8")).toBe("unrelated");
    await expect(createFdcRecordExport(fixture)).rejects.toThrow("refusing to overwrite");
  });

  it.each([
    "../escape.ndjson",
    "nested/records.ndjson",
    "records.json",
    "records.ndjson/",
    "a\\records.ndjson",
  ])("rejects noncanonical output (%s)", async (name) => {
    const fixture = await createFixture();
    await expect(
      createFdcRecordExport({ ...fixture, outputPath: `${fixture.parent}/${name}` }),
    ).rejects.toThrow("canonical Linux path");
  });

  it("rejects symlinked/private-directory violations and leaves unrelated files intact", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.workspaceRoot, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(fixture.workspaceRoot, ".local-data"));
    await expect(createFdcRecordExport(fixture)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    await unlink(join(fixture.workspaceRoot, ".local-data"));
    await mkdir(join(fixture.workspaceRoot, ".local-data"), { mode: 0o755 });
    await expect(createFdcRecordExport(fixture)).rejects.toThrow("private (0700)");
    await chmod(join(fixture.workspaceRoot, ".local-data"), 0o700);
    const writer = await createFdcRecordExport(fixture);
    await writer.abort();
    await symlink(join(outside, "target"), fixture.outputPath);
    await expect(createFdcRecordExport(fixture)).rejects.toThrow("refusing to overwrite");
    expect((await lstat(fixture.outputPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects a workspace reached through a symlink or a Windows mount", async () => {
    const fixture = await createFixture();
    const alias = `${fixture.workspaceRoot}-alias`;
    cleanupPaths.push(alias);
    await symlink(fixture.workspaceRoot, alias);
    await expect(
      createFdcRecordExport({
        ...fixture,
        workspaceRoot: alias,
        outputPath: join(alias, ".local-data/evidence/fdc-csv-records/records.ndjson"),
      }),
    ).rejects.toThrow("symbolic link");
    await expect(
      createFdcRecordExport({ ...fixture, workspaceRoot: "/mnt/c/project" }),
    ).rejects.toThrow("canonical Linux path");
  });

  it("detects changed temporary content before publication", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    const temporary = await tempPath(fixture.parent);
    const bytes = await readFile(temporary);
    bytes[0] = 32;
    await writeFile(temporary, bytes);
    await expect(writer.publish(expectation([]))).rejects.toThrow("content or identity changed");
    expect(await readdir(fixture.parent)).toEqual([]);
  });

  it("preserves a substituted temporary path and refuses publication", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    const temporary = await tempPath(fixture.parent);
    await rename(temporary, `${temporary}.original`);
    await writeFile(temporary, "replacement", { mode: 0o600 });
    await expect(writer.publish(expectation([]))).rejects.toThrow("export and cleanup failed");
    await expect(lstat(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(temporary, "utf8")).toBe("replacement");
  });

  it("rolls back a substituted source linked at the syscall boundary, preserving the substituted temporary file", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    let replacement = "";
    hooks.beforeLink = async (source) => {
      hooks.beforeLink = undefined;
      replacement = join(fixture.parent, basename(source));
      await rename(source, `${source}.original`);
      await writeFile(source, "replacement", { mode: 0o600 });
    };
    await expect(writer.publish(expectation([]))).rejects.toThrow("export and cleanup failed");
    await expect(lstat(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(replacement, "utf8")).toBe("replacement");
  });

  it("preserves an unrelated replacement of the final path", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    hooks.afterLink = async (_source, destination) => {
      hooks.afterLink = undefined;
      await unlink(destination);
      await writeFile(destination, "unrelated replacement", { mode: 0o600 });
    };
    await expect(writer.publish(expectation([]))).rejects.toThrow("export and cleanup failed");
    expect(await readFile(fixture.outputPath, "utf8")).toBe("unrelated replacement");
  });

  it.each(["before", "during"])(
    "rejects a renamed output parent %s linking without escaped publication",
    async (when) => {
      const fixture = await createFixture();
      const writer = await createFdcRecordExport(fixture);
      const moved = `${fixture.parent}-moved`;
      const replace = async () => {
        await rename(fixture.parent, moved);
        await mkdir(fixture.parent, { mode: 0o700 });
        await writeFile(join(fixture.parent, "keep"), "unrelated");
      };
      if (when === "before") await replace();
      else
        hooks.beforeLink = async () => {
          hooks.beforeLink = undefined;
          await replace();
        };
      await expect(writer.publish(expectation([]))).rejects.toThrow("directory identity changed");
      expect(await readdir(moved)).toEqual([]);
      expect(await readdir(fixture.parent)).toEqual(["keep"]);
    },
  );

  it("restores a replaced temporary path discovered during cleanup without deleting it", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    let replacement = "";
    hooks.beforeRename = async (source) => {
      hooks.beforeRename = undefined;
      replacement = join(fixture.parent, basename(source));
      await rename(source, `${source}.original`);
      await writeFile(source, "replacement", { mode: 0o600 });
    };
    await expect(writer.abort()).rejects.toThrow("required cleanup failed");
    expect(await readFile(replacement, "utf8")).toBe("replacement");
    await expect(lstat(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["write", "file-sync", "close", "parent-close", "parent-sync", "cleanup"])(
    "fails closed on injected %s failure",
    async (failure) => {
      const fixture = await createFixture();
      const writer = await createFdcRecordExport(fixture);
      const fail = async () => {
        throw new Error(`injected ${failure} failure`);
      };
      if (failure === "write") hooks.beforeWrite = fail;
      if (failure === "file-sync")
        hooks.beforeSync = async (path) => {
          if (path.endsWith(".tmp")) await fail();
        };
      if (failure === "close")
        hooks.beforeClose = async (path) => {
          if (path.endsWith(".tmp")) {
            hooks.beforeClose = undefined;
            await fail();
          }
        };
      if (failure === "parent-close")
        hooks.beforeClose = async (path) => {
          if (path.endsWith("/fdc-csv-records")) {
            hooks.beforeClose = undefined;
            await fail();
          }
        };
      if (failure === "parent-sync")
        hooks.beforeSync = async (path) => {
          if (path.endsWith("/fdc-csv-records")) await fail();
        };
      if (failure === "cleanup")
        hooks.beforeUnlink = async (path) => {
          if (path.includes(".tmp.")) {
            hooks.beforeUnlink = undefined;
            await fail();
          }
        };
      await expect(writer.publish(expectation([]))).rejects.toThrow(`injected ${failure} failure`);
      await expect(lstat(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writer.abort();
    },
  );

  it("serializes concurrent abort cleanup", async () => {
    const fixture = await createFixture();
    const writer = await createFdcRecordExport(fixture);
    let release = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    hooks.beforeRename = async () => {
      await gate;
    };
    const first = writer.abort();
    const second = writer.abort();
    release();
    await Promise.all([first, second]);
    expect(await readdir(fixture.parent)).toEqual([]);
  });

  it("supports idempotent abort and cancellation immediately before publication", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const writer = await createFdcRecordExport({ ...fixture, signal: controller.signal });
    hooks.beforeLink = async () => {
      controller.abort(new Error("cancelled publication"));
    };
    await expect(writer.publish(expectation([]))).rejects.toThrow("cancelled publication");
    expect(await readdir(fixture.parent)).toEqual([]);
    await writer.abort();
    await writer.abort();
    await expect(writer.append(RECORD)).rejects.toThrow("aborted");
  });

  it.each(["append", "publish", "abort"])(
    "waits for write backpressure and safely rejects concurrent %s",
    async (action) => {
      const fixture = await createFixture();
      const writer = await createFdcRecordExport(fixture);
      let release = () => {};
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      hooks.beforeWrite = async () => {
        await gate;
      };
      const first = writer.append(RECORD);
      const firstFailure = expect(first).rejects.toThrow("aborted or used concurrently");
      let aborted: Promise<void> | undefined;
      if (action === "abort") aborted = writer.abort();
      else
        await expect(
          action === "append" ? writer.append(RECORD) : writer.publish(expectation([])),
        ).rejects.toThrow("forbids concurrent");
      release();
      await firstFailure;
      await aborted;
      await writer.abort();
      expect(await readdir(fixture.parent)).toEqual([]);
    },
  );
});

async function createFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fdc-record-export-test-"));
  cleanupPaths.push(workspaceRoot);
  const parent = join(workspaceRoot, ".local-data/evidence/fdc-csv-records");
  return { workspaceRoot, parent, outputPath: join(parent, "records.ndjson"), header: HEADER };
}

function expectation(records: readonly StagedFoodRecord[]) {
  return {
    footer: FOOTER,
    expectedRecordCount: records.length,
    expectedRecordSha256: digest(records.map((record) => `${canonicalJson(record)}\n`).join("")),
  };
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function tempPath(parent: string): Promise<string> {
  const name = (await readdir(parent)).find((entry) => entry.endsWith(".tmp"));
  if (!name) throw new Error("Missing private temporary export");
  return join(parent, name);
}
