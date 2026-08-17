import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseWorkerConfig } from "./config.js";
import { createRetentionStorageRuntime } from "./retention-storage.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("retention storage runtime", () => {
  it("constructs purpose-separated encrypted stores and scavenges stale plaintext export spools", async () => {
    const root = await mkdtemp(join(tmpdir(), "retention-storage-runtime-"));
    cleanup.push(root);
    const spool = join(root, "protected-spool");
    await mkdir(spool, { mode: 0o700 });
    const orphan = join(spool, "nutrition-account-export-crashed");
    const authenticatedOrphan = join(spool, "nutrition-artifact-read-crashed");
    const recent = join(spool, "nutrition-artifact-read-still-active");
    await Promise.all([
      mkdir(orphan, { mode: 0o700 }),
      mkdir(authenticatedOrphan, { mode: 0o700 }),
      mkdir(recent, { mode: 0o700 }),
    ]);
    const old = new Date(Date.now() - 2 * 60_000);
    await Promise.all([utimes(orphan, old, old), utimes(authenticatedOrphan, old, old)]);
    const runtime = await createRetentionStorageRuntime(
      parseWorkerConfig({
        ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "ledger-v1",
        ERASURE_REPLAY_LEDGER_DIRECTORY: join(root, "ledger"),
        ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
          "ledger-v1": Buffer.alloc(32, 2).toString("base64"),
        }),
        ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
        ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
          "locator-v1": Buffer.alloc(32, 3).toString("base64"),
        }),
        EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
        EXPORT_ARTIFACT_DIRECTORY: join(root, "exports"),
        EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
          "export-v1": Buffer.alloc(32, 1).toString("base64"),
        }),
        RETENTION_EXPORT_SPOOL_DIR: spool,
        RETENTION_EXPORT_SPOOL_MAX_AGE_MS: "60000",
        RETENTION_FEATURES_ENABLED: "true",
      }),
    );
    expect(runtime.exportArtifactStore).toBeDefined();
    expect(runtime.erasureLedger).toBeDefined();
    expect(await readdir(spool)).toEqual(["nutrition-artifact-read-still-active"]);
  });
});
