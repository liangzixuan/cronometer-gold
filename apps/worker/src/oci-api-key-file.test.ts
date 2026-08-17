import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOciApiSigningPrivateKey } from "./oci-api-key-file.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nutrition-oci-key-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("restore-only OCI API signing key file", () => {
  it("reads an owner-only bounded regular file", async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, "oci-api-key.pem");
    const key = "strict-test-key-bytes\n";
    await writeFile(keyPath, key, { encoding: "utf8", mode: 0o600 });
    await chmod(keyPath, 0o400);
    await expect(loadOciApiSigningPrivateKey(keyPath)).resolves.toBe(key);
  });

  it("rejects relative paths and symbolic links", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.pem");
    const link = join(directory, "link.pem");
    await writeFile(target, "test-key", { mode: 0o600 });
    await symlink(target, link);
    await expect(loadOciApiSigningPrivateKey("relative-key.pem")).rejects.toThrow(
      "safe absolute file path",
    );
    await expect(loadOciApiSigningPrivateKey(link)).rejects.toThrow("owner-only regular file");
  });

  it("rejects group-readable and oversized key files", async () => {
    const directory = await temporaryDirectory();
    const permissive = join(directory, "permissive.pem");
    const oversized = join(directory, "oversized.pem");
    await writeFile(permissive, "test-key", { mode: 0o600 });
    await chmod(permissive, 0o640);
    await writeFile(oversized, Buffer.alloc(16_385, 0x61), { mode: 0o600 });
    await expect(loadOciApiSigningPrivateKey(permissive)).rejects.toThrow(
      "owner-only regular file",
    );
    await expect(loadOciApiSigningPrivateKey(oversized)).rejects.toThrow("owner-only regular file");
  });
});
