import { randomBytes, randomUUID } from "node:crypto";

import {
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  parseErasureLedgerLocatorKeyRing,
  S3ArtifactStoreVersionConflictError,
  S3RawArtifactStore,
} from "@nutrition-tracker/artifact-store";
import {
  assertDatabaseReady,
  createDatabase,
  reconcileErasedAccountRows,
  runMigrations,
} from "@nutrition-tracker/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { runDatabaseReadinessProbeFromEnvironment } from "./database-readiness-probe.js";
import { replayAndAttestErasureLedgerRestore } from "./erasure-ledger-restore.js";
import { assertWorkerDatabaseReady } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_RETENTION_RESTORE_INTEGRATION === "1" && databaseUrl;

describe.skipIf(!enabled)("live MinIO to restored PostgreSQL erasure replay", () => {
  it("authenticates the sole ledger version, erases the restored subject, and reconciles before readiness", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `restore_replay_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    try {
      await runMigrations(database);
      const restoreEpoch = `restore-integration-${randomBytes(32).toString("base64url")}`;
      await expect(
        assertDatabaseReady(database, {
          requireRestoreAttestation: true,
          restoreEpoch,
        }),
      ).rejects.toThrow("restore replay attestation");
      await expect(
        assertWorkerDatabaseReady(database, {
          DATABASE_RESTORE_EPOCH: restoreEpoch,
          NODE_ENV: "production",
        }),
      ).rejects.toThrow("restore replay attestation");
      await expect(
        runDatabaseReadinessProbeFromEnvironment({
          DATABASE_RESTORE_EPOCH: restoreEpoch,
          DATABASE_URL: scopedUrl.toString(),
          NODE_ENV: "test",
        }),
      ).rejects.toThrow("restore replay attestation");
      const subjectUserId = randomUUID();
      await database
        .insertInto("app_user")
        .values({
          auth_subject: `restored-subject:${subjectUserId}`,
          email: `restored-${subjectUserId}@example.invalid`,
          id: subjectUserId,
        })
        .execute();
      const bucket = process.env.ERASURE_REPLAY_LEDGER_BUCKET ?? "nutrition-erasure-ledger";
      const endpoint = process.env.ERASURE_REPLAY_LEDGER_ENDPOINT ?? "http://127.0.0.1:9000";
      const region = process.env.ERASURE_REPLAY_LEDGER_REGION ?? "us-east-1";
      const writerRaw = new S3RawArtifactStore({
        accessKeyId:
          process.env.ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID ?? "nutrition_erasure_writer",
        bucket,
        endpoint,
        region,
        secretAccessKey:
          process.env.ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY ??
          "nutrition_erasure_writer_local_only",
      });
      const restoreRaw = new S3RawArtifactStore({
        accessKeyId:
          process.env.ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID ?? "nutrition_erasure_restore",
        bucket,
        endpoint,
        readVersionPolicy: "require_singleton",
        region,
        secretAccessKey:
          process.env.ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY ??
          "nutrition_erasure_restore_local_only",
      });
      const keyRing = {
        currentKeyId: "restore-integration-ledger-v1",
        keys: new Map([["restore-integration-ledger-v1", Buffer.alloc(32, 31)]]),
        purpose: "erasure_replay_ledger",
      } as const;
      const locatorKeyRing = parseErasureLedgerLocatorKeyRing({
        currentKeyId: "restore-integration-locator-v1",
        serializedKeys: JSON.stringify({
          "restore-integration-locator-v1": Buffer.alloc(32, 30).toString("base64"),
        }),
      });
      const writer = new EncryptedErasureReplayLedger({
        artifactStore: new EncryptedArtifactStore({ keyRing, rawStore: writerRaw }),
        locatorKeyRing,
      });
      const restore = new EncryptedErasureReplayLedger({
        artifactStore: new EncryptedArtifactStore({ keyRing, rawStore: restoreRaw }),
        locatorKeyRing,
      });
      await writer.append({
        jobId: randomUUID(),
        recordedAt: "2026-08-16T12:00:00.000Z",
        restoreLocator: writer.locatorForSubject(subjectUserId),
        subjectUserId,
      });
      const result = await replayAndAttestErasureLedgerRestore({
        clock: () => new Date("2026-08-16T12:05:00.000Z"),
        database,
        ledger: restore,
        maximumConcurrency: 2,
        restoreEpoch,
      });
      expect(result).toEqual({
        reconciled: true,
        reconciliationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        replayedTombstones: 1,
        scannedSubjects: 1,
      });
      expect(await reconcileErasedAccountRows(database, { userId: subjectUserId })).toMatchObject({
        reconciled: true,
      });
      expect(
        await database
          .selectFrom("app_user")
          .select("id")
          .where("id", "=", subjectUserId)
          .execute(),
      ).toEqual([]);
      await expect(
        assertWorkerDatabaseReady(database, {
          DATABASE_RESTORE_EPOCH: restoreEpoch,
          NODE_ENV: "production",
        }),
      ).resolves.toBeUndefined();
      await expect(
        runDatabaseReadinessProbeFromEnvironment({
          DATABASE_RESTORE_EPOCH: restoreEpoch,
          DATABASE_URL: scopedUrl.toString(),
          NODE_ENV: "test",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });

  it("does not attest readiness when singleton ledger evidence changes before its exact read", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `restore_replay_conflict_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const restoreEpoch = `restore-conflict-${randomBytes(32).toString("base64url")}`;
    try {
      await runMigrations(database);
      const subjectUserId = randomUUID();
      await database
        .insertInto("app_user")
        .values({
          auth_subject: `restored-conflict:${subjectUserId}`,
          email: `restored-conflict-${subjectUserId}@example.invalid`,
          id: subjectUserId,
        })
        .execute();
      await expect(
        replayAndAttestErasureLedgerRestore({
          database,
          ledger: {
            replaySubject: async () => {
              throw new S3ArtifactStoreVersionConflictError();
            },
          },
          maximumConcurrency: 1,
          restoreEpoch,
        }),
      ).rejects.toBeInstanceOf(S3ArtifactStoreVersionConflictError);
      await expect(
        assertDatabaseReady(database, { requireRestoreAttestation: true, restoreEpoch }),
      ).rejects.toThrow("restore replay attestation");
    } finally {
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  });
});
