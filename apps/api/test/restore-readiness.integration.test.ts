import { randomBytes } from "node:crypto";

import {
  completeDatabaseRestoreReplayAttestation,
  createDatabase,
  runMigrations,
} from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";

import { createApiSearchRuntime } from "../src/search-runtime.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_RETENTION_RESTORE_INTEGRATION === "1" && databaseUrl;

describe.skipIf(!enabled)("API restored-database readiness", () => {
  it("stays unready until the offline replay attests this database and epoch", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `api_restore_ready_${randomBytes(6).toString("hex")}`;
    await bootstrap.schema.createSchema(schemaName).execute();
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const migrationDatabase = createDatabase({
      connectionString: scopedUrl.toString(),
      maxConnections: 1,
    });
    const restoreEpoch = `api-restore-integration-${randomBytes(32).toString("base64url")}`;
    let runtime: Awaited<ReturnType<typeof createApiSearchRuntime>> | undefined;
    try {
      await runMigrations(migrationDatabase);
      runtime = await createApiSearchRuntime(
        { DATABASE_URL: scopedUrl.toString(), NODE_ENV: "test" },
        {
          cursorSecret: "restore-readiness-test-cursor-secret-over-thirty-two-bytes",
          databaseRestoreEpoch: restoreEpoch,
          databaseUrl: scopedUrl.toString(),
          meiliUrl: "http://127.0.0.1:7700",
          requireDatabaseRestoreAttestation: true,
          retention: null,
          searchDatabaseMaxConcurrency: 1,
          searchDatabaseMaxQueue: 0,
          searchRequestTimeoutMs: 100,
        },
      );

      await expect(runtime.readinessCheck()).rejects.toThrow("restore replay attestation");
      await completeDatabaseRestoreReplayAttestation(migrationDatabase, {
        completedAt: "2026-08-16T12:05:00.000Z",
        reconciliationDigest: "a".repeat(64),
        replayedSubjectCount: 0,
        restoreEpoch,
      });
      await expect(runtime.readinessCheck()).resolves.toBe(true);
    } finally {
      await runtime?.close();
      await migrationDatabase.destroy();
      await bootstrap.schema.dropSchema(schemaName).cascade().execute();
      await bootstrap.destroy();
    }
  });
});
