import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rm, statfs } from "node:fs/promises";

import {
  type EncryptedArtifactMetadata,
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  parseArtifactEncryptionKeyRing,
  parseErasureLedgerLocatorKeyRing,
  S3RawArtifactStore,
} from "@nutrition-tracker/artifact-store";
import {
  type AccountErasureMutationResponse,
  type AccountErasureResponse,
  type AccountExportResponse,
  type CustomFoodMutationResponse,
  canonicalJson,
  type DiaryDayResponse,
  type DiaryMutationResponse,
  type NutritionGoalMutationResponse,
  type NutritionGoalProgressResponse,
} from "@nutrition-tracker/contracts";
import {
  createDatabase,
  getDiaryDay,
  getPrivacyExportJob,
  MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES,
  reconcileErasedAccountRows,
  runMigrations,
} from "@nutrition-tracker/db";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkerPollRuntime,
  type WorkerOperationalEvent,
  type WorkerPollRuntime,
} from "../../worker/src/worker-runtime.js";
import { type ApiApplicationRuntime, createApiApplicationRuntime } from "../src/server.js";

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

function localMeiliEndpoint(value: string, port: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MEILI_URL must use the local Compose Meilisearch target");
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
    throw new Error("MEILI_URL must use the local Compose Meilisearch target");
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

function storedZipEntries(bytes: Buffer): ReadonlyMap<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && bytes.readUInt32LE(offset) === 0x0403_4b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    expect(bytes.readUInt16LE(offset + 10)).toBe(0);
    expect(bytes.readUInt16LE(offset + 12)).toBe(0x21);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(name, Buffer.from(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

function requiredZipEntry(entries: ReadonlyMap<string, Buffer>, path: string): Buffer {
  const entry = entries.get(path);
  if (!entry) throw new Error(`Missing ZIP entry: ${path}`);
  return entry;
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function csvEntityIds(bytes: Buffer): string[] {
  const lines = bytes.toString("utf8").split("\r\n");
  expect(lines.shift()).toBe(
    "ordinal,entity_id,revision,deleted,watermark,payload_sha256,payload_json",
  );
  expect(lines.pop()).toBe("");
  return lines.map((line) => {
    const ordinalBoundary = line.indexOf(",");
    const entityBoundary = line.indexOf(",", ordinalBoundary + 1);
    expect(ordinalBoundary).toBeGreaterThan(0);
    expect(entityBoundary).toBeGreaterThan(ordinalBoundary + 1);
    return line.slice(ordinalBoundary + 1, entityBoundary);
  });
}

function expectExactEntityIds(actual: readonly string[], expected: readonly string[]): void {
  expect(actual).toHaveLength(expected.length);
  expect(new Set(actual).size).toBe(actual.length);
  expect([...actual].sort()).toEqual([...expected].sort());
}

async function createPrivateTmpfsDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(`/dev/shm/${prefix}`);
  try {
    await chmod(directory, 0o700);
    const details = await lstat(directory);
    expect(details.isDirectory()).toBe(true);
    expect(details.isSymbolicLink()).toBe(false);
    expect(details.mode & 0o777).toBe(0o700);
    return directory;
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
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
    const meiliPort = exactPort(required(process.env.MEILI_PORT, "MEILI_PORT"), "MEILI_PORT");
    const meiliUrl = localMeiliEndpoint(required(process.env.MEILI_URL, "MEILI_URL"), meiliPort);
    const meiliAdminKey = required(process.env.MEILI_ADMIN_KEY, "MEILI_ADMIN_KEY");
    const meiliSearchKey = required(process.env.MEILI_SEARCH_KEY, "MEILI_SEARCH_KEY");
    const meiliTaskObserverKey = required(
      process.env.MEILI_TASK_OBSERVER_KEY,
      "MEILI_TASK_OBSERVER_KEY",
    );
    if (new Set([meiliAdminKey, meiliSearchKey, meiliTaskObserverKey]).size !== 3) {
      throw new Error("Retention integration Meilisearch roles must remain split");
    }
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
    const spoolDirectoryHandles = new Set<string>();
    let bootstrapHandle: ReturnType<typeof createDatabase> | undefined;
    let databaseHandle: ReturnType<typeof createDatabase> | undefined;
    let exportWriterRawHandle: S3RawArtifactStore | undefined;
    let apiRuntimeHandle: ApiApplicationRuntime | undefined;
    let workerRuntimeHandle: WorkerPollRuntime | undefined;
    let retentionTablesReady = false;
    let operationFailed = false;
    let operationError: unknown;

    try {
      expect((await statfs("/dev/shm")).type).toBe(TMPFS_MAGIC);
      const apiSpoolDirectory = await createPrivateTmpfsDirectory("nutrition-retention-api-");
      spoolDirectoryHandles.add(apiSpoolDirectory);
      const workerSpoolDirectory = await createPrivateTmpfsDirectory("nutrition-retention-worker-");
      spoolDirectoryHandles.add(workerSpoolDirectory);
      const restoreSpoolDirectory = await createPrivateTmpfsDirectory(
        "nutrition-retention-restore-",
      );
      spoolDirectoryHandles.add(restoreSpoolDirectory);

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
      await runMigrations(database);
      retentionTablesReady = true;

      const exportKeyId = "retention-integration-export-v1";
      const ledgerKeyId = "retention-integration-ledger-v1";
      const locatorKeyId = "retention-integration-locator-v1";
      const exportEncryptionKeys = JSON.stringify({
        [exportKeyId]: Buffer.alloc(32, 41).toString("base64"),
      });
      const ledgerEncryptionKeys = JSON.stringify({
        [ledgerKeyId]: Buffer.alloc(32, 42).toString("base64"),
      });
      const locatorHmacKeys = JSON.stringify({
        [locatorKeyId]: Buffer.alloc(32, 43).toString("base64"),
      });
      const exportKeyRing = parseArtifactEncryptionKeyRing({
        currentKeyId: exportKeyId,
        purpose: "export",
        serializedKeys: exportEncryptionKeys,
      });
      const ledgerKeyRing = parseArtifactEncryptionKeyRing({
        currentKeyId: ledgerKeyId,
        purpose: "erasure_replay_ledger",
        serializedKeys: ledgerEncryptionKeys,
      });
      const locatorKeyRing = parseErasureLedgerLocatorKeyRing({
        currentKeyId: locatorKeyId,
        serializedKeys: locatorHmacKeys,
      });

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
      const exportVerifier = new EncryptedArtifactStore({
        keyRing: exportKeyRing,
        maxPlaintextBytes: WORKSPACE_BYTES,
        rawStore: new S3RawArtifactStore({
          accessKeyId: exportReadAccessKeyId,
          bucket: exportBucket,
          endpoint: exportEndpoint,
          region: exportRegion,
          requestTimeoutMs: 5_000,
          secretAccessKey: exportReadSecretAccessKey,
        }),
        temporaryDirectory: apiSpoolDirectory,
      });
      let clock = new Date(Date.now() + 60_000);
      const ledgerRestore = new EncryptedErasureReplayLedger({
        artifactStore: new EncryptedArtifactStore({
          keyRing: ledgerKeyRing,
          maxPlaintextBytes: 16_384,
          rawStore: new S3RawArtifactStore({
            accessKeyId: ledgerRestoreAccessKeyId,
            bucket: ledgerBucket,
            endpoint: ledgerEndpoint,
            readVersionPolicy: "require_singleton",
            region: ledgerRegion,
            requestTimeoutMs: 5_000,
            secretAccessKey: ledgerRestoreSecretAccessKey,
          }),
          temporaryDirectory: restoreSpoolDirectory,
        }),
        clock: () => clock,
        locatorKeyRing,
      });

      const apiEnvironment: NodeJS.ProcessEnv = {
        API_HOST: "127.0.0.1",
        API_PORT: "3001",
        DATABASE_SSL_MODE: "disable",
        DATABASE_URL: scopedUrl.toString(),
        DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 44).toString("base64"),
        ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: locatorKeyId,
        ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: locatorHmacKeys,
        ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 45).toString("base64"),
        EXPORT_ARTIFACT_BUCKET: exportBucket,
        EXPORT_ARTIFACT_CURRENT_KEY_ID: exportKeyId,
        EXPORT_ARTIFACT_ENCRYPTION_KEYS: exportEncryptionKeys,
        EXPORT_ARTIFACT_ENDPOINT: exportEndpoint,
        EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: exportReadAccessKeyId,
        EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
        EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
        EXPORT_ARTIFACT_READ_MAX_CONCURRENCY: "2",
        EXPORT_ARTIFACT_READ_MAX_DOWNLOADS_PER_WINDOW: "3",
        EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES: String(MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES),
        EXPORT_ARTIFACT_READ_RATE_WINDOW_MS: "60000",
        EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: exportReadSecretAccessKey,
        EXPORT_ARTIFACT_READ_SPOOL_DIR: apiSpoolDirectory,
        EXPORT_ARTIFACT_READ_SPOOL_MAX_AGE_MS: "60000",
        EXPORT_ARTIFACT_READ_SPOOL_PROTECTION: "tmpfs",
        EXPORT_ARTIFACT_REGION: exportRegion,
        EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS: "5000",
        EXPORT_ARTIFACT_STORE: "s3",
        LOG_LEVEL: "silent",
        MEILI_SEARCH_KEY: meiliSearchKey,
        MEILI_URL: meiliUrl,
        NODE_ENV: "test",
        READINESS_TIMEOUT_MS: "5000",
        RETENTION_FEATURES_ENABLED: "true",
        SEARCH_CURSOR_SECRET: Buffer.alloc(32, 46).toString("base64"),
        SHUTDOWN_GRACE_MS: "10000",
      };
      const workerEnvironment: NodeJS.ProcessEnv = {
        DATABASE_SSL_MODE: "disable",
        DATABASE_URL: scopedUrl.toString(),
        ERASURE_REPLAY_LEDGER_BUCKET: ledgerBucket,
        ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: ledgerKeyId,
        ERASURE_REPLAY_LEDGER_DIRECTORY: `${workerSpoolDirectory}/unused-ledger-store`,
        ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: ledgerEncryptionKeys,
        ERASURE_REPLAY_LEDGER_ENDPOINT: ledgerEndpoint,
        ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: locatorKeyId,
        ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: locatorHmacKeys,
        ERASURE_REPLAY_LEDGER_REGION: ledgerRegion,
        ERASURE_REPLAY_LEDGER_STORE: "s3",
        ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: ledgerWriteAccessKeyId,
        ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: ledgerWriteSecretAccessKey,
        EXPORT_ARTIFACT_BUCKET: exportBucket,
        EXPORT_ARTIFACT_CURRENT_KEY_ID: exportKeyId,
        EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "suspended_null",
        EXPORT_ARTIFACT_DIRECTORY: `${workerSpoolDirectory}/unused-export-store`,
        EXPORT_ARTIFACT_ENCRYPTION_KEYS: exportEncryptionKeys,
        EXPORT_ARTIFACT_ENDPOINT: exportEndpoint,
        EXPORT_ARTIFACT_REGION: exportRegion,
        EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS: "5000",
        EXPORT_ARTIFACT_STORE: "s3",
        EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: exportWriteAccessKeyId,
        EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: exportWriteSecretAccessKey,
        LOG_LEVEL: "error",
        MEILI_ADMIN_KEY: meiliAdminKey,
        MEILI_TASK_OBSERVER_KEY: meiliTaskObserverKey,
        MEILI_URL: meiliUrl,
        NODE_ENV: "test",
        POLL_INTERVAL_MS: "1000",
        RETENTION_EXPORT_SPOOL_DIR: workerSpoolDirectory,
        RETENTION_EXPORT_SPOOL_MAX_AGE_MS: "60000",
        RETENTION_EXPORT_SPOOL_MAX_BYTES: String(WORKSPACE_BYTES),
        RETENTION_EXPORT_SPOOL_PROTECTION: "tmpfs",
        RETENTION_FEATURES_ENABLED: "true",
        RETENTION_WORKER_ID: "retention-integration-worker",
        SEARCH_REBUILD_SPOOL_DIR: `${workerSpoolDirectory}/search-rebuild`,
        SEARCH_REBUILD_WORKER_ID: "retention-integration-search-worker",
        SERVICE_VERSION: "retention-integration",
        SHUTDOWN_GRACE_MS: "10000",
      };

      const apiRuntime = await createApiApplicationRuntime(apiEnvironment, {
        clock: () => clock,
        logger: false,
      });
      apiRuntimeHandle = apiRuntime;
      const app = apiRuntime.app;
      expect(app.server.listening).toBe(false);
      const events: WorkerOperationalEvent[] = [];
      const workerRuntime = await createWorkerPollRuntime({
        clock: () => clock,
        environment: workerEnvironment,
        onOperationalEvent: (event) => events.push(event),
      });
      workerRuntimeHandle = workerRuntime;

      const readiness = await app.inject({ method: "GET", url: "/ready" });
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json()).toEqual({ status: "ok" });
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

      const nutrients = await database
        .insertInto("nutrient")
        .values([
          {
            canonical_unit: "kcal",
            code: "energy",
            dimension: "energy",
            is_targetable: true,
            name: "Energy",
          },
          {
            canonical_unit: "g",
            code: "retention_e2e_protein",
            dimension: "mass",
            is_targetable: true,
            name: "Retention E2E protein",
          },
        ])
        .returning(["code", "id"])
        .execute();
      const energyNutrient = nutrients.find((candidate) => candidate.code === "energy");
      const proteinNutrient = nutrients.find(
        (candidate) => candidate.code === "retention_e2e_protein",
      );
      if (!energyNutrient || !proteinNutrient) throw new Error("Expected both nutrient fixtures");
      const customFoodResponse = await app.inject({
        method: "POST",
        url: "/v1/custom-foods",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          brandName: null,
          name: "Private export fixture food",
          notes: null,
          nutrients: [
            {
              amountPer100Grams: "123.45",
              nutrientId: energyNutrient.id,
              state: "quantified",
            },
          ],
          serving: { grams: "100", label: "serving" },
        },
      });
      expect(customFoodResponse.statusCode, customFoodResponse.body).toBe(201);
      const customFood = customFoodResponse.json<CustomFoodMutationResponse>().data.customFood;
      const proteinFoodResponse = await app.inject({
        method: "POST",
        url: "/v1/custom-foods",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          brandName: null,
          name: "Private protein fixture food",
          notes: null,
          nutrients: [
            {
              amountPer100Grams: "10",
              nutrientId: proteinNutrient.id,
              state: "quantified",
            },
          ],
          serving: { grams: "100", label: "serving" },
        },
      });
      expect(proteinFoodResponse.statusCode, proteinFoodResponse.body).toBe(201);
      const proteinFood = proteinFoodResponse.json<CustomFoodMutationResponse>().data.customFood;
      const logResponse = await app.inject({
        method: "POST",
        url: `/v1/custom-foods/${customFood.id}/log`,
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          customFoodVersionId: customFood.currentVersion.id,
          mealSlot: "lunch",
          occurredAt: new Date(clock.getTime() - 2_000).toISOString(),
          portion: { grams: "100", kind: "grams" },
        },
      });
      expect(logResponse.statusCode, logResponse.body).toBe(201);
      expect(logResponse.headers.etag).toBe('"1"');
      const loggedEntry = logResponse.json<DiaryMutationResponse>().data.entry;
      if (!loggedEntry) throw new Error("Expected a logged private food diary entry");
      expect(loggedEntry.note).toBeNull();
      const diaryEntryId = loggedEntry.id;
      const diaryLocalDate = loggedEntry.localDate;
      const privateDiaryNote = `private-diary-history-${randomUUID()}`;

      const setNoteResponse = await app.inject({
        method: "PATCH",
        url: `/v1/diary/entries/${diaryEntryId}`,
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "if-match": '"1"',
        },
        payload: { note: privateDiaryNote },
      });
      expect(setNoteResponse.statusCode, setNoteResponse.body).toBe(200);
      expect(setNoteResponse.headers.etag).toBe('"2"');
      expect(setNoteResponse.json<DiaryMutationResponse>().data.entry?.note).toBe(privateDiaryNote);

      const clearNoteResponse = await app.inject({
        method: "PATCH",
        url: `/v1/diary/entries/${diaryEntryId}`,
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "if-match": '"2"',
        },
        payload: { note: null },
      });
      expect(clearNoteResponse.statusCode, clearNoteResponse.body).toBe(200);
      expect(clearNoteResponse.headers.etag).toBe('"3"');
      expect(clearNoteResponse.json<DiaryMutationResponse>().data.entry?.note).toBeNull();

      const diaryEntryIds = [diaryEntryId];
      const mealSlots = ["breakfast", "lunch", "dinner", "snacks"] as const;
      for (let index = 0; index < 44; index += 1) {
        const selectedFood = index < 39 ? customFood : proteinFood;
        const additionalLog = await app.inject({
          method: "POST",
          url: `/v1/custom-foods/${selectedFood.id}/log`,
          headers: { authorization, "idempotency-key": randomUUID() },
          payload: {
            customFoodVersionId: selectedFood.currentVersion.id,
            mealSlot: mealSlots[index % mealSlots.length],
            occurredAt: `${diaryLocalDate}T18:${String(index).padStart(2, "0")}:00.000Z`,
            portion: { grams: "100", kind: "grams" },
            position: index + 1,
          },
        });
        expect(additionalLog.statusCode, additionalLog.body).toBe(201);
        const additionalEntry = additionalLog.json<DiaryMutationResponse>().data.entry;
        if (!additionalEntry) throw new Error("Expected an additional private diary entry");
        expect(additionalEntry).toMatchObject({
          localDate: diaryLocalDate,
          mealSlot: mealSlots[index % mealSlots.length],
          revision: "1",
        });
        diaryEntryIds.push(additionalEntry.id);
      }
      expect(diaryEntryIds).toHaveLength(45);
      expect(new Set(diaryEntryIds).size).toBe(45);

      const firstDiaryPageResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20`,
        headers: { authorization },
      });
      expect(firstDiaryPageResponse.statusCode, firstDiaryPageResponse.body).toBe(200);
      expect(firstDiaryPageResponse.headers["cache-control"]).toBe("no-store");
      const firstDiaryPage = firstDiaryPageResponse.json<DiaryDayResponse>();
      expect(firstDiaryPage.data.entries).toHaveLength(20);
      expect(firstDiaryPage.page).toMatchObject({ totalEntries: 45 });
      expect(firstDiaryPage.page?.nextCursor).toEqual(expect.any(String));
      const nextDiaryCursor = firstDiaryPage.page?.nextCursor;
      if (!nextDiaryCursor) throw new Error("Expected a second diary page cursor");
      expect(nextDiaryCursor).toMatch(/^d1\.[A-Za-z0-9_-]+$/u);
      expect(nextDiaryCursor.length).toBeLessThanOrEqual(512);

      const crossOwnerRegistration = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          displayName: "Other Pagination Owner",
          email: `retention-page-other-${randomUUID()}@example.invalid`,
          password,
          timeZone: "America/Chicago",
        },
      });
      expect(crossOwnerRegistration.statusCode, crossOwnerRegistration.body).toBe(201);
      const crossOwnerAuthorization = `Bearer ${
        crossOwnerRegistration.json<{ data: { accessToken: string } }>().data.accessToken
      }`;
      const crossOwnerPage = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20&cursor=${encodeURIComponent(nextDiaryCursor)}`,
        headers: { authorization: crossOwnerAuthorization },
      });
      expect(crossOwnerPage.statusCode, crossOwnerPage.body).toBe(400);
      expect(crossOwnerPage.json()).toMatchObject({ code: "VALIDATION_ERROR" });

      const replacement = nextDiaryCursor.endsWith("A") ? "B" : "A";
      const tamperedDiaryCursor = `${nextDiaryCursor.slice(0, -1)}${replacement}`;
      for (const url of [
        `/v1/diary?date=1900-01-01&limit=20&cursor=${encodeURIComponent(nextDiaryCursor)}`,
        `/v1/diary?date=${diaryLocalDate}&limit=19&cursor=${encodeURIComponent(nextDiaryCursor)}`,
        `/v1/diary?date=${diaryLocalDate}&limit=20&cursor=${encodeURIComponent(tamperedDiaryCursor)}`,
      ]) {
        const invalidPage = await app.inject({
          method: "GET",
          url,
          headers: { authorization },
        });
        expect(invalidPage.statusCode, invalidPage.body).toBe(400);
        expect(invalidPage.json()).toMatchObject({ code: "VALIDATION_ERROR" });
        expect(invalidPage.body).not.toContain(nextDiaryCursor);
      }

      const secondDiaryPageResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20&cursor=${encodeURIComponent(nextDiaryCursor)}`,
        headers: { authorization },
      });
      expect(secondDiaryPageResponse.statusCode, secondDiaryPageResponse.body).toBe(200);
      expect(secondDiaryPageResponse.headers["cache-control"]).toBe("no-store");
      const secondDiaryPage = secondDiaryPageResponse.json<DiaryDayResponse>();
      expect(secondDiaryPage.data.entries).toHaveLength(20);
      expect(secondDiaryPage.page).toMatchObject({ totalEntries: 45 });
      const finalDiaryCursor = secondDiaryPage.page?.nextCursor;
      if (!finalDiaryCursor) throw new Error("Expected a final diary page cursor");
      const thirdDiaryPageResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20&cursor=${encodeURIComponent(finalDiaryCursor)}`,
        headers: { authorization },
      });
      expect(thirdDiaryPageResponse.statusCode, thirdDiaryPageResponse.body).toBe(200);
      expect(thirdDiaryPageResponse.headers["cache-control"]).toBe("no-store");
      const thirdDiaryPage = thirdDiaryPageResponse.json<DiaryDayResponse>();
      expect(thirdDiaryPage.data.entries).toHaveLength(5);
      expect(thirdDiaryPage.page).toEqual({ nextCursor: null, totalEntries: 45 });
      expect(secondDiaryPage.data.totals).toEqual(firstDiaryPage.data.totals);
      expect(thirdDiaryPage.data.totals).toEqual(firstDiaryPage.data.totals);
      expect(firstDiaryPage.data.totals.find((total) => total.code === "energy")).toMatchObject({
        completeness: "partial",
        contributorCount: 45,
        isExact: false,
        knownAmount: "4938",
        quantifiedCount: 40,
        traceCount: 0,
        unknownCount: 5,
      });
      expect(
        firstDiaryPage.data.totals.find((total) => total.code === "retention_e2e_protein"),
      ).toMatchObject({
        completeness: "partial",
        contributorCount: 45,
        isExact: false,
        knownAmount: "50",
        quantifiedCount: 5,
        traceCount: 0,
        unknownCount: 40,
      });
      const persistenceDiaryDay = await getDiaryDay(database, {
        localDate: diaryLocalDate,
        userId,
      });
      expect(persistenceDiaryDay.totalEntries).toBe(45);
      expect(persistenceDiaryDay.totals.find((total) => total.code === "energy")).toMatchObject({
        contributorCount: 45,
        quantifiedCount: 40,
        unknownCount: 5,
        unknownReasons: { not_reported: 5 },
      });
      expect(
        persistenceDiaryDay.totals.find((total) => total.code === "retention_e2e_protein"),
      ).toMatchObject({
        contributorCount: 45,
        quantifiedCount: 5,
        unknownCount: 40,
        unknownReasons: { not_reported: 40 },
      });
      const pagedEntries = [
        ...firstDiaryPage.data.entries,
        ...secondDiaryPage.data.entries,
        ...thirdDiaryPage.data.entries,
      ];
      expectExactEntityIds(
        pagedEntries.map((entry) => entry.id),
        diaryEntryIds,
      );
      const mealRank = new Map([
        ["breakfast", 0],
        ["lunch", 1],
        ["dinner", 2],
        ["snacks", 3],
      ]);
      const compareText = (left: string, right: string): number =>
        left < right ? -1 : left > right ? 1 : 0;
      expect(pagedEntries.map((entry) => entry.id)).toEqual(
        [...pagedEntries]
          .sort(
            (left, right) =>
              (mealRank.get(left.mealSlot) ?? 99) - (mealRank.get(right.mealSlot) ?? 99) ||
              left.position - right.position ||
              compareText(left.occurredAt, right.occurredAt) ||
              compareText(left.id, right.id),
          )
          .map((entry) => entry.id),
      );

      const expectDiaryPageStale = async (cursor: string): Promise<void> => {
        const response = await app.inject({
          method: "GET",
          url: `/v1/diary?date=${diaryLocalDate}&limit=20&cursor=${encodeURIComponent(cursor)}`,
          headers: { authorization },
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ code: "DIARY_PAGE_STALE" });
      };
      const diaryId = firstDiaryPage.data.id;
      if (!diaryId) throw new Error("Expected a persisted diary day");
      await database
        .updateTable("diary")
        .set({ status: "locked" })
        .where("id", "=", diaryId)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      await expectDiaryPageStale(nextDiaryCursor);

      const lockedDiaryPageResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20`,
        headers: { authorization },
      });
      expect(lockedDiaryPageResponse.statusCode, lockedDiaryPageResponse.body).toBe(200);
      const lockedDiaryPage = lockedDiaryPageResponse.json<DiaryDayResponse>();
      expect(lockedDiaryPage.data.status).toBe("locked");
      const lockedDiaryCursor = lockedDiaryPage.page?.nextCursor;
      if (!lockedDiaryCursor) throw new Error("Expected a locked diary continuation");
      const lockedUpdatedAt = lockedDiaryPage.data.updatedAt;
      await database
        .updateTable("diary")
        .set({ note: null })
        .where("id", "=", diaryId)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      const metadataUpdatedAt = (
        await database
          .selectFrom("diary")
          .select("updated_at")
          .where("id", "=", diaryId)
          .executeTakeFirstOrThrow()
      ).updated_at.toISOString();
      expect(metadataUpdatedAt).not.toBe(lockedUpdatedAt);
      await expectDiaryPageStale(lockedDiaryCursor);

      const beforeUnlockResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20`,
        headers: { authorization },
      });
      expect(beforeUnlockResponse.statusCode, beforeUnlockResponse.body).toBe(200);
      const beforeUnlockCursor = beforeUnlockResponse.json<DiaryDayResponse>().page?.nextCursor;
      if (!beforeUnlockCursor) throw new Error("Expected a pre-unlock diary continuation");
      await database
        .updateTable("diary")
        .set({ status: "open" })
        .where("id", "=", diaryId)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      await expectDiaryPageStale(beforeUnlockCursor);

      const beforeMutationResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20`,
        headers: { authorization },
      });
      expect(beforeMutationResponse.statusCode, beforeMutationResponse.body).toBe(200);
      const beforeMutationCursor = beforeMutationResponse.json<DiaryDayResponse>().page?.nextCursor;
      if (!beforeMutationCursor) throw new Error("Expected a pre-mutation diary continuation");
      const mutationResponse = await app.inject({
        method: "PATCH",
        url: `/v1/diary/entries/${diaryEntryIds[1]}`,
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "if-match": '"1"',
        },
        payload: { position: 999_999 },
      });
      expect(mutationResponse.statusCode, mutationResponse.body).toBe(200);
      expect(mutationResponse.json<DiaryMutationResponse>().data.entry?.revision).toBe("2");
      await expectDiaryPageStale(beforeMutationCursor);

      const beforeTimeZoneResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}&limit=20`,
        headers: { authorization },
      });
      expect(beforeTimeZoneResponse.statusCode, beforeTimeZoneResponse.body).toBe(200);
      const beforeTimeZoneCursor = beforeTimeZoneResponse.json<DiaryDayResponse>().page?.nextCursor;
      if (!beforeTimeZoneCursor) throw new Error("Expected a pre-time-zone diary continuation");
      const profileTimeZoneResponse = await app.inject({
        method: "PATCH",
        url: "/v1/profile",
        headers: { authorization, "if-match": '"0"' },
        payload: { timeZone: "Asia/Tokyo" },
      });
      expect(profileTimeZoneResponse.statusCode, profileTimeZoneResponse.body).toBe(200);
      expect(profileTimeZoneResponse.headers.etag).toBe('"1"');
      await expectDiaryPageStale(beforeTimeZoneCursor);

      const goalResponse = await app.inject({
        method: "POST",
        url: "/v1/goals",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          effectiveFrom: diaryLocalDate,
          energy: {
            mode: "fixed",
            rationale: "Pagination compatibility fixture.",
            targetKcal: "2000",
          },
          nutrientTargets: [],
        },
      });
      expect(goalResponse.statusCode, goalResponse.body).toBe(201);
      expect(
        goalResponse.json<NutritionGoalMutationResponse>().data.goal.currentVersion.energy,
      ).toMatchObject({ mode: "fixed", targetKcal: "2000" });
      const goalProgressResponse = await app.inject({
        method: "GET",
        url: `/v1/goals/progress?date=${diaryLocalDate}`,
        headers: { authorization },
      });
      expect(goalProgressResponse.statusCode, goalProgressResponse.body).toBe(200);
      const goalProgress = goalProgressResponse.json<NutritionGoalProgressResponse>().data;
      expect(goalProgress).toMatchObject({
        diaryRevision: "48",
        localDate: diaryLocalDate,
        timeZone: "Asia/Tokyo",
      });
      expect(goalProgress.energy).toMatchObject({
        amountInterpretation: "lower_bound",
        code: "energy",
        completeness: "partial",
        knownAmount: "4938",
        target: { amount: "2000", lowerBoundPercent: "246.9", percentIsExact: false },
      });

      const currentDiaryResponse = await app.inject({
        method: "GET",
        url: `/v1/diary?date=${diaryLocalDate}`,
        headers: { authorization },
      });
      expect(currentDiaryResponse.statusCode, currentDiaryResponse.body).toBe(200);
      const currentDiary = currentDiaryResponse.json<DiaryDayResponse>().data;
      expect(currentDiary.entries).toHaveLength(45);
      expect(currentDiary.totals).toEqual(firstDiaryPage.data.totals);
      expectExactEntityIds(
        currentDiary.entries.map((entry) => entry.id),
        diaryEntryIds,
      );
      expect(currentDiary.entries.find((entry) => entry.id === diaryEntryId)).toMatchObject({
        note: null,
        revision: "3",
      });
      expect(currentDiaryResponse.body).not.toContain(privateDiaryNote);

      const expectedDiaryEntries = await database
        .selectFrom("diary_entry")
        .select("id")
        .where("user_id", "=", userId)
        .execute();
      const expectedDiaryRevisions = await database
        .selectFrom("diary_entry_revision")
        .select(["id", "diary_entry_id", "revision_number"])
        .where("user_id", "=", userId)
        .execute();
      const expectedDiaryNutrients = await database
        .selectFrom("diary_entry_revision_nutrient as nutrient")
        .innerJoin(
          "diary_entry_revision as revision",
          "revision.id",
          "nutrient.diary_entry_revision_id",
        )
        .select(["nutrient.diary_entry_revision_id", "nutrient.nutrient_id"])
        .where("revision.user_id", "=", userId)
        .execute();
      const expectedDiarySources = await database
        .selectFrom("diary_entry_revision_source as source")
        .innerJoin(
          "diary_entry_revision as revision",
          "revision.id",
          "source.diary_entry_revision_id",
        )
        .select([
          "source.diary_entry_revision_id",
          "source.food_source_id",
          "source.source_release_id",
        ])
        .where("revision.user_id", "=", userId)
        .execute();
      const expectedDiaryOperations = await database
        .selectFrom("diary_operation")
        .select(["client_operation_id", "operation"])
        .where("user_id", "=", userId)
        .execute();
      expectExactEntityIds(
        expectedDiaryEntries.map((row) => row.id),
        diaryEntryIds,
      );
      expect(expectedDiaryRevisions).toHaveLength(48);
      expect(expectedDiaryNutrients).toHaveLength(96);
      expect(expectedDiarySources).toHaveLength(0);
      expect(expectedDiaryOperations).toHaveLength(48);

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
      await workerRuntime.pollOnce();
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
      for (const [entity, count] of [
        ["diary_day", 1],
        ["diary_entry", 45],
        ["diary_entry_legacy_nutrient", 0],
        ["diary_entry_nutrient", 96],
        ["diary_entry_revision", 48],
        ["diary_entry_source", 0],
        ["diary_operation", 48],
      ] as const) {
        expect(
          completedExport.reconciliation?.entities.find((candidate) => candidate.entity === entity),
        ).toMatchObject({ exportedCount: count, sourceCount: count });
      }

      const expectedDiaryExportIds = {
        entries: expectedDiaryEntries.map((row) => row.id),
        nutrients: expectedDiaryNutrients.map(
          (row) => `${row.diary_entry_revision_id}:${row.nutrient_id}`,
        ),
        operations: expectedDiaryOperations.map(
          (row) => `${row.client_operation_id}:${row.operation}`,
        ),
        revisions: expectedDiaryRevisions.map((row) => row.id),
        revisionSignatures: expectedDiaryRevisions.map(
          (row) => `${row.id}:${row.diary_entry_id}:${row.revision_number}`,
        ),
        sources: expectedDiarySources.map(
          (row) => `${row.diary_entry_revision_id}:${row.food_source_id}:${row.source_release_id}`,
        ),
      };

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
          const rawJson = download.rawPayload.toString("utf8");
          const parsed = JSON.parse(rawJson) as {
            entities: {
              account: unknown[];
              biometric_definition: unknown[];
              biometric_definition_version: unknown[];
              biometric_event: unknown[];
              biometric_event_revision: unknown[];
              diary_entry: readonly {
                readonly entityId: string;
                readonly payload: Readonly<Record<string, unknown>>;
                readonly revision: string | null;
              }[];
              diary_entry_nutrient: readonly {
                readonly entityId: string;
                readonly payload: Readonly<Record<string, unknown>>;
                readonly revision: string | null;
              }[];
              diary_entry_revision: readonly {
                readonly entityId: string;
                readonly payload: Readonly<Record<string, unknown>>;
                readonly revision: string | null;
              }[];
              diary_entry_source: readonly {
                readonly entityId: string;
                readonly payload: Readonly<Record<string, unknown>>;
                readonly revision: string | null;
              }[];
              diary_operation: readonly {
                readonly entityId: string;
                readonly payload: Readonly<Record<string, unknown>>;
                readonly revision: string | null;
              }[];
              profile: unknown[];
            };
            manifest: Parameters<typeof canonicalJson>[0];
          };
          expect(rawJson).toBe(
            `${canonicalJson(parsed as unknown as Parameters<typeof canonicalJson>[0])}\n`,
          );
          expect(parsed.entities.account).toHaveLength(1);
          expect(parsed.entities.biometric_definition).toHaveLength(1);
          expect(parsed.entities.biometric_definition_version).toHaveLength(1);
          expect(parsed.entities.biometric_event).toHaveLength(1);
          expect(parsed.entities.biometric_event_revision).toHaveLength(1);
          expect(parsed.entities.profile).toHaveLength(1);
          expectExactEntityIds(
            parsed.entities.diary_entry.map((row) => row.entityId),
            expectedDiaryExportIds.entries,
          );
          expectExactEntityIds(
            parsed.entities.diary_entry_nutrient.map((row) => row.entityId),
            expectedDiaryExportIds.nutrients,
          );
          expectExactEntityIds(
            parsed.entities.diary_entry_source.map((row) => row.entityId),
            expectedDiaryExportIds.sources,
          );
          expectExactEntityIds(
            parsed.entities.diary_operation.map((row) => row.entityId),
            expectedDiaryExportIds.operations,
          );
          expectExactEntityIds(
            parsed.entities.diary_entry_revision.map((row) => row.entityId),
            expectedDiaryExportIds.revisions,
          );
          expectExactEntityIds(
            parsed.entities.diary_entry_revision.map(
              (row) => `${row.entityId}:${row.payload.diary_entry_id}:${row.revision}`,
            ),
            expectedDiaryExportIds.revisionSignatures,
          );
          const exportedDiaryRevisions = parsed.entities.diary_entry_revision
            .filter((row) => row.payload.diary_entry_id === diaryEntryId)
            .sort((left, right) => Number(left.revision) - Number(right.revision));
          expect(
            exportedDiaryRevisions.map((row) => ({
              note: row.payload.note,
              operation: row.payload.operation,
              revision: row.revision,
            })),
          ).toEqual([
            { note: null, operation: "create", revision: "1" },
            { note: privateDiaryNote, operation: "update", revision: "2" },
            { note: null, operation: "update", revision: "3" },
          ]);
          expect(parsed.manifest).toMatchObject({
            formatVersion: "nutrition-account-export-v1",
            reconciled: true,
            semanticEvidence: {
              diaryDailyNutrientGroupCount: "2",
              diaryDailyTotalsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
              version: "retention-export-semantic-v1",
            },
          });
          expect(sha256(canonicalJson(parsed.manifest))).toBe(completedExport.manifestSha256);
        } else {
          expect(download.rawPayload.readUInt32LE(0)).toBe(0x0403_4b50);
          const zipEntries = storedZipEntries(download.rawPayload);
          expectExactEntityIds(
            csvEntityIds(requiredZipEntry(zipEntries, "entities/diary_entry/part-000001.csv")),
            expectedDiaryExportIds.entries,
          );
          expectExactEntityIds(
            csvEntityIds(
              requiredZipEntry(zipEntries, "entities/diary_entry_nutrient/part-000001.csv"),
            ),
            expectedDiaryExportIds.nutrients,
          );
          expectExactEntityIds(
            csvEntityIds(
              requiredZipEntry(zipEntries, "entities/diary_entry_revision/part-000001.csv"),
            ),
            expectedDiaryExportIds.revisions,
          );
          expectExactEntityIds(
            csvEntityIds(
              requiredZipEntry(zipEntries, "entities/diary_entry_source/part-000001.csv"),
            ),
            expectedDiaryExportIds.sources,
          );
          expectExactEntityIds(
            csvEntityIds(requiredZipEntry(zipEntries, "entities/diary_operation/part-000001.csv")),
            expectedDiaryExportIds.operations,
          );
          const diaryRevisionCsv = requiredZipEntry(
            zipEntries,
            "entities/diary_entry_revision/part-000001.csv",
          ).toString("utf8");
          expect(occurrenceCount(diaryRevisionCsv, diaryEntryId)).toBe(3);
          expect(occurrenceCount(diaryRevisionCsv, privateDiaryNote)).toBe(1);
          expect(occurrenceCount(diaryRevisionCsv, '""note"":null')).toBe(47);
          expect(diaryRevisionCsv).toContain(`""note"":""${privateDiaryNote}""`);
        }
        await vi.waitFor(async () => expect(await readdir(apiSpoolDirectory)).toEqual([]), {
          interval: 10,
          timeout: 2_000,
        });
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
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
      await workerRuntime.pollOnce();
      expect(events).toContainEqual({
        event: "retention.erasure.completed",
        jobId: queuedErasure.erasure.id,
        level: "info",
      });
      expect(events.filter((event) => event.level === "warn")).toEqual([]);
      expect(events.filter((event) => event.event === "worker.poll.slice_failed")).toEqual([]);

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
        const opened = await exportVerifier.openAuthenticated(metadata);
        await opened?.dispose();
        expect(opened).toBeNull();
      }
      expect(await ledgerRestore.findForSubject({ subjectUserId: userId })).toMatchObject({
        jobId: queuedErasure.erasure.id,
        restoreLocator: ledgerRestore.locatorForSubject(userId),
        subjectUserId: userId,
      });
      const reconciliation = await reconcileErasedAccountRows(database, { userId });
      expect(reconciliation.reconciled).toBe(true);
      expect(reconciliation.remainingRows).toMatchObject({
        biometric_definition: "0",
        biometric_definition_version: "0",
        biometric_event: "0",
        biometric_event_revision: "0",
        diary_day: "0",
        diary_entry: "0",
        diary_entry_legacy_nutrient: "0",
        diary_entry_nutrient: "0",
        diary_entry_revision: "0",
        diary_entry_source: "0",
        diary_operation: "0",
      });
      expect(Object.values(reconciliation.remainingRows).every((count) => count === "0")).toBe(
        true,
      );
      const erasedDiaryCounts = {
        diary: (
          await database
            .selectFrom("diary")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
        diary_entry: (
          await database
            .selectFrom("diary_entry")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
        diary_entry_nutrient_snapshot: (
          await database
            .selectFrom("diary_entry_nutrient_snapshot")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
        diary_entry_revision: (
          await database
            .selectFrom("diary_entry_revision")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
        diary_entry_revision_nutrient: (
          await database
            .selectFrom("diary_entry_revision_nutrient")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
        diary_entry_revision_source: (
          await database
            .selectFrom("diary_entry_revision_source")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
        diary_operation: (
          await database
            .selectFrom("diary_operation")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      };
      expect(erasedDiaryCounts).toEqual({
        diary: "0",
        diary_entry: "0",
        diary_entry_nutrient_snapshot: "0",
        diary_entry_revision: "0",
        diary_entry_revision_nutrient: "0",
        diary_entry_revision_source: "0",
        diary_operation: "0",
      });
      expect(
        await database
          .selectFrom("diary_entry_revision")
          .select(["id", "note"])
          .where("diary_entry_id", "=", diaryEntryId)
          .execute(),
      ).toEqual([]);
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
      expect(await readdir(apiSpoolDirectory)).toEqual([]);
      expect(await readdir(workerSpoolDirectory)).toEqual([]);
      expect(await readdir(restoreSpoolDirectory)).toEqual([]);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      const cleanupErrors: Error[] = [];
      const apiRuntime = apiRuntimeHandle;
      if (apiRuntime) {
        await attemptCleanup(cleanupErrors, "close API application runtime", () =>
          apiRuntime.close(),
        );
      }
      const workerRuntime = workerRuntimeHandle;
      if (workerRuntime) {
        await attemptCleanup(cleanupErrors, "close worker poll runtime", () =>
          workerRuntime.close(),
        );
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

      for (const spoolDirectory of spoolDirectoryHandles) {
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
