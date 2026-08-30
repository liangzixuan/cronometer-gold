import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rm, statfs } from "node:fs/promises";

import {
  ArtifactReadBulkhead,
  type EncryptedArtifactMetadata,
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  parseErasureLedgerLocatorKeyRing,
  S3RawArtifactStore,
} from "@nutrition-tracker/artifact-store";
import {
  type AccountErasureMutationResponse,
  type AccountErasureResponse,
  type AccountExportResponse,
  canonicalJson,
} from "@nutrition-tracker/contracts";
import {
  createDatabase,
  getPrivacyExportJob,
  reconcileErasedAccountRows,
  runMigrations,
} from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";
import { createRetentionWorkerRepository } from "../../worker/src/retention-database-repository.js";
import {
  type RetentionWorkerEvent,
  runRetentionWorkerPoll,
} from "../../worker/src/retention-worker.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SecureAuthService } from "../src/modules/auth/auth-service.js";
import { DatabaseAuthRepository, DatabaseGoalService } from "../src/persistence-services.js";
import { DatabaseRetentionService } from "../src/retention-persistence-service.js";

const enabled = process.env.RUN_RETENTION_WORKER_INTEGRATION === "1";
const WORKSPACE_BYTES = 100 * 1_024 * 1_024;
const TMPFS_MAGIC = 0x0102_1994;

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function localDatabaseUrl(
  value: string,
  target: {
    readonly database: string;
    readonly password: string;
    readonly port: string;
    readonly user: string;
  },
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Retention integration PostgreSQL must use the local Compose target");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== target.port ||
    url.username !== target.user ||
    url.password !== target.password ||
    url.pathname !== `/${target.database}` ||
    url.search ||
    url.hash
  ) {
    throw new Error("Retention integration PostgreSQL must use the local Compose target");
  }
  return value;
}

function localS3Endpoint(value: string, field: string, port: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must use the local Compose MinIO target`);
  }
  const expected = `http://127.0.0.1:${port}`;
  if (
    value !== expected ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(`${field} must use the local Compose MinIO target`);
  }
  return value;
}

function exactValue(value: string, expected: string, field: string): string {
  if (value !== expected) throw new Error(`${field} does not match the local fixture`);
  return value;
}

function exactPort(value: string, field: string): string {
  const parsed = exactNumber(value, field);
  if (parsed > 65_535 || String(parsed) !== value) throw new Error(`${field} is not exact`);
  return value;
}

function exactNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${field} is not exact`);
  return parsed;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function attemptCleanup(
  cleanupErrors: Error[],
  label: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (cause) {
    cleanupErrors.push(new Error(`Retention integration cleanup failed: ${label}`, { cause }));
  }
}

describe.skipIf(!enabled)("live retention API, worker, PostgreSQL, and MinIO boundary", () => {
  it("exports reconciled artifacts and completes capability-only account erasure", {
    timeout: 120_000,
  }, async () => {
    const postgresTarget = {
      database: required(process.env.POSTGRES_DB, "POSTGRES_DB"),
      password: required(process.env.POSTGRES_PASSWORD, "POSTGRES_PASSWORD"),
      port: exactPort(required(process.env.POSTGRES_PORT, "POSTGRES_PORT"), "POSTGRES_PORT"),
      user: required(process.env.POSTGRES_USER, "POSTGRES_USER"),
    };
    const minioPort = exactPort(
      required(process.env.MINIO_API_PORT, "MINIO_API_PORT"),
      "MINIO_API_PORT",
    );
    const databaseUrl = localDatabaseUrl(
      required(
        process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL,
        "DATABASE_URL or TEST_DATABASE_URL",
      ),
      postgresTarget,
    );
    const exportEndpoint = localS3Endpoint(
      required(process.env.EXPORT_ARTIFACT_ENDPOINT, "EXPORT_ARTIFACT_ENDPOINT"),
      "EXPORT_ARTIFACT_ENDPOINT",
      minioPort,
    );
    const ledgerEndpoint = localS3Endpoint(
      required(process.env.ERASURE_REPLAY_LEDGER_ENDPOINT, "ERASURE_REPLAY_LEDGER_ENDPOINT"),
      "ERASURE_REPLAY_LEDGER_ENDPOINT",
      minioPort,
    );
    const exportRegion = exactValue(
      required(process.env.EXPORT_ARTIFACT_REGION, "EXPORT_ARTIFACT_REGION"),
      "us-east-1",
      "EXPORT_ARTIFACT_REGION",
    );
    const exportBucket = exactValue(
      required(process.env.EXPORT_ARTIFACT_BUCKET, "EXPORT_ARTIFACT_BUCKET"),
      "nutrition-private-exports",
      "EXPORT_ARTIFACT_BUCKET",
    );
    const ledgerRegion = exactValue(
      required(process.env.ERASURE_REPLAY_LEDGER_REGION, "ERASURE_REPLAY_LEDGER_REGION"),
      "us-east-1",
      "ERASURE_REPLAY_LEDGER_REGION",
    );
    const ledgerBucket = exactValue(
      required(process.env.ERASURE_REPLAY_LEDGER_BUCKET, "ERASURE_REPLAY_LEDGER_BUCKET"),
      "nutrition-erasure-ledger",
      "ERASURE_REPLAY_LEDGER_BUCKET",
    );
    const exportWriteAccessKeyId = required(
      process.env.EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID,
      "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
    );
    const exportWriteSecretAccessKey = required(
      process.env.EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY,
      "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
    );
    const exportReadAccessKeyId = required(
      process.env.EXPORT_ARTIFACT_READ_ACCESS_KEY_ID,
      "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
    );
    const exportReadSecretAccessKey = required(
      process.env.EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY,
      "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
    );
    const ledgerWriteAccessKeyId = required(
      process.env.ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID,
      "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
    );
    const ledgerWriteSecretAccessKey = required(
      process.env.ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY,
      "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
    );
    const ledgerRestoreAccessKeyId = required(
      process.env.ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID,
      "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
    );
    const ledgerRestoreSecretAccessKey = required(
      process.env.ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY,
      "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    );
    const credentialIds = [
      exportWriteAccessKeyId,
      exportReadAccessKeyId,
      ledgerWriteAccessKeyId,
      ledgerRestoreAccessKeyId,
    ];
    const credentialSecrets = [
      exportWriteSecretAccessKey,
      exportReadSecretAccessKey,
      ledgerWriteSecretAccessKey,
      ledgerRestoreSecretAccessKey,
    ];
    if (new Set(credentialIds).size !== credentialIds.length) {
      throw new Error("Retention integration access-key IDs must remain split");
    }
    if (new Set(credentialSecrets).size !== credentialSecrets.length) {
      throw new Error("Retention integration secret keys must remain split");
    }

    const schemaName = `retention_e2e_${randomBytes(6).toString("hex")}`;
    const trackedExportObjects = new Set<string>();
    let spoolDirectoryHandle: string | undefined;
    let bootstrapHandle: ReturnType<typeof createDatabase> | undefined;
    let databaseHandle: ReturnType<typeof createDatabase> | undefined;
    let exportWriterRawHandle: S3RawArtifactStore | undefined;
    let appHandle: ReturnType<typeof buildApp> | undefined;
    let retentionTablesReady = false;
    let operationFailed = false;
    let operationError: unknown;

    try {
      expect((await statfs("/dev/shm")).type).toBe(TMPFS_MAGIC);
      const spoolDirectory = await mkdtemp("/dev/shm/nutrition-retention-integration-");
      spoolDirectoryHandle = spoolDirectory;
      await chmod(spoolDirectory, 0o700);
      const spool = await lstat(spoolDirectory);
      expect(spool.isDirectory()).toBe(true);
      expect(spool.isSymbolicLink()).toBe(false);
      expect(spool.mode & 0o777).toBe(0o700);

      const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
      bootstrapHandle = bootstrap;
      await bootstrap.schema.createSchema(schemaName).execute();
      const scopedUrl = new URL(databaseUrl);
      scopedUrl.searchParams.set(
        "options",
        `-csearch_path=${schemaName},public -cstatement_timeout=15000`,
      );
      const database = createDatabase({
        connectionString: scopedUrl.toString(),
        maxConnections: 12,
      });
      databaseHandle = database;
      const exportWriterRaw = new S3RawArtifactStore({
        accessKeyId: exportWriteAccessKeyId,
        bucket: exportBucket,
        deleteVersionPolicy: "suspended_null",
        endpoint: exportEndpoint,
        region: exportRegion,
        requestTimeoutMs: 5_000,
        secretAccessKey: exportWriteSecretAccessKey,
      });
      exportWriterRawHandle = exportWriterRaw;
      const exportReaderRaw = new S3RawArtifactStore({
        accessKeyId: exportReadAccessKeyId,
        bucket: exportBucket,
        endpoint: exportEndpoint,
        region: exportRegion,
        requestTimeoutMs: 5_000,
        secretAccessKey: exportReadSecretAccessKey,
      });
      const ledgerWriterRaw = new S3RawArtifactStore({
        accessKeyId: ledgerWriteAccessKeyId,
        bucket: ledgerBucket,
        endpoint: ledgerEndpoint,
        region: ledgerRegion,
        requestTimeoutMs: 5_000,
        secretAccessKey: ledgerWriteSecretAccessKey,
      });
      const ledgerRestoreRaw = new S3RawArtifactStore({
        accessKeyId: ledgerRestoreAccessKeyId,
        bucket: ledgerBucket,
        endpoint: ledgerEndpoint,
        readVersionPolicy: "require_singleton",
        region: ledgerRegion,
        requestTimeoutMs: 5_000,
        secretAccessKey: ledgerRestoreSecretAccessKey,
      });
      const exportKeyRing = {
        currentKeyId: "retention-integration-export-v1",
        keys: new Map([["retention-integration-export-v1", Buffer.alloc(32, 41)]]),
        purpose: "export",
      } as const;
      const ledgerKeyRing = {
        currentKeyId: "retention-integration-ledger-v1",
        keys: new Map([["retention-integration-ledger-v1", Buffer.alloc(32, 42)]]),
        purpose: "erasure_replay_ledger",
      } as const;
      const locatorKeyRing = parseErasureLedgerLocatorKeyRing({
        currentKeyId: "retention-integration-locator-v1",
        serializedKeys: JSON.stringify({
          "retention-integration-locator-v1": Buffer.alloc(32, 43).toString("base64"),
        }),
      });
      const exportWriter = new EncryptedArtifactStore({
        keyRing: exportKeyRing,
        maxPlaintextBytes: WORKSPACE_BYTES,
        rawStore: exportWriterRaw,
        temporaryDirectory: spoolDirectory,
      });
      const exportReader = new EncryptedArtifactStore({
        keyRing: exportKeyRing,
        maxPlaintextBytes: WORKSPACE_BYTES,
        rawStore: exportReaderRaw,
        temporaryDirectory: spoolDirectory,
      });
      let clock = new Date(Date.now() + 60_000);
      const ledgerWriter = new EncryptedErasureReplayLedger({
        artifactStore: new EncryptedArtifactStore({
          keyRing: ledgerKeyRing,
          maxPlaintextBytes: 16_384,
          rawStore: ledgerWriterRaw,
          temporaryDirectory: spoolDirectory,
        }),
        clock: () => clock,
        locatorKeyRing,
      });
      const ledgerRestore = new EncryptedErasureReplayLedger({
        artifactStore: new EncryptedArtifactStore({
          keyRing: ledgerKeyRing,
          maxPlaintextBytes: 16_384,
          rawStore: ledgerRestoreRaw,
          temporaryDirectory: spoolDirectory,
        }),
        clock: () => clock,
        locatorKeyRing,
      });
      const authService = new SecureAuthService({
        clock: () => clock,
        repository: new DatabaseAuthRepository(database),
      });
      const retentionService = new DatabaseRetentionService({
        artifacts: {
          bulkhead: new ArtifactReadBulkhead({
            clock: () => clock.getTime(),
            maximumArtifactBytes: WORKSPACE_BYTES,
            maximumBytesPerOwnerPerWindow: 2 * WORKSPACE_BYTES,
            maximumConcurrentReads: 2,
            maximumOpensPerOwnerPerWindow: 3,
            maximumReservedPlaintextBytes: 2 * WORKSPACE_BYTES,
            rateWindowMs: 60_000,
          }),
          store: exportReader,
        },
        clock: () => clock,
        database,
        deviceChallengeHmacKey: Buffer.alloc(32, 44),
        erasureLedgerLocatorKeyRing: locatorKeyRing,
        erasureStatusCapabilityHmacKey: Buffer.alloc(32, 45),
      });
      const app = buildApp({
        authService,
        config: loadConfig({ LOG_LEVEL: "silent", NODE_ENV: "test" }),
        goalService: new DatabaseGoalService(database),
        logger: false,
        retentionClock: () => clock,
        retentionService,
      });
      appHandle = app;
      const events: RetentionWorkerEvent[] = [];
      const workerOptions = {
        clock: () => clock,
        erasureLedger: ledgerWriter,
        exportArtifactStore: exportWriter,
        exportTtlMs: 7 * 86_400_000,
        onEvent: (event: RetentionWorkerEvent) => events.push(event),
        repository: createRetentionWorkerRepository(database),
        spoolMaximumBytes: WORKSPACE_BYTES,
        temporaryDirectory: spoolDirectory,
        uploadLeaseMs: 30_000,
        workerId: "retention-worker-integration",
        workLeaseHeartbeatMs: 1_000,
      } as const;

      await runMigrations(database);
      retentionTablesReady = true;
      const password = "correct horse battery staple";
      const email = `retention-e2e-${randomUUID()}@example.invalid`;
      const registration = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: { displayName: "Retention E2E", email, password, timeZone: "America/Chicago" },
      });
      expect(registration.statusCode).toBe(201);
      const registered = registration.json<{
        data: { accessToken: string; user: { id: string } };
      }>();
      const userId = registered.data.user.id;
      const authorization = `Bearer ${registered.data.accessToken}`;

      const biometricDefinitionResponse = await app.inject({
        method: "POST",
        url: "/v1/biometrics/definitions",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          canonicalUnit: "kg",
          dimension: "mass",
          name: "Body weight",
          notes: null,
        },
      });
      expect(biometricDefinitionResponse.statusCode).toBe(201);
      const biometricDefinitionId = biometricDefinitionResponse.json<{
        data: { definition: { id: string } };
      }>().data.definition.id;
      const biometricEventResponse = await app.inject({
        method: "POST",
        url: "/v1/biometrics/events",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          definitionId: biometricDefinitionId,
          measuredAt: new Date(clock.getTime() - 1_000).toISOString(),
          value: "72.125",
        },
      });
      expect(biometricEventResponse.statusCode).toBe(201);

      const exportProof = await app.inject({
        method: "POST",
        url: "/v1/auth/reauthenticate",
        headers: { authorization },
        payload: { password, purpose: "account_export" },
      });
      expect(exportProof.statusCode).toBe(200);
      expect(exportProof.headers["cache-control"]).toBe("no-store");
      const exportProofToken = exportProof.json<{
        data: { reauthenticationToken: string };
      }>().data.reauthenticationToken;

      const exportRequest = await app.inject({
        method: "POST",
        url: "/v1/exports",
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "x-reauthentication-token": exportProofToken,
        },
        payload: { formats: ["json", "csv"] },
      });
      expect(exportRequest.statusCode).toBe(202);
      expect(exportRequest.headers["cache-control"]).toBe("no-store");
      const requestedExport = exportRequest.json<AccountExportResponse>().data.export;
      expect(requestedExport.status).toBe("queued");

      clock = new Date(Date.now() + 120_000);
      await runRetentionWorkerPoll(workerOptions);
      expect(events).toContainEqual({
        event: "retention.export.completed",
        jobId: requestedExport.id,
        level: "info",
      });

      const statusResponse = await app.inject({
        method: "GET",
        url: `/v1/exports/${requestedExport.id}`,
        headers: { authorization },
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.headers["cache-control"]).toBe("no-store");
      const completedExport = statusResponse.json<AccountExportResponse>().data.export;
      expect(completedExport).toMatchObject({
        status: "completed",
        reconciliation: { reconciled: true },
      });
      expect(completedExport.artifacts.map((artifact) => artifact.format).sort()).toEqual([
        "csv",
        "json",
      ]);
      expect(
        completedExport.reconciliation?.entities.every(
          (entity) => entity.sourceCount === entity.exportedCount,
        ),
      ).toBe(true);

      const persistedExport = await getPrivacyExportJob(database, {
        jobId: requestedExport.id,
        userId,
      });
      const persistedMetadata: EncryptedArtifactMetadata[] = persistedExport.artifacts.map(
        (artifact) => {
          trackedExportObjects.add(artifact.objectKey);
          return {
            ciphertextBytes: exactNumber(artifact.ciphertextBytes, "ciphertextBytes"),
            encryptionKeyId: artifact.encryptionKeyId,
            envelopeVersion: 1,
            mediaType: artifact.mediaType,
            objectKey: artifact.objectKey,
            plaintextBytes: exactNumber(artifact.plaintextBytes, "plaintextBytes"),
            plaintextSha256: artifact.plaintextSha256,
          };
        },
      );

      for (const artifact of completedExport.artifacts) {
        const download = await app.inject({
          method: "GET",
          url: artifact.downloadPath,
          headers: { authorization },
        });
        expect(download.statusCode).toBe(200);
        expect(download.headers["cache-control"]).toBe("no-store");
        expect(download.headers["content-length"]).toBe(String(artifact.byteLength));
        expect(download.rawPayload.byteLength).toBe(
          exactNumber(artifact.byteLength, "download byteLength"),
        );
        expect(sha256(download.rawPayload)).toBe(artifact.sha256);
        if (artifact.format === "json") {
          const parsed = JSON.parse(download.rawPayload.toString("utf8")) as {
            entities: {
              account: unknown[];
              biometric_definition: unknown[];
              biometric_definition_version: unknown[];
              biometric_event: unknown[];
              biometric_event_revision: unknown[];
              profile: unknown[];
            };
            manifest: Parameters<typeof canonicalJson>[0];
          };
          expect(parsed.entities.account).toHaveLength(1);
          expect(parsed.entities.biometric_definition).toHaveLength(1);
          expect(parsed.entities.biometric_definition_version).toHaveLength(1);
          expect(parsed.entities.biometric_event).toHaveLength(1);
          expect(parsed.entities.biometric_event_revision).toHaveLength(1);
          expect(parsed.entities.profile).toHaveLength(1);
          expect(parsed.manifest).toMatchObject({
            formatVersion: "nutrition-account-export-v1",
            reconciled: true,
          });
          expect(sha256(canonicalJson(parsed.manifest))).toBe(completedExport.manifestSha256);
        } else {
          expect(download.rawPayload.readUInt32LE(0)).toBe(0x0403_4b50);
        }
      }
      expect(
        await database
          .selectFrom("privacy_export_download_audit")
          .select(["format", "outcome"])
          .where("user_id", "=", userId)
          .orderBy("format")
          .execute(),
      ).toEqual([
        { format: "csv_zip", outcome: "opened" },
        { format: "json", outcome: "opened" },
      ]);

      const erasureProof = await app.inject({
        method: "POST",
        url: "/v1/auth/reauthenticate",
        headers: { authorization },
        payload: { password, purpose: "account_erasure" },
      });
      expect(erasureProof.statusCode).toBe(200);
      const erasureProofToken = erasureProof.json<{
        data: { reauthenticationToken: string };
      }>().data.reauthenticationToken;
      const erasureRequest = await app.inject({
        method: "POST",
        url: "/v1/account/erasure",
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "x-reauthentication-token": erasureProofToken,
        },
        payload: { confirmation: "DELETE_MY_ACCOUNT" },
      });
      expect(erasureRequest.statusCode).toBe(202);
      const queuedErasure = erasureRequest.json<AccountErasureMutationResponse>().data;
      expect(queuedErasure.erasure.status).toBe("queued");
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/auth/me",
            headers: { authorization },
          })
        ).statusCode,
      ).toBe(401);

      clock = new Date(Date.parse(queuedErasure.erasure.executeAfter) + 60_000);
      await runRetentionWorkerPoll(workerOptions);
      expect(events).toContainEqual({
        event: "retention.erasure.completed",
        jobId: queuedErasure.erasure.id,
        level: "info",
      });
      expect(events.filter((event) => event.level === "warn")).toEqual([]);

      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/account/erasure/${queuedErasure.erasure.id}`,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/account/erasure/${queuedErasure.erasure.id}`,
            headers: { "x-erasure-status-token": "z".repeat(43) },
          })
        ).statusCode,
      ).toBe(404);
      const capabilityStatus = await app.inject({
        method: "GET",
        url: `/v1/account/erasure/${queuedErasure.erasure.id}`,
        headers: { "x-erasure-status-token": queuedErasure.statusCapability.token },
      });
      expect(capabilityStatus.statusCode).toBe(200);
      expect(capabilityStatus.headers["cache-control"]).toBe("no-store");
      expect(capabilityStatus.json<AccountErasureResponse>().data.erasure).toMatchObject({
        id: queuedErasure.erasure.id,
        status: "completed",
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/exports/${requestedExport.id}`,
            headers: { authorization },
          })
        ).statusCode,
      ).toBe(401);

      for (const metadata of persistedMetadata) {
        const opened = await exportReader.openAuthenticated(metadata);
        await opened?.dispose();
        expect(opened).toBeNull();
      }
      expect(await ledgerRestore.findForSubject({ subjectUserId: userId })).toMatchObject({
        jobId: queuedErasure.erasure.id,
        restoreLocator: ledgerWriter.locatorForSubject(userId),
        subjectUserId: userId,
      });
      const reconciliation = await reconcileErasedAccountRows(database, { userId });
      expect(reconciliation.reconciled).toBe(true);
      expect(reconciliation.remainingRows).toMatchObject({
        biometric_definition: "0",
        biometric_definition_version: "0",
        biometric_event: "0",
        biometric_event_revision: "0",
      });
      expect(Object.values(reconciliation.remainingRows).every((count) => count === "0")).toBe(
        true,
      );
      expect(
        await database.selectFrom("app_user").select("id").where("id", "=", userId).execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom("account_erasure_job")
          .select([
            "client_operation_id",
            "object_deletion_evidence",
            "recovery_session_token_hash",
            "request_digest",
            "restore_ledger_digest",
            "restore_ledger_reference",
            "restore_locator",
            "status",
            "status_capability_hash",
            "user_id",
          ])
          .where("id", "=", queuedErasure.erasure.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        client_operation_id: null,
        object_deletion_evidence: null,
        recovery_session_token_hash: null,
        request_digest: null,
        restore_ledger_digest: null,
        restore_ledger_reference: null,
        restore_locator: null,
        status: "completed",
        status_capability_hash: sha256(queuedErasure.statusCapability.token),
        user_id: null,
      });
      expect(
        await database
          .selectFrom("account_erasure_receipt")
          .select(["job_id", "policy_version"])
          .where("job_id", "=", queuedErasure.erasure.id)
          .execute(),
      ).toEqual([
        {
          job_id: queuedErasure.erasure.id,
          policy_version: "complete-account-erasure-v1",
        },
      ]);
      expect(await readdir(spoolDirectory)).toEqual([]);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      const cleanupErrors: Error[] = [];
      const app = appHandle;
      if (app) {
        await attemptCleanup(cleanupErrors, "close Fastify app", () => app.close());
      }

      const database = databaseHandle;
      if (database && retentionTablesReady) {
        await attemptCleanup(cleanupErrors, "discover staged export objects", async () => {
          const staged = await database
            .selectFrom("privacy_export_upload_artifact")
            .select("object_key")
            .execute();
          for (const artifact of staged) trackedExportObjects.add(artifact.object_key);
        });
      }

      const exportWriterRaw = exportWriterRawHandle;
      if (exportWriterRaw) {
        for (const objectKey of trackedExportObjects) {
          await attemptCleanup(cleanupErrors, "delete tracked export object", () =>
            exportWriterRaw.delete({ objectKey }),
          );
        }
      }

      if (database) {
        await attemptCleanup(cleanupErrors, "destroy scoped database pool", () =>
          database.destroy(),
        );
      }

      const bootstrap = bootstrapHandle;
      if (bootstrap) {
        await attemptCleanup(cleanupErrors, "drop scratch PostgreSQL schema", () =>
          bootstrap.schema.dropSchema(schemaName).ifExists().cascade().execute(),
        );
        await attemptCleanup(cleanupErrors, "destroy bootstrap database pool", () =>
          bootstrap.destroy(),
        );
      }

      const spoolDirectory = spoolDirectoryHandle;
      if (spoolDirectory) {
        await attemptCleanup(cleanupErrors, "remove private spool", () =>
          rm(spoolDirectory, { force: true, recursive: true }),
        );
      }

      if (cleanupErrors.length > 0) {
        operationError = new AggregateError(
          operationFailed ? [operationError, ...cleanupErrors] : cleanupErrors,
          operationFailed
            ? "Retention integration failed and cleanup also failed"
            : "Retention integration cleanup failed",
        );
        operationFailed = true;
      }
    }

    if (operationFailed) throw operationError;
  });
});
