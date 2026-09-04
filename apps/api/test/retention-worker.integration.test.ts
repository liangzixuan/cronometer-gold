import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
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
  type CurrentAccountResponse,
  type CustomFoodMutationResponse,
  canonicalJson,
  type DeviceChallengeResponse,
  type DiaryDayResponse,
  type DiaryMutationResponse,
  deviceRegistrationSignaturePayload,
  type HealthDeviceResponse,
  type HealthImportBatchRequest,
  type HealthImportBatchResponse,
  healthImportSignaturePayload,
  type NutritionGoalMutationResponse,
  type NutritionGoalProgressResponse,
  type PlatformIntegrationResponse,
  type RecipeMutationResponse,
  type ReminderMutationResponse,
} from "@nutrition-tracker/contracts";
import {
  createDatabase,
  enqueueDueReminderDeliveries,
  getDiaryDay,
  getPrivacyExportJob,
  issueEmailVerificationToken,
  issuePasswordRecoveryToken,
  MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES,
  type PrivacyExportEntity,
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

const EXPECTED_PRIVACY_EXPORT_ENTITY_SET: Readonly<Record<PrivacyExportEntity, true>> = {
  account: true,
  audit_event: true,
  biometric_definition: true,
  biometric_definition_operation: true,
  biometric_definition_version: true,
  biometric_event: true,
  biometric_event_operation: true,
  biometric_event_revision: true,
  custom_food: true,
  custom_food_catalogue_barcode: true,
  custom_food_catalogue_food: true,
  custom_food_catalogue_nutrient: true,
  custom_food_catalogue_serving: true,
  custom_food_catalogue_version: true,
  custom_food_nutrient: true,
  custom_food_operation: true,
  custom_food_version: true,
  device: true,
  diary_day: true,
  diary_entry: true,
  diary_entry_legacy_nutrient: true,
  diary_entry_nutrient: true,
  diary_entry_revision: true,
  diary_entry_source: true,
  diary_operation: true,
  nutrition_goal: true,
  nutrition_goal_operation: true,
  nutrition_goal_target: true,
  nutrition_goal_version: true,
  platform_health_import: true,
  platform_health_import_conflict: true,
  platform_health_import_revision: true,
  platform_import_batch: true,
  platform_integration: true,
  platform_integration_version: true,
  privacy_export_artifact: true,
  privacy_export_artifact_deletion: true,
  privacy_export_artifact_tombstone: true,
  privacy_export_download_audit: true,
  privacy_export_job: true,
  profile: true,
  reauthentication_proof: true,
  recipe: true,
  recipe_ingredient: true,
  recipe_nutrient: true,
  recipe_operation: true,
  recipe_source: true,
  recipe_version: true,
  reminder_consent: true,
  reminder_consent_version: true,
  reminder_delivery: true,
  reminder_schedule: true,
  reminder_schedule_version: true,
  retention_operation: true,
  security_challenge: true,
  session: true,
  user_watermark: true,
};
const EXPECTED_PRIVACY_EXPORT_ENTITIES = Object.keys(
  EXPECTED_PRIVACY_EXPORT_ENTITY_SET,
) as PrivacyExportEntity[];

type ExportEntityRow = {
  readonly entityId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly revision: string | null;
};

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

function expectExactEntityIds(
  actual: readonly string[],
  expected: readonly string[],
  label?: string,
): void {
  expect(actual, label).toHaveLength(expected.length);
  expect(new Set(actual).size, label).toBe(actual.length);
  expect([...actual].sort(), label).toEqual([...expected].sort());
}

async function seedPromotedPublicFood(
  database: ReturnType<typeof createDatabase>,
  input: {
    readonly energyNutrientId: string;
    readonly now: Date;
    readonly proteinNutrientId: string;
  },
): Promise<{
  readonly foodVersionId: string;
  readonly releaseId: string;
  readonly sourceId: string;
}> {
  return database.transaction().execute(async (transaction) => {
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    const instant = input.now.toISOString();
    const artifactSha256 = sha256(`retention-public-food-${suffix}`);
    const rightsManifestSha256 = sha256(`retention-public-rights-${suffix}`);
    const source = await transaction
      .insertInto("food_source")
      .values({
        access_url: null,
        active: true,
        attribution_required: true,
        attribution_text: "Synthetic retention privacy drill fixture",
        code: `RP${suffix}`,
        commercial_use_allowed: true,
        database_rights_notes: "Test-only synthetic fixture",
        display_name: `Retention public source ${suffix}`,
        homepage_url: "https://example.invalid/retention-public-food",
        kind: "government",
        license_expression: "CC0-1.0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistribution_allowed: true,
        rights_review_status: "approved",
        rights_reviewed_at: input.now,
        rights_reviewed_by: "principal:retention-privacy-drill",
        terms_url: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const release = await transaction
      .insertInto("food_source_release")
      .values({
        acquired_at: input.now,
        artifact_bytes: 1,
        artifact_sha256: artifactSha256,
        artifact_uri: `s3://retention-fixture.invalid/sha256/${artifactSha256}.json`,
        food_source_id: source.id,
        media_type: "application/json",
        parser_version: "retention-privacy-drill@1",
        promoted_at: null,
        published_on: instant.slice(0, 10),
        record_counts: { records: 1 },
        release_key: `retention-public-${suffix}`,
        rights_manifest_sha256: rightsManifestSha256,
        rights_manifest_uri: "repo://retention-privacy-drill/synthetic-rights.json",
        status: "imported",
        upstream_schema_version: "synthetic-v1",
        validation_summary: { synthetic: true, valid: true },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const batch = await transaction
      .insertInto("food_import_batch")
      .values({
        acquired_at: input.now,
        artifact_bytes: 1,
        artifact_sha256: artifactSha256,
        artifact_uri: `s3://retention-fixture.invalid/sha256/${artifactSha256}.json`,
        completed_at: input.now,
        food_source_id: source.id,
        materialized_count: 1,
        media_type: "application/json",
        parser_version: "retention-privacy-drill@1",
        published_on: instant.slice(0, 10),
        release_id: release.id,
        release_key: `retention-public-${suffix}`,
        rights_manifest_sha256: rightsManifestSha256,
        rights_manifest_uri: "repo://retention-privacy-drill/synthetic-rights.json",
        staged_count: 1,
        status: "completed",
        upstream_schema_version: "synthetic-v1",
        valid_count: 1,
        validated_at: input.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const food = await transaction
      .insertInto("food")
      .values({
        archived_at: null,
        food_source_id: source.id,
        kind: "generic",
        owner_user_id: null,
        source_food_key: `retention-public-${suffix}`,
        visibility: "public",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await transaction
      .insertInto("food_version")
      .values({
        attributes: { synthetic: true },
        basis_quantity: "100",
        basis_unit: "g",
        brand_name: null,
        created_by_user_id: null,
        data_quality: "verified",
        description: "Synthetic source-backed public food",
        food_id: food.id,
        ingredients_text: null,
        language_tag: "en-US",
        market_code: "US",
        name: "Retention public food",
        normalized_name: "retention public food",
        source_modified_at: input.now,
        source_release_id: release.id,
        version_number: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("food_import_record")
      .values({
        batch_id: batch.id,
        canonical_payload: { name: "Retention public food", synthetic: true },
        canonical_payload_sha256: sha256("retention-public-canonical-payload"),
        food_version_id: version.id,
        materialized_at: input.now,
        sequence_number: 0,
        source_payload_sha256: sha256("retention-public-source-payload"),
        source_record_key: `retention-public-${suffix}`,
        source_record_type: "fixture",
        validated_at: input.now,
        validation_status: "materialized",
      })
      .execute();
    await transaction
      .updateTable("food")
      .set({ current_version_id: version.id })
      .where("id", "=", food.id)
      .execute();
    await transaction
      .insertInto("food_nutrient_value")
      .values([
        {
          amount: "321",
          basis_quantity: "100",
          basis_unit: "g",
          food_version_id: version.id,
          nutrient_id: input.energyNutrientId,
          unit: "kcal",
          value_status: "measured",
        },
        {
          amount: "17.5",
          basis_quantity: "100",
          basis_unit: "g",
          food_version_id: version.id,
          nutrient_id: input.proteinNutrientId,
          unit: "g",
          value_status: "measured",
        },
      ])
      .execute();
    await transaction
      .updateTable("food_source_release")
      .set({ promoted_at: input.now, status: "promoted" })
      .where("id", "=", release.id)
      .execute();
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: release.id })
      .where("id", "=", source.id)
      .execute();
    return { foodVersionId: version.id, releaseId: release.id, sourceId: source.id };
  });
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
      const workerPollSequence: string[] = [];
      const pollRetentionWorkerOnce = async (
        phase: "seed_export" | "seed_artifact_expiry" | "measured_export" | "account_erasure",
      ): Promise<void> => {
        workerPollSequence.push(phase);
        await workerRuntime.pollOnce();
      };

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

      const secondLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email, password },
      });
      expect(secondLogin.statusCode, secondLogin.body).toBe(200);
      const secondAuthorization = `Bearer ${
        secondLogin.json<{ data: { accessToken: string } }>().data.accessToken
      }`;
      const secondLogout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: secondAuthorization },
      });
      expect(secondLogout.statusCode, secondLogout.body).toBe(204);

      const emailHash = sha256(email);
      expect(
        await issueEmailVerificationToken(database, {
          deliver: async () => undefined,
          emailHash,
          expiresAt: new Date(clock.getTime() + 86_400_000).toISOString(),
          issuedAt: clock.toISOString(),
          tokenHash: sha256(`retention-email-verification-${userId}`),
          userId,
        }),
      ).toBe("issued");
      expect(
        await issuePasswordRecoveryToken(database, {
          deliver: async () => undefined,
          emailHash,
          expiresAt: new Date(clock.getTime() + 86_400_000).toISOString(),
          issuedAt: clock.toISOString(),
          normalizedEmail: email,
          tokenHash: sha256(`retention-password-recovery-${userId}`),
        }),
      ).toBe("issued");

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
      const customFoodOperationId = randomUUID();
      await database
        .insertInto("custom_food_operation")
        .values({
          client_operation_id: customFoodOperationId,
          custom_food_id: customFood.id,
          operation: "create",
          request_digest: sha256("retention-custom-food-operation"),
          result_payload: { customFoodId: customFood.id },
          user_id: userId,
        })
        .execute();
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
      const crossOwner = crossOwnerRegistration.json<{
        data: { accessToken: string; user: { id: string } };
      }>().data;
      const crossOwnerAuthorization = `Bearer ${crossOwner.accessToken}`;
      const crossOwnerUserId = crossOwner.user.id;
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
          nutrientTargets: [
            {
              maximumAmount: "150",
              minimumAmount: "50",
              nutrientId: proteinNutrient.id,
              rationale: "Synthetic privacy-drill coverage target.",
              source: { label: "Synthetic integration fixture", version: null },
              targetAmount: "75",
            },
          ],
        },
      });
      expect(goalResponse.statusCode, goalResponse.body).toBe(201);
      const goal = goalResponse.json<NutritionGoalMutationResponse>().data.goal;
      expect(goal.currentVersion.energy).toMatchObject({ mode: "fixed", targetKcal: "2000" });
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

      const publicRecipeFood = await seedPromotedPublicFood(database, {
        energyNutrientId: energyNutrient.id,
        now: clock,
        proteinNutrientId: proteinNutrient.id,
      });
      const recipeResponse = await app.inject({
        method: "POST",
        url: "/v1/recipes",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          description: "Synthetic route-first privacy coverage.",
          finalYield: { grams: "100", source: "measured" },
          ingredients: [
            {
              foodVersionId: publicRecipeFood.foodVersionId,
              kind: "food",
              portion: { grams: "100", kind: "grams" },
            },
          ],
          instructions: null,
          name: "Private retention recipe",
          servingCount: "1",
          servingLabel: "bowl",
        },
      });
      expect(recipeResponse.statusCode, recipeResponse.body).toBe(201);
      const recipe = recipeResponse.json<RecipeMutationResponse>().data.recipe;
      expect(recipe.currentVersion.ingredients).toHaveLength(1);
      expect(
        recipe.currentVersion.nutrition.totals.map((nutrient) => nutrient.code).sort(),
      ).toEqual(["energy", "retention_e2e_protein"]);
      expect(
        await database
          .selectFrom("recipe_version_source")
          .select(["food_source_id", "source_release_id"])
          .where("recipe_version_id", "=", recipe.currentVersion.id)
          .execute(),
      ).toEqual([
        {
          food_source_id: publicRecipeFood.sourceId,
          source_release_id: publicRecipeFood.releaseId,
        },
      ]);

      const reminderDraft = {
        channel: "local" as const,
        consentGranted: true as const,
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        label: "Private retention reminder",
        localTime: "12:34",
        timeZone: "UTC",
      };
      const reminderResponse = await app.inject({
        method: "POST",
        url: "/v1/reminders",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: reminderDraft,
      });
      expect(reminderResponse.statusCode, reminderResponse.body).toBe(201);
      const reminder = reminderResponse.json<ReminderMutationResponse>().data.reminder;
      expect(
        await enqueueDueReminderDeliveries(database, {
          limit: 1,
          through: new Date(clock.getTime() + 2 * 86_400_000).toISOString(),
        }),
      ).toBe(1);
      const pausedReminderResponse = await app.inject({
        method: "PATCH",
        url: `/v1/reminders/${reminder.id}`,
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "if-match": `"${reminder.revision}"`,
        },
        payload: {
          daysOfWeek: reminderDraft.daysOfWeek,
          label: reminderDraft.label,
          localTime: reminderDraft.localTime,
          status: "paused",
          timeZone: reminderDraft.timeZone,
        },
      });
      expect(pausedReminderResponse.statusCode, pausedReminderResponse.body).toBe(200);
      const pausedReminder = pausedReminderResponse.json<ReminderMutationResponse>().data.reminder;
      expect(pausedReminder.status).toBe("paused");
      const revokedReminderResponse = await app.inject({
        method: "DELETE",
        url: `/v1/reminders/${reminder.id}`,
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "if-match": `"${pausedReminder.revision}"`,
        },
      });
      expect(revokedReminderResponse.statusCode, revokedReminderResponse.body).toBe(200);
      expect(revokedReminderResponse.json<ReminderMutationResponse>().data.reminder.status).toBe(
        "revoked",
      );
      expect(
        await database
          .selectFrom("reminder_delivery_outbox")
          .select(["schedule_id", "status"])
          .where("user_id", "=", userId)
          .where("schedule_id", "=", reminder.id)
          .execute(),
      ).toEqual([{ schedule_id: reminder.id, status: "cancelled" }]);

      const challengeResponse = await app.inject({
        method: "POST",
        url: "/v1/devices/challenges",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: { platform: "apple_healthkit" },
      });
      expect(challengeResponse.statusCode, challengeResponse.body).toBe(201);
      const challenge = challengeResponse.json<DeviceChallengeResponse>().data;
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const publicKeyRequest = {
        algorithm: "ES256" as const,
        derBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
        format: "spki" as const,
      };
      const canonicalPublicKeySha256 = sha256(canonicalJson(publicKeyRequest));
      const challengeSignature = sign(
        "sha256",
        Buffer.from(
          deviceRegistrationSignaturePayload({
            canonicalPublicKeySha256,
            challenge: challenge.challenge,
            challengeId: challenge.id,
            platform: challenge.platform,
          }),
          "utf8",
        ),
        privateKey,
      ).toString("base64url");
      const deviceResponse = await app.inject({
        method: "POST",
        url: "/v1/devices",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          attestation: null,
          challenge: challenge.challenge,
          challengeId: challenge.id,
          challengeSignature,
          displayName: "Synthetic retention phone",
          platform: challenge.platform,
          publicKey: publicKeyRequest,
        },
      });
      expect(deviceResponse.statusCode, deviceResponse.body).toBe(201);
      const device = deviceResponse.json<HealthDeviceResponse>().data.device;
      const consentResponse = await app.inject({
        method: "POST",
        url: "/v1/integrations/health/consents",
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          consentGranted: true,
          dataTypeCodes: ["body_weight"],
          platform: "apple_healthkit",
        },
      });
      expect(consentResponse.statusCode, consentResponse.body).toBe(201);
      const integration = consentResponse.json<PlatformIntegrationResponse>().data.integration;
      expect(integration).toMatchObject({ deviceId: device.id, cursorEpoch: "1" });

      const injectSignedHealthBatch = async (request: HealthImportBatchRequest) => {
        const signedAt = clock.toISOString();
        const nonce = randomBytes(16).toString("base64url");
        const signaturePayload = healthImportSignaturePayload({
          batchId: request.batchId,
          bodySha256: sha256(canonicalJson(request)),
          deviceId: request.deviceId,
          nonce,
          platform: request.platform,
          signedAt,
        });
        const signature = sign(
          "sha256",
          Buffer.from(signaturePayload, "utf8"),
          privateKey,
        ).toString("base64url");
        return app.inject({
          method: "POST",
          url: "/v1/integrations/health/imports",
          headers: {
            authorization,
            "x-device-nonce": nonce,
            "x-device-signature": signature,
            "x-device-timestamp": signedAt,
          },
          payload: request,
        });
      };
      const platformExternalId = `retention-weight-${randomUUID()}`;
      const firstHealthRecord = {
        definitionCode: "body_weight",
        externalId: platformExternalId,
        externalRevision: "1",
        measuredAt: new Date(clock.getTime() - 500).toISOString(),
        operation: "upsert" as const,
        recordedTimeZone: "America/Chicago",
        unit: "kg",
        value: "72.125",
      };
      const firstHealthBatch: HealthImportBatchRequest = {
        batchId: randomUUID(),
        cursorEpoch: integration.cursorEpoch,
        deviceId: device.id,
        nextSourceCursor: "retention-anchor-0001",
        platform: "apple_healthkit",
        records: [firstHealthRecord],
        sourceCursor: null,
      };
      const firstHealthResponse = await injectSignedHealthBatch(firstHealthBatch);
      expect(firstHealthResponse.statusCode, firstHealthResponse.body).toBe(201);
      expect(firstHealthResponse.json<HealthImportBatchResponse>().data).toMatchObject({
        accepted: 1,
        conflicts: [],
      });
      const conflictingHealthBatch: HealthImportBatchRequest = {
        ...firstHealthBatch,
        batchId: randomUUID(),
        nextSourceCursor: "retention-anchor-0002",
        records: [{ ...firstHealthRecord, value: "72.250" }],
        sourceCursor: firstHealthBatch.nextSourceCursor,
      };
      const conflictHealthResponse = await injectSignedHealthBatch(conflictingHealthBatch);
      expect(conflictHealthResponse.statusCode, conflictHealthResponse.body).toBe(201);
      expect(conflictHealthResponse.json<HealthImportBatchResponse>().data).toMatchObject({
        accepted: 0,
        conflicts: [
          {
            code: "SOURCE_ID_REUSED",
            currentRevision: "1",
            externalId: platformExternalId,
            submittedRevision: "1",
          },
        ],
      });

      // These narrowly scoped database fixtures cover compatibility-only owner barcode, legacy
      // nutrient, and redacted audit export tables that have no current mutation route. Their data
      // is synthetic and remains confined to this per-test scratch schema.
      const customFoodCatalogue = await database
        .selectFrom("custom_food")
        .select(["food_id", "current_food_version_id"])
        .where("id", "=", customFood.id)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      const customFoodServing = await database
        .selectFrom("food_serving")
        .select("id")
        .where("food_version_id", "=", customFoodCatalogue.current_food_version_id)
        .executeTakeFirstOrThrow();
      const scratchBarcode = await database
        .insertInto("food_barcode")
        .values({
          food_id: customFoodCatalogue.food_id,
          food_serving_id: customFoodServing.id,
          food_version_id: customFoodCatalogue.current_food_version_id,
          gtin: "012345678905",
          market_code: "US",
          metadata: { fixture: "retention-privacy-drill-only" },
          source_release_id: null,
          valid_from: clock,
          valid_to: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await database
        .insertInto("diary_entry_nutrient_snapshot")
        .values({
          amount: "123.45",
          calculation_version: "retention-privacy-drill-legacy-v1",
          diary_entry_id: diaryEntryId,
          nutrient_id: energyNutrient.id,
          provenance: { fixture: "retention-privacy-drill-only" },
          unit: "kcal",
        })
        .execute();
      const recipeLogResponse = await app.inject({
        method: "POST",
        url: `/v1/recipes/${recipe.id}/log`,
        headers: { authorization, "idempotency-key": randomUUID() },
        payload: {
          mealSlot: "dinner",
          occurredAt: `${diaryLocalDate}T12:00:00.000Z`,
          portion: { amount: "1", kind: "serving" },
          position: 1_000,
          recipeVersionId: recipe.currentVersion.id,
        },
      });
      expect(recipeLogResponse.statusCode, recipeLogResponse.body).toBe(201);
      const recipeDiaryEntry = recipeLogResponse.json<DiaryMutationResponse>().data.entry;
      if (recipeDiaryEntry?.entryKind !== "recipe") {
        throw new Error("Expected a logged recipe diary entry");
      }
      expect(recipeDiaryEntry.sources).toHaveLength(1);
      diaryEntryIds.push(recipeDiaryEntry.id);
      expect(
        await database
          .selectFrom("diary_entry_revision_source as source")
          .innerJoin(
            "diary_entry_revision as revision",
            "revision.id",
            "source.diary_entry_revision_id",
          )
          .select(["source.food_source_id", "source.source_release_id"])
          .where("revision.diary_entry_id", "=", recipeDiaryEntry.id)
          .execute(),
      ).toEqual([
        {
          food_source_id: publicRecipeFood.sourceId,
          source_release_id: publicRecipeFood.releaseId,
        },
      ]);
      const auditPrivateStateSentinel = `audit-private-state-${randomUUID()}`;
      const auditPrivateRequestId = `audit-private-request-${randomUUID()}`;
      const auditPrivateSourceIp = "192.0.2.10";
      const auditPrivateUserAgent = `audit-private-agent-${randomUUID()}`;
      const auditRedactionSentinels = [
        auditPrivateStateSentinel,
        auditPrivateRequestId,
        auditPrivateSourceIp,
        auditPrivateUserAgent,
      ] as const;
      await database
        .insertInto("audit_log")
        .values({
          action: "retention-privacy-drill",
          actor_user_id: userId,
          after_state: { privateFixture: auditPrivateStateSentinel },
          before_state: null,
          context: { internalRequest: auditPrivateStateSentinel },
          entity_id: userId,
          entity_type: "user",
          reason: "synthetic",
          request_id: auditPrivateRequestId,
          sensitivity: "health",
          source_ip: auditPrivateSourceIp,
          subject_user_id: userId,
          user_agent: auditPrivateUserAgent,
        })
        .execute();

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
      expect(expectedDiaryRevisions).toHaveLength(49);
      expect(expectedDiaryNutrients).toHaveLength(98);
      expect(expectedDiarySources).toHaveLength(1);
      expect(expectedDiaryOperations).toHaveLength(49);

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
      const biometricEventId = biometricEventResponse.json<{
        data: { event: { id: string } };
      }>().data.event.id;
      const biometricDefinitionOperationId = randomUUID();
      const biometricEventOperationId = randomUUID();
      await database
        .insertInto("biometric_definition_operation")
        .values({
          client_operation_id: biometricDefinitionOperationId,
          definition_id: biometricDefinitionId,
          operation: "create",
          request_digest: sha256("retention-biometric-definition-operation"),
          result_payload: { definitionId: biometricDefinitionId },
          user_id: userId,
        })
        .execute();
      await database
        .insertInto("biometric_event_operation")
        .values({
          client_operation_id: biometricEventOperationId,
          event_id: biometricEventId,
          operation: "create",
          request_digest: sha256("retention-biometric-event-operation"),
          result_payload: { eventId: biometricEventId },
          user_id: userId,
        })
        .execute();

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
      await pollRetentionWorkerOnce("seed_export");
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
        ["diary_entry", 46],
        ["diary_entry_legacy_nutrient", 1],
        ["diary_entry_nutrient", 98],
        ["diary_entry_revision", 49],
        ["diary_entry_source", 1],
        ["diary_operation", 49],
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
          expect(parsed.entities.biometric_definition).toHaveLength(2);
          expect(parsed.entities.biometric_definition_version).toHaveLength(2);
          expect(parsed.entities.biometric_event).toHaveLength(2);
          expect(parsed.entities.biometric_event_revision).toHaveLength(2);
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
          expect(occurrenceCount(diaryRevisionCsv, '""note"":null')).toBe(48);
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

      const seedExportExpiresAt = completedExport.expiresAt;
      if (!seedExportExpiresAt) throw new Error("Expected the seed export to have an expiry");
      clock = new Date(Date.parse(seedExportExpiresAt) + 1_000);
      await pollRetentionWorkerOnce("seed_artifact_expiry");
      expect(events).toContainEqual({
        event: "retention.export_artifact.expired",
        jobId: requestedExport.id,
        level: "info",
      });
      const seedLifecycleCounts = {
        privacy_export_artifact: (
          await database
            .selectFrom("privacy_export_artifact as artifact")
            .innerJoin("privacy_export_job as job", "job.id", "artifact.job_id")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("job.user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).count,
        privacy_export_artifact_deletion: (
          await database
            .selectFrom("privacy_export_artifact_deletion as deletion")
            .innerJoin("privacy_export_artifact as artifact", "artifact.id", "deletion.artifact_id")
            .innerJoin("privacy_export_job as job", "job.id", "artifact.job_id")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("job.user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).count,
        privacy_export_artifact_tombstone: (
          await database
            .selectFrom("privacy_export_artifact_tombstone as tombstone")
            .innerJoin("privacy_export_job as job", "job.id", "tombstone.job_id")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("job.user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).count,
        privacy_export_download_audit: (
          await database
            .selectFrom("privacy_export_download_audit")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).count,
        privacy_export_job: (
          await database
            .selectFrom("privacy_export_job")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).count,
      };
      expect(seedLifecycleCounts).toEqual({
        privacy_export_artifact: "1",
        privacy_export_artifact_deletion: "1",
        privacy_export_artifact_tombstone: "1",
        privacy_export_download_audit: "2",
        privacy_export_job: "1",
      });

      const measuredExportProof = await app.inject({
        method: "POST",
        url: "/v1/auth/reauthenticate",
        headers: { authorization },
        payload: { password, purpose: "account_export" },
      });
      expect(measuredExportProof.statusCode, measuredExportProof.body).toBe(200);
      const measuredExportProofToken = measuredExportProof.json<{
        data: { reauthenticationToken: string };
      }>().data.reauthenticationToken;
      const measuredExportRequest = await app.inject({
        method: "POST",
        url: "/v1/exports",
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "x-reauthentication-token": measuredExportProofToken,
        },
        payload: { formats: ["json", "csv"] },
      });
      expect(measuredExportRequest.statusCode, measuredExportRequest.body).toBe(202);
      const requestedMeasuredExport =
        measuredExportRequest.json<AccountExportResponse>().data.export;
      expect(requestedMeasuredExport.status).toBe("queued");

      const expectedMeasuredBoundaryIds: Partial<Record<PrivacyExportEntity, readonly string[]>> = {
        account: [userId],
        custom_food: [customFood.id, proteinFood.id],
        custom_food_catalogue_barcode: [scratchBarcode.id],
        device: [device.id],
        diary_entry: expectedDiaryEntries.map((row) => row.id),
        nutrition_goal: [goal.id],
        nutrition_goal_version: [goal.currentVersion.id],
        platform_import_batch: [firstHealthBatch.batchId, conflictingHealthBatch.batchId],
        privacy_export_job: [requestedExport.id],
        profile: [userId],
        recipe: [recipe.id],
        recipe_version: [recipe.currentVersion.id],
        reminder_schedule: [reminder.id],
        security_challenge: [challenge.id],
        user_watermark: [userId],
      };
      const directBoundaryQueries = {
        biometric_definition: await database
          .selectFrom("biometric_definition")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        biometric_definition_version: await database
          .selectFrom("biometric_definition_version")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        biometric_definition_operation: (
          await database
            .selectFrom("biometric_definition_operation")
            .select(["client_operation_id", "operation"])
            .where("user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.client_operation_id}:${row.operation}` })),
        biometric_event: await database
          .selectFrom("biometric_event")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        biometric_event_revision: await database
          .selectFrom("biometric_event_revision")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        biometric_event_operation: (
          await database
            .selectFrom("biometric_event_operation")
            .select(["client_operation_id", "operation"])
            .where("user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.client_operation_id}:${row.operation}` })),
        audit_event: await database
          .selectFrom("audit_log")
          .select("id")
          .where((builder) =>
            builder.or([
              builder("subject_user_id", "=", userId),
              builder("actor_user_id", "=", userId),
            ]),
          )
          .execute(),
        custom_food_catalogue_food: await database
          .selectFrom("food")
          .select("id")
          .where("owner_user_id", "=", userId)
          .execute(),
        custom_food_catalogue_version: await database
          .selectFrom("food_version as version")
          .innerJoin("food as owner", "owner.id", "version.food_id")
          .select("version.id as id")
          .where("owner.owner_user_id", "=", userId)
          .execute(),
        custom_food_catalogue_serving: await database
          .selectFrom("food_serving as serving")
          .innerJoin("food_version as version", "version.id", "serving.food_version_id")
          .innerJoin("food as owner", "owner.id", "version.food_id")
          .select("serving.id as id")
          .where("owner.owner_user_id", "=", userId)
          .execute(),
        custom_food_catalogue_nutrient: (
          await database
            .selectFrom("food_nutrient_value as nutrient")
            .innerJoin("food_version as version", "version.id", "nutrient.food_version_id")
            .innerJoin("food as owner", "owner.id", "version.food_id")
            .select(["nutrient.food_version_id", "nutrient.nutrient_id"])
            .where("owner.owner_user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.food_version_id}:${row.nutrient_id}` })),
        custom_food_version: (
          await database
            .selectFrom("custom_food_version as version")
            .innerJoin("custom_food as owner", "owner.id", "version.custom_food_id")
            .select(["version.custom_food_id", "version.food_version_id"])
            .where("owner.user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.custom_food_id}:${row.food_version_id}` })),
        custom_food_nutrient: (
          await database
            .selectFrom("custom_food_version_nutrient as nutrient")
            .innerJoin("custom_food as owner", "owner.id", "nutrient.custom_food_id")
            .select(["nutrient.custom_food_id", "nutrient.food_version_id", "nutrient.nutrient_id"])
            .where("owner.user_id", "=", userId)
            .execute()
        ).map((row) => ({
          id: `${row.custom_food_id}:${row.food_version_id}:${row.nutrient_id}`,
        })),
        custom_food_operation: (
          await database
            .selectFrom("custom_food_operation")
            .select(["client_operation_id", "operation"])
            .where("user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.client_operation_id}:${row.operation}` })),
        diary_day: [{ id: diaryId }],
        diary_entry_legacy_nutrient: [{ id: `${diaryEntryId}:${energyNutrient.id}` }],
        diary_entry_nutrient: expectedDiaryExportIds.nutrients.map((id) => ({ id })),
        diary_entry_revision: expectedDiaryExportIds.revisions.map((id) => ({ id })),
        diary_entry_source: expectedDiaryExportIds.sources.map((id) => ({ id })),
        diary_operation: expectedDiaryExportIds.operations.map((id) => ({ id })),
        nutrition_goal_target: (
          await database
            .selectFrom("nutrition_goal_target as target")
            .innerJoin(
              "nutrition_goal_version as version",
              "version.id",
              "target.nutrition_goal_version_id",
            )
            .select(["target.nutrition_goal_version_id", "target.nutrient_id"])
            .where("version.user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.nutrition_goal_version_id}:${row.nutrient_id}` })),
        nutrition_goal_operation: (
          await database
            .selectFrom("nutrition_goal_operation")
            .select(["client_operation_id", "operation"])
            .where("user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.client_operation_id}:${row.operation}` })),
        platform_health_import: await database
          .selectFrom("platform_health_import")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        platform_health_import_conflict: await database
          .selectFrom("platform_health_import_conflict")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        platform_health_import_revision: await database
          .selectFrom("platform_health_import_revision")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        platform_import_batch: await database
          .selectFrom("platform_import_batch")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        platform_integration: await database
          .selectFrom("platform_integration")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        platform_integration_version: await database
          .selectFrom("platform_integration_version")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        privacy_export_artifact: await database
          .selectFrom("privacy_export_artifact as artifact")
          .innerJoin("privacy_export_job as job", "job.id", "artifact.job_id")
          .select("artifact.id")
          .where("job.user_id", "=", userId)
          .where("job.id", "=", requestedExport.id)
          .execute(),
        privacy_export_artifact_deletion: await database
          .selectFrom("privacy_export_artifact_deletion as deletion")
          .innerJoin("privacy_export_artifact as artifact", "artifact.id", "deletion.artifact_id")
          .innerJoin("privacy_export_job as job", "job.id", "artifact.job_id")
          .select("deletion.artifact_id as id")
          .where("job.user_id", "=", userId)
          .where("job.id", "=", requestedExport.id)
          .execute(),
        privacy_export_artifact_tombstone: await database
          .selectFrom("privacy_export_artifact_tombstone")
          .select("artifact_id as id")
          .where("job_id", "=", requestedExport.id)
          .execute(),
        privacy_export_download_audit: await database
          .selectFrom("privacy_export_download_audit")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        reauthentication_proof: await database
          .selectFrom("reauthentication_proof")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        recipe_ingredient: await database
          .selectFrom("recipe_ingredient as ingredient")
          .innerJoin("recipe_version as version", "version.id", "ingredient.recipe_version_id")
          .select("ingredient.id")
          .where("version.owner_user_id", "=", userId)
          .execute(),
        recipe_nutrient: (
          await database
            .selectFrom("recipe_version_nutrient as nutrient")
            .innerJoin("recipe_version as version", "version.id", "nutrient.recipe_version_id")
            .select(["nutrient.recipe_version_id", "nutrient.nutrient_id"])
            .where("version.owner_user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.recipe_version_id}:${row.nutrient_id}` })),
        recipe_source: (
          await database
            .selectFrom("recipe_version_source as source")
            .innerJoin("recipe_version as version", "version.id", "source.recipe_version_id")
            .select([
              "source.recipe_version_id",
              "source.food_source_id",
              "source.source_release_id",
            ])
            .where("version.owner_user_id", "=", userId)
            .execute()
        ).map((row) => ({
          id: `${row.recipe_version_id}:${row.food_source_id}:${row.source_release_id}`,
        })),
        recipe_operation: (
          await database
            .selectFrom("recipe_operation")
            .select(["client_operation_id", "operation"])
            .where("user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.client_operation_id}:${row.operation}` })),
        reminder_consent: await database
          .selectFrom("reminder_consent")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        reminder_consent_version: await database
          .selectFrom("reminder_consent_version")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        reminder_delivery: await database
          .selectFrom("reminder_delivery_outbox")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        reminder_schedule_version: await database
          .selectFrom("reminder_schedule_version")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
        retention_operation: (
          await database
            .selectFrom("retention_operation")
            .select(["client_operation_id", "feature", "operation"])
            .where("user_id", "=", userId)
            .execute()
        ).map((row) => ({ id: `${row.client_operation_id}:${row.feature}:${row.operation}` })),
        session: await database
          .selectFrom("user_session")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
      };
      for (const [entity, rows] of Object.entries(directBoundaryQueries) as [
        PrivacyExportEntity,
        readonly { readonly id: string }[],
      ][]) {
        expectedMeasuredBoundaryIds[entity] = rows.map((row) => row.id);
      }
      expect(Object.keys(expectedMeasuredBoundaryIds).sort()).toEqual(
        [...EXPECTED_PRIVACY_EXPORT_ENTITIES].sort(),
      );

      await pollRetentionWorkerOnce("measured_export");
      const measuredStatusResponse = await app.inject({
        method: "GET",
        url: `/v1/exports/${requestedMeasuredExport.id}`,
        headers: { authorization },
      });
      expect(measuredStatusResponse.statusCode, measuredStatusResponse.body).toBe(200);
      const measuredExport = measuredStatusResponse.json<AccountExportResponse>().data.export;
      expect(measuredExport).toMatchObject({
        status: "completed",
        reconciliation: { reconciled: true },
      });
      const measuredReconciliation = measuredExport.reconciliation;
      if (!measuredReconciliation) throw new Error("Expected measured export reconciliation");
      expect(measuredReconciliation.entities.map((entity) => entity.entity).sort()).toEqual(
        [...EXPECTED_PRIVACY_EXPORT_ENTITIES].sort(),
      );
      for (const entity of measuredReconciliation.entities) {
        expect(entity.sourceCount, entity.entity).toBeGreaterThan(0);
        expect(entity.exportedCount, entity.entity).toBe(entity.sourceCount);
      }

      const persistedMeasuredExport = await getPrivacyExportJob(database, {
        jobId: requestedMeasuredExport.id,
        userId,
      });
      const measuredMetadata: EncryptedArtifactMetadata[] = persistedMeasuredExport.artifacts.map(
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
      let measuredJson:
        | {
            readonly entities: Record<PrivacyExportEntity, readonly ExportEntityRow[]>;
            readonly manifest: Parameters<typeof canonicalJson>[0];
          }
        | undefined;
      let measuredZipEntries: ReadonlyMap<string, Buffer> | undefined;
      for (const artifact of measuredExport.artifacts) {
        const download = await app.inject({
          method: "GET",
          url: artifact.downloadPath,
          headers: { authorization },
        });
        expect(download.statusCode, download.body).toBe(200);
        expect(download.headers["cache-control"]).toBe("no-store");
        expect(download.rawPayload.byteLength).toBe(
          exactNumber(artifact.byteLength, "measured download byteLength"),
        );
        expect(sha256(download.rawPayload)).toBe(artifact.sha256);
        if (artifact.format === "json") {
          const rawJson = download.rawPayload.toString("utf8");
          measuredJson = JSON.parse(rawJson) as typeof measuredJson;
          if (!measuredJson) throw new Error("Expected measured JSON export");
          expect(rawJson).toBe(
            `${canonicalJson(measuredJson as unknown as Parameters<typeof canonicalJson>[0])}\n`,
          );
          expect(rawJson).not.toContain(crossOwnerUserId);
          expect(sha256(canonicalJson(measuredJson.manifest))).toBe(measuredExport.manifestSha256);
        } else {
          measuredZipEntries = storedZipEntries(download.rawPayload);
        }
        await vi.waitFor(async () => expect(await readdir(apiSpoolDirectory)).toEqual([]), {
          interval: 10,
          timeout: 2_000,
        });
      }
      if (!measuredJson || !measuredZipEntries) {
        throw new Error("Expected measured JSON and CSV export artifacts");
      }
      const measuredCsvText = [...measuredZipEntries.values()]
        .map((bytes) => bytes.toString("utf8"))
        .join("\n");
      expect(measuredCsvText).not.toContain(crossOwnerUserId);
      expect(Object.keys(measuredJson.entities).sort()).toEqual(
        [...EXPECTED_PRIVACY_EXPORT_ENTITIES].sort(),
      );
      for (const entity of EXPECTED_PRIVACY_EXPORT_ENTITIES) {
        const reconciliation = measuredReconciliation.entities.find(
          (candidate) => candidate.entity === entity,
        );
        if (!reconciliation) throw new Error(`Missing reconciliation for ${entity}`);
        const jsonIds = measuredJson.entities[entity].map((row) => row.entityId);
        expect(jsonIds, entity).toHaveLength(reconciliation.sourceCount);
        expect(new Set(jsonIds).size, entity).toBe(jsonIds.length);
        expectExactEntityIds(
          csvEntityIds(requiredZipEntry(measuredZipEntries, `entities/${entity}/part-000001.csv`)),
          jsonIds,
          `${entity} CSV IDs`,
        );
        const expectedIds = expectedMeasuredBoundaryIds[entity];
        if (!expectedIds) throw new Error(`Missing independent expected IDs for ${entity}`);
        expectExactEntityIds(jsonIds, expectedIds, `${entity} independent IDs`);
      }
      const redactedAuditFields = [
        "actor_user_id",
        "subject_user_id",
        "source_ip",
        "request_id",
        "user_agent",
        "before_state",
        "after_state",
        "context",
      ] as const;
      for (const row of measuredJson.entities.audit_event) {
        for (const field of redactedAuditFields) {
          expect(row.payload, `audit ${row.entityId} must redact ${field}`).not.toHaveProperty(
            field,
          );
        }
      }
      const measuredAuditJson = JSON.stringify(measuredJson.entities.audit_event);
      const measuredAuditCsv = [...measuredZipEntries.entries()]
        .filter(([name]) => name.startsWith("entities/audit_event/") && name.endsWith(".csv"))
        .map(([, bytes]) => bytes.toString("utf8"))
        .join("\n");
      expect(measuredAuditCsv.length).toBeGreaterThan(0);
      for (const field of redactedAuditFields) {
        expect(measuredAuditCsv, `audit CSV must redact ${field}`).not.toContain(`""${field}""`);
      }
      for (const sentinel of auditRedactionSentinels) {
        expect(measuredAuditJson).not.toContain(sentinel);
        expect(measuredAuditCsv).not.toContain(sentinel);
      }
      expect(measuredJson.entities.account[0]?.payload).not.toHaveProperty("auth_subject");
      expect(measuredJson.entities.device[0]?.payload).not.toHaveProperty("public_key_spki_base64");
      expect(measuredJson.entities.platform_import_batch[0]?.payload).not.toHaveProperty(
        "nonce_hash",
      );
      expect(measuredJson.entities.privacy_export_artifact[0]?.payload).not.toHaveProperty(
        "object_key",
      );
      expect(measuredJson.entities.privacy_export_artifact[0]?.payload).not.toHaveProperty(
        "encryption_key_id",
      );
      expect(measuredJson.entities.privacy_export_artifact[0]?.payload).not.toHaveProperty(
        "ciphertext_bytes",
      );
      expect(measuredJson.entities.privacy_export_artifact_deletion[0]?.payload).not.toHaveProperty(
        "deletion_evidence_digest",
      );
      expect(
        measuredJson.entities.privacy_export_artifact_tombstone[0]?.payload,
      ).not.toHaveProperty("deletion_evidence_digest");
      expect(measuredJson.entities.reauthentication_proof[0]?.payload).not.toHaveProperty(
        "token_hash",
      );
      expect(measuredJson.entities.session[0]?.payload).not.toHaveProperty("token_hash");

      const excludedOwnerRowsBeforeErasure = {
        auth_action_token: (
          await database
            .selectFrom("auth_action_token")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).count,
        user_password_credential: (
          await database
            .selectFrom("user_password_credential")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("user_id", "=", userId)
            .executeTakeFirstOrThrow()
        ).count,
      };
      expect(excludedOwnerRowsBeforeErasure).toEqual({
        auth_action_token: "2",
        user_password_credential: "1",
      });

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
      await pollRetentionWorkerOnce("account_erasure");
      expect(workerPollSequence).toEqual([
        "seed_export",
        "seed_artifact_expiry",
        "measured_export",
        "account_erasure",
      ]);
      expect(events).toContainEqual({
        event: "retention.erasure.completed",
        jobId: queuedErasure.erasure.id,
        level: "info",
      });
      expect(events.filter((event) => event.level === "warn")).toEqual([]);
      expect(events.filter((event) => event.event === "worker.poll.slice_failed")).toEqual([]);

      const crossOwnerMeAfterErasure = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: crossOwnerAuthorization },
      });
      expect(crossOwnerMeAfterErasure.statusCode, crossOwnerMeAfterErasure.body).toBe(200);
      expect(crossOwnerMeAfterErasure.headers["cache-control"]).toBe("no-store");
      expect(crossOwnerMeAfterErasure.json<CurrentAccountResponse>().data.user.id).toBe(
        crossOwnerUserId,
      );
      expect(
        await database
          .selectFrom("app_user")
          .select("id")
          .where("id", "=", crossOwnerUserId)
          .execute(),
      ).toEqual([{ id: crossOwnerUserId }]);

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

      for (const metadata of [...persistedMetadata, ...measuredMetadata]) {
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
      expect(
        await database
          .selectFrom("auth_action_token")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom("user_password_credential")
          .select("user_id")
          .where("user_id", "=", userId)
          .execute(),
      ).toEqual([]);
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
      expect(await readdir(workerSpoolDirectory)).toEqual(["search-rebuild"]);
      const searchRebuildSpoolDirectory = `${workerSpoolDirectory}/search-rebuild`;
      expect((await lstat(searchRebuildSpoolDirectory)).mode & 0o777).toBe(0o700);
      expect(await readdir(searchRebuildSpoolDirectory)).toEqual([]);
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
        await attemptCleanup(cleanupErrors, "discover export objects", async () => {
          const [staged, finalized] = await Promise.all([
            database.selectFrom("privacy_export_upload_artifact").select("object_key").execute(),
            database.selectFrom("privacy_export_artifact").select("object_key").execute(),
          ]);
          for (const artifact of [...staged, ...finalized]) {
            if (artifact.object_key) trackedExportObjects.add(artifact.object_key);
          }
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
