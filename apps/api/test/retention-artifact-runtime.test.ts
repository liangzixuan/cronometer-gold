import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiRetentionDependencyConfig } from "../src/config.js";
import { createApiRetentionArtifactRuntime } from "../src/retention-artifact-runtime.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("API retention artifact runtime", () => {
  it("removes only stale owned authenticated plaintext crash spools before serving", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-retention-artifacts-"));
    cleanup.push(root);
    const spool = join(root, "protected-spool");
    const encrypted = join(root, "encrypted-objects");
    await mkdir(spool, { mode: 0o700 });
    const orphan = join(spool, "nutrition-artifact-read-crashed");
    const unrelated = join(spool, "operator-data");
    await Promise.all([mkdir(orphan, { mode: 0o700 }), mkdir(unrelated, { mode: 0o700 })]);
    const old = new Date(Date.now() - 2 * 60_000);
    await utimes(orphan, old, old);
    const config: ApiRetentionDependencyConfig = {
      artifactDirectory: encrypted,
      artifactEncryptionKeyRing: {
        currentKeyId: "export-v1",
        keys: new Map([["export-v1", Buffer.alloc(32, 1)]]),
        purpose: "export",
      },
      artifactReadMaximumArtifactBytes: 100 * 1_024 * 1_024,
      artifactReadMaximumBytesPerWindow: 200 * 1_024 * 1_024,
      artifactReadMaximumConcurrency: 1,
      artifactReadMaximumDownloadsPerWindow: 2,
      artifactReadMaximumReservedBytes: 100 * 1_024 * 1_024,
      artifactReadRateWindowMs: 60_000,
      artifactReadSpoolDirectory: spool,
      artifactReadSpoolMaximumAgeMs: 60_000,
      artifactReadSpoolProtection: "encrypted_volume",
      artifactRequestTimeoutMs: 30_000,
      artifactStore: "filesystem",
      deviceChallengeHmacKey: Buffer.alloc(32, 4),
      erasureLedgerLocatorKeyRing: {
        currentKeyId: "locator-v1",
        keys: new Map([["locator-v1", Buffer.alloc(32, 2)]]),
      },
      erasureStatusCapabilityHmacKey: Buffer.alloc(32, 3),
    };
    await createApiRetentionArtifactRuntime(config);
    expect(await readdir(spool)).toEqual(["operator-data"]);
  });
});
