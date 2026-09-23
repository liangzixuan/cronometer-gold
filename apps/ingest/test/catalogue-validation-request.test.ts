import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertCatalogueValidationRequestDestination,
  catalogueValidationRequestPath,
  MAX_CATALOGUE_VALIDATION_REQUEST_BYTES,
  readCatalogueValidationRequest,
  writeCatalogueValidationRequest,
} from "../src/catalogue-validation-request.js";

const PATH = ".local-data/evidence/catalogue-validation/request.json";
const DOCUMENT = {
  kind: "retained-request",
  observation: "opaque-postgresql-token",
  validationDocument: '{"frozen":"same\\nbytes"}',
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catalogue-request-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const pins = (bytes: Buffer) => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.length,
});

describe("retained catalogue validation request", () => {
  it("durably publishes private canonical bytes, exact pins and the original inner document", async () => {
    const file = await writeCatalogueValidationRequest(PATH, DOCUMENT, root);
    const bytes = await readFile(join(root, PATH));
    expect(file).toEqual({ path: PATH, ...pins(bytes) });
    expect(bytes.toString()).toBe(`${JSON.stringify(DOCUMENT)}\n`);
    expect((await lstat(join(root, PATH))).mode & 0o777).toBe(0o600);
    for (const part of [".local-data", ".local-data/evidence", dirname(PATH)]) {
      expect((await lstat(join(root, part))).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(join(root, dirname(PATH)))).toEqual(["request.json"]);
    expect(await readCatalogueValidationRequest(PATH, file, root)).toEqual(DOCUMENT);
  });

  it("round-trips a large escaped request with exact native JSON bytes and private-file pins", async () => {
    const requestDocument = JSON.stringify({
      payload: 'quote"\\\n\u0000café😀'.repeat(40_000),
    });
    // Insertion order here is canonical; native JSON supplies an independent byte oracle.
    const document = { kind: "retained-request", requestDocument };
    const expectedBytes = Buffer.from(`${JSON.stringify(document)}\n`);
    expect(expectedBytes.byteLength).toBeGreaterThan(1024 * 1024);

    const file = await writeCatalogueValidationRequest(PATH, document, root);
    expect(file).toEqual({ path: PATH, ...pins(expectedBytes) });
    expect((await readFile(join(root, PATH))).equals(expectedBytes)).toBe(true);
    expect(await readCatalogueValidationRequest(PATH, file, root)).toEqual(document);
    expect((await lstat(join(root, PATH))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, dirname(PATH)))).toEqual(["request.json"]);
  });

  it("never overwrites a retained request or leaves a competing temporary file", async () => {
    const file = await writeCatalogueValidationRequest(PATH, DOCUMENT, root);
    const bytes = await readFile(join(root, PATH));
    await expect(writeCatalogueValidationRequest(PATH, { changed: true }, root)).rejects.toThrow(
      "publication failed",
    );
    await expect(assertCatalogueValidationRequestDestination(PATH, root)).rejects.toThrow(
      "already exists",
    );
    expect(await readFile(join(root, PATH))).toEqual(bytes);
    expect(await readCatalogueValidationRequest(PATH, file, root)).toEqual(DOCUMENT);
    expect(await readdir(join(root, dirname(PATH)))).toEqual(["request.json"]);
  });

  it("permits exactly one concurrent publication without replacing the winner", async () => {
    const outcomes = await Promise.allSettled([
      writeCatalogueValidationRequest(PATH, { source: "first" }, root),
      writeCatalogueValidationRequest(PATH, { source: "second" }, root),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((item) => item.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("missing winner");
    expect(await readCatalogueValidationRequest(PATH, winner.value, root)).toEqual(
      expect.objectContaining({ source: expect.stringMatching(/^(first|second)$/u) }),
    );
    expect(await readdir(join(root, dirname(PATH)))).toEqual(["request.json"]);
  });

  it.each([
    "../outside.json",
    "/tmp/request.json",
    "C:\\request.json",
    ".local-data/evidence/catalogue-validation/../escape.json",
    ".local-data/evidence/catalogue-validation/sub/request.json",
    ".local-data/evidence/catalogue-validation/.hidden.json",
    ".local-data/evidence/catalogue-validation/request.ndjson",
  ])("rejects an unsafe or unsupported destination %s", async (path) => {
    await expect(writeCatalogueValidationRequest(path, DOCUMENT, root)).rejects.toThrow(
      "must name",
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects Windows-mounted workspaces before creating evidence", () => {
    expect(() => catalogueValidationRequestPath(PATH, "/mnt/c/Users/example/repo")).toThrow(
      "Linux filesystem",
    );
  });

  it("rejects permissive shared evidence directories without changing their modes", async () => {
    await mkdir(join(root, ".local-data"), { mode: 0o755 });
    await expect(writeCatalogueValidationRequest(PATH, DOCUMENT, root)).rejects.toThrow(
      "mode 0700",
    );
    expect((await lstat(join(root, ".local-data"))).mode & 0o777).toBe(0o755);
  });

  it("rejects a symlinked private directory and preserves its unrelated target", async () => {
    await mkdir(join(root, "other"), { mode: 0o700 });
    await writeFile(join(root, "other", "keep"), "preserved");
    await symlink("other", join(root, ".local-data"));
    await expect(writeCatalogueValidationRequest(PATH, DOCUMENT, root)).rejects.toThrow();
    expect(await readdir(join(root, "other"))).toEqual(["keep"]);
  });

  it.each(["symlink", "hardlink", "mode", "directory"] as const)(
    "rejects a %s request file",
    async (kind) => {
      const file = await writeCatalogueValidationRequest(PATH, DOCUMENT, root);
      if (kind === "symlink") {
        await symlink("request.json", join(root, dirname(PATH), "alias.json"));
        await expect(
          readCatalogueValidationRequest(PATH.replace("request.json", "alias.json"), file, root),
        ).rejects.toThrow();
        return;
      }
      if (kind === "hardlink")
        await link(join(root, PATH), join(root, dirname(PATH), "alias.json"));
      if (kind === "mode") await chmod(join(root, PATH), 0o644);
      if (kind === "directory") {
        await rm(join(root, PATH));
        await mkdir(join(root, PATH), { mode: 0o700 });
      }
      await expect(readCatalogueValidationRequest(PATH, file, root)).rejects.toThrow(
        "mode-0600 regular file",
      );
    },
  );

  it("detects altered bytes even when their length is unchanged", async () => {
    const file = await writeCatalogueValidationRequest(PATH, DOCUMENT, root);
    const bytes = await readFile(join(root, PATH));
    bytes[10] = bytes[10] === 97 ? 98 : 97;
    await writeFile(join(root, PATH), bytes);
    await expect(readCatalogueValidationRequest(PATH, file, root)).rejects.toThrow("SHA-256");
  });

  it.each([
    Buffer.from('{"b":1,"a":2}\n'),
    Buffer.from('{"a":1,"a":2}\n'),
    Buffer.from('{"a":2}'),
    Buffer.from('{"a":2}\n\n'),
    Buffer.from([0xff]),
  ])("rejects pinned bytes that are not one canonical UTF-8 document", async (bytes) => {
    await assertCatalogueValidationRequestDestination(PATH, root);
    await writeFile(join(root, PATH), bytes, { mode: 0o600 });
    await expect(readCatalogueValidationRequest(PATH, pins(bytes), root)).rejects.toThrow(
      /canonical|UTF-8/u,
    );
  });

  it("bounds pins before touching any filesystem", async () => {
    for (const byteSize of [0, -1, 1.5, MAX_CATALOGUE_VALIDATION_REQUEST_BYTES + 1]) {
      await expect(
        readCatalogueValidationRequest(PATH, { sha256: "a".repeat(64), byteSize }, root),
      ).rejects.toThrow("bounded byte-size");
    }
    expect(await readdir(root)).toEqual([]);
  });
});
