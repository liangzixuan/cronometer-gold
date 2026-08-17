import { createHash, createHmac } from "node:crypto";

import {
  ArtifactReadRateLimitedError,
  ArtifactReadUnavailableError,
  deriveErasureLedgerLocator,
  type EncryptedArtifactMetadata,
  type ErasureLedgerLocatorKeyRing,
} from "@nutrition-tracker/artifact-store";
import type {
  AccountErasureJob,
  AccountExportJob,
  BiometricDefinition,
  BiometricEvent,
  CustomFood,
  DiaryMutationResponse,
  HealthDevice,
  PlatformIntegration,
  Reminder,
} from "@nutrition-tracker/contracts";
import { canonicalJson } from "@nutrition-tracker/contracts";
import {
  applyPlatformHealthImportBatch,
  archiveBiometricDefinition,
  archiveCustomFood,
  type BiometricDefinitionRecord,
  type BiometricEventRecord,
  type CustomFoodRecord,
  consentPlatformIntegration,
  createBiometricDefinition,
  createCustomFood,
  type createDatabaseFromEnvironment,
  createDeviceChallenge,
  createFoodDiaryEntry,
  createPrivacyExportJob,
  createReminderSchedule,
  type DeviceRegistrationRecord,
  DiaryIdempotencyConflictError,
  DiaryLockedError,
  DiaryNotFoundError,
  DiaryValidationError,
  deleteBiometricEvent,
  disconnectPlatformIntegration,
  getAccountErasureByCapability,
  getAccountErasureJob,
  getActiveDeviceRegistration,
  getBiometricTrends,
  getCustomFood,
  getNutrientTrend,
  getPrivacyExportJob,
  listBiometricDefinitions,
  listBiometricEvents,
  listCustomFoods,
  listPlatformIntegrations,
  listReminderSchedules,
  type PlatformIntegrationRecord,
  type PrivacyExportJobRecord,
  type ReminderScheduleRecord,
  RetentionConsentRequiredError,
  RetentionExportInProgressError,
  RetentionExportNotReadyError,
  RetentionIdempotencyConflictError,
  RetentionImportConflictError,
  RetentionNotFoundError,
  RetentionRevisionConflictError,
  RetentionValidationError,
  rebindPlatformIntegration,
  recordBiometricEvent,
  recordPrivacyExportArtifactDownloadAudit,
  registerDevice,
  repeatDiaryEntry,
  requestAccountErasure,
  reviseBiometricDefinition,
  reviseBiometricEvent,
  reviseCustomFood,
  reviseReminderSchedule,
  revokeDevice,
  revokeReminderSchedule,
  type TrendNutrientRecord,
} from "@nutrition-tracker/db";
import { verifyP256DerSignature } from "./modules/retention/device-signatures.js";
import {
  RetentionConsentRequiredServiceError,
  RetentionDeviceAuthenticationServiceError,
  RetentionDownloadRateLimitedServiceError,
  RetentionDownloadUnavailableServiceError,
  RetentionExportInProgressServiceError,
  RetentionExportNotReadyServiceError,
  RetentionIdempotencyConflictServiceError,
  RetentionImportConflictServiceError,
  RetentionNotFoundServiceError,
  RetentionRecentAuthenticationServiceError,
  RetentionRevisionConflictServiceError,
  type RetentionService,
  RetentionValidationServiceError,
} from "./modules/retention/retention.routes.js";
import { mapDiaryEntryRecord } from "./persistence-services.js";
import type { ApiRetentionArtifactRuntime } from "./retention-artifact-runtime.js";

type AppDatabase = ReturnType<typeof createDatabaseFromEnvironment>;
const EMPTY_REASON_COUNTS = {
  not_analyzed: 0,
  not_applicable: 0,
  not_reported: 0,
  withheld: 0,
} as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(key: Uint8Array, value: string): string {
  return createHmac("sha256", Buffer.from(key)).update(value, "utf8").digest("base64url");
}

function safeCount(value: unknown): number {
  const result = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(result) || (result as number) < 0) throw new TypeError("Invalid count");
  return result as number;
}

function aggregate(record: TrendNutrientRecord) {
  return {
    code: record.code,
    completeness: record.completeness,
    contributorCount: record.contributorCount,
    isExact: record.isExact,
    knownAmount: record.knownAmount,
    name: record.name,
    nutrientId: record.nutrientId,
    quantifiedCount: record.quantifiedCount,
    traceCount: record.traceCount,
    unit: record.unit,
    unknownCount: record.unknownCount,
    unknownReasonCounts: { ...EMPTY_REASON_COUNTS, ...record.unknownReasons },
  };
}

function customFood(record: CustomFoodRecord): CustomFood {
  const versionNumber = safeCount(record.currentVersion.versionNumber);
  if (versionNumber < 1) throw new TypeError("Invalid custom-food version");
  return {
    createdAt: record.createdAt,
    currentVersion: {
      brandName: record.currentVersion.brandName,
      createdAt: record.currentVersion.createdAt,
      id: record.currentVersion.id,
      name: record.currentVersion.name,
      notes: record.currentVersion.notes,
      nutrients: record.currentVersion.nutrients.map((item) => {
        const base = { nutrient: item.nutrient };
        if (item.state === "quantified") {
          if (item.amountPer100Grams === null || item.reason !== null)
            throw new TypeError("Invalid quantified custom nutrient");
          return {
            ...base,
            amountPer100Grams: item.amountPer100Grams,
            state: "quantified" as const,
          };
        }
        if (item.state === "trace") {
          if (item.amountPer100Grams !== null || item.reason !== null)
            throw new TypeError("Invalid trace custom nutrient");
          return { ...base, amountPer100Grams: null, state: "trace" as const };
        }
        if (item.amountPer100Grams !== null || item.reason === null)
          throw new TypeError("Invalid unknown custom nutrient");
        return { ...base, amountPer100Grams: null, reason: item.reason, state: "unknown" as const };
      }),
      provenance: { kind: "user_entered", statement: "Entered by the account owner." },
      serving: record.currentVersion.serving,
      versionNumber,
    },
    id: record.id,
    revision: record.currentRevision,
    status: record.status,
    updatedAt: record.updatedAt,
  };
}

function definition(record: BiometricDefinitionRecord): BiometricDefinition {
  return {
    canonicalUnit: record.currentVersion.canonicalUnit,
    createdAt: record.createdAt,
    dimension: record.currentVersion.dimension,
    id: record.id,
    name: record.currentVersion.name,
    notes: record.currentVersion.notes,
    revision: record.currentRevision,
    status: record.status,
    updatedAt: record.updatedAt,
  };
}

function biometricEvent(record: BiometricEventRecord): BiometricEvent {
  const provider = record.source.provider;
  const kind =
    record.source.kind === "manual"
      ? "manual"
      : provider === "apple_healthkit" || provider === "android_health_connect"
        ? provider
        : null;
  if (kind === null) throw new TypeError("Unsupported biometric event source");
  if (
    (kind === "manual" && record.source.deviceId !== null) ||
    (kind !== "manual" && record.source.deviceId === null)
  ) {
    throw new TypeError("Biometric event source-device provenance is incomplete");
  }
  return {
    createdAt: record.createdAt,
    definitionId: record.definition.id,
    id: record.id,
    localDate: record.localDate,
    measuredAt: record.measuredAt,
    revision: record.currentRevision,
    source: {
      deviceId: record.source.deviceId,
      externalId: record.source.externalSourceId,
      externalRevision: record.source.externalRevision,
      kind,
    },
    timeZone: record.timeZone,
    updatedAt: record.updatedAt,
    value: record.value,
  };
}

function reminder(record: ReminderScheduleRecord): Reminder {
  return {
    channel: record.channel,
    consent: record.consent,
    createdAt: record.createdAt,
    daysOfWeek: record.daysOfWeek,
    deliveryPolicy: record.deliveryPolicy,
    id: record.id,
    label: record.label,
    localTime: record.localTime,
    revision: record.currentRevision,
    status: record.status,
    timeZone: record.timeZone,
    updatedAt: record.updatedAt,
  };
}

function device(record: DeviceRegistrationRecord): HealthDevice {
  return {
    attestationStatus: record.attestationStatus,
    displayName: record.displayName,
    id: record.id,
    keyFingerprint: record.keyFingerprint,
    platform: record.platform,
    registeredAt: record.createdAt,
    revision: record.revision,
    revokedAt: record.revokedAt,
    status: record.status,
  };
}

function integration(record: PlatformIntegrationRecord): PlatformIntegration {
  return {
    consentGrantedAt: record.consentGrantedAt,
    consentHistory: record.consentHistory,
    cursorEpoch: record.cursorEpoch,
    currentSourceCursor: record.currentSourceCursor,
    dataTypeCodes: record.dataTypeCodes,
    deviceId: record.deviceId,
    disconnectedAt: record.disconnectedAt,
    lastImportAt: record.lastImportAt,
    platform: record.platform,
    revision: record.currentRevision,
    status: record.status,
  };
}

function exportReconciliation(
  value: PrivacyExportJobRecord["reconciliation"],
): AccountExportJob["reconciliation"] {
  if (!value) return null;
  const entities = value.entities;
  if (
    !Array.isArray(entities) ||
    value.reconciled !== true ||
    typeof value.snapshotWatermark !== "string"
  ) {
    throw new TypeError("Invalid export reconciliation");
  }
  return {
    entities: entities.map((item) => {
      if (!item || Array.isArray(item) || typeof item !== "object")
        throw new TypeError("Invalid export entity reconciliation");
      const row = item as Record<string, unknown>;
      if (typeof row.entity !== "string" || typeof row.watermarkRevision !== "string")
        throw new TypeError("Invalid export entity reconciliation");
      return {
        entity: row.entity,
        exportedCount: safeCount(row.exportedCount),
        sourceCount: safeCount(row.sourceCount),
        watermark: row.watermarkRevision,
      };
    }),
    reconciled: true,
    snapshotWatermark: value.snapshotWatermark,
  };
}

function exportJob(record: PrivacyExportJobRecord): AccountExportJob {
  return {
    artifacts: record.artifacts.map((artifact) => ({
      byteLength: artifact.plaintextBytes,
      downloadPath: `/v1/exports/${record.id}/artifacts/${artifact.format}`,
      expiresAt: artifact.expiresAt,
      fileName: artifact.fileName,
      format: artifact.format,
      mediaType: artifact.mediaType,
      sha256: artifact.plaintextSha256,
    })),
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    failureCode: record.failureCode,
    formats: record.requestedFormats,
    id: record.id,
    manifestSha256: record.manifestDigest,
    reconciliation: exportReconciliation(record.reconciliation),
    requestedAt: record.createdAt,
    startedAt: record.startedAt,
    status: record.status,
  };
}

function isExpiredExport(record: PrivacyExportJobRecord, now: Date): boolean {
  if (record.status !== "completed") return false;
  if (!record.expiresAt) throw new TypeError("Completed export is missing its expiry");
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new TypeError("Export expiry is invalid");
  return expiresAt <= now.getTime();
}

function erasureJob(record: {
  readonly id: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly requestedAt: string;
  readonly executeAfter: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastErrorCode: string | null;
}): AccountErasureJob {
  return {
    completedAt: record.completedAt,
    consequences: ["ACCOUNT_ACCESS_REVOKED", "PRIVATE_HEALTH_DATA_DELETED", "EXPORT_LINKS_REVOKED"],
    executeAfter: record.executeAfter,
    failureCode: record.status === "failed" ? "ERASURE_FAILED" : null,
    id: record.id,
    recentAuthenticationSatisfied: true,
    requestedAt: record.requestedAt,
    startedAt: record.startedAt,
    status: record.status,
  };
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof RetentionNotFoundError || error instanceof DiaryNotFoundError)
    throw new RetentionNotFoundServiceError();
  if (error instanceof RetentionRevisionConflictError)
    throw new RetentionRevisionConflictServiceError();
  if (
    error instanceof RetentionIdempotencyConflictError ||
    error instanceof DiaryIdempotencyConflictError
  )
    throw new RetentionIdempotencyConflictServiceError();
  if (error instanceof RetentionImportConflictError)
    throw new RetentionImportConflictServiceError();
  if (error instanceof RetentionConsentRequiredError)
    throw new RetentionConsentRequiredServiceError();
  if (error instanceof RetentionExportNotReadyError)
    throw new RetentionExportNotReadyServiceError();
  if (
    error instanceof RetentionValidationError ||
    error instanceof DiaryValidationError ||
    error instanceof DiaryLockedError ||
    error instanceof RangeError
  )
    throw new RetentionValidationServiceError();
  throw error;
}

function operation<T extends { userId: string; clientOperationId: string; requestDigest: string }>(
  input: T,
) {
  return {
    clientOperationId: input.clientOperationId,
    requestDigest: input.requestDigest,
    userId: input.userId,
  };
}

export interface DatabaseRetentionServiceOptions {
  readonly database: AppDatabase;
  readonly artifacts: ApiRetentionArtifactRuntime;
  readonly deviceChallengeHmacKey: Uint8Array;
  readonly erasureStatusCapabilityHmacKey: Uint8Array;
  readonly erasureLedgerLocatorKeyRing: ErasureLedgerLocatorKeyRing;
  readonly clock?: () => Date;
}

export class DatabaseRetentionService implements RetentionService {
  readonly #database: AppDatabase;
  readonly #artifacts: ApiRetentionArtifactRuntime;
  readonly #deviceChallengeHmacKey: Uint8Array;
  readonly #erasureStatusCapabilityHmacKey: Uint8Array;
  readonly #erasureLedgerLocatorKeyRing: ErasureLedgerLocatorKeyRing;
  readonly #clock: () => Date;

  constructor(options: DatabaseRetentionServiceOptions) {
    this.#database = options.database;
    this.#artifacts = options.artifacts;
    this.#deviceChallengeHmacKey = options.deviceChallengeHmacKey;
    this.#erasureStatusCapabilityHmacKey = options.erasureStatusCapabilityHmacKey;
    this.#erasureLedgerLocatorKeyRing = options.erasureLedgerLocatorKeyRing;
    this.#clock = options.clock ?? (() => new Date());
  }

  async nutrientTrend(input: Parameters<RetentionService["nutrientTrend"]>[0]) {
    try {
      const result = await getNutrientTrend(this.#database, {
        userId: input.userId,
        nutrientId: input.nutrientId,
        fromLocalDate: input.from,
        toLocalDate: input.to,
      });
      return {
        data: {
          bucket: "day" as const,
          from: result.fromLocalDate,
          nutrient: {
            id: result.nutrient.nutrientId,
            code: result.nutrient.code,
            name: result.nutrient.name,
            unit: result.nutrient.unit,
          },
          points: result.points.map((point) => ({
            ...point,
            aggregate: point.aggregate ? aggregate(point.aggregate) : null,
          })),
          timeZone: result.timeZone,
          to: result.toLocalDate,
          watermarkRevision: result.watermarkRevision,
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async biometricTrend(input: Parameters<RetentionService["biometricTrend"]>[0]) {
    try {
      const result = await getBiometricTrends(this.#database, {
        userId: input.userId,
        definitionId: input.definitionId,
        fromLocalDate: input.from,
        toLocalDate: input.to,
      });
      return {
        data: {
          bucket: "day" as const,
          definition: definition(result.definition),
          from: result.fromLocalDate,
          points: result.points,
          timeZone: result.timeZone,
          to: result.toLocalDate,
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async repeatEntry(
    input: Parameters<RetentionService["repeatEntry"]>[0],
  ): Promise<DiaryMutationResponse> {
    try {
      const result = await repeatDiaryEntry(this.#database, {
        ...operation(input),
        sourceEntryId: input.sourceEntryId,
        sourceRevision: input.expectedSourceRevision,
        occurredAt: input.request.occurredAt,
        ...(input.request.mealSlot ? { mealSlot: input.request.mealSlot } : {}),
        ...(input.request.position === undefined ? {} : { position: input.request.position }),
      });
      return {
        data: {
          affectedDays: result.days,
          entry: mapDiaryEntryRecord(result.entry),
          replayed: result.replayed,
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async listCustomFoods(input: Parameters<RetentionService["listCustomFoods"]>[0]) {
    try {
      const result = await listCustomFoods(this.#database, {
        userId: input.userId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return { data: result.records.map(customFood), page: { nextCursor: result.nextCursor } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async getCustomFood(input: Parameters<RetentionService["getCustomFood"]>[0]) {
    try {
      return customFood(
        await getCustomFood(this.#database, {
          userId: input.userId,
          customFoodId: input.customFoodId,
        }),
      );
    } catch (error) {
      if (error instanceof RetentionNotFoundError) return null;
      mapPersistenceError(error);
    }
  }
  async createCustomFood(input: Parameters<RetentionService["createCustomFood"]>[0]) {
    try {
      const result = await createCustomFood(this.#database, {
        ...operation(input),
        food: input.draft,
      });
      return { data: { customFood: customFood(result.food), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async reviseCustomFood(input: Parameters<RetentionService["reviseCustomFood"]>[0]) {
    try {
      const result = await reviseCustomFood(this.#database, {
        ...operation(input),
        customFoodId: input.customFoodId,
        expectedRevision: input.expectedRevision,
        food: input.draft,
      });
      return { data: { customFood: customFood(result.food), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async archiveCustomFood(input: Parameters<RetentionService["archiveCustomFood"]>[0]) {
    try {
      const result = await archiveCustomFood(this.#database, {
        ...operation(input),
        customFoodId: input.customFoodId,
        expectedRevision: input.expectedRevision,
      });
      return { data: { customFood: customFood(result.food), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async logCustomFood(
    input: Parameters<RetentionService["logCustomFood"]>[0],
  ): Promise<DiaryMutationResponse> {
    try {
      const result = await createFoodDiaryEntry(this.#database, {
        ...operation(input),
        expectedCustomFoodId: input.customFoodId,
        foodVersionId: input.entry.customFoodVersionId,
        mealSlot: input.entry.mealSlot,
        occurredAt: input.entry.occurredAt,
        portion: input.entry.portion,
        ...(input.entry.position === undefined ? {} : { position: input.entry.position }),
      });
      return {
        data: {
          affectedDays: result.days,
          entry: mapDiaryEntryRecord(result.entry),
          replayed: result.replayed,
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async listBiometricDefinitions(
    input: Parameters<RetentionService["listBiometricDefinitions"]>[0],
  ) {
    try {
      return {
        data: (await listBiometricDefinitions(this.#database, { userId: input.userId })).map(
          definition,
        ),
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async createBiometricDefinition(
    input: Parameters<RetentionService["createBiometricDefinition"]>[0],
  ) {
    try {
      const result = await createBiometricDefinition(this.#database, {
        ...operation(input),
        definition: input.draft,
      });
      return { data: { definition: definition(result.definition), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async reviseBiometricDefinition(
    input: Parameters<RetentionService["reviseBiometricDefinition"]>[0],
  ) {
    try {
      const result = await reviseBiometricDefinition(this.#database, {
        ...operation(input),
        definitionId: input.definitionId,
        expectedRevision: input.expectedRevision,
        definition: input.draft,
      });
      return { data: { definition: definition(result.definition), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async archiveBiometricDefinition(
    input: Parameters<RetentionService["archiveBiometricDefinition"]>[0],
  ) {
    try {
      const result = await archiveBiometricDefinition(this.#database, {
        ...operation(input),
        definitionId: input.definitionId,
        expectedRevision: input.expectedRevision,
      });
      return { data: { definition: definition(result.definition), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async listBiometricEvents(input: Parameters<RetentionService["listBiometricEvents"]>[0]) {
    try {
      const result = await listBiometricEvents(this.#database, {
        userId: input.userId,
        from: input.from,
        to: input.to,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.definitionId ? { definitionId: input.definitionId } : {}),
      });
      return { data: result.records.map(biometricEvent), page: { nextCursor: result.nextCursor } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async createBiometricEvent(input: Parameters<RetentionService["createBiometricEvent"]>[0]) {
    try {
      const result = await recordBiometricEvent(this.#database, {
        ...operation(input),
        definitionId: input.event.definitionId,
        measuredAt: input.event.measuredAt,
        value: input.event.value,
      });
      return {
        data: {
          event: result.event ? biometricEvent(result.event) : null,
          replayed: result.replayed,
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async reviseBiometricEvent(input: Parameters<RetentionService["reviseBiometricEvent"]>[0]) {
    try {
      const result = await reviseBiometricEvent(this.#database, {
        ...operation(input),
        eventId: input.eventId,
        expectedRevision: input.expectedRevision,
        value: input.event.value,
        ...(input.event.measuredAt ? { measuredAt: input.event.measuredAt } : {}),
      });
      return {
        data: {
          event: result.event ? biometricEvent(result.event) : null,
          replayed: result.replayed,
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async deleteBiometricEvent(input: Parameters<RetentionService["deleteBiometricEvent"]>[0]) {
    try {
      const result = await deleteBiometricEvent(this.#database, {
        ...operation(input),
        eventId: input.eventId,
        expectedRevision: input.expectedRevision,
      });
      return {
        data: {
          event: result.event ? biometricEvent(result.event) : null,
          replayed: result.replayed,
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async listReminders(input: Parameters<RetentionService["listReminders"]>[0]) {
    try {
      return {
        data: (await listReminderSchedules(this.#database, { userId: input.userId })).map(reminder),
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async createReminder(input: Parameters<RetentionService["createReminder"]>[0]) {
    try {
      const result = await createReminderSchedule(this.#database, {
        ...operation(input),
        schedule: { ...input.reminder },
      });
      return { data: { reminder: reminder(result.schedule), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async reviseReminder(input: Parameters<RetentionService["reviseReminder"]>[0]) {
    try {
      const result = await reviseReminderSchedule(this.#database, {
        ...operation(input),
        scheduleId: input.reminderId,
        expectedRevision: input.expectedRevision,
        schedule: { channel: "local", ...input.reminder },
      });
      return { data: { reminder: reminder(result.schedule), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async revokeReminder(input: Parameters<RetentionService["revokeReminder"]>[0]) {
    try {
      const result = await revokeReminderSchedule(this.#database, {
        ...operation(input),
        scheduleId: input.reminderId,
        expectedRevision: input.expectedRevision,
      });
      return { data: { reminder: reminder(result.schedule), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async createDeviceChallenge(input: Parameters<RetentionService["createDeviceChallenge"]>[0]) {
    try {
      const raw = token(
        this.#deviceChallengeHmacKey,
        `nutrition-tracker-device-challenge-v1\n${input.userId}\n${input.clientOperationId}\n${input.request.platform}`,
      );
      const result = await createDeviceChallenge(this.#database, {
        ...operation(input),
        expiresAt: new Date(this.#clock().getTime() + 5 * 60_000).toISOString(),
        nonceHash: sha256(raw),
        platform: input.request.platform,
      });
      return {
        replayed: result.replayed,
        response: {
          data: {
            challenge: raw,
            expiresAt: result.challenge.expiresAt,
            id: result.challenge.id,
            platform: result.challenge.platform,
          },
        },
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }

  async registerDevice(input: Parameters<RetentionService["registerDevice"]>[0]) {
    try {
      const result = await registerDevice(this.#database, {
        ...operation(input),
        attestationMetadata: input.request.attestation
          ? { evidenceDigest: sha256(input.request.attestation) }
          : {},
        attestationStatus: input.request.attestation ? "unverified" : "not_provided",
        challengeId: input.request.challengeId,
        displayName: input.request.displayName,
        keyFingerprint: input.verification.keyFingerprint,
        nonceHash: sha256(input.request.challenge),
        platform: input.request.platform,
        proofSignatureDigest: input.verification.proofSignatureDigest,
        publicKeySpkiBase64: input.verification.publicKeySpkiBase64,
      });
      return { data: { device: device(result.device), replayed: result.replayed } };
    } catch (error) {
      if (error instanceof RetentionNotFoundError)
        throw new RetentionDeviceAuthenticationServiceError();
      mapPersistenceError(error);
    }
  }
  async revokeDevice(input: Parameters<RetentionService["revokeDevice"]>[0]) {
    try {
      const result = await revokeDevice(this.#database, {
        ...operation(input),
        deviceId: input.deviceId,
        expectedRevision: input.expectedRevision,
      });
      return { data: { device: device(result.device), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async listPlatformIntegrations(
    input: Parameters<RetentionService["listPlatformIntegrations"]>[0],
  ) {
    try {
      return {
        data: (await listPlatformIntegrations(this.#database, { userId: input.userId })).map(
          integration,
        ),
      };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async consentPlatformIntegration(
    input: Parameters<RetentionService["consentPlatformIntegration"]>[0],
  ) {
    try {
      const result = await consentPlatformIntegration(this.#database, {
        ...operation(input),
        ...input.request,
      });
      return { data: { integration: integration(result.integration), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async disconnectPlatformIntegration(
    input: Parameters<RetentionService["disconnectPlatformIntegration"]>[0],
  ) {
    try {
      const result = await disconnectPlatformIntegration(this.#database, {
        ...operation(input),
        expectedRevision: input.expectedRevision,
        importedDataDisposition: input.request.importedDataDisposition,
        platform: input.platform,
      });
      return { data: { integration: integration(result.integration), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async rebindPlatformIntegration(
    input: Parameters<RetentionService["rebindPlatformIntegration"]>[0],
  ) {
    try {
      const result = await rebindPlatformIntegration(this.#database, {
        ...operation(input),
        deviceId: input.request.deviceId,
        expectedRevision: input.expectedRevision,
        platform: input.platform,
      });
      return { data: { integration: integration(result.integration), replayed: result.replayed } };
    } catch (error) {
      mapPersistenceError(error);
    }
  }
  async importPlatformHealth(input: Parameters<RetentionService["importPlatformHealth"]>[0]) {
    try {
      const registered = await getActiveDeviceRegistration(this.#database, {
        userId: input.userId,
        deviceId: input.request.deviceId,
        platform: input.request.platform,
      }).catch((error: unknown) => {
        if (error instanceof RetentionNotFoundError)
          throw new RetentionDeviceAuthenticationServiceError();
        throw error;
      });
      if (
        !verifyP256DerSignature({
          payload: input.canonicalSignaturePayload,
          publicKeySpkiBase64: registered.publicKeySpkiBase64,
          signatureBase64Url: input.signature,
        })
      )
        throw new RetentionDeviceAuthenticationServiceError();
      if (
        input.request.records.some(
          (record) =>
            record.operation === "upsert" &&
            (record.definitionCode !== "body_weight" || record.unit !== "kg"),
        )
      )
        throw new RetentionValidationServiceError();
      const result = await applyPlatformHealthImportBatch(this.#database, {
        ...operation(input),
        batchDigest: sha256(canonicalJson(input.request)),
        batchId: input.request.batchId,
        cursorEpoch: input.request.cursorEpoch,
        deviceId: input.request.deviceId,
        isTimestampFresh: input.timestampFresh,
        nextSourceCursor: input.request.nextSourceCursor,
        nonceHash: sha256(input.nonce),
        platform: input.request.platform,
        records: input.request.records as Parameters<
          typeof applyPlatformHealthImportBatch
        >[1]["records"],
        signatureDigest: sha256(Buffer.from(input.signature, "base64url")),
        signedAt: input.signedAt,
        sourceCursor: input.request.sourceCursor,
      });
      return { data: result };
    } catch (error) {
      if (
        error instanceof RetentionDeviceAuthenticationServiceError ||
        error instanceof RetentionValidationServiceError
      )
        throw error;
      mapPersistenceError(error);
    }
  }

  async createExport(input: Parameters<RetentionService["createExport"]>[0]) {
    try {
      const result = await createPrivacyExportJob(this.#database, {
        ...operation(input),
        proofTokenHash: sha256(input.reauthenticationToken),
        requestedFormats: input.request.formats,
        sessionTokenHash: input.sessionTokenHash,
      });
      return { data: { export: exportJob(result.job), replayed: result.replayed } };
    } catch (error) {
      if (error instanceof RetentionExportInProgressError)
        throw new RetentionExportInProgressServiceError();
      if (error instanceof RetentionNotFoundError)
        throw new RetentionRecentAuthenticationServiceError();
      mapPersistenceError(error);
    }
  }
  async getExport(input: Parameters<RetentionService["getExport"]>[0]) {
    try {
      const job = await getPrivacyExportJob(this.#database, {
        userId: input.userId,
        jobId: input.exportId,
      });
      if (isExpiredExport(job, this.#clock())) return null;
      return { data: { export: exportJob(job), replayed: false } };
    } catch (error) {
      if (error instanceof RetentionNotFoundError) return null;
      mapPersistenceError(error);
    }
  }
  async getExportArtifact(input: Parameters<RetentionService["getExportArtifact"]>[0]) {
    let artifactIdentified = false;
    let auditCompleted = false;
    try {
      const job = await getPrivacyExportJob(this.#database, {
        userId: input.userId,
        jobId: input.exportId,
      });
      if (isExpiredExport(job, this.#clock())) return null;
      if (job.status !== "completed" || !job.expiresAt)
        throw new RetentionExportNotReadyServiceError();
      const artifact = job.artifacts.find((candidate) => candidate.format === input.format);
      if (!artifact) return null;
      artifactIdentified = true;
      const metadata: EncryptedArtifactMetadata = {
        ciphertextBytes: safeCount(artifact.ciphertextBytes),
        encryptionKeyId: artifact.encryptionKeyId,
        envelopeVersion: 1,
        mediaType: artifact.mediaType,
        objectKey: artifact.objectKey,
        plaintextBytes: safeCount(artifact.plaintextBytes),
        plaintextSha256: artifact.plaintextSha256,
      };
      const opened = await this.#artifacts.bulkhead.openAuthenticated({
        metadata,
        ownerKey: sha256(input.userId),
        store: this.#artifacts.store,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!opened) {
        await recordPrivacyExportArtifactDownloadAudit(this.#database, {
          format: input.format,
          jobId: input.exportId,
          occurredAt: this.#clock().toISOString(),
          outcome: "not_found",
          userId: input.userId,
        });
        auditCompleted = true;
        return null;
      }
      try {
        await recordPrivacyExportArtifactDownloadAudit(this.#database, {
          format: input.format,
          jobId: input.exportId,
          occurredAt: this.#clock().toISOString(),
          outcome: "opened",
          userId: input.userId,
        });
        auditCompleted = true;
      } catch (error) {
        await opened.dispose();
        throw error;
      }
      return {
        contentLength: opened.contentLength,
        fileName: artifact.fileName,
        mediaType: artifact.mediaType,
        sha256: artifact.plaintextSha256,
        stream: opened.stream,
      };
    } catch (error) {
      if (
        artifactIdentified &&
        !auditCompleted &&
        !(error instanceof ArtifactReadRateLimitedError) &&
        !(error instanceof ArtifactReadUnavailableError)
      ) {
        await recordPrivacyExportArtifactDownloadAudit(this.#database, {
          format: input.format,
          jobId: input.exportId,
          occurredAt: this.#clock().toISOString(),
          outcome: "failed",
          userId: input.userId,
        }).catch(() => undefined);
      }
      if (error instanceof ArtifactReadRateLimitedError)
        throw new RetentionDownloadRateLimitedServiceError();
      if (error instanceof ArtifactReadUnavailableError)
        throw new RetentionDownloadUnavailableServiceError();
      if (error instanceof RetentionExportNotReadyServiceError) throw error;
      mapPersistenceError(error);
    }
  }

  async requestErasure(input: Parameters<RetentionService["requestErasure"]>[0]) {
    try {
      if (input.request.confirmation !== "DELETE_MY_ACCOUNT")
        throw new RetentionValidationServiceError();
      const statusToken = token(
        this.#erasureStatusCapabilityHmacKey,
        `nutrition-tracker-erasure-status-capability-v1\n${input.userId}\n${input.clientOperationId}`,
      );
      const requestedAt = this.#clock();
      const statusCapabilityExpiresAt = new Date(
        requestedAt.getTime() + 30 * 86_400_000,
      ).toISOString();
      const result = await requestAccountErasure(this.#database, {
        ...operation(input),
        executeAfter: new Date(requestedAt.getTime() + 24 * 60 * 60_000).toISOString(),
        proofTokenHash: sha256(input.reauthenticationToken),
        requestedAt: requestedAt.toISOString(),
        restoreLocator: deriveErasureLedgerLocator(this.#erasureLedgerLocatorKeyRing, input.userId)
          .value,
        sessionTokenHash: input.sessionTokenHash,
        statusCapabilityExpiresAt,
        statusCapabilityHash: sha256(statusToken),
      });
      return {
        data: {
          erasure: erasureJob(result.job),
          replayed: result.replayed,
          statusCapability: { expiresAt: result.job.statusCapabilityExpiresAt, token: statusToken },
        },
      };
    } catch (error) {
      if (error instanceof RetentionValidationServiceError) throw error;
      if (error instanceof RetentionNotFoundError)
        throw new RetentionRecentAuthenticationServiceError();
      mapPersistenceError(error);
    }
  }
  async getErasure(input: Parameters<RetentionService["getErasure"]>[0]) {
    try {
      const result = await getAccountErasureJob(this.#database, {
        userId: input.userId,
        jobId: input.erasureId,
      });
      return { data: { erasure: erasureJob(result), replayed: true } };
    } catch (error) {
      if (error instanceof RetentionNotFoundError) return null;
      mapPersistenceError(error);
    }
  }
  async getErasureByCapability(input: Parameters<RetentionService["getErasureByCapability"]>[0]) {
    try {
      const result = await getAccountErasureByCapability(this.#database, {
        jobId: input.erasureId,
        now: this.#clock().toISOString(),
        statusCapabilityHash: input.statusTokenHash,
      });
      return { data: { erasure: erasureJob(result), replayed: true } };
    } catch (error) {
      if (error instanceof RetentionNotFoundError) return null;
      mapPersistenceError(error);
    }
  }
}
