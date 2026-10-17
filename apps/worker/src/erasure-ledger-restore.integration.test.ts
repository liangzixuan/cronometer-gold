import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  parseErasureLedgerLocatorKeyRing,
  S3ArtifactStoreVersionConflictError,
  S3RawArtifactStore,
} from "@nutrition-tracker/artifact-store";
import {
  assertDatabaseReady,
  getDayNote,
  putDayNote,
  reconcileErasedAccountRows,
  runMigrations,
} from "@nutrition-tracker/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { withRestoreIntegrationDatabase } from "../test/restore-integration-database.js";
import { runDatabaseReadinessProbeFromEnvironment } from "./database-readiness-probe.js";
import { replayAndAttestErasureLedgerRestore } from "./erasure-ledger-restore.js";
import { assertWorkerDatabaseReady } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_RETENTION_RESTORE_INTEGRATION === "1" && databaseUrl;

describe.skipIf(!enabled)("live MinIO to restored PostgreSQL erasure replay", () => {
  it("authenticates the sole ledger version, erases the restored subject, and reconciles before readiness", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await withRestoreIntegrationDatabase(
      databaseUrl,
      async ({ database, databaseUrl: scopedUrl, identity }) => {
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
            DATABASE_URL: scopedUrl,
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
        await database
          .insertInto("user_profile")
          .values({
            user_id: subjectUserId,
            time_zone: "America/Chicago",
          })
          .execute();
        const restoredNote = await putDayNote(database, {
          userId: subjectUserId,
          localDate: "2026-08-16",
          expectedRevision: "0",
          expectedProfileTimeZone: "America/Chicago",
          clientOperationId: randomUUID(),
          requestDigest: "a".repeat(64),
          note: "Restored private day context",
        });
        await putDayNote(database, {
          userId: subjectUserId,
          localDate: "2026-08-16",
          expectedRevision: "1",
          expectedProfileTimeZone: "America/Chicago",
          clientOperationId: randomUUID(),
          requestDigest: "b".repeat(64),
          note: null,
        });
        expect(
          await getDayNote(database, { userId: subjectUserId, localDate: "2026-08-16" }),
        ).toMatchObject({ id: restoredNote.data.note.id, revision: "2", note: null });
        expect(
          await database
            .selectFrom("diary_day_note_revision")
            .select("id")
            .where("user_id", "=", subjectUserId)
            .execute(),
        ).toHaveLength(2);
        expect(
          await database
            .selectFrom("diary_day_note_operation")
            .select("client_operation_id")
            .where("user_id", "=", subjectUserId)
            .execute(),
        ).toHaveLength(2);
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
          attestation: {
            ...identity,
            completedAt: "2026-08-16T12:05:00.000Z",
            reconciliationDigest: result.reconciliationDigest,
            replayedSubjectCount: "1",
            restoreEpochHash: createHash("sha256").update(restoreEpoch).digest("hex"),
          },
          reconciled: true,
          reconciliationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          replayedTombstones: 1,
          scannedSubjects: 1,
        });
        const persisted = await sql<{
          database_name: string;
          database_oid: string;
          completed_at: Date;
          reconciliation_digest: string;
          replayed_subject_count: string;
          restore_epoch_hash: string;
        }>`select database_name, database_oid, completed_at, reconciliation_digest,
        replayed_subject_count, restore_epoch_hash from public.database_restore_attestation
        where singleton = true`.execute(database);
        expect(persisted.rows).toEqual([
          {
            database_name: identity.databaseName,
            database_oid: identity.databaseOid,
            completed_at: new Date(result.attestation.completedAt),
            reconciliation_digest: result.attestation.reconciliationDigest,
            replayed_subject_count: result.attestation.replayedSubjectCount,
            restore_epoch_hash: result.attestation.restoreEpochHash,
          },
        ]);
        expect(await reconcileErasedAccountRows(database, { userId: subjectUserId })).toMatchObject(
          {
            reconciled: true,
          },
        );
        expect(
          await database
            .selectFrom("app_user")
            .select("id")
            .where("id", "=", subjectUserId)
            .execute(),
        ).toEqual([]);
        for (const table of [
          "diary_day_note",
          "diary_day_note_revision",
          "diary_day_note_operation",
        ] as const) {
          expect(
            await database
              .selectFrom(table)
              .select("user_id")
              .where("user_id", "=", subjectUserId)
              .execute(),
          ).toEqual([]);
        }
        await expect(
          assertWorkerDatabaseReady(database, {
            DATABASE_RESTORE_EPOCH: restoreEpoch,
            NODE_ENV: "production",
          }),
        ).resolves.toBeUndefined();
        await expect(
          runDatabaseReadinessProbeFromEnvironment({
            DATABASE_RESTORE_EPOCH: restoreEpoch,
            DATABASE_URL: scopedUrl,
            NODE_ENV: "test",
          }),
        ).resolves.toBeUndefined();
      },
    );
  });

  it("does not attest readiness when singleton ledger evidence changes before its exact read", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    await withRestoreIntegrationDatabase(databaseUrl, async ({ database }) => {
      const restoreEpoch = `restore-conflict-${randomBytes(32).toString("base64url")}`;
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
    });
  });
});
